import type { AppSnapshot, Task } from '../domain';
import { AUTO_CONTEXT, type ContextStage } from '../contextState';
import { inputCapacity } from '../memory';
import { noteNoticeFacts } from './noteFreshness';
import { pendingCanvasChanges,canvasNoticeLabels } from './contextFreshness';
import { digest } from './directGraph';
import { contextProtection, eligibleRead } from './contextProtection';
import { allRetainedCalls, originResultId, receiptFamily } from './readVisibility';
import { requestTokens } from './providers';
import { planFrozenReads } from './frozenReadCommit';
import { graphReadContext,type GraphReadContext } from './graphReadContext';
import { contextNoteNoticeIds } from './taskNotices';

export interface NoticeFact { key:string; version:string; callIds:string[]; kind:string;labels:string[];detail?:string;nonCallSource?:boolean }
export interface NoticeState {
  tokens:number; threshold:number; target:number; signature:string; facts:NoticeFact[];
  availableTokens?:number; resourceBytes?:number;
  maintenance?: { before:number; after:number; targetReached:boolean; relaxedReads:number; builds:number; elapsedMs:number; reason:string };
}
export const noticeThreshold=(capacity:number)=>Math.max(1,Math.min(Math.floor(capacity*AUTO_CONTEXT.noticeShare),AUTO_CONTEXT.noticeMaxTokens));

/** Private identities/versions, never parsed back from the abbreviated model-facing lines. */
export function captureNoticeState(state:AppSnapshot,task:Task,stage:ContextStage,tokens:number,encode:(id:string)=>string=id=>id,requestSize?:number,readContext?:GraphReadContext):NoticeState {
  readContext??=state.graph?graphReadContext(state):undefined;
  const facts:NoticeFact[]=[];
  for(const [key,{change,observations,observation}] of pendingCanvasChanges(state,task,stage,readContext))facts.push({key:`canvas:${key}`,
    version:digest(change),callIds:[...new Set(observations.flatMap(o=>o.callId?[o.callId]:[]))].sort(),
    ...canvasNoticeLabels(state,task,change,observation,encode,readContext),nonCallSource:observations.some(o=>!o.callId)});
  for(const fact of noteNoticeFacts(state,task,stage))facts.push({key:fact.key,version:digest(fact.state),callIds:fact.callIds,
    kind:fact.kind,labels:[`${encode(fact.id)}${fact.deleted?'（已删除）':''}`],nonCallSource:!fact.callIds.length});
  const noteNotices=contextNoteNoticeIds(state,task.workspaceId);
  const timelineNotices=stage.entries.filter(e=>e.representation!=='receipt'&&e.contextUpdate?.kind!=='note'&&!noteNotices.has(e.noticeId??'')
    &&(e.category==='review'||e.noticeId));
  const noticeTokens=requestTokens({...state.provider,...task.modelSelection},{messages:timelineNotices.flatMap(e=>e.wireMessages??e.messages),tools:[]})
    -requestTokens({...state.provider,...task.modelSelection},{messages:[],tools:[]});
  tokens+=Math.max(0,noticeTokens);
  facts.sort((a,b)=>a.key.localeCompare(b.key));
  const protection=contextProtection(state,task),ids=[...receiptFamily(state,facts.flatMap(f=>f.callIds))].sort();
  const threshold=noticeThreshold(inputCapacity(state));
  let resourceBytes=0;
  if(facts.length){let reads;try{reads=planFrozenReads(state,task,stage).reads;}catch{reads=[...state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads??[],...stage.frozenReadDrafts??[]];}
    resourceBytes=reads.filter(r=>r.expiresAt>Date.now()).reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0);}
  return {tokens,threshold,target:Math.floor(threshold*AUTO_CONTEXT.noticeTargetShare),facts,resourceBytes,
    // Keep a signed deficit: a request can become safe while still above the
    // refill target, and clamping both states to zero would hide that release.
    availableTokens:requestSize===undefined?undefined:Math.floor(inputCapacity(state)*.65)-requestSize,
    // Resource consumption is a directional retry condition, not a source change.
    // The version tag gives persisted pre-fix attempts one fresh evaluation.
    signature:digest(['notice-retry-v3',timelineNotices.map(e=>[e.id,e.contentSignature]),[inputCapacity(state),task.modelSelection],facts.map(({kind:_kind,labels:_labels,...fact})=>fact),ids.map(id=>[id,protection.protectedCalls.has(id),[...new Set(protection.hardReasons[id]??[])].sort()]),
      state.workspaces.find(w=>w.id===task.workspaceId)?.sessionContext?.residentTaskIds])};
}

export function noticeDue(state:AppSnapshot,task:Task,stage:ContextStage|undefined):boolean {
  const n=stage?.versionNotices,w=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const previous=w.noticeMaintenanceAttempt;
  const reasons=previous?.reasons??[];
  const capacityBlocked=reasons.some(r=>['capacity_or_read_reserve','refill_capacity','capacity_pressure','read_pool',
    'required_content_exceeds_refill_target','retained_sources_exceed_read_pool'].includes(r));
  // Only workspace storage shares a limit with unrelated frozen reads. Releasing
  // those reads cannot solve a single source/snapshot/page limit or hard protection.
  const storageBlocked=reasons.some(r=>r==='resource:workspaceBytes'||r==='resource:READ_RESOURCE_LIMIT');
  return !!n&&n.tokens>=n.threshold&&(previous?.signature!==n.signature
    ||capacityBlocked&&n.availableTokens!==undefined&&previous?.availableTokens!==undefined&&n.availableTokens>previous.availableTokens
    ||storageBlocked&&n.resourceBytes!==undefined&&previous?.resourceBytes!==undefined&&n.resourceBytes<previous.resourceBytes);
}

/** Persist resource failures even when the builder could not produce a safe candidate. */
export function noticeMaintenanceReasons(stage:ContextStage|undefined):string[] {
  return [...new Set([...(stage?.canvasRefresh?.diagnostics.reasons??[]),
    ...[stage?.canvasRefresh?.diagnostics.resourceFailure,stage?.summaryRegions?.diagnostics.resourceFailure]
      .filter((r):r is string=>!!r).map(r=>`resource:${r}`)])];
}

/** A receipt family is indivisible; never weaken an explicit, paging or other-task dependency. */
export function noticeCleanupCalls(state:AppSnapshot,task:Task,stage:ContextStage):string[] {
  const causes=new Set(stage.versionNotices?.facts.flatMap(f=>f.callIds)??[]),protection=contextProtection(state,task);
  const calls=allRetainedCalls(state);
  return calls.filter(c=>causes.has(c.id)&&eligibleRead(c,state,protection.hardProtectedCalls)
    &&[...receiptFamily(state,[originResultId(c)])].every(id=>!protection.hardProtectedCalls.has(id)))
    .sort((a,b)=>(a.firstDelivery?.sequence??a.sequence??Date.parse(a.createdAt))-(b.firstDelivery?.sequence??b.sequence??Date.parse(b.createdAt))
      ||originResultId(a).localeCompare(originResultId(b))).map(originResultId);
}
