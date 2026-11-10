import { createHash } from 'node:crypto';
import type { AppSnapshot, ToolCallRecord } from '../domain';
import type { ReadPageRef, RetentionState } from '../contextState';
import { isDataRead } from './toolContextKinds';
import { reviewedCallResult } from '../changeReview';

export const RETENTION_POLICY_VERSION = 1;
export const retentionHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const originResultId = (call: ToolCallRecord) => call.originResultId ?? call.id;
export function allRetainedCalls(state: AppSnapshot): ToolCallRecord[] {
  return [...new Map([...state.snapshots.flatMap(s => s.toolCalls ?? []), ...state.toolCalls].map(c => [originResultId(c), c])).values()];
}
export function isReceipted(state: AppSnapshot, call: ToolCallRecord | string): boolean {
  return !!state.contextRetention?.receipts[typeof call === 'string' ? call : originResultId(call)]
    || typeof call !== 'string' && resultFullyReceipted(call,p=>frozenPageRevoked(state,p.pointerId,p.page));
}
const record = (text: string | undefined): Record<string, unknown> => {
  try { const value = JSON.parse(text ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
/** Compact projection; immutable arguments and returned results stay in the task archive. */
export function permanentReadReceipt(call: ToolCallRecord): string {
  const value = record(call.result), args = record(call.arguments);
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {};
  const scope: Record<string, unknown> = {};
  for (const key of ['refId', 'scope', 'field', 'version', 'directoryVersion', 'directDataVersion', 'start', 'end']) {
    const item = data[key] ?? args[key];
    if (typeof item === 'string' || typeof item === 'number') scope[key] = typeof item === 'string' ? item.slice(0, 160) : item;
  }
  if (!Object.keys(scope).length && Array.isArray(args.refs)) scope.refs = args.refs.filter(x => typeof x === 'string').slice(0, 20);
  const error = value.message ?? value.error;
  return JSON.stringify({ function: call.name, callId: originResultId(call), status: value.status ?? call.status,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.executed === 'boolean' ? { executed: value.executed } : {}),
    ...(Object.keys(scope).length ? { readRange: scope } : {}),
    ...(typeof error === 'string' ? { error: error.slice(0, 240) } : {}), bodyOmitted: true, readWith: { tool: 'context_restore_records', arguments: { recordIds: [originResultId(call)] } } });
}
/** Old attachment-summary calls stay archived, but new prompt projections offer original-file readers. */
function retiredAttachmentSummary(state: AppSnapshot, call: ToolCallRecord): string | undefined {
  if(call.attachmentRead||!['context_read_children','context_read_summary_tree','context_read_pages','context_view'].includes(call.name))return;
  const archive=[...state.workspaces.flatMap(w=>w.summaries??[]),...state.snapshots.flatMap(s=>s.summaries??[])].filter(s=>s.semanticType==='artifact');
  if(!archive.length)return;
  const ids=new Set<string>(call.summaryOrigins?.flatMap(o=>o.roots)??[]);
  const visit=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value))if(key==='summaryId'&&typeof item==='string')ids.add(item);
      else if(!['content','text','serializedResult'].includes(key))visit(item);
  };
  visit(record(call.arguments));visit(record(call.result));
  const files=archive.filter(s=>ids.has(s.id));if(!files.length)return;
  const entries=[...new Map(files.map(s=>[`${s.artifactId}:${s.artifactVersion}`,{artifactId:s.artifactId,version:s.artifactVersion,
    readWith:{tool:'workspace_read_artifact',arguments:{artifactId:s.artifactId,version:s.artifactVersion}}}])).values()];
  return JSON.stringify({...JSON.parse(permanentReadReceipt(call)),attachmentSummaryRetired:true,
    instruction:'旧附件摘要已停用，请读取原文件；原调用仍保存在任务档案。',files:entries,
    readWith:{tool:'context_read_task_attachments',arguments:{taskId:call.taskId}}});
}
export function visibleCallResult(state: AppSnapshot, call: ToolCallRecord): string | undefined {
  if (isWriteReceipted(state, call)) return state.contextRetention!.writeReceipts![originResultId(call)].receipt;
  if(isReceipted(state,call))return state.contextRetention?.receipts[originResultId(call)]?.receipt??permanentReadReceipt(call);
  const retired=retiredAttachmentSummary(state,call);if(retired)return retired;
  const result=reviewedCallResult(state,call);if(!isDataRead(call.name))return result;
  const value=record(result);let changed=false;
  const project=(row:Record<string,unknown>):Record<string,unknown>=>{
    const page=returnedPage(row);
    if(page&&frozenPageRevoked(state,page.pointerId,page.page)){
      changed=true;return JSON.parse(permanentReadReceipt({...call,result:JSON.stringify(row)}));
    }
    if(Array.isArray(row.results))row.results=row.results.map(child=>child&&typeof child==='object'&&!Array.isArray(child)?project(child as Record<string,unknown>):child);
    return row;
  };
  project(value);return changed?JSON.stringify(value):result;
}
export function isWriteReceipted(state: AppSnapshot, call: ToolCallRecord): boolean {
  return call.name !== 'workspace_update_work_notes' && !!state.contextRetention?.writeReceipts?.[originResultId(call)];
}
/** Receipt projection never mutates executable arguments in the immutable call archive. */
export function visibleCallArguments(state: AppSnapshot, call: ToolCallRecord): string {
  if (!isWriteReceipted(state, call)) return call.arguments;
  const receipt = record(state.contextRetention!.writeReceipts![originResultId(call)].receipt);
  return JSON.stringify({ receipt: { callId: originResultId(call), status: receipt.status ?? call.status,
    bodyOmitted: true, readWith: { tool: 'context_restore_records', arguments: { recordIds: [originResultId(call)] } } } });
}
export function visibleCall(state: AppSnapshot, call: ToolCallRecord): ToolCallRecord {
  return { ...call, originResultId: originResultId(call), result: visibleCallResult(state, call),
    ...(isReceipted(state, call) || isWriteReceipted(state, call) ? { resultRepresentation:'receipt' as const } : {}) };
}
/** Successful returned pages only; capacity refusals do not acquire a page's identity. */
export function resultPages(call: ToolCallRecord): ReadPageRef[] {
  if(!isDataRead(call.name))return [];
  if(call.readPageRefs)return call.readPageRefs;
  const value=record(call.result),pages:ReadPageRef[]=[];
  const visit=(r:Record<string,unknown>)=>{
    if(['ok','partial'].includes(String(r.status))&&r.data!==undefined&&typeof r.pointerId==='string'&&Number.isInteger(r.page)&&Number(r.page)>0)
      pages.push({pointerId:r.pointerId,page:Number(r.page)});
    if(Array.isArray(r.results))for(const child of r.results)if(child&&typeof child==='object')visit(child as Record<string,unknown>);
  };visit(value);return pages;
}
function returnedPage(row:Record<string,unknown>):ReadPageRef|undefined {
  return ['ok','partial'].includes(String(row.status))&&row.data!==undefined&&typeof row.pointerId==='string'&&Number.isInteger(row.page)&&Number(row.page)>0
    ?{pointerId:row.pointerId,page:Number(row.page)}:undefined;
}
/** A shared page cannot hide independent payloads in a batched result. */
function resultFullyReceipted(call:ToolCallRecord,receipted:(p:ReadPageRef)=>boolean):boolean {
  if(!isDataRead(call.name))return false;
  const covered=(row:Record<string,unknown>):boolean=>{
    const page=returnedPage(row);if(page)return receipted(page);
    return Array.isArray(row.results)&&row.results.length>0&&row.results.every(child=>child&&typeof child==='object'&&!Array.isArray(child)&&covered(child as Record<string,unknown>));
  };
  return covered(record(call.result));
}
export function rememberReadPage(call:ToolCallRecord,pointerId:string,page:number,hashes?:Record<string,string>):void {
  call.readPageRefs=[...new Map([...(call.readPageRefs??[]),{pointerId,page}].map(p=>[JSON.stringify(p),p])).values()];
  if(hashes)call.resultReadHashes={...call.resultReadHashes,...hashes};
}
export function readReceiptEntry(call:ToolCallRecord):RetentionState['receipts'][string] {
  const pages=resultPages(call);
  return {receipt:permanentReadReceipt(call),taskId:call.taskId,stepId:call.stepId,...(pages.length?{...pages[0],pages}:{} )};
}
/** Pure same-page copies share retention; mixed returns project only the covered children. */
export function receiptFamily(state: AppSnapshot, ids: Iterable<string>): Set<string> {
  const result=new Set(ids),calls=allRetainedCalls(state).filter(c=>isDataRead(c.name));
  const known=new Set([...calls.map(originResultId),...Object.keys(state.contextRetention?.receipts??{})]);
  const pageKey=(p:ReadPageRef)=>JSON.stringify([p.pointerId,p.page]);
  const families=calls.filter(c=>!Array.isArray(record(c.result).results)).map(c=>[originResultId(c),...(c.readOriginIds??[]).filter(id=>known.has(id))]);
  let changed=true;
  while(changed){changed=false;for(const family of families){
    if(family.some(id=>result.has(id)))for(const id of family)if(!result.has(id)){result.add(id);changed=true;}}
    const pages=new Set<string>();
    for(const c of calls)if(result.has(originResultId(c)))for(const p of resultPages(c))pages.add(pageKey(p));
    for(const [id,r] of Object.entries(state.contextRetention?.receipts??{}))if(result.has(id))for(const p of r.pages??(r.pointerId&&r.page?[{pointerId:r.pointerId,page:r.page}]:[]))pages.add(pageKey(p));
    for(const c of calls)if(!result.has(originResultId(c))&&resultFullyReceipted(c,p=>pages.has(pageKey(p)))){result.add(originResultId(c));changed=true;}
  }
  return result;
}
/** A draft overlays visibility only on the private state passed by the builder. */
export function previewReceipts(state: AppSnapshot, ids: Iterable<string>): AppSnapshot {
  const receipts = { ...state.contextRetention?.receipts };
  const calls = new Map(allRetainedCalls(state).map(c => [originResultId(c), c]));
  for (const id of receiptFamily(state,ids)) { const call = calls.get(id); if (call && isDataRead(call.name) && !receipts[id])
    receipts[id] = readReceiptEntry(call); }
  return { ...state, contextRetention: { version: RETENTION_POLICY_VERSION, revision: state.contextRetention?.revision ?? 0,
    ...state.contextRetention, receipts } };
}
export function frozenReadRevoked(state: AppSnapshot, read: { callId: string; originResultIds?: string[] }): boolean {
  return [read.callId, ...(read.originResultIds ?? [])].some(id => isReceipted(state, id));
}
export function frozenPageRevoked(state: AppSnapshot, pointerId: string, page: number): boolean {
  return Object.values(state.contextRetention?.receipts??{}).some(r=>r.pointerId===pointerId&&r.page===page
    ||r.pages?.some(p=>p.pointerId===pointerId&&p.page===page));
}
