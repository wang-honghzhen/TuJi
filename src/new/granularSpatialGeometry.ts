import type { RenderModel } from '../v3/layout';
import type { EdgeRouteStyle, GraphEdge } from '../v3/types';
import type { GranularityIndex, GranularityProjection, SubgraphRelation } from './canvasGranularity';
import { layout, type Group, type Link, type Node, type WorldPoint } from './spatialGeometry/layout.mjs';
import { createSpatialLineRouter, type RelationEndpoints } from './spatialGeometry/routes.mjs';
import { planLayeredLines, routeOrthogonalTrunks } from './spatialGeometry/orthogonalTrunks.mjs';
import { createPlanarDeckRouter } from './spatialGeometry/planarDeckRoutes';

export type SpatialMode = 'layered' | 'sphere';
export interface SpatialLine {
  id:string; kind:'relation'|'edge'|'outside'; points:WorldPoint[]; count:number; directed:boolean; name:string;
  branches?:PlatformBranch[];
  /** Boundary-to-boundary portion of an individually displayed planar crossing. */
  trunkPoints?:WorldPoint[];
}
export interface PlatformBranch {
  nodeId:string; side:'source'|'target'; memberEdgeIds:string[]; points:WorldPoint[];
  description:string; membersJson:string;
}
const link=(e:GraphEdge):Link=>({id:e.edgeId,source:e.sourceNodeId,target:e.targetNodeId,directed:e.directed});

/** Independent of all visibility, observation and expansion controls. */
export function buildSpatialWorld(natural:RenderModel,index:GranularityIndex,mode:SpatialMode,rootName:string){
  const box=natural.bounds;
  const groups:Group[]=[{id:index.rootId,name:rootName,parent:null,depth:0,rect:{
    x:box.x-50,y:box.y-50,width:Math.max(100,box.width+100),height:Math.max(100,box.height+100)}}];
  const nodes:Node[]=[];
  for(const block of natural.blocks){
    if(block.kind==='node')nodes.push({id:block.id,name:block.name,owner:block.parentId,
      x:block.rect.x+block.rect.width/2,y:block.rect.y+block.rect.height/2});
    else groups.push({id:block.id,name:block.name,parent:block.parentId,depth:block.depth+1,rect:block.rect});
  }
  const ids=new Set(nodes.map(n=>n.id));
  const edges=Array.from(index.edgesById.values()).filter(e=>!e.removed&&ids.has(e.sourceNodeId)&&ids.has(e.targetNodeId)).map(link);
  const shape=layout({groups,nodes,edges},mode==='sphere'?'sphere':'plane',2);
  return {shape,steppedDecks:mode==='layered',nodes:new Map(shape.nodes.map(n=>[n.id,n])),groups:new Map(shape.groups.map(g=>[g.id,g]))};
}
export type SpatialWorld=ReturnType<typeof buildSpatialWorld>;

export function spatialAnchor(world:SpatialWorld,id:string) {
  return world.nodes.get(id)?.p??world.groups.get(id)?.center;
}

interface EdgeGeometry {
  edge:GraphEdge;
  line:SpatialLine;
  crossing?:Link;
}

