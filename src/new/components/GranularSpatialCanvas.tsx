import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type PointerEvent as ReactPointerEvent,type SyntheticEvent} from 'react';
import type {RenderBlock,RenderModel} from '../../v3/layout';
import type {Point,Rect} from '../../v3/types';
import type {GranularityIndex,GranularityProjection} from '../canvasGranularity';
import type {EndpointPaths} from '../neighborhoodPaths';
import {EdgePathLabels} from './EdgePathLabels';
import {buildSpatialWorld,spatialAnchor,spatialLines,type SpatialMode,type SpatialWorld} from '../granularSpatialGeometry';
import {createSpatialProjection,DEFAULT_SPATIAL_CAMERA,orbitSpatialCamera,panSpatialCamera,zoomSpatialCamera,type SpatialCamera} from '../spatialProjection';
import type {WorldPoint} from '../spatialGeometry/layout.mjs';
import {useSpatialPointer,type LinkHandle,type SpatialEditActions} from '../useSpatialPointer';
import {useCameraTransition} from '../useCameraTransition';
import {findVisiblePath} from '../spatialPath';
import {SpatialPathPanel} from './SpatialPathPanel';
import {platformCorners as corners, projectSpatialInk} from '../projectSpatialInk';
import {batchOrbitInk} from '../batchOrbitInk';
import {darkEdgeAccents,lightEdgeAccents,useGraphAppearance} from '../graphAppearance';
import {createCaptionMeasurer,placeShellTitle} from '../spatialGeometry/shellTitles';
import {polylineLabel} from '../spatialGeometry/polylineLabel';
import {relationLabelBounds} from '../planarRelationLabel';
import {RectangleIndex} from '../../v3/rectangleIndex';
import './granular-spatial.css';

export interface SpatialViewFrame {id?:string;u:number;v:number;zoomRatio?:number}
export interface GranularSpatialProps extends Pick<SpatialEditActions,'onBeginMove'|'onMoveBlock'|'onConnect'|'onReconnect'> {
  natural:RenderModel; index:GranularityIndex; scene:GranularityProjection; mode:SpatialMode; canvasId:string;canvasName?:string;
  projectedIndex?:GranularityIndex;occlusions?:readonly Rect[];
  endpointPaths?:ReadonlyMap<string,EndpointPaths>;
  selectedId:string|null;selectedIds:ReadonlySet<string>;lightGrid:boolean;
  aiTargets?:ReadonlySet<string>;hoveredId?:string|null;
  neighborhoodFocus?:string|null;
  manualSelectedIds?:ReadonlySet<string>;editorOpen?:boolean;
  insets?:{left:number;right:number;bottom:number};initialFrame?:SpatialViewFrame|null;
  onFrame?:(frame:SpatialViewFrame)=>void;
  focusRequest?:{id:string;sequence:number;fit?:boolean;animate?:boolean}|null;
  onSelect:(id:string|null,toggle?:boolean,client?:Point,altKey?:boolean)=>void;
  onToggle:(id:string)=>void;onExpandRelation?:(id:string)=>void;onContextMenu?:(id:string|null,client:Point,world?:Point,region?:RenderBlock)=>void;
  onHoverObject?:(id:string|null,event:ReactPointerEvent)=>void;onLeaveObject?:()=>void;
}

const asCameraPoint=(p:WorldPoint)=>({x:p.x,y:p.z,z:p.y});
const groupCaption=(name:string)=>name.length>24?name.slice(0,23)+'…':name;
const nodeCaption=(name:string)=>name.length>18?name.slice(0,17)+'…':name;
const svgPath=(points:readonly Point[])=>'M'+points.map(p=>p.x+','+p.y).join(' L');
function middle(points:WorldPoint[]):WorldPoint{
  const i=(points.length-1)>>1,a=points[i],b=points[points.length>>1];
  return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2};
}
export function fitWorld(world:SpatialWorld,width:number,height:number){
  const base=DEFAULT_SPATIAL_CAMERA;
  const project=createSpatialProjection(base,{width:0,height:0}).point;
  let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
  for(const g of world.shape.groups){
    const r=g.shape==='sphere'?g.radius:0;
    for(const p of r?[g.center]:corners(g)){
      const q=project(asCameraPoint(p));left=Math.min(left,q.x-r);right=Math.max(right,q.x+r);
      top=Math.min(top,q.y-r);bottom=Math.max(bottom,q.y+r);
    }
  }
  const scale=Math.max(.00001,Math.min(2,(width*.9)/Math.max(1,right-left),(height*.86)/Math.max(1,bottom-top)));
  return panSpatialCamera({...base,zoom:scale},-scale*(left+right)/2,-scale*(top+bottom)/2);
}
const savedCameras=new Map<string,SpatialCamera>();
function loadCamera(key:string){
  const known=savedCameras.get(key);
  if(known)return known;
  try{
    const cam=JSON.parse(localStorage.getItem(key)??'null') as SpatialCamera|null;
    if(cam&&cam.target&&cam.zoom>0&&cam.zoom<=8&&cam.pitch>=.14&&cam.pitch<=Math.PI/2&&
      [cam.zoom,cam.pitch,cam.yaw,cam.target.x,cam.target.y,cam.target.z].every(Number.isFinite))return cam;
  }catch{ /* A session camera still works in storage-limited windows. */ }
  return undefined;
}
function objectId(target:EventTarget|null){return target instanceof Element?target.closest('[data-space-object]')?.getAttribute('data-space-object')??null:null;}

