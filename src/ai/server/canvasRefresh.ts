import { randomUUID } from 'node:crypto';
import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { ContextStage, FrozenRead, Observation, PromptEntry } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { contextProtection } from './contextProtection';
import { staleReadResult, directoryReadResult } from './contextRetention';
import { allRetainedCalls, isReceipted, originResultId, receiptFamily } from './readVisibility';
import { visibleObservations, canvasObservationChanges } from './contextFreshness';
import { buildCanvasRead, type CanvasReadDraft } from './canvasReadBuilder';
import { canvasKey, canvasRefreshRequest, canvasReadTools, canvasResultHasBody, row, visibleCanvasCallIds, type CanvasReadRequest, type Row } from './canvasReadEvidence';
import { requestTokens } from './providers';
import { estimateTokens } from '../tokens';
import { requireValue } from './errors';
import { GRAPH_READ_LIMITS } from './graphReadLimits';
import { selectCanvasRefreshScope } from './canvasRefreshScope';

export interface CanvasRefreshMember {
  id:string;key:string;request:CanvasReadRequest;callIds:string[];order:number;generation:number;anchorId?:string;
  result:Row;results?:Row[];observations:Observation[];pageIds:string[];unavailable:string[];
}
export interface CanvasRefreshState {
  version:1;members:CanvasRefreshMember[];
  diagnostics:{tokens:number;refreshed:number;receipted:number;evicted:number;builds:number;elapsedMs:number;target:number;targetReached:boolean;reasons:string[];resourceFailure?:string;pureReceipts?:Record<string,string>};
}
export interface CanvasMaintenance {
  id:string;memo:Map<string,CanvasReadDraft>;evicted:Set<string>;evictionReasons:Map<string,string>;builds:number;
  graph?:AppSnapshot['graph'];revision?:number;graphHash?:string;
}
export const createCanvasMaintenance=():CanvasMaintenance=>({id:randomUUID(),memo:new Map(),evicted:new Set(),evictionReasons:new Map(),builds:0});
export const canvasMemberResults=(member:CanvasRefreshMember)=>member.results??[member.result];
export const canvasEntryId=(id:string)=>`canvas-refresh:${id}`;
export function canvasRefillTarget(state:AppSnapshot){const c=inputCapacity(state),reserve=Math.min(AUTO_CONTEXT.readTokens,c*AUTO_CONTEXT.recentShare)+Math.min(AUTO_CONTEXT.readTokens,c*.05);
  return Math.max(0,Math.min(Math.floor(c*.65),Math.floor(c*AUTO_CONTEXT.trigger-reserve)-1,Math.floor(c-reserve)));}
export function canvasMemberProtected(state:AppSnapshot,task:Task,member:CanvasRefreshMember):boolean {
  const hard=contextProtection(state,task).hardProtectedCalls;
  return member.callIds.some(id=>hard.has(id));
}
export function canvasMemberProof(member:CanvasRefreshMember){return canvasKey(member);}
function canvasContentProof(member:CanvasRefreshMember){return canvasKey([member.key,canvasMemberResults(member),member.pageIds,member.unavailable,
  member.observations.map(o=>[o.refs,o.sources,o.readHashes,o.canvasFacts,o.canvasPage])]);}
