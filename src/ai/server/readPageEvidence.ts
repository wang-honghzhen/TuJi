import { createHash } from 'node:crypto';
import type { AppSnapshot, ToolCallRecord } from '../domain';
import type { FrozenRead } from '../contextState';

type Row=Record<string,any>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const key=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ReadPageOrigin {
  pointerId:string;page:number;totalPages:number;kind:string;payloadHash:string;
  sourcesHash?:string;
  noteBinding?:FrozenRead['noteBinding'];
}
/** Provenance outlives cursor storage; only successful, actually returned pages are stamped. */
export function rememberPageOrigin(call:ToolCallRecord,read:FrozenRead,page:number):void {
  const origin:ReadPageOrigin={pointerId:read.id,page,totalPages:read.pages.length,kind:read.kind,
    payloadHash:key(read.pages[page-1]),sourcesHash:key(read.pageSources?.[page-1]??[]),...(read.noteBinding?{noteBinding:{...read.noteBinding}}:{})};
  call.readPageOrigins=[...new Map([...(call.readPageOrigins??[]),origin].map(o=>[`${o.pointerId}:${o.page}`,o])).values()];
}
export function returnedReadPages(call:ToolCallRecord):Row[]{
  const pages:Row[]=[];
  const visit=(r:unknown)=>{if(!row(r))return;
    if(['ok','partial'].includes(r.status)&&r.data!==undefined&&typeof r.pointerId==='string'&&Number.isInteger(r.page))pages.push(r);
    if(Array.isArray(r.results))r.results.forEach(visit);
  };
  try{visit(JSON.parse(call.result??'{}'));}catch{/* Unparseable bodies cannot supply evidence. */}
  return pages;
}
export function pageOrigin(state:AppSnapshot,call:ToolCallRecord,result:Row,visited=new Set<string>()):ReadPageOrigin|undefined {
  if(visited.has(call.id))return;visited.add(call.id);
  const saved=call.readPageOrigins?.find(o=>o.pointerId===result.pointerId&&o.page===result.page);
  if(saved)return saved.payloadHash===key(result.data)&&saved.totalPages===result.totalPages?saved:undefined;
  const read=state.workspaces.flatMap(w=>w.frozenReads??[]).find(r=>r.id===result.pointerId);
  if(read&&read.pages[result.page-1]&&key(read.pages[result.page-1])===key(result.data))return {
    pointerId:read.id,page:result.page,totalPages:read.pages.length,kind:read.kind,payloadHash:key(result.data),noteBinding:read.noteBinding};
  // Identity comes from returned rows, never from citations to other domains.
  const items=Array.isArray(result.data?.items)?result.data.items:[];
  const kind=items.length&&items.every((v:unknown)=>row(v)&&typeof v.noteId==='string')?'note'
    :items.length&&items.every((v:unknown)=>row(v)&&typeof v.artifactId==='string')?'artifact'
    :items.length&&items.every((v:unknown)=>row(v)&&typeof v.recordId==='string')?'history'
    :call.summaryOrigins?.some(o=>o.pointerId===result.pointerId)?'summary_tree'
    :call.canvasOrigins?.some(o=>o.pointerId===result.pointerId)||call.name.startsWith('graph_')?'graph_unknown':undefined;
  if(kind)return {pointerId:result.pointerId,page:result.page,totalPages:result.totalPages,kind,payloadHash:key(result.data)};
  // Pre-metadata cursors can still identify their domain through the original successful call.
  const source=call.frozenSourceCallId&&[...state.toolCalls,...state.snapshots.flatMap(s=>s.toolCalls??[])].find(c=>c.id===call.frozenSourceCallId);
  if(source)for(const first of returnedReadPages(source))if(first.pointerId===result.pointerId){
    const origin=pageOrigin(state,source,first,visited);
    if(origin)return {...origin,page:result.page,payloadHash:key(result.data),totalPages:result.totalPages};
  }
  if(call.name==='web_search'||call.name==='web_fetch')return {pointerId:result.pointerId,page:result.page,totalPages:result.totalPages,kind:call.name,payloadHash:key(result.data)};
}
/** Unknown legacy pages stay conservative; positively identified non-canvas pages are excluded. */
export function mayHaveCanvasPage(state:AppSnapshot,call:ToolCallRecord):boolean {
  const pages=returnedReadPages(call);
  return !pages.length||pages.some(p=>{const origin=pageOrigin(state,call,p);return !origin||origin.kind.startsWith('graph_');});
}
