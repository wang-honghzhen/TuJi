import type { Observation } from '../contextState';
import type { CanvasReadDraft } from './canvasReadBuilder';
import { canvasFactCovered, factKey, type CanvasFact, type CanvasReadRequest, type Row } from './canvasReadEvidence';

function completeSnapshot(observations:Observation[]){
  const groups=new Map<string,{total:number;pages:Set<number>}>();
  for(const o of observations)if(o.canvasPage){const p=o.canvasPage,g=groups.get(p.pointerId)??{total:p.totalPages,pages:new Set<number>()};
    g.pages.add(p.page);groups.set(p.pointerId,g);}
  return [...groups.values()].some(g=>g.total>0&&g.pages.size===g.total&&[...g.pages].every(p=>p>=1&&p<=g.total));
}
function fullField(f:CanvasFact,facts:CanvasFact[]){
  return canvasFactCovered({...f,start:undefined,end:undefined},facts.filter(v=>v.version===f.version));
}
function hasWholeField(f:CanvasFact,facts:CanvasFact[]){
  return facts.some(prior=>factKey(prior)===factKey(f)&&fullField(prior,facts));
}
/** Map semantic scope, never an old page number, onto the new immutable snapshot. */
export function selectCanvasRefreshScope(request:CanvasReadRequest,prior:Observation[],draft:CanvasReadDraft):{results:Row[];observations:Observation[]}|undefined {
  if(!draft.result)return;
  if(draft.result.status==='unavailable')return {results:[draft.result],observations:[]};
  const read=draft.pages.find(p=>p.id===draft.result!.pointerId);
  if(!read?.pageObservations||read.pages.some((_,i)=>!read.pageObservations?.[i])||!prior.length||prior.some(o=>o.evidenceUnknown))return;
  const facts=prior.flatMap(o=>o.canvasFacts??[]);
  const field=request.tool==='graph_read_node_content'?String(request.arguments.field??'content'):request.tool==='graph_read_object_field'?String(request.arguments.field):undefined;
  const fieldFacts=field?facts.filter(f=>f.refId===request.arguments.refId&&f.field===field):[];
  const query=request.tool==='graph_search'||request.tool==='graph_search_node_content'||request.tool==='graph_read_design_references';
  const whole=field?fieldFacts.some(f=>fullField(f,fieldFacts))
    :completeSnapshot(prior)&&(query||facts.every(f=>hasWholeField(f,facts)));
  let selected:number[];
  if(whole)selected=read.pages.map((_,i)=>i);
  else {
    // Partial query results cannot be mapped across changed membership or ordering.
    if(prior.some(o=>o.querySignature&&read.pageObservations!.some(p=>p.querySignature!==o.querySignature)))return;
    const covers=(current:CanvasFact)=>{
      const old=facts.filter(f=>factKey(f)===factKey(current));
      return old.some(f=>fullField(f,old))||canvasFactCovered(current,old.filter(f=>f.version===current.version));
    };
    selected=read.pageObservations.flatMap((o,i)=>o.canvasFacts?.length&&o.canvasFacts.every(covers)?[i]:[]);
    const shown=selected.flatMap(i=>read.pageObservations![i].canvasFacts??[]);
    if(!selected.length||facts.some(f=>!draft.unavailable.includes(f.refId)&&(!hasWholeField(f,facts)
      &&!shown.some(s=>factKey(s)===factKey(f)&&s.version===f.version)||!canvasFactCovered(f,shown))))return;
  }
  const results=selected.map(i=>{
    const result:Row={...draft.result,data:read.pages[i],page:i+1,totalPages:read.pages.length,sources:read.pageSources?.[i]??[],
      hasMorePages:i+1<read.pages.length,isLastPage:i+1===read.pages.length};
    if(i+1<read.pages.length)result.nextCursor={pointerId:read.id,page:i+2};else delete result.nextCursor;
    return result;
  });
  return {results,observations:structuredClone(selected.map(i=>read.pageObservations![i]))};
}