function createLineCache(world:SpatialWorld,index:GranularityIndex){
  const router=createSpatialLineRouter(world.shape,index.relations.values());
  const layered=world.shape.groups[0]?.shape==='plane';
  let deck:ReturnType<typeof createPlanarDeckRouter>|undefined;
  const localDeck=()=>layered?(deck??=createPlanarDeckRouter(world,index)):undefined;
  const originals=new WeakMap<GraphEdge,EdgeGeometry>();
  const pairs=new WeakMap<SubgraphRelation,RelationEndpoints>();
  const branchPaths=new WeakMap<WorldPoint,Map<string,WorldPoint[]>>();
  const groupVisibility=new Map<string,number>();
  const branchCache=new WeakMap<SubgraphRelation,{
    from:WorldPoint;to:WorldPoint;sourceRevision:number;targetRevision:number;branches:PlatformBranch[];
  }>();
  let lastScene:GranularityProjection|undefined;
  let memberDirectory:{relations:Map<string,{sourceSubgraphId:string;targetSubgraphId:string}>}|undefined;
  const completeMembers=new WeakMap<WorldPoint[],SpatialLine>();

  function access(nodeId:string,gate:WorldPoint,side:'source'|'target',style:EdgeRouteStyle){
    let paths=branchPaths.get(gate);
    if(!paths){paths=new Map();branchPaths.set(gate,paths);}
    const key=JSON.stringify([nodeId,side,style]);
    const known=paths.get(key);
    if(known)return known;
    const node=world.nodes.get(nodeId);
    const p=node?.p??world.groups.get(nodeId)!.center;
    const local=localDeck()?.branch(nodeId,gate,style)??router.platformBranch(node?.owner??nodeId,p,gate);
    const route=side==='source'?local:local.slice().reverse();
    paths.set(key,route);
    return route;
  }

  function observePlatforms(scene:GranularityProjection){
    if(lastScene===scene)return;
    if(lastScene){
      const changed=new Set<string>();
      const inspect=(a:GranularityProjection,b:GranularityProjection)=>{
        for(const id of a.nodeIds)if(!b.nodeIds.has(id)){
          const owner=world.nodes.get(id)?.owner;
          if(owner)changed.add(owner);
        }
        for(const id of a.collapsedGroupIds)if(!b.collapsedGroupIds.has(id))changed.add(id);
      };
      inspect(lastScene,scene);inspect(scene,lastScene);
      for(const id of changed)groupVisibility.set(id,(groupVisibility.get(id)??0)+1);
    }
    lastScene=scene;
  }

  function platformBranches(r:SubgraphRelation,points:WorldPoint[],scene:GranularityProjection):PlatformBranch[] {
    if(!scene.nodeIds?.size || world.groups.get(r.sourceSubgraphId)?.shape!=='plane')return [];
    const sourceOpen=!scene.collapsedGroupIds.has(r.sourceSubgraphId),targetOpen=!scene.collapsedGroupIds.has(r.targetSubgraphId);
    if(!sourceOpen&&!targetOpen)return [];
    const sourceRevision=groupVisibility.get(r.sourceSubgraphId)??0,targetRevision=groupVisibility.get(r.targetSubgraphId)??0;
    const from=points[0],to=points[points.length-1];
    const cached=branchCache.get(r);
    if(cached&&cached.from===from&&cached.to===to&&cached.sourceRevision===sourceRevision&&cached.targetRevision===targetRevision)return cached.branches;
    const byNode=new Map<string,Pick<PlatformBranch,'nodeId'|'side'|'memberEdgeIds'>>();
    function add(nodeId:string,memberId:string){
      if(!scene.nodeIds.has(nodeId))return;
      const existing=byNode.get(nodeId);
      if(existing){existing.memberEdgeIds.push(memberId);return;}
      const node=world.nodes.get(nodeId);
      if(!node)return;
      // Undirected member order can be the reverse of the canonical group pair.
      const source=node.owner===r.sourceSubgraphId;
      const target=node.owner===r.targetSubgraphId;
      if(!(source&&sourceOpen || target&&targetOpen))return;
      byNode.set(nodeId,{nodeId,side:source?'source':'target',memberEdgeIds:[memberId]});
    }
    // The residual list already excludes hidden and independently expanded originals.
    for(const id of r.memberEdgeIds){
      const edge=index.edgesById.get(id);
      if(edge){add(edge.sourceNodeId,id);add(edge.targetNodeId,id);}
    }
    function endpointName(id:string){
      const node=world.nodes.get(id);
      if(!node)return world.groups.get(id)?.name??id;
      if(scene.nodeIds.has(id)&&!scene.collapsedGroupIds.has(node.owner))return node.name;
      return '子图 '+(world.groups.get(node.owner)?.name??node.owner);
    }
    const branches=Array.from(byNode.values(),branch=>{
      const direction=!r.directed?'无向端点':branch.side==='source'?'起点（节点 → 主干）':'终点（主干 → 节点）';
      const header=endpointName(branch.nodeId)+' · '+direction+' · 本段 '+branch.memberEdgeIds.length+' / '+r.relationCount+' 条聚合成员';
      const members=branch.memberEdgeIds.map(id=>{
        const e=index.edgesById.get(id)!;
        return endpointName(e.sourceNodeId)+(e.directed?' → ':' — ')+endpointName(e.targetNodeId)+'（'+id+'）';
      });
      const style=branch.memberEdgeIds.every(id=>index.edgesById.get(id)?.routeStyle==='orthogonal')?'orthogonal':'curve';
      const points=access(branch.nodeId,branch.side==='source'?from:to,branch.side,style);
      return {...branch,points,description:[header,...members].join('\n'),membersJson:JSON.stringify(branch.memberEdgeIds)};
    });
    branchCache.set(r,{from,to,sourceRevision,targetRevision,branches});
    return branches;
  }

  function original(e:GraphEdge):EdgeGeometry|undefined {
    const known=originals.get(e);
    if(known)return known;
    const from=spatialAnchor(world,e.sourceNodeId),to=spatialAnchor(world,e.targetNodeId);
    const outside=index.edgeScopes.get(e.edgeId)==='outside';
    let points:WorldPoint[],crossing:Link|undefined;
    if(outside){
      const n=from??to;
      if(!n)return;
      const side=from?1:-1,dist=world.shape.spacing*.8;
      const stub={x:n.x+side*dist,y:n.y+dist*.15,z:n.z+dist*.12};
      points=from?[n,stub]:[stub,n];
    }else{
      if(!from||!to)return;
      const owner=(id:string)=>world.nodes.get(id)?.owner??id;
      if(owner(e.sourceNodeId)!==owner(e.targetNodeId))crossing=link(e);
      points=(!crossing&&localDeck()?.internal(e))||[from,to];
    }
    const geometry:EdgeGeometry={edge:e,crossing,line:{id:e.edgeId,kind:outside?'outside':'edge',points,
      count:1,directed:e.directed,name:e.edgeContent||(outside?'画布外关系':'知识关系')}};
    originals.set(e,geometry);
    return geometry;
  }

  function endpoints(residual:SubgraphRelation):RelationEndpoints {
    const r=index.relations.get(residual.id)??residual;
    const known=pairs.get(r);
    if(known)return known;
    const source=world.groups.get(r.sourceSubgraphId),target=world.groups.get(r.targetSubgraphId);
    const fromPoints:WorldPoint[]=[],toPoints:WorldPoint[]=[];
    // Geometry of a residual relation uses the original members so revealing
    // one member does not move its remaining semantic pair to a new centroid.
    if(source?.shape==='sphere'&&target){
      for(const id of r.memberEdgeIds){
        const e=index.edgesById.get(id);
        if(!e)continue;
        const a=spatialAnchor(world,e.sourceNodeId),b=spatialAnchor(world,e.targetNodeId);
        if(!a||!b)continue;
        // A nested endpoint may now meet the rim of its folded ancestor.
        let owner:string|undefined=world.nodes.get(e.sourceNodeId)?.owner??e.sourceNodeId;
        while(owner && owner!==r.sourceSubgraphId && owner!==r.targetSubgraphId)owner=index.parents.get(owner);
        const forward=owner===r.sourceSubgraphId;
        fromPoints.push(forward?a:b);toPoints.push(forward?b:a);
      }
    }
    const pair={id:r.id,from:r.sourceSubgraphId,to:r.targetSubgraphId,fromPoints,toPoints};
    pairs.set(r,pair);
    return pair;
  }
  function routeMembers(crossings:EdgeGeometry[],coarse:ReturnType<typeof router.overview>,summaries:SpatialLine[]){
    if(!memberDirectory){
      const relations=new Map<string,{sourceSubgraphId:string;targetSubgraphId:string}>();
      for(const [edgeId,pairId] of index.relationOfEdge){
        const edge=index.edgesById.get(edgeId)!,pair=index.relations.get(pairId)!;
        const source=world.nodes.get(edge.sourceNodeId)?.owner??edge.sourceNodeId;
        relations.set(edgeId,source===pair.sourceSubgraphId?pair:{
          sourceSubgraphId:pair.targetSubgraphId,targetSubgraphId:pair.sourceSubgraphId});
      }
      memberDirectory={relations};
    }
    const seeds:SpatialLine[]=[];
    for(const {edge,line} of crossings){
      const pairId=index.relationOfEdge.get(edge.edgeId)!;
      const pair=index.relations.get(pairId)!,gates=coarse.get(pairId)?.gates;
      if(!gates||gates.length!==2)continue;
      const forward=memberDirectory.relations.get(line.id)!.sourceSubgraphId===pair.sourceSubgraphId;
      const points=forward?[gates[0].point,gates[1].point]:[gates[1].point,gates[0].point];
      seeds.push({...line,points});
    }
    const occupied=summaries.map(l=>{
      const {sourceSubgraphId,targetSubgraphId}=index.relations.get(l.id)!;
      return {id:l.id,sourceSubgraphId,targetSubgraphId,points:l.points};
    });
    const routes=routeOrthogonalTrunks(world,memberDirectory,seeds,'original',occupied);
    return new Map(routes.map(l=>{
      const trunk=l.points,known=completeMembers.get(trunk);
      if(known)return [l.id,known];
      const e=index.edgesById.get(l.id)!,style=e.routeStyle??'curve';
      const start=access(e.sourceNodeId,trunk[0],'source',style);
      const end=access(e.targetNodeId,trunk[trunk.length-1],'target',style);
      const complete={...l,trunkPoints:trunk,points:[...start.slice(0,-1),...trunk,...end.slice(1)]};
      completeMembers.set(trunk,complete);
      return [l.id,complete];
    }));
  }
  return {index,router,original,endpoints,platformBranches,observePlatforms,routeMembers};
}

