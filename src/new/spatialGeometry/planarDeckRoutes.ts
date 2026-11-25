import type { ConnectionSide, EdgeRouteStyle, GraphEdge, Point, Rect } from '../../v3/types';
import type { RenderBlock, RenderEdge } from '../../v3/layout';
import { choosePorts, makeStubRoute, portPoint, type Cubic, type EdgeRoute } from '../../v3/edgeGeometry';
import { createRoutingGeometry } from '../../v3/edgeRoutingGeometry';
import { routeAroundObstacles } from '../../v3/obstacleRouter';
import { intersects } from '../../v3/rectangleIndex';
import type { GranularityIndex } from '../canvasGranularity';
import type { SpatialWorld } from '../granularSpatialGeometry';
import type { WorldGroup, WorldNode, WorldPoint } from './layout.mjs';

const epsilon=1e-6;
const midpoint=(a:Point,b:Point):Point=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const bounds=(g:WorldGroup):Rect=>({x:g.center.x-g.halfWidth,y:g.center.y-g.halfHeight,width:2*g.halfWidth,height:2*g.halfHeight});

/** The SVG spatial renderer consumes point lists. Flatten the very same cubic
 * chosen by the 2D router; straight cubics stay a single segment. */
function deckPoints(route:EdgeRoute,from:WorldPoint,to:WorldPoint,rect:Rect):WorldPoint[] {
  const result:WorldPoint[]=[from];
  function push(p:Point){
    const last=result[result.length-1];
    if(Math.abs(last.x-p.x)+Math.abs(last.y-p.y)<=epsilon)return;
    const prior=result.at(-2);
    if(prior){
      const dx=last.x-prior.x,dy=last.y-prior.y,nx=p.x-last.x,ny=p.y-last.y;
      if(Math.abs(dx*ny-dy*nx)<epsilon&&dx*nx+dy*ny>=0)result.pop();
    }
    result.push({x:p.x,y:p.y,z:from.z});
  }
  // The two-dimensional solver deliberately returns an unconstrained curve
  // when manual overlap leaves no clear route. Its visible samples still
  // belong to this finite deck, including between samples (a convex box).
  const append=route.fallback?(p:Point)=>push({
    x:Math.max(rect.x,Math.min(rect.x+rect.width,p.x)),
    y:Math.max(rect.y,Math.min(rect.y+rect.height,p.y)),
  }):push;
  function flatten([a,b,c,d]:Cubic,depth:number){
    const dx=d.x-a.x,dy=d.y-a.y,dd=dx*dx+dy*dy;
    const close=(p:Point)=>{
      const t=dd?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/dd)):0;
      return (p.x-a.x-t*dx)**2+(p.y-a.y-t*dy)**2<=.36;
    };
    if(depth===12||close(b)&&close(c)){append(d);return;}
    const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d);
    const left=midpoint(ab,bc),right=midpoint(bc,cd),half=midpoint(left,right);
    flatten([a,ab,left,half],depth+1);flatten([half,right,cd,d],depth+1);
  }
  append(route.segments[0][0]);
  for(const curve of route.segments)flatten(curve,0);
  push(to);result[result.length-1]=to;
  return result.length===1?[from,to]:result;
}

function rimSide(g:WorldGroup,p:WorldPoint):ConnectionSide|undefined {
  const x=p.x-g.center.x,y=p.y-g.center.y;
  if(!(Math.abs(p.z-g.center.z)<=epsilon&&Math.abs(x)<=g.halfWidth+epsilon&&Math.abs(y)<=g.halfHeight+epsilon))return;
  if(Math.abs(Math.abs(x)-g.halfWidth)<epsilon)return x<0?'left':'right';
  if(Math.abs(Math.abs(y)-g.halfHeight)<epsilon)return y<0?'top':'bottom';
}
const inward:Record<ConnectionSide,ConnectionSide>={left:'right',right:'left',top:'bottom',bottom:'top'};

