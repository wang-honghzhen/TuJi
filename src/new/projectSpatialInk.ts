import type {GranularityIndex, GranularityProjection} from './canvasGranularity';
import type {SpatialLine, SpatialWorld} from './granularSpatialGeometry';
import type {WorldPoint} from './spatialGeometry/layout.mjs';
import {spreadProjectedPoints, type Outline, type ScreenDot} from './spatialGeometry/screenSpread.mjs';
import {createShellOcclusion,shadowStrokeOpacity,shellStrokeRuns,type ScreenPoint} from './spatialGeometry/visualDepth.mjs';

function edgeInk(points:ScreenPoint[], emphasized:boolean, dashed=false) {
  return {points,width:emphasized?2.2:1.25,alpha:emphasized?1:.74,dashed,occluded:false};
}

export function platformCorners(g:SpatialWorld['shape']['groups'][number]):WorldPoint[] {
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>({
    x:g.center.x+a*g.halfWidth,y:g.center.y+b*g.halfHeight,z:g.center.z
  }));
}

/** Sketch in CSS pixels. Geometry and semantic endpoints are read-only throughout the frame. */
export function projectSpatialInk(world:SpatialWorld,index:GranularityIndex,scene:GranularityProjection,
  lines:SpatialLine[],project:(p:WorldPoint)=>ScreenPoint,scale:number,selected:ReadonlySet<string>) {
  const groups=world.shape.groups.filter(g=>scene.groupIds.has(g.id));
  const sphere=groups[0]?.shape==='sphere';
  const nodes=world.shape.nodes.filter(n=>scene.nodeIds.has(n.id));
  const residual=new Map(scene.relations.map(r=>[r.id,r]));
  const selectedResidual=new Set<string>();
  const member=(id:string)=>residual.has(index.relationOfEdge.get(id)??'');
  const focalNodes=new Set<string>(), relatedNodes=new Set<string>();
  for(const id of selected){
    if(index.nodeIds.has(id))focalNodes.add(id);
    const edge=index.edgesById.get(id);
    if(edge){
      focalNodes.add(edge.sourceNodeId);focalNodes.add(edge.targetNodeId);
      if(groups[0]?.shape==='plane'){
        const pairId=index.relationOfEdge.get(id);
        if(pairId&&residual.get(pairId)?.memberEdgeIds.includes(id))selectedResidual.add(pairId);
      }
    }
  }
  if(focalNodes.size){
    for(const line of lines){
      const e=index.edgesById.get(line.id);
      if(e&&(focalNodes.has(e.sourceNodeId)||focalNodes.has(e.targetNodeId))){
        relatedNodes.add(e.sourceNodeId);relatedNodes.add(e.targetNodeId);
      }
    }
  }
  const anchors=nodes.map(node=>project(node.p));
  const points:ScreenDot[]=anchors.map((p,i)=>({...p,id:nodes[i].id,anchorX:p.x,anchorY:p.y}));
  const important=new Set<string>();
  const degrees=nodes.map(n=>index.incidentEdges.get(n.id)?.length??0).sort((a,b)=>a-b);
  const threshold=Math.max(3,degrees[Math.floor(degrees.length*.9)]??3);
  for(const n of nodes)if((index.incidentEdges.get(n.id)?.length??0)>=threshold)important.add(n.id);
  const shells=sphere?groups.map(g=>({...project(g.center),radius:g.radius*scale})):[];
  // Only mounted groups participate. The canvas root encloses the scene.
  const blockers=shells.filter((_,i)=>groups[i].parent!=null);
  const occlusion=blockers.length?createShellOcclusion(blockers,scale):null;
  const outlines:Outline[]=groups.map((g,i)=>{
    if(sphere){
      const {x,y,radius:r}=shells[i];
      return {x,y,radius:r,left:x-r,right:x+r,top:y-r,bottom:y+r};
    }
    const corners=platformCorners(g).map(project),xs=corners.map(p=>p.x),ys=corners.map(p=>p.y);
    return {corners,left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
  });
  // Iterate in immutable graph order. Depth-sorting the solver input would make coincident
  // dots swap places as they pass one another in camera space.
  spreadProjectedPoints(points,outlines,{preferred:focalNodes,important,pinned:focalNodes});
  const dots=new Map(points.map(point=>[point.id,point]));
  const nodeDraw=nodes.map((n,i)=>{
    const at=points[i];
    const occluded=!!occlusion?.behind(anchors[i]);
    const alpha=focalNodes.has(n.id)?1:occluded?.38:.97;
    const labelPriority=focalNodes.has(n.id)?3:relatedNodes.has(n.id)?2:important.has(n.id)?1:0;
    return {...n,at,alpha,labelPriority,occluded};
  }).sort((a,b)=>a.at.depth-b.at.depth);
  const lineDraw=lines.map(line=>{
    const canonical=line.points.map(project),e=index.edgesById.get(line.id);
    const screen=e&&occlusion?canonical.slice():canonical;
    if(e&&screen.length>=2){
      const from=dots.get(e.sourceNodeId),to=dots.get(e.targetNodeId);
      if(from)screen[0]=from;
      if(to)screen[screen.length-1]=to;
    }
    // A disclosed original stays one selectable path. Its inner pieces
    // follow the spread dots while the two published rim points stay fixed.
    let deckRoute;
    if(line.trunkPoints){
      const start=line.points.indexOf(line.trunkPoints[0]),end=start+line.trunkPoints.length-1;
      deckRoute={source:screen.slice(0,start+1),trunk:screen.slice(start,end+1),target:screen.slice(end)};
    }
    const role=line.kind==='relation'?'trunk':member(line.id)?'branch':
      index.edgeScopes.get(line.id)==='internal'?'internal':'single';
    const pairId=index.relationOfEdge.get(line.id);
    const relationSelected=selected.has(line.id);
    const branches=line.branches?.map(branch=>{
      const at=dots.get(branch.nodeId)!;
      const fromNode=branch.side==='source';
      const gate=fromNode?screen[0]:screen[screen.length-1];
      const points=branch.points.map((p,i)=>{
        if(i===0)return fromNode?at:gate;
        if(i===branch.points.length-1)return fromNode?gate:at;
        return project(p);
      });
      const memberSelected=selected.size>0&&branch.memberEdgeIds.some(id=>selected.has(id));
      const active=relationSelected||memberSelected;
      const ink=edgeInk(points,active,true);
      return {...branch,screen:points,ink,highlighted:active};
    });
    const highlighted=relationSelected||!!pairId&&selected.has(pairId)||selectedResidual.has(line.id);
    // A disclosed original has normal ink even while its siblings remain aggregated.
    const ink=edgeInk(screen,highlighted,sphere&&line.kind==='relation');
    const runs=screen.length<2?[]:occlusion&&!highlighted?shellStrokeRuns(occlusion,ink,canonical):[ink];
    let arrowOccluded=false;
    if(occlusion&&(line.directed||line.kind==='outside')&&!highlighted&&screen.length>1){
      const mid=Math.max(1,Math.floor(canonical.length/2)),a=canonical[mid-1],b=canonical[mid];
      arrowOccluded=occlusion.behind({x:(a.x+b.x)/2,y:(a.y+b.y)/2,depth:(a.depth+b.depth)/2});
    }
    const arrowAlpha=arrowOccluded?shadowStrokeOpacity:ink.alpha;
    return {...line,branches,screen,deckRoute,runs,role,highlighted,arrowOccluded,arrowAlpha};
  }).sort((a,b)=>Number(a.highlighted)-Number(b.highlighted)||
    Number(a.kind==='relation')-Number(b.kind==='relation'));
  // In each layer keep the physical far-to-near order. A selected rear
  // endpoint stays reachable even when another shell covers its projection.
  if(sphere&&(occlusion||selected.size)){
    const layer=(n:typeof nodeDraw[number])=>selected.has(n.id)?3:n.occluded?(focalNodes.has(n.id)?2:0):1;
    nodeDraw.sort((a,b)=>layer(a)-layer(b));
  }
  const groupDraw=groups.map((g,i)=>({...g,occluded:g.parent!=null&&!!occlusion?.coversShell(shells[i])}));
  return {groups:groupDraw,nodes:nodeDraw,lines:lineDraw};
}