// Ports paint above edge hit bands, while nodes still paint above ports.
// Mirror only transient CSS state across the two SVG groups without running
// projection or rendering the whole scene on every hover transition.
function matchPortHighlight(event:SyntheticEvent<SVGSVGElement>){
  if(!(event.target instanceof Element))return;
  const owner=event.target.closest<SVGGElement>('[data-port-line],[data-port-endpoints],[data-spatial-relation-expand]');
  if(!owner)return;
  const related=(event.nativeEvent as MouseEvent|FocusEvent).relatedTarget;
  if(related instanceof Node&&owner.contains(related))return;
  const focus=event.type==='focus'||event.type==='blur',on=event.type==='focus'||event.type==='pointerover';
  if(focus&&on&&!owner.matches(':focus-visible'))return;
  const id=owner.dataset.spaceObject!;
  for(const peer of ['data-port-line','data-port-endpoints','data-spatial-relation-expand']){
    if(!owner.hasAttribute(peer))event.currentTarget.querySelector('['+peer+'='+CSS.escape(id)+']')?.toggleAttribute(focus?'data-peer-focus':'data-peer-hover',on);
  }
}

export function GranularSpatialCanvas(props:GranularSpatialProps){
  return <SpatialScene key={JSON.stringify([props.canvasId,props.mode])} {...props}/>;
}
function SpatialScene(props:GranularSpatialProps){
  const {natural,scene,mode,selectedId,selectedIds}=props;
  const index=props.projectedIndex??props.index;
  const svg=useRef<SVGSVGElement>(null);
  const paintId=useId().replace(/:/g,'');
  const appearance=useGraphAppearance();
  const palette=props.lightGrid?lightEdgeAccents:darkEdgeAccents;
  const [size,setSize]=useState({width:0,height:0});
  useLayoutEffect(()=>{
    if(!svg.current)return;
    const el=svg.current,measure=()=>{const {width,height}=el.getBoundingClientRect();setSize({width,height});};
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
  },[]);
  const world=useMemo(()=>buildSpatialWorld(natural,props.index,mode,props.canvasName??'画布'),[natural,props.index,mode,props.canvasName]);
  const captions=useMemo(()=>mode==='sphere'?{
    group:createCaptionMeasurer('600 12px system-ui, sans-serif'),
    node:createCaptionMeasurer('12px system-ui, sans-serif'),
  }:null,[world,mode]);
  const lines=useMemo(()=>spatialLines(world,index,scene),[world,index,scene]);
  const nodePaint=useMemo(()=>new Map([...index.nodeIds].map(id=>[id,appearance(id,'node',props.lightGrid)])),
    [index.nodeIds,appearance,props.lightGrid]);
  const groupPaint=useMemo(()=>new Map([...index.groupIds].map(id=>[id,appearance(id,id===index.rootId?'root':undefined,props.lightGrid).accent])),
    [index,appearance,props.lightGrid]);
  const linePaint=useMemo(()=>new Map(lines.map((line,i)=>{
    const pair=index.relations.get(line.id),edge=index.edgesById.get(line.id);
    const source=pair?groupPaint.get(pair.sourceSubgraphId):edge&&nodePaint.get(edge.sourceNodeId)?.accent;
    const target=pair?groupPaint.get(pair.targetSubgraphId):edge&&nodePaint.get(edge.targetNodeId)?.accent;
    return [line.id,{source:source??palette.neutral,target:target??palette.neutral,gradientId:paintId+'-line-'+i}];
  })),[index,lines,groupPaint,nodePaint,palette,paintId]);
  const lineById=useMemo(()=>new Map(lines.map(l=>[l.id,l])),[lines]);
  const anchors=useCallback((id:string|null|undefined)=>{
    if(!id)return undefined;
    const obj=spatialAnchor(world,id);
    if(obj)return obj;
    const line=lineById.get(id);
    if(line)return middle(line.points);
    // A fully opened relation has no remaining aggregate line. Its group
    // centers still provide a stable focus for a transfer or locate action.
    const relation=index.relations.get(id),edge=index.edgesById.get(id);
    const source=relation?world.groups.get(relation.sourceSubgraphId)?.center:edge&&spatialAnchor(world,edge.sourceNodeId);
    const target=relation?world.groups.get(relation.targetSubgraphId)?.center:edge&&spatialAnchor(world,edge.targetNodeId);
    return source&&target?middle([source,target]):source??target;
  },[world,lineById,index]);
  const left=props.insets?.left??0,top=40;
  const width=Math.max(1,size.width-left-(props.insets?.right??0)),height=Math.max(1,size.height-top-(props.insets?.bottom??0));
  const fit=useMemo(()=>fitWorld(world,width,height),[world,width,height]);
  const key='qixue:granular-camera:'+JSON.stringify([props.canvasId,mode]);
  const [manual,applyCamera]=useState<SpatialCamera|undefined>(()=>loadCamera(key));
  const {animate,cancel:cancelMotion}=useCameraTransition();
  const setManual=useCallback((next:Parameters<typeof applyCamera>[0])=>{
    cancelMotion();applyCamera(next);
  },[cancelMotion]);
  const camera=manual??fit;
  const ref=useRef(camera);ref.current=camera;
  const initial=useRef(props.initialFrame);
  const first=useRef(true);
  useLayoutEffect(()=>{
    if(!size.width||!first.current)return;
    first.current=false;
    const frame=initial.current;
    if(manual){
      const anchor=anchors(selectedId);
      if(!anchor)return;
      const q=createSpatialProjection(manual,{width,height}).point(asCameraPoint(anchor));
      if(q.x>=0&&q.x<=width&&q.y>=0&&q.y<=height)return;
      // The graph geometry and orbit are specific to this view. Only bring
      // the shared selection back inside its unobscured viewport.
      const clamp=(v:number)=>Math.min(.92,Math.max(.08,v));
      const u=frame?.id===selectedId?frame.u:.5,v=frame?.id===selectedId?frame.v:.5;
      setManual(panSpatialCamera(manual,width*clamp(u)-q.x,height*clamp(v)-q.y));
      return;
    }
    const p=anchors(frame?.id??selectedId);
    if(!frame||!p)return;
    const zoom=Math.max(.00001,Math.min(8,fit.zoom*(frame.zoomRatio??1)));
    setManual(panSpatialCamera({...fit,zoom,target:asCameraPoint(p)},width*(frame.u-.5),height*(frame.v-.5)));
  },[size.width,manual,anchors,fit,width,height,selectedId]);
  useEffect(()=>{
    if(!size.width)return;
    savedCameras.set(key,camera);
    const persist=()=>{try{localStorage.setItem(key,JSON.stringify(ref.current));}catch{/* memory cache is sufficient */}};
    const timer=window.setTimeout(persist,250);return ()=>window.clearTimeout(timer);
  },[camera,key,size.width]);
  useEffect(()=>()=>{try{localStorage.setItem(key,JSON.stringify(ref.current));}catch{/* optional persistence */}},[key]);
  const projection=createSpatialProjection(camera,{width,height});
  function project(p:WorldPoint){const q=projection.point(asCameraPoint(p));return {x:q.x+left,y:q.y+top,depth:q.depth};}
  const usedFocus=useRef<number>();
  useEffect(()=>{
    if(!props.focusRequest)cancelMotion();
  },[props.focusRequest,cancelMotion]);
  useEffect(()=>{
    const request=props.focusRequest;
    if(!size.width||!request||usedFocus.current===request.sequence)return;
    if(request.fit){usedFocus.current=request.sequence;setManual(fit);return;}
    const p=anchors(request.id);if(!p)return;
    usedFocus.current=request.sequence;
    const start=ref.current,target=asCameraPoint(p);
    if(!request.animate){setManual({...start,target});return;}
    animate(t=>applyCamera({...start,target:{
      x:start.target.x+(target.x-start.target.x)*t,
      y:start.target.y+(target.y-start.target.y)*t,
      z:start.target.z+(target.z-start.target.z)*t,
    }}));
  },[anchors,fit,props.focusRequest,size.width,animate,setManual]);
  const selected=useMemo(()=>new Set(selectedId?[...selectedIds,selectedId]:selectedIds),[selectedId,selectedIds]);
  const [hitHover,setHitHover]=useState<{id:string;at:Point}|null>(null);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>>();
  const hovered=hitHover?.id??props.hoveredId;
  const leaveHover=()=>{clearTimeout(hoverTimer.current);hoverTimer.current=undefined;setHitHover(null);props.onLeaveObject?.();};
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);
  useEffect(()=>{
    if(hitHover&&!scene.nodeIds.has(hitHover.id)&&!scene.groupIds.has(hitHover.id)&&!lineById.has(hitHover.id)&&
      !scene.relations.some(pair=>pair.memberEdgeIds.includes(hitHover.id)))setHitHover(null);
  },[scene,lineById,hitHover]);
  const neighbors=useMemo(()=>{
    const nodes=new Set<string>(),edges=new Set<string>(),groups=new Set<string>(),summaries=new Set<string>();
    const focus=new Set(selected);
    if(hovered)focus.add(hovered);
    for(const id of focus){
      if(index.groupIds.has(id))continue;
      const pair=index.relations.get(id);
      if(pair){groups.add(pair.sourceSubgraphId);groups.add(pair.targetSubgraphId);}
      if(index.nodeIds.has(id))nodes.add(id);
      const originals=index.nodeIds.has(id)?index.incidentEdges.get(id)??[]:
        index.edgesById.has(id)?[index.edgesById.get(id)!]:[];
      for(const edge of originals){
        edges.add(edge.edgeId);
        for(const end of [edge.sourceNodeId,edge.targetNodeId]){
          (index.groupIds.has(end)?groups:nodes).add(end);
        }
        const pair=index.relationOfEdge.get(edge.edgeId);
        if(pair)summaries.add(pair);
      }
    }
    return {nodes,edges,groups,summaries};
  },[selected,hovered,index]);
  const focusIds=useMemo(()=>props.neighborhoodFocus&&!selected.has(props.neighborhoodFocus)
    ?new Set([...selected,props.neighborhoodFocus]):selected,[selected,props.neighborhoodFocus]);
  const {groups,nodes,lines:lineDraw}=useMemo(()=>projectSpatialInk(world,index,scene,lines,project,camera.zoom,focusIds),
    [world,index,scene,lines,camera,width,height,left,focusIds]);
  const manualSelection=props.manualSelectedIds??selectedIds;
  const pair=useMemo(()=>{
    if(props.editorOpen||manualSelection.size!==2)return null;
    const ids=[...manualSelection];
    return ids.every(id=>scene.nodeIds.has(id))?ids:null;
  },[manualSelection,scene.nodeIds,props.editorOpen]);
  const pairKey=JSON.stringify(pair);
  const [trace,setTrace]=useState<{pairKey:string;reversed:boolean;step:string|null}|null>(null);
  const beforeStep=useRef<SpatialCamera|null>(null);
  const tracing=!!pair&&trace?.pairKey===pairKey;
  const from=pair?.[tracing&&trace.reversed?1:0],to=pair?.[tracing&&trace.reversed?0:1];
  const path=useMemo(()=>{
    if(!tracing||!from||!to)return undefined;
    // Scope and disclosure determine connectivity. Orbiting changes the ink,
    // but the highlighted path through the same original edges stays valid.
    const originals=lines.flatMap(line=>{
      const e=index.edgesById.get(line.id);
      return line.kind==='edge'&&e&&scene.nodeIds.has(e.sourceNodeId)&&scene.nodeIds.has(e.targetNodeId)
        ?[{edge:e,kind:'full' as const,sourceBlockId:e.sourceNodeId,targetBlockId:e.targetNodeId}]:[];
    });
    return findVisiblePath(originals,from,to);
  },[tracing,from,to,lines,index,scene.nodeIds]);
  const pathIds=useMemo(()=>new Set(path?.map(step=>step.edge.edgeId)),[path]);
  const activeStep=tracing?trace.step:null;
  const restoreStep=useCallback(()=>{
    if(beforeStep.current)setManual(beforeStep.current);
    beforeStep.current=null;
  },[]);
  useEffect(()=>{
    if(trace&&trace.pairKey!==pairKey){restoreStep();setTrace(null);}
    else if(activeStep&&!pathIds.has(activeStep)){restoreStep();setTrace(t=>t&&{...t,step:null});}
  },[trace,pairKey,activeStep,pathIds,restoreStep]);
  const sendFrame=useRef(props.onFrame);sendFrame.current=props.onFrame;
  useLayoutEffect(()=>{
    if(!size.width)return;
    let id=selectedId,p=anchors(id);
    if(!p){
      let best=Infinity;
      for(const item of [...world.shape.nodes,...world.shape.groups]){
        if(!scene.nodeIds.has(item.id)&&!scene.groupIds.has(item.id))continue;
        const point='p' in item?item.p:item.center;
        const xy=projection.point(asCameraPoint(point));
        const d=Math.hypot(xy.x-width/2,xy.y-height/2);
        if(d<best){best=d;p=point;id=item.id;}
      }
    }
    if(p){const q=projection.point(asCameraPoint(p)),unit=(n:number)=>Math.max(.08,Math.min(.92,n));
      sendFrame.current?.({id:id??undefined,u:unit(q.x/width),v:unit(q.y/height),zoomRatio:camera.zoom/fit.zoom});}
  },[camera,world,scene,fit,width,height,anchors,selectedId,size.width]); // projection uses this camera and viewport
  const blocks=useMemo(()=>new Map(natural.blocks.filter(b=>scene.groupIds.has(b.id)||scene.nodeIds.has(b.id)).map(b=>[b.id,b])),[natural,scene]);
  const handles:LinkHandle[]=[];
  const selectedNode=nodes.find(n=>n.id===selectedId);
  const selectedLine=selectedId&&lineDraw.find(l=>l.id===selectedId&&l.kind!=='relation');
  const edge=selectedId&&index.edgesById.get(selectedId);
  if(selectedNode&&!props.editorOpen&&manualSelection.size<=1){
    const fixed=selectedNode.at;
    handles.push({end:'create',owner:selectedNode.id,fixedId:selectedNode.id,fixed,at:{x:fixed.x,y:fixed.y-17}});
  }else if(selectedLine&&edge&&!edge.membershipFor&&!props.editorOpen&&manualSelection.size<=1){
    for(const end of ['source','target'] as const){
      const isSource=end==='source',id=isSource?edge.sourceNodeId:edge.targetNodeId;
      if(!scene.nodeIds.has(id))continue;
      const at=isSource?selectedLine.screen[0]:selectedLine.screen.at(-1)!;
      const fixed=isSource?selectedLine.screen.at(-1)!:selectedLine.screen[0];
      handles.push({end,owner:edge.edgeId,fixedId:isSource?edge.targetNodeId:edge.sourceNodeId,fixed,at});
    }
  }
  const pointer=useSpatialPointer({
    ...props, surface:svg, handles, blocks, moveBlocks:mode==='layered',
    onBeginMove:(block,pointerId,client)=>{
      const started=props.onBeginMove(block,pointerId,client);
      if(started)setManual(ref.current);
      return started;
    },
    projection:{...projection,onPlane:(p,h)=>projection.onPlane({x:p.x-left,y:p.y-top},h)},
    heightOf:id=>spatialAnchor(world,id)?.z??0,
    menuRegionAt:(point)=>{
      let best:RenderBlock|undefined,nearest=-Infinity;
      if(mode==='sphere'){
        const hits=new Map<string,number>(),containers=new Set<string>();
        for(const g of groups){
          if(g.occluded&&!focusIds.has(g.id)||!blocks.has(g.id))continue;
          const center=project(g.center);
          const dx=(point.x-center.x)/camera.zoom,dy=(point.y-center.y)/camera.zoom;
          const chord=g.radius*g.radius-dx*dx-dy*dy;
          if(chord<0)continue;
          hits.set(g.id,center.depth+Math.sqrt(chord));
          if(g.parent)containers.add(g.parent);
        }
        // Enter nested shells, then choose the front surface among the remaining branches.
        for(const [id,front] of hits)if(!containers.has(id)&&front>nearest){best=blocks.get(id);nearest=front;}
        return best;
      }
      for(const g of groups){
        const block=blocks.get(g.id);
        if(!block||best&&block.depth<best.depth)continue;
        const center=project(g.center);
        const p=projection.onPlane({x:point.x-left,y:point.y-top},g.center.z);
        if(Math.abs(p.x-g.center.x)>g.halfWidth||Math.abs(p.y-g.center.y)>g.halfHeight)continue;
        if(!best||block.depth>best.depth||center.depth>nearest){best=block;nearest=center.depth;}
      }
      return best;
    },
    onMenu:(client,p,id,region)=>props.onContextMenu?.(id??region?.id??null,client,mode==='layered'?p:undefined,region),
    onHoverObject:(id,e)=>{
      if(id){
        clearTimeout(hoverTimer.current);hoverTimer.current=undefined;
        if(id!==hitHover?.id){
          const rect=e.currentTarget.getBoundingClientRect();
          setHitHover({id,at:{x:e.clientX-rect.left,y:e.clientY-rect.top}});
        }
      }else if(hitHover&&!hoverTimer.current)hoverTimer.current=setTimeout(()=>{hoverTimer.current=undefined;setHitHover(null);},140);
      props.onHoverObject?.(id,e);
    },onHoverEdge:()=>{},onLeaveObject:leaveHover,
    pan:(dx,dy)=>setManual(cam=>panSpatialCamera(cam??fit,dx,dy)),
    orbit:(dx,dy,id)=>{const p=anchors(id??selectedId);setManual(cam=>orbitSpatialCamera(cam??fit,dx,dy,p&&asCameraPoint(p)));},
    pinch:(center,ratio,dx,dy)=>setManual(cam=>panSpatialCamera(zoomSpatialCamera(cam??fit,ratio,
      {x:center.x-left,y:center.y-top},{width,height}),dx,dy))
  });
  const activePointer=useRef(pointer);activePointer.current=pointer;
  useEffect(()=>{
    const cancel=()=>{if(activePointer.current.contacts.current.size)activePointer.current.cancel();};
    window.addEventListener('blur',cancel);return ()=>{window.removeEventListener('blur',cancel);cancel();};
  },[]);
  useEffect(()=>{
    const el=svg.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{
      const content=e.target instanceof Element?e.target.closest('.spatial-hover-copy'):null;
      if(content&&content.scrollHeight>content.clientHeight)return;
      e.preventDefault();const rect=el.getBoundingClientRect();
      setManual(zoomSpatialCamera(ref.current,Math.exp(-Math.max(-300,Math.min(300,e.deltaY))*.002),
        {x:e.clientX-rect.left-left,y:e.clientY-rect.top-top},{width,height}));};
    el.addEventListener('wheel',wheel,{passive:false});return ()=>el.removeEventListener('wheel',wheel);
  },[width,height,left]);
  const reconnecting=pointer.link&&selectedLine?selectedLine.id:null;
  const statusColor=(id:string)=>id===reconnecting?palette.drag:props.aiTargets?.has(id)?palette.ai:
    id===hovered?palette.active:undefined;
  const batches=mode==='sphere'&&pointer.dragging&&lineDraw.length>=128
    ?batchOrbitInk(lineDraw,pathIds,id=>{
      const ink=linePaint.get(id)!;
      return !statusColor(id)&&!neighbors.edges.has(id)&&ink.source===ink.target?ink.source:undefined;
    }):null;
  const visible=(p:Point)=>p.x>-80&&p.y>-30&&p.x<size.width+80&&p.y<size.height+30;
  // Screen text obeys a fixed pixel budget independent of the world scale.
  const rows=new Map<number,Rect[]>();
  const labelObstacles=scene.relations.length||props.endpointPaths?.size?new RectangleIndex([...(props.occlusions??[])],128):null;
  function reserve(box:Rect,check=false){
    const start=Math.floor(box.y/24),end=Math.floor((box.y+box.height)/24);
    for(let i=start;check&&i<=end;i++){
      if(rows.get(i)?.some(b=>b.x+b.width>=box.x&&box.x+box.width>=b.x&&b.y+b.height>=box.y&&box.y+box.height>=b.y))return false;
    }
    for(let i=start;i<=end;i++){let row=rows.get(i);if(!row)rows.set(i,row=[]);row.push(box);}
    labelObstacles?.add(box);
    return true;
  }
  // Reserve each dot before assigning text. A neighboring label must not
  // paint or intercept the pointer on top of a real geometric endpoint.
  const readableNode=(n:typeof nodes[number])=>!n.occluded||n.labelPriority===3;
  for(const n of nodes)if(visible(n.at)&&readableNode(n))reserve({x:n.at.x-5,y:n.at.y-5,width:10,height:10});
  const labels=new Map<string,{left:boolean;fallback?:boolean}>();
  for(const n of [...nodes].sort((a,b)=>Number(b.id===hovered)-Number(a.id===hovered)||b.labelPriority-a.labelPriority||a.id.localeCompare(b.id))){
    if(!visible(n.at)||!readableNode(n))continue;
    const w=Math.min(18,n.name.length)*13;
    const rightBox={x:n.at.x+7,y:n.at.y-12,width:w,height:18};
    if(reserve(rightBox,true))labels.set(n.id,{left:false});
    else if(reserve({...rightBox,x:n.at.x-7-w},true))labels.set(n.id,{left:true});
    else if(focusIds.has(n.id)||n.id===hovered){
      labels.set(n.id,{left:false,fallback:true});
    }
  }
  const shellTitles=new Map<string,Point>();
  if(captions){
    // All node anchors are final. These ink bounds affect only shell titles,
    // including where they must clear labels forced into view by selection.
    for(const n of nodes){
      const label=labels.get(n.id);
      if(!label)continue;
      const ink=captions.node(nodeCaption(n.name));
      const anchor=n.at.x+(label.left?-7:7), start=label.left?anchor-ink.advance:anchor;
      reserve({x:start+ink.left,y:n.at.y+4+ink.top,width:ink.right-ink.left,height:ink.bottom-ink.top});
    }
    const frame={x:left,y:top,width,height};
    const ordered=selected.size?[...groups].sort((a,b)=>Number(selected.has(b.id))-Number(selected.has(a.id))):groups;
    for(const g of ordered){
      if(g.occluded&&!focusIds.has(g.id))continue;
      const label=placeShellTitle(project(g.center),g.radius*camera.zoom,captions.group(groupCaption(g.name)),frame,box=>reserve(box,true));
      if(label)shellTitles.set(g.id,label);
    }
  }
  const frame={x:left,y:top,width,height};
  const relationLines=scene.relations.length?lineDraw.filter(l=>l.kind==='relation').sort((a,b)=>a.id.localeCompare(b.id)):[];
  for(const line of relationLines){
    for(const p of [line.screen[0],line.screen.at(-1)!])labelObstacles!.add({x:p.x-4,y:p.y-4,width:8,height:8});
  }
  const relationCounts=relationLines.flatMap(line=>{
    const width=Math.max(20,String(line.count).length*7+10);
    const xs=line.screen.map(p=>p.x),ys=line.screen.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
    const masks=labelObstacles!.query({x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y},width);
    // Keep the expand button on an exposed stretch of the trunk as the camera turns.
    const spans=line.runs.filter(run=>!run.occluded);
    let position;
    for(const obstacles of [masks,props.occlusions??[]]){
      for(const span of spans){
        position=polylineLabel(span.points,frame,obstacles,width,16);
        if(position)break;
      }
      if(position)break;
    }
    if(!position)return [];
    labelObstacles!.add(relationLabelBounds(position,width,16));
    return [{id:line.id,count:line.count,width,position}];
  });
  const previewNode=hitHover&&blocks.get(hitHover.id),previewEdge=hitHover&&index.edgesById.get(hitHover.id);
  const previewPair=hitHover&&index.relations.get(hitHover.id);
  const previewTitle=previewNode?.kind==='node'?previewNode.name:previewEdge?
    [world.nodes.get(previewEdge.sourceNodeId)?.name??world.groups.get(previewEdge.sourceNodeId)?.name??previewEdge.sourceNodeId,
      previewEdge.directed?' → ':' — ',world.nodes.get(previewEdge.targetNodeId)?.name??world.groups.get(previewEdge.targetNodeId)?.name??previewEdge.targetNodeId].join(''):
    previewPair?lineById.get(previewPair.id)?.name:undefined;
  const previewContent=previewNode?.kind==='node'?previewNode.content:previewEdge?.edgeContent;
  const previewWidth=Math.min(width,260);
  const previewPos=hitHover&&{left:Math.max(left,hitHover.at.x+previewWidth+10<left+width?hitHover.at.x+10:hitHover.at.x-previewWidth-10),
    top:Math.max(top,hitHover.at.y+115<top+height?hitHover.at.y+12:hitHover.at.y-114)};
  return <><svg ref={svg} className={'granular-spatial '+(props.lightGrid?'light':'dark')} tabIndex={0} role="application"
    style={{'--active':palette.active} as CSSProperties}
    aria-label={mode==='sphere'?'球体嵌套三维图谱':'多层平面三维图谱'} data-granular-view={mode} data-spatial-scene
    data-spatial-yaw={camera.yaw} data-spatial-pitch={camera.pitch} data-spatial-zoom={camera.zoom}
    data-spatial-target={[camera.target.x,camera.target.y,camera.target.z].join(',')}
    data-routed-originals={scene.edges.length} data-coarse-relations={scene.relations.length}
    onPointerOver={matchPortHighlight} onPointerOut={matchPortHighlight}
    onFocus={matchPortHighlight} onBlur={matchPortHighlight}
    onPointerDownCapture={cancelMotion} onPointerDown={e=>{
      if(e.button===0 && (e.ctrlKey||e.metaKey) && e.target instanceof Element &&
        index.groupIds.has(objectId(e.target)??'') && !e.target.matches('.group-pick')) return;
      pointer.down(e);
    }} onPointerMove={pointer.move}
    onPointerUp={e=>pointer.release(e,false)} onPointerCancel={e=>pointer.release(e,true)}
    onLostPointerCapture={e=>pointer.release(e,true)} onPointerLeave={leaveHover}
    onClick={e=>{if(e.detail===0)props.onSelect(objectId(e.target),e.ctrlKey||e.metaKey,{x:e.clientX,y:e.clientY},e.altKey);}}
    onDoubleClick={e=>{const id=objectId(document.elementFromPoint(e.clientX,e.clientY));if(!id){setManual(fit);return;}if(index.groupIds.has(id)||index.relations.has(id))props.onToggle(id);
      else props.onSelect(id,false,{x:e.clientX,y:e.clientY},true);}}
    onContextMenu={pointer.contextMenu}
    onKeyDown={e=>{
      if(e.defaultPrevented||e.nativeEvent.isComposing)return;
      const id=objectId(e.target);
      if(id&&e.key==='Enter'){e.preventDefault();props.onSelect(id,e.ctrlKey||e.metaKey);return;}
      if(e.ctrlKey||e.altKey||e.metaKey)return;
      if(pointer.contacts.current.size){
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();pointer.cancel();}
        return;
      }
      const delta=({ArrowLeft:[-32,0],ArrowRight:[32,0],ArrowUp:[0,-32],ArrowDown:[0,32]} as Record<string,number[]>)[e.key];
      if(delta){
        const p=anchors(selectedId);
        setManual(e.shiftKey?panSpatialCamera(ref.current,delta[0],delta[1])
          :orbitSpatialCamera(ref.current,delta[0],delta[1],p&&asCameraPoint(p)));
      }else if(e.key==='+'||e.key==='='||e.key==='-')setManual(zoomSpatialCamera(ref.current,e.key==='-'?1/1.2:1.2));
      else if(e.key==='Home')setManual(fit);
      else if(e.key==='Escape'){restoreStep();setTrace(null);props.onSelect(null);}
      else return;
      e.preventDefault();e.stopPropagation();
    }}>
    {groups.map(g=>{
      const at=project(g.center),ring=mode==='sphere',radius=g.radius*camera.zoom,poly=ring?[]:corners(g).map(project);
      const tip=ring?undefined:poly.reduce((a,b)=>a.y<b.y?a:b);
      const label=tip?(visible(tip)?{x:tip.x+4,y:tip.y+2}:undefined):shellTitles.get(g.id);
      const on=selected.has(g.id);
      return <g key={g.id} data-space-object={g.id} data-spatial-group={g.id} data-spatial-block={g.id} data-spatial-level={g.depth}
        data-world={`${g.center.x},${g.center.y},${g.center.z}`}
        data-occluded={g.occluded||undefined} data-covered={g.occluded&&!focusIds.has(g.id)||undefined}
        data-neighbor-focus={props.neighborhoodFocus===g.id||undefined} data-selected={on} data-related={neighbors.groups.has(g.id)||undefined} data-collapsed={scene.collapsedGroupIds.has(g.id)||undefined}
        role="button" tabIndex={0} aria-label={g.name+' · 第 '+g.depth+' 层'} className="granular-group"
        style={{'--group-color':groupPaint.get(g.id)} as CSSProperties}>
        <title>{g.name}</title>
        {ring?<><circle className="group-pick" cx={at.x} cy={at.y} r={radius}/><circle className="group-face" cx={at.x} cy={at.y} r={radius}/>
          <ellipse className="group-equator" cx={at.x} cy={at.y} rx={radius} ry={radius*Math.sin(camera.pitch)}/></>:
          <><polygon className="group-pick" points={poly.map(p=>p.x+','+p.y).join(' ')}/>
            <polygon className="group-face" points={poly.map(p=>p.x+','+p.y).join(' ')}/></>}
        {label&&<text className="group-name" x={label.x} y={label.y}>{groupCaption(g.name)}</text>}
      </g>;
    })}
    {hitHover&&previewPos&&previewTitle&&!pointer.dragging&&<foreignObject data-space-object={hitHover.id} data-spatial-hover-label={hitHover.id}
      x={previewPos.left} y={previewPos.top} width={previewWidth} height="102" pointerEvents="none">
      <div className="spatial-hover-copy"><strong>{previewTitle}</strong>{previewContent&&<span>{previewContent}</span>}</div>
    </foreignObject>}
    {nodes.filter(n=>labels.get(n.id)?.fallback).map(n=><text key={n.id} data-space-object={n.id} aria-hidden="true"
      opacity="0" x={n.at.x+7} y={n.at.y+4}>{nodeCaption(n.name)}</text>)}
    {batches&&<g className="granular-line" pointerEvents="none" aria-hidden="true" data-orbit-batches={batches.styles.length}>
      {batches.styles.map(batch=><path key={batch.key} className="line-ink" data-occluded={batch.occluded||undefined} d={batch.paths.join('')}
        style={{stroke:batch.stroke,strokeWidth:batch.width,strokeOpacity:batch.alpha}}/>)}
    </g>}
    {mode==='layered'&&lineDraw.map(line=>line.branches?.map(branch=>{
      if(!branch.ink)return null;
      const ids=branch.memberEdgeIds,selectedObject=ids.length===1?ids[0]:line.id;
      const color=linePaint.get(line.id)![branch.side];
      const points=branch.screen.map(p=>p.x+','+p.y).join(' ');
      return <g key={JSON.stringify([line.id,branch.nodeId])} className="granular-line relation-branch"
        data-relation-branch={line.id} data-branch-node={branch.nodeId} data-branch-side={branch.side}
        data-branch-members={branch.membersJson} data-member-count={ids.length} data-directed={line.directed}
        data-space-object={selectedObject} data-ink-role="branch" data-highlighted={branch.highlighted||neighbors.nodes.has(branch.nodeId)}
        style={{'--line-target':color} as CSSProperties}
        aria-label={branch.description} role="button" tabIndex={0}>
        <title>{branch.description}</title><polyline className="line-hit" points={points}/><polyline className="line-ink" points={points}
          style={{strokeWidth:Math.min(branch.ink.width,branch.highlighted?1.6:1.1),strokeOpacity:branch.ink.alpha}}/>
      </g>;
    }))}
    {lineDraw.map(l=>{
      const arrowLine=l.deckRoute?.trunk??l.screen;
      const mid=Math.max(1,Math.floor(arrowLine.length/2)),a=arrowLine[mid-1],b=arrowLine[mid];
      if(!a||!b)return null;
      const at={x:(a.x+b.x)/2,y:(a.y+b.y)/2},angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
      const onPath=pathIds.has(l.id);
      const ink=linePaint.get(l.id)!;
      const from=l.screen[0],to=l.screen.at(-1)!;
      const gradient=ink.source!==ink.target&&(from.x!==to.x||from.y!==to.y)&&l.kind!=='outside';
      const target=l.kind==='outside'?palette.outside:ink.target;
      const runs=onPath?[{points:l.screen,alpha:1,width:l.id===activeStep?3.6:2.6,dashed:false,occluded:false}]:l.runs;
      const hitPath=runs.some(r=>r.occluded)?runs.filter(r=>!r.occluded).map(r=>svgPath(r.points)).join(' '):svgPath(l.screen);
      return <g key={l.id} data-space-object={l.id} data-granular-line={l.kind} data-member-count={l.count}
        data-port-line={l.deckRoute||l.kind==='relation'?l.id:undefined}
        data-semantic-relation={l.kind==='relation'?l.id:undefined} data-count={l.count} data-directed={l.directed}
        data-path-hop={onPath||undefined} data-path-step={l.id===activeStep||undefined}
        data-neighbor-focus={props.neighborhoodFocus===l.id||undefined} data-ink-role={l.role} data-selected={selected.has(l.id)} data-spatial-edge={l.kind==='relation'?undefined:l.id} aria-label={l.name} tabIndex={0} role="button"
        data-highlighted={l.highlighted} data-related={(l.kind==='relation'?neighbors.summaries:neighbors.edges).has(l.id)||undefined} className={'granular-line '+l.kind}
        style={{'--line-target':target,'--line-stroke':gradient?'url(#'+ink.gradientId+')':l.kind==='outside'?target:ink.source,
          '--state-color':l.kind==='relation'?undefined:statusColor(l.id)} as CSSProperties}>
        {gradient&&<linearGradient id={ink.gradientId} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
          <stop offset="0" stopColor={ink.source}/><stop offset="1" stopColor={ink.target}/>
        </linearGradient>}
        <title>{l.name}</title><path d={hitPath} className="line-hit"/>
        {l.deckRoute&&runs[0]?(['source','trunk','target'] as const).map(part=><polyline key={part}
          className="line-ink" data-original-section={part} points={l.deckRoute![part].map(p=>p.x+','+p.y).join(' ')}
          style={{strokeWidth:part==='trunk'?runs[0].width:Math.min(runs[0].width,1.6),strokeOpacity:runs[0].alpha}}/>):
        !batches?.ids.has(l.id)&&runs.map((r,i)=><path key={i} className="line-ink" data-occluded={r.occluded||undefined}
          d={runs.length===1&&!r.occluded?hitPath:svgPath(r.points)}
          style={{strokeWidth:l.kind==='relation'?`calc(${r.width}px + var(--relation-width-add, 0px))`:r.width,
            strokeOpacity:r.alpha,strokeDasharray:r.dashed?'4 5':l.kind==='outside'&&!selected.has(l.id)?'6 4':undefined}}/>)}
        {l.directed&&<path className="line-arrow" opacity={onPath?1:l.arrowAlpha} pointerEvents="none" d="M-4,-3 L4,0 L-4,3 Z" transform={`translate(${at.x} ${at.y}) rotate(${angle})`}/>}
        {l.kind==='outside'&&!l.arrowOccluded&&visible(at)&&<text className="relation-count" x={at.x+4} y={at.y-4}>画布外</text>}
      </g>;
    })}
    {lineDraw.map(l=>{
      const summary=l.kind==='relation';
      if(!summary&&!l.deckRoute)return null;
      const trunk=l.deckRoute?.trunk??l.screen,start=trunk[0],end=trunk[trunk.length-1];
      const ink=linePaint.get(l.id)!;
      return <g key={l.id} data-port-endpoints={l.id} data-relation-ports={summary?l.id:undefined} data-space-object={l.id}
        data-highlighted={l.highlighted} aria-hidden="true" className={'granular-line '+l.kind}
        pointerEvents={mode==='sphere'?'none':undefined} style={{'--state-color':summary?undefined:statusColor(l.id)} as CSSProperties}>
        <circle className="rim-socket" style={{'--port-color':ink.source} as CSSProperties} data-relation-port={summary?'source':undefined} data-original-port={summary?undefined:'source'}
          cx={start.x} cy={start.y} r={3.4} opacity={l.runs[0]?.alpha}/>
        <circle className="rim-socket" style={{'--port-color':ink.target} as CSSProperties} data-relation-port={summary?'target':undefined} data-original-port={summary?undefined:'target'}
          cx={end.x} cy={end.y} r={3.4} opacity={l.runs[l.runs.length-1]?.alpha}/>
      </g>;
    })}
    {nodes.filter(n=>visible(n.at)).map(n=><g key={n.id} data-space-object={n.id} data-spatial-block={n.id} data-granular-node={n.id} data-spatial-point={n.id}
      data-occluded={n.occluded||undefined} pointerEvents={readableNode(n)?undefined:'none'}
      data-neighbor-focus={props.neighborhoodFocus===n.id||undefined} data-world={`${n.p.x},${n.p.y},${n.p.z}`} data-selected={selected.has(n.id)} role="button" tabIndex={0} aria-label={n.name} className="granular-dot"
      data-connection-level={nodePaint.get(n.id)?.level} data-ai-highlighted={props.aiTargets?.has(n.id)||undefined} data-related={neighbors.nodes.has(n.id)||undefined}
      data-anchor-x={n.at.anchorX} data-anchor-y={n.at.anchorY} opacity={n.alpha}
      style={{'--node-color':nodePaint.get(n.id)?.accent,'--ai-color':palette.ai} as CSSProperties}>
      <title>{n.name}</title><circle cx={n.at.x} cy={n.at.y} r={selected.has(n.id)?6:4} fill="var(--node-color)"/>
      {props.neighborhoodFocus===n.id&&<circle aria-hidden="true" className="neighbor-focus-ring" cx={n.at.x} cy={n.at.y} r={10}/>}
      {labels.has(n.id)&&<text x={n.at.x+(labels.get(n.id)!.left?-7:7)} y={n.at.y+4}
        textAnchor={labels.get(n.id)!.left?'end':'start'} pointerEvents={labels.get(n.id)!.fallback?'none':undefined}>{nodeCaption(n.name)}</text>}
    </g>)}
    {props.endpointPaths?.size ? <EdgePathLabels paths={props.endpointPaths} frame={frame} light={props.lightGrid}
      lines={lineDraw.filter(l=>l.screen.length>1).map(l=>({id:l.id,source:l.screen[0],target:l.screen[l.screen.length-1],
        hideSource:!pathIds.has(l.id)&&l.runs[0]?.occluded,hideTarget:!pathIds.has(l.id)&&l.runs.at(-1)?.occluded}))}
      obstacles={labelObstacles!.rects} /> : null}
    {relationCounts.map(({id,count,width,position})=><g key={id} data-space-object={id} data-spatial-relation-expand={id}
      role="button" tabIndex={0} aria-label={'展开 '+count+' 条关系'} className="spatial-count-button"
      style={{color:linePaint.get(id)?.target}} transform={`translate(${position.x} ${position.y}) rotate(${position.angle})`}
      onPointerDown={e=>{if(e.button===0)e.stopPropagation();}} onClick={e=>{e.stopPropagation();(props.onExpandRelation??props.onToggle)(id);}}
      onDoubleClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();(props.onExpandRelation??props.onToggle)(id);}}}>
      <rect x={-width/2} y={-8} width={width} height="16" rx="5"/><text className="relation-count" textAnchor="middle" dominantBaseline="central">{count}</text>
    </g>)}
    {pointer.link&&<line data-spatial-link-preview x1={pointer.link.from.x} y1={pointer.link.from.y}
      x2={pointer.link.to.x} y2={pointer.link.to.y} pointerEvents="none"
      stroke={pointer.link.snapped?palette.drag:palette.high} strokeWidth="2" strokeDasharray="5 3"/>}
    {!pointer.link&&handles.map(h=><circle key={h.end} data-spatial-handle={h.end} cx={h.at.x} cy={h.at.y} r={5}
      className="granular-link-handle"><title>{h.end==='create'?'拖到另一知识节点创建关系':h.end==='source'?'拖动更换起点':'拖动更换终点'}</title></circle>)}
  </svg>
    {from&&to&&<div className={'granular-path-layer'+(props.lightGrid?' light':'')} style={{left,top,width,height}}>
      <SpatialPathPanel start={from} end={to} current={activeStep} steps={path}
        nameOf={id=>world.nodes.get(id)?.name??id}
        onStart={()=>setTrace({pairKey,reversed:false,step:null})}
        onSwap={()=>{restoreStep();setTrace({pairKey,reversed:!trace?.reversed,step:null});}}
        onFocus={id=>{
          const p=anchors(id);if(!p||!pathIds.has(id))return;
          beforeStep.current??=ref.current;
          setManual({...ref.current,target:asCameraPoint(p)});
          setTrace(t=>t&&{...t,step:id});
        }}
        onClose={()=>{restoreStep();setTrace(null);svg.current?.focus({preventScroll:true});}}/>
    </div>}
  </>;
}