export function createPlanarDeckRouter(world:SpatialWorld,index:GranularityIndex) {
  const nodesByDeck=new Map<string,WorldNode[]>(),edgesByDeck=new Map<string,GraphEdge[]>();
  const decks=new Map<string,ReturnType<typeof buildDeck>>();
  const originals=new WeakMap<GraphEdge,WorldPoint[]>();
  const branches=new WeakMap<WorldPoint,Map<string,WorldPoint[]>>();
  // Small routing footprints around the existing spatial dots. Their geometry
  // is independent of camera zoom and never becomes a rendered rectangle.
  const radius=Math.max(5,Math.min(24,world.shape.spacing*.13));
  for(const n of world.shape.nodes){
    if(!nodesByDeck.has(n.owner))nodesByDeck.set(n.owner,[]);
    nodesByDeck.get(n.owner)!.push(n);
  }
  for(const e of index.edgesById.values()){
    if(e.removed)continue;
    const a=world.nodes.get(e.sourceNodeId),b=world.nodes.get(e.targetNodeId);
    if(!a||!b||a.owner!==b.owner)continue;
    if(!edgesByDeck.has(a.owner))edgesByDeck.set(a.owner,[]);
    edgesByDeck.get(a.owner)!.push(e);
  }
  function buildDeck(owner:WorldGroup){
    const rect=bounds(owner),blocks:RenderBlock[]=[],rects=new Map<string,Rect>();
    function add(id:string,name:string,box:Rect,kind:RenderBlock['kind']){
      rects.set(id,box);
      blocks.push({id,name,rect:box,kind,anchor:{x:box.x,y:box.y},parentId:owner.id,depth:0,collapsed:false});
    }
    for(const n of nodesByDeck.get(owner.id)??[]){
      add(n.id,n.name,{x:n.p.x-radius,y:n.p.y-radius,width:2*radius,height:2*radius},'node');
    }
    for(const g of world.shape.groups){
      if(g===owner||g.shape!=='plane'||Math.abs(g.center.z-owner.center.z)>epsilon)continue;
      const box=bounds(g);if(intersects(rect,box))add(g.id,g.name,box,'directory');
    }
    let internalRows:Map<string,RenderEdge>|undefined;
    function row(edge:GraphEdge){
      if(!internalRows){
        const edges:RenderEdge[]=(edgesByDeck.get(owner.id)??[]).map(e=>{
          const a=world.nodes.get(e.sourceNodeId)!.p,b=world.nodes.get(e.targetNodeId)!.p;
          return {edge:e,kind:'full',scope:'internal',source:a,target:b,sourceSide:'right',targetSide:'left',
            sourceBlockId:e.sourceNodeId,targetBlockId:e.targetNodeId,arrowAt:e.directed?'target':null,route:makeStubRoute(a,b)};
        });
        // The normal 2D worker makes these same obstacle-aware port choices
        // and orders incident records into seats. Scale the seats to a dot.
        const geometry=createRoutingGeometry({blocks,edges,parentOf:new Map()},[],{
          spacing:{gap:Math.min(18,radius*.65),minGap:Math.min(6,radius*.25),margin:Math.min(8,radius*.25)},
        });
        internalRows=new Map(geometry.edges.map(e=>[e.edge.edgeId,e]));
      }
      return internalRows.get(edge.edgeId);
    }
    function others(a:string,b?:string){return blocks.filter(v=>v.id!==a&&v.id!==b).map(v=>v.rect);}
    return {rect,rects,row,others};
  }
  function deck(owner:WorldGroup){
    if(!decks.has(owner.id))decks.set(owner.id,buildDeck(owner));
    return decks.get(owner.id)!;
  }
  function internal(edge:GraphEdge):WorldPoint[]|undefined {
    const old=originals.get(edge);if(old)return old;
    const a=world.nodes.get(edge.sourceNodeId),b=world.nodes.get(edge.targetNodeId);
    if(!a||!b||a.owner!==b.owner||a.id===b.id)return;
    const owner=world.groups.get(a.owner);if(owner?.shape!=='plane')return;
    if(!(Math.abs(a.p.z-owner.center.z)<=epsilon&&Math.abs(b.p.z-owner.center.z)<=epsilon))return;
    const d=deck(owner),r=d.row(edge);if(!r)return;
    const ra=d.rects.get(a.id)!,rb=d.rects.get(b.id)!,overlap=Math.abs(a.p.x-b.p.x)+Math.abs(a.p.y-b.p.y)<epsilon;
    const from=overlap?portPoint(ra,'right'):r.source,to=overlap?portPoint(rb,'top'):r.target;
    const route=routeAroundObstacles(from,to,overlap?'right':r.sourceSide,overlap?'top':r.targetSide,
      d.others(a.id,b.id),8,[ra,rb],d.rect,{},edge.routeStyle);
    const points=deckPoints(route,a.p,b.p,d.rect);
    originals.set(edge,points);return points;
  }
  function branch(nodeId:string,gate:WorldPoint,style:EdgeRouteStyle='curve'):WorldPoint[]|undefined {
    const key=JSON.stringify([nodeId,style]);
    let cache=branches.get(gate);
    const known=cache?.get(key);if(known)return known;
    const n=world.nodes.get(nodeId),owner=n&&world.groups.get(n.owner);
    if(!n||owner?.shape!=='plane'||!(Math.abs(n.p.z-owner.center.z)<=epsilon))return;
    const face=rimSide(owner,gate);if(!face)return;
    const d=deck(owner),nr=d.rects.get(n.id)!,obs=d.others(n.id);
    const terminal={x:gate.x,y:gate.y,width:0,height:0};
    const {source,sourceSide}=choosePorts(nr,terminal,obs);
    const route=routeAroundObstacles(source,gate,sourceSide,inward[face],obs,8,[nr],d.rect,{},style);
    const points=deckPoints(route,n.p,gate,d.rect);
    if(!cache){cache=new Map();branches.set(gate,cache);}
    cache.set(key,points);return points;
  }
  return {internal,branch};
}