export function canvasRefreshEntry(member:CanvasRefreshMember):PromptEntry {
  return {id:canvasEntryId(member.id),category:'canvas',lifecycle:'region',coverage:[],originResultIds:member.callIds,
    messages:[{role:'user',content:JSON.stringify({canvas_refresh:{callIds:member.callIds,function:member.request.tool,
      versionState:'current_when_refreshed',pagination:member.results?'restored_visible_scope':'new_snapshot_start',unavailableRefs:member.unavailable,
      ...(member.results?{results:member.results}:{result:member.result})}})}]};
}
function sourceRequest(state:AppSnapshot,task:Task,call:ToolCallRecord):CanvasReadRequest|undefined {
  if(call.canvasOrigins?.length===1)return structuredClone(call.canvasOrigins[0].request);
  if(call.canvasOrigins?.length)return;
  let args:Row;try{args=JSON.parse(call.arguments);}catch{return;}
  if(!row(args))return;
  if(call.name==='context_read_pages')return structuredClone(state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads?.find(r=>r.id===args.pointerId)?.canvasOrigin);
  if(canvasReadTools.has(call.name))return {version:1,tool:call.name,arguments:args};
}
const resolvedProof=(state:AppSnapshot,request:CanvasReadRequest,graphHash=canvasKey(state.graph))=>canvasKey([request,state.graphRevision,graphHash]);
function stale(state:AppSnapshot,observations:Observation[]){return observations.some(o=>canvasObservationChanges(state,o).length>0);}
/** Capture sources before any receipt overlay. The caller selects and commits the whole candidate. */
export function prepareCanvasRefresh(state:AppSnapshot,task:Task,maintenance:CanvasMaintenance,encode:(id:string)=>string,
  collect=true,allowRecentReceipts=false){
  const started=Date.now(),workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,prior=workspace.contextStage;
  if(maintenance.graph!==state.graph||maintenance.revision!==state.graphRevision){maintenance.graph=state.graph;maintenance.revision=state.graphRevision;maintenance.graphHash=canvasKey(state.graph);}
  const calls=allRetainedCalls(state),byId=new Map(calls.map(c=>[originResultId(c),c]));
  const protection=contextProtection(state,task),visible=prior?visibleCanvasCallIds(prior):new Set<string>();
  const observations=prior?visibleObservations(prior,workspace.observations??[],task,calls,state):[];
  const old=prior?.canvasRefresh?.members??[],members:CanvasRefreshMember[]=[],drafts:FrozenRead[]=[],receipts=new Set<string>(),refreshed=new Set<string>();
  const reasons=new Set<string>(),resolved:Record<string,string>={},fallbacks:Record<string,string>={},rebuilt=new Set<string>(),recentReceipts=new Set<string>();
  const propose=(request:CanvasReadRequest,callIds:string[],order:number,scope:Observation[],anchorId?:string)=>{
    const fail=(reason:string)=>{reasons.add(reason);for(const id of callIds)fallbacks[id]=reason;return undefined;};
    if(request.tool==='graph_read_directory')return undefined;
    const key=canvasKey(canvasRefreshRequest(request)),cacheKey=canvasKey([key,maintenance.graphHash,inputCapacity(state)]);
    const id=canvasKey([key,state.graphRevision,maintenance.id]),source=callIds.map(id=>byId.get(id)).find(Boolean);
    if(!source)return fail('missing_source_record');
    let draft=maintenance.memo.get(cacheKey);
    if(draft?.references?.some(([id,alias])=>encode(id)!==alias))draft=undefined;
    if(!draft){draft=buildCanvasRead(state,task,source,request,id,encode);maintenance.memo.set(cacheKey,draft);maintenance.builds++;}
    if(!draft.result&&draft.reason==='source_unavailable'&&draft.unavailable.length)
      draft={...draft,result:{status:'unavailable',data:{unavailableRefs:draft.unavailable,contentState:'deleted_or_out_of_scope'}}};
    if(!draft.result)return fail(draft.reason??'refresh_unavailable');
    const selected=selectCanvasRefreshScope(request,scope,draft);
    if(!selected)return fail('visible_scope_unmapped');
    const primary=draft.pages.find(r=>r.id===draft.result!.pointerId);
    const memberId=primary?.callId.slice('canvas-view:'.length)??canvasKey([key,draft.result]);
    const member:CanvasRefreshMember={id:memberId,key,request,callIds:[...new Set(callIds)].sort(),order,generation:(prior?.generation??0)+1,
      anchorId,result:structuredClone(selected.results[0]),results:structuredClone(selected.results),observations:selected.observations,
      pageIds:draft.pages.map(p=>p.id),unavailable:draft.unavailable};
    for(const o of member.observations){delete o.callId;o.taskId=task.id;o.entryId=canvasEntryId(member.id);}
    if(maintenance.evicted.has(memberId))return fail(maintenance.evictionReasons.get(memberId)??'refill_capacity');
    for(const id of callIds){const c=byId.get(id),original=c&&sourceRequest(state,task,c);if(original)resolved[id]=resolvedProof(state,original,maintenance.graphHash);}
    rebuilt.add(memberId);
    const existing=members.find(m=>m.id===member.id);
    if(existing){existing.callIds=[...new Set([...existing.callIds,...member.callIds])].sort();
      existing.results=[...new Map([...canvasMemberResults(existing),...selected.results].map(r=>[`${r.pointerId}:${r.page}`,r])).values()].sort((a,b)=>Number(a.page)-Number(b.page));
      existing.result=existing.results[0];
      existing.observations=[...new Map([...existing.observations,...member.observations].map(o=>[canvasKey(o.canvasPage),o])).values()];
      if(order>existing.order){existing.order=order;existing.anchorId=anchorId;}}
    else {members.push(member);drafts.push(...draft.pages);}
    return member;
  };
  for(const member of old){
    const delivered=observations.filter(o=>o.entryId===canvasEntryId(member.id));
    const changed=stale(state,delivered.length?delivered:member.observations),protectedMember=canvasMemberProtected(state,task,member);
    if(maintenance.evicted.has(member.id)&&!protectedMember){const reason=maintenance.evictionReasons.get(member.id)??'capacity_pressure';
      reasons.add(reason);for(const id of member.callIds)fallbacks[id]=reason;}
    if(!changed||protectedMember){
      if(!maintenance.evicted.has(member.id)||protectedMember)members.push(structuredClone(member));
    }
    if(changed)propose(member.request,member.callIds,member.order,delivered.length?delivered:member.observations,member.anchorId);
  }
  const groups=new Map<string,{request:CanvasReadRequest;ids:Set<string>;order:number;anchorId?:string}>();
  if(collect)for(const call of calls){
    const id=originResultId(call);if(!visible.has(call.id)&&!visible.has(id)||isReceipted(state,call)||!canvasResultHasBody(call))continue;
    const request=sourceRequest(state,task,call);if(!request||!canvasReadTools.has(request.tool)||request.tool==='graph_read_directory')continue;
    const family=[...receiptFamily(state,[id])];
    // A graph page sharing a receipt family with a mixed or invisible return is not independently removable.
    const compatible=family.every(id=>isReceipted(state,id)||visible.has(id)&&!!byId.get(id)&&!!sourceRequest(state,task,byId.get(id)!));
    if(!compatible){reasons.add('mixed_or_invisible_copy');continue;}
    const anchor=prior?.entries.find(e=>e.readCallIds?.includes(call.id)||e.readCallIds?.includes(id));
    const order=call.firstDelivery?.sequence??call.sequence??Date.parse(call.createdAt);
    const key=canvasKey(canvasRefreshRequest(request)),group=groups.get(key)??{request,ids:new Set<string>(),order,anchorId:anchor?.id};
    family.forEach(id=>group.ids.add(id));if(order>group.order){group.order=order;group.anchorId=anchor?.id;}groups.set(key,group);
  }
  for(const group of groups.values()){
    const own=observations.filter(o=>o.callId&&group.ids.has(o.callId));
    if(!stale(state,own))continue;
    const family=[...receiptFamily(state,own.filter(o=>o.callId&&stale(state,[o])).map(o=>o.callId!))];
    const next=propose(group.request,family,group.order,own,group.anchorId),hard=family.some(id=>protection.hardProtectedCalls.has(id));
    if(hard){reasons.add('protected_old_version');continue;}
    const recent=family.some(id=>protection.protectedCalls.has(id));
    if(!next&&recent){
      if(!allowRecentReceipts){reasons.add('recent_refresh_unavailable');continue;}
      for(const id of family)recentReceipts.add(id);
    }
    for(const member of family)receipts.add(member);
    if(next)for(const member of family)refreshed.add(member);
  }
  const pages=[...new Map(drafts.map(p=>[p.id,p])).values()];
  const removedViews=new Set(old.filter(m=>!members.some(next=>next.id===m.id)).flatMap(m=>m.callIds));
  const pureReceipts=Object.fromEntries(Object.entries(fallbacks).filter(([id])=>(receipts.has(id)||removedViews.has(id))
    &&!members.some(m=>m.callIds.includes(id))));
  const result:CanvasRefreshState={version:1,members,diagnostics:{tokens:0,refreshed:new Set(members.filter(m=>rebuilt.has(m.id)).flatMap(m=>m.callIds)).size,
    receipted:[...receipts].filter(id=>!isReceipted(state,id)).length,evicted:maintenance.evicted.size,
    builds:maintenance.builds,elapsedMs:Date.now()-started,target:canvasRefillTarget(state),targetReached:false,reasons:[...reasons],pureReceipts}};
  return {refresh:result,drafts:pages,receiptIds:[...receipts],refreshedIds:[...refreshed],recentReceiptIds:[...recentReceipts],resolved,
    fallbacks:pureReceipts};
}
export function installCanvasRefresh(stage:ContextStage){
  const members=stage.canvasRefresh?.members??[];
  for(const member of [...members].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))){
    const entry=canvasRefreshEntry(member);if(stage.entries.some(e=>e.id===entry.id))continue;
    let anchor=stage.entries.findIndex(e=>e.id===member.anchorId);
    if(anchor<0)anchor=stage.entries.findIndex(e=>e.coverage.some(c=>member.callIds.includes(c.recordId)));
    const position=anchor<0?stage.entries.length:anchor+1;
    stage.entries.splice(position,0,entry);stage.eventIds.push(entry.id);
    (stage.baselineObservations??=[]).push(...structuredClone(member.observations));
  }
}
/** A resident view owns its immutable snapshot independently of the receipted tool stream. */
export function renewCanvasPages(state:AppSnapshot,task:Task,stage:ContextStage):boolean {
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,now=Date.now();let available=true;
  for(const id of new Set(stage.canvasRefresh?.members.flatMap(m=>m.pageIds)??[])){
    if(stage.frozenReadDrafts?.some(r=>r.id===id))continue;
    const page=workspace.frozenReads?.find(r=>r.id===id&&r.canvasView);
    if(!page){available=false;continue;}
    if(page.expiresAt<now+GRAPH_READ_LIMITS.ttlMs/4)(stage.frozenReadDrafts??=[]).push({...structuredClone(page),expiresAt:now+GRAPH_READ_LIMITS.ttlMs});
  }
  return available;
}
export function evictCanvasRefresh(state:AppSnapshot,task:Task,stage:ContextStage,maintenance:CanvasMaintenance,intent:'notice'|'capacity'|'ordinary',reason='capacity_pressure'){
  const oldIds=new Set(state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.canvasRefresh?.members.map(m=>m.id));
  const selected=stage.canvasRefresh?.members.filter(m=>!maintenance.evicted.has(m.id)&&!canvasMemberProtected(state,task,m)
    &&(intent==='capacity'||!oldIds.has(m.id))).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))[0];
  if(!selected)return false;maintenance.evicted.add(selected.id);maintenance.evictionReasons.set(selected.id,reason);return true;
}
export function canvasRefreshTokens(state:AppSnapshot,task:Task,stage:ContextStage){const provider={...state.provider,...task.modelSelection};
  return requestTokens(provider,{messages:stage.entries.filter(e=>e.id.startsWith('canvas-refresh:')).flatMap(e=>e.wireMessages??e.messages),tools:[]})-requestTokens(provider,{messages:[],tools:[]});}