// Publishing a new world or membership index invalidates the entire geometry
// cache. Switching granularity on a fixed world changes only port occupancy.
const lineCaches=new WeakMap<SpatialWorld,ReturnType<typeof createLineCache>>();
export function spatialLines(world:SpatialWorld,index:GranularityIndex,scene:GranularityProjection){
  let cache=lineCaches.get(world);
  if(!cache||cache.index!==index){
    cache=createLineCache(world,index);
    lineCaches.set(world,cache);
  }
  const layered=world.shape.groups[0]?.shape==='plane'&&!!index.relationOfEdge;
  const lines:SpatialLine[]=[],inside:EdgeGeometry[]=[],crossings:Link[]=[];
  const memberCrossings:EdgeGeometry[]=[];
  const pairs=new Map(scene.relations.map(r=>[r.id,cache.endpoints(r)]));
  for(const e of scene.edges){
    const geometry=cache.original(e);
    if(!geometry)continue;
    if(geometry.line.kind==='outside')lines.push(geometry.line);
    else inside.push(geometry);
    if(geometry.crossing){
      const pairId=layered&&index.relationOfEdge.get(e.edgeId);
      if(pairId){
        memberCrossings.push(geometry);
        if(!pairs.has(pairId))pairs.set(pairId,cache.endpoints(index.relations.get(pairId)!));
      }else crossings.push(geometry.crossing);
    }
  }
  const detailed=crossings.length?cache.router.detailed(crossings):undefined;
  for(const geometry of inside){
    if(geometry.crossing&&detailed){
      const points=detailed[geometry.crossing.id];
      if(points&&points!==geometry.line.points)geometry.line={...geometry.line,points};
    }
    lines.push(geometry.line);
  }
  const descriptors=[...pairs.values()];
  const coarse=layered?cache.router.rims(descriptors):cache.router.overview(descriptors);
  const summaries:SpatialLine[]=[];
  for(const r of scene.relations){
    const path=coarse.get(r.id);
    if(!path)continue;
    const line:SpatialLine={id:r.id,kind:'relation',points:path.points,count:r.relationCount,directed:r.directed,
      name:[world.groups.get(r.sourceSubgraphId)?.name,r.directed?'→':'—',world.groups.get(r.targetSubgraphId)?.name,
        '·',r.relationCount+' 条关系',r.summary].filter(Boolean).join(' ')};
    summaries.push(line);
  }
  if(world.shape.groups[0]?.shape!=='plane')return lines.concat(summaries);
  const routed=layered?planLayeredLines(world,index,scene,summaries):summaries;
  if(memberCrossings.length){
    const completed=cache.routeMembers(memberCrossings,coarse,routed);
    for(let i=0;i<lines.length;i++)lines[i]=completed.get(lines[i].id)??lines[i];
  }
  if(!routed.length||!scene.nodeIds?.size)return lines.concat(routed);

  // The final trunk determines the rim socket; the visible residual determines
  // which original members can have a branch ending at that socket.
  cache.observePlatforms(scene);
  const residuals=new Map(scene.relations.map(r=>[r.id,r]));
  for(const line of routed){
    if(line.kind!=='relation')continue;
    const branches=cache.platformBranches(residuals.get(line.id)!,line.points,scene);
    if(branches.length)line.branches=branches;
  }
  return lines.concat(routed);
}