/** Refreshed bodies share the existing ordinary read pool, never summary/directory quotas. */
export function canvasReadOverflow(state:AppSnapshot,task:Task,stage:ContextStage){
  const protectedCalls=contextProtection(state,task).protectedCalls,visible=visibleCanvasCallIds(stage);
  const raw=allRetainedCalls(state).filter(c=>visible.has(c.id)&&!protectedCalls.has(originResultId(c))).reduce((n,c)=>n+estimateTokens(c.result??''),0);
  const views=stage.canvasRefresh?.members.filter(m=>!canvasMemberProtected(state,task,m)).reduce((n,m)=>n+estimateTokens(JSON.stringify(canvasRefreshEntry(m).messages)),0)??0;
  return Math.max(0,raw+views-Math.min(65536,Math.floor(inputCapacity(state)*.15)));
}
export function validateCanvasRefresh(state:AppSnapshot,task:Task,stage:ContextStage){
  const prior=state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.canvasRefresh?.members??[],members=stage.canvasRefresh?.members??[];
  for(const member of prior)if(canvasMemberProtected(state,task,member))requireValue(members.some(m=>m.id===member.id&&canvasContentProof(m)===canvasContentProof(member)),
    '受保护的画布视图版本或范围不可替换','PROTECTED_READ');
  if(!stage.retentionDraft)return;
  const draft=stage.retentionDraft,workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const calls=allRetainedCalls(state),byId=new Map(calls.map(c=>[originResultId(c),c]));
  const visible=workspace.contextStage?visibleCanvasCallIds(workspace.contextStage):new Set<string>();
  const observations=workspace.contextStage?visibleObservations(workspace.contextStage,workspace.observations??[],task,calls,state):[];
  for(const id of draft.canvasReceiptIds??[]){
    if(isReceipted(state,id))continue;
    const call=byId.get(id),own=observations.filter(o=>o.callId===id);
    const family=receiptFamily(state,[id]);
    requireValue(!!call&&visible.has(id)&&!!sourceRequest(state,task,call)
      &&(stale(state,own)||[...family].some(other=>stale(state,observations.filter(o=>o.callId===other)))),
      '画布回执缺少仍可见的过期来源','STALE_CONTEXT_PLAN');
  }
  const graphHash=canvasKey(state.graph);
  for(const id of draft.canvasRefreshedIds??[]){const c=byId.get(id),request=c&&sourceRequest(state,task,c);
    requireValue(request&&draft.canvasRefreshProofs?.[id]===resolvedProof(state,request,graphHash)&&members.some(m=>m.callIds.includes(id)),
      '近期读取的当前版本没有实际进入提示词，不能提前回执','PROTECTED_READ');}
  for(const id of draft.canvasReceiptIds??[])if(!isReceipted(state,id)&&!draft.canvasRefreshedIds?.includes(id))
    requireValue(!!draft.canvasReceiptFallbacks?.[id],'纯回执缺少范围或容量失败原因','STALE_CONTEXT_PLAN');
  for(const id of draft.canvasRecentReceiptIds??[])requireValue((draft.maintenanceIntent==='notice'||draft.noticeRefill)
    &&draft.canvasReceiptIds?.includes(id)&&!!draft.canvasReceiptFallbacks?.[id]&&!draft.canvasRefreshedIds?.includes(id),
    '近期纯回执必须属于通知维护且不能冒充成功刷新','STALE_CONTEXT_PLAN');
  if(draft.maintenanceIntent==='notice')for(const id of draft.receiptIds)requireValue(isReceipted(state,id)
    ||draft.canvasReceiptIds?.includes(id)||draft.relocatedReceiptIds?.includes(id)
    ||!!byId.get(id)&&(staleReadResult(state,task,byId.get(id)!)||directoryReadResult(byId.get(id)!))
    ||draft.summaryRegionMaintenance&&draft.relaxedReceiptIds?.includes(id),
    '通知维护不能清除无关有效正文','STALE_CONTEXT_PLAN');
  for(const member of members){
    requireValue(stage.retentionDraft.canvasProofs?.[member.id]===canvasMemberProof(member),'画布刷新承接内容已变化','STALE_CONTEXT_PLAN');
    const entry=canvasRefreshEntry(member);requireValue(stage.entries.some(e=>e.id===entry.id&&canvasKey(e.messages)===canvasKey(entry.messages)),
      '画布刷新内容没有完整进入候选提示词','STALE_CONTEXT_PLAN');
    for(const id of member.pageIds){const page=stage.frozenReadDrafts?.find(r=>r.id===id)??state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads?.find(r=>r.id===id);
      requireValue(page?.canvasView&&page.expiresAt>Date.now(),'画布刷新分页已失效','STALE_CONTEXT_PLAN');
      if(stage.retentionDraft.canvasPageProofs?.[id])requireValue(stage.retentionDraft.canvasPageProofs[id]===canvasKey(page),'画布刷新分页内容已变化','STALE_CONTEXT_PLAN');}
    const results=canvasMemberResults(member),shown=results.filter(r=>typeof r.pointerId==='string');
    requireValue(results.length>0&&canvasKey(results[0])===canvasKey(member.result)&&member.observations.length===shown.length
      &&new Set(shown.map(r=>`${r.pointerId}:${r.page}`)).size===shown.length,'画布刷新显示页与读取依据不一致','STALE_CONTEXT_PLAN');
    for(const result of shown){
      const page=stage.frozenReadDrafts?.find(r=>r.id===result.pointerId)??workspace.frozenReads?.find(r=>r.id===result.pointerId),number=Number(result.page);
      requireValue(page&&Number.isInteger(number)&&number>=1&&number<=page.pages.length&&result.totalPages===page.pages.length
        &&result.hasMorePages===(number<page.pages.length)&&canvasKey(page.pages[number-1])===canvasKey(result.data),
        '画布刷新显示页与冻结内容不一致','STALE_CONTEXT_PLAN');
      if(number<page.pages.length)requireValue(row(result.nextCursor)&&result.nextCursor.pointerId===page.id&&result.nextCursor.page===number+1,
        '画布刷新没有提供正确的独立续读入口','STALE_CONTEXT_PLAN');
      const evidence=(o:Observation)=>[o.refs,o.sources,o.readHashes,o.canvasFacts,o.canvasPage];
      const observation=member.observations.find(o=>o.canvasPage?.pointerId===page.id&&o.canvasPage.page===number);
      requireValue(page.pageObservations?.[number-1]&&observation&&canvasKey(evidence(page.pageObservations[number-1]))===canvasKey(evidence(observation)),
        '画布刷新登记了未显示或无法核验的读取依据','STALE_CONTEXT_PLAN');
    }
  }
}
