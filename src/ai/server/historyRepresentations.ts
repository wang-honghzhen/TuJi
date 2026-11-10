import { randomUUID } from 'node:crypto';
import { canReceiptTaskNotice, taskNoticeReceipt } from './taskNotices';
import { AUTO_CONTEXT } from '../contextState';
import { allReviewDecisions, reviewDecisionText } from '../changeReview';
import { inheritedReadScope } from './inheritedReadScope';
import type { AppSnapshot, Artifact, ChatMessage, Task, ToolCallRecord, ProtocolMessage, SourceRef } from '../domain';
import type { Coverage, PromptEntry, SummarySnapshot, SummaryObjectBinding } from '../contextState';
import { historyTurns, residentHistoryTurns } from '../history';
import { digest } from './directGraph';
import { requireValue } from './errors';
import { historicalRecordView, viewedContent } from './historyRecordView';
import { summaryProjection } from './summaryBindings';
import { isDataRead } from './toolContextKinds';
import { isReceipted, isWriteReceipted, visibleCallResult, visibleCallArguments, RETENTION_POLICY_VERSION } from './readVisibility';
import { reviewEvidence } from './reviewContext';

export interface Evidence { id:string; taskId:string; version:string; text:string; projectionText?:string; sources:SourceRef[]; user:boolean; order:number; createdAt:string; part?:number; summaryText?:string; stepId?:string; readData?:boolean; reviewDecision?:true; representation?:'body'|'receipt' }
export const coverageKey=(c:Coverage)=>`${c.recordId}:${c.version}:${c.start}:${c.end}`;
export const fullCoverage=(r:Evidence):Coverage=>({recordId:r.id,taskId:r.taskId,version:r.version,start:0,end:r.text.length});
export function summaryArchive(state:AppSnapshot,task:Task) {
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  return [...new Map([...(workspace.summaries??[]),...state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked)
    .flatMap(s=>s.summaries??[])].map(s=>[s.id,s])).values()];
}
export function allEvidence(state:AppSnapshot,task:Task):Evidence[] {
  state=inheritedReadScope(state,task);
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const turns=historyTurns(state,task.sessionId,task.id), memories=state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked);
  const localTasks=new Set(state.tasks.filter(t=>t.sessionId===task.sessionId).map(t=>t.id));
  const messages=[...state.messages.filter(m=>localTasks.has(m.taskId)),...turns.flatMap(t=>t.messages)];
  const calls=[...state.toolCalls.filter(c=>localTasks.has(c.taskId)),...memories.flatMap(m=>m.toolCalls??[])];
  const result:Evidence[]=[...reviewEvidence(state,task)];
  for(const m of messages)if(m.status!=='streaming'&&!m.presentationCallId&&m.phase!=='status'&&(m.role!=='assistant'||!!m.text.trim())) {
    const text=JSON.stringify({role:m.role,text:m.text,targetRefs:m.targetRefs,attachments:m.attachments,selected_progress:m.selectedProgress,viewedPart:m.viewedPart,viewedPartUnavailable:m.viewedPartUnavailable});
    result.push({id:m.id,taskId:m.taskId,stepId:m.stepId,version:digest([m.version,text]),text,sources:[{kind:'message',id:m.id,version:m.version}],user:m.role==='user',part:m.partSeq,order:m.sequence??Date.parse(m.createdAt),createdAt:m.createdAt});
  }
  for(const c of calls)if(['completed','rejected'].includes(c.status)&&c.result!==undefined){
    const text=JSON.stringify({function:c.name,arguments:c.arguments,result:c.result,operationId:c.operationId});
    const projectionText=JSON.stringify({function:c.name,arguments:visibleCallArguments(state,c),result:visibleCallResult(state,c),operationId:c.operationId});
    result.push({id:c.id,taskId:c.taskId,stepId:c.stepId,readData:isDataRead(c.name),representation:isReceipted(state,c)||isWriteReceipted(state,c)||c.resultRepresentation==='receipt'?'receipt':'body',version:digest(text),text,projectionText,sources:c.resultSources??[],user:false,part:c.partSeq,order:c.sequence??Date.parse(c.createdAt),createdAt:c.createdAt});
  }
  for(const p of [...(workspace.progressEvents??[]),...memories.flatMap(m=>m.progressEvents??[])]) {
    const text=JSON.stringify({progress:p.text,version:p.version});
    result.push({id:p.id,taskId:p.taskId,version:digest(text),text,sources:p.sourceRefs,user:false,order:p.sequence,createdAt:p.createdAt});
  }
  for(const turn of turns)for(const note of turn.notes){
    const text=JSON.stringify({historical_note:{id:note.id,version:note.version,text:note.text,type:note.type,sourceRefs:note.sourceRefs}});
    result.push({id:note.id,taskId:turn.taskId,version:digest([note.version,text]),text,sources:[{kind:'note',id:note.id,version:note.version}],user:false,order:Date.parse(note.updatedAt),createdAt:note.updatedAt});
  }
  const receiptedNotices=new Set(workspace.sessionContext?.receiptedNoticeIds??[]);
  const notices=[...workspace.taskNotices??[],...memories.flatMap(m=>m.taskNotices??[])];
  for(const notice of notices)if(notice.taskId){
    const receipted=canReceiptTaskNotice(notice)&&receiptedNotices.has(notice.id);
    result.push({id:notice.id,taskId:notice.taskId,version:notice.version,representation:receipted?'receipt':'body',
      text:notice.content,projectionText:receipted?JSON.stringify(taskNoticeReceipt(notice)):notice.content,
      sources:notice.sourceRefs,user:false,order:notice.sequence,createdAt:notice.createdAt});
  }
  const evidence=[...new Map(result.map(r=>[r.id,r])).values()];
  return evidence.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}
export function validSummary(summary:SummarySnapshot,records:Evidence[],archive:SummarySnapshot[],visiting=new Set<string>()):boolean {
  if(visiting.has(summary.id)||!summary.coverage.length)return false;
  if(summary.semanticType!=='artifact'&&summary.retentionPolicyVersion!==RETENTION_POLICY_VERSION)return false;
  const tasks=new Set(summary.coverage.map(c=>c.taskId));
  if(summary.semanticType==='task'&&tasks.size!==1)return false;
  if(new Set(summary.children).size!==summary.children.length)return false;
  if(summary.children.length){
    const children=summary.children.map(id=>archive.find(s=>s.id===id));
    if(children.some(s=>!s||s.semanticType!==summary.semanticType))return false;
    const coverage=children.flatMap(s=>s!.coverage);
    if(coverage.some(c=>!summary.coverage.some(parent=>coverageKey(c)===coverageKey(parent))))return false;
    if(coverage.some((c,i)=>coverage.some((p,j)=>j<i&&c.recordId===p.recordId&&c.version===p.version&&c.start<p.end&&p.start<c.end)))return false;
  }
  const next=new Set(visiting);next.add(summary.id);
  return summary.coverage.every(c=>records.some(r=>r.id===c.recordId&&r.taskId===c.taskId&&r.version===c.version&&c.start>=0&&c.end<=r.text.length&&c.end>c.start))
    &&summary.children.every(id=>{const child=archive.find(s=>s.id===id);return !!child&&validSummary(child,records,archive,next);});
}
export function descendants(roots:string[],archive:SummarySnapshot[]):Set<string> {
  const found=new Set<string>(),queue=[...roots];for(let i=0;i<queue.length;i++){
    if(found.has(queue[i]))continue;found.add(queue[i]);queue.push(...(archive.find(s=>s.id===queue[i])?.children??[]));
  }return found;
}
export function selectHistory(state:AppSnapshot,task:Task,previousRoots:string[]=[],includeCompleted=false) {
  const records=allEvidence(state,task),archive=summaryArchive(state,task);
  const turns=residentHistoryTurns(state,task.sessionId,includeCompleted?undefined:task.id), ids=new Set(turns.map(t=>t.taskId));
  const protectedCoverage=records.filter(r=>ids.has(r.taskId)).map(fullCoverage);
  const covered:Coverage[]=[], roots:SummarySnapshot[]=[];
  const intersects=(a:Coverage,b:Coverage)=>a.recordId===b.recordId&&a.version===b.version&&a.start<b.end&&b.start<a.end;
  const rank=(s:SummarySnapshot)=>Math.min(...s.coverage.map(c=>turns.findIndex(t=>t.taskId===c.taskId)).filter(n=>n>=0));
  const valid=archive.filter(s=>s.semanticType!=='artifact'&&validSummary(s,records,archive));
  const spans=valid.flatMap(s=>s.coverage),incompleteSteps=new Set<string>();
  for(const r of records)if(r.stepId){
    let end=0;
    for(const c of spans.filter(c=>c.recordId===r.id&&c.version===r.version).sort((a,b)=>a.start-b.start)){
      if(c.start>end)break;end=Math.max(end,c.end);
    }
    if(end<r.text.length)incompleteSteps.add(r.stepId);
  }
  const candidates=valid.filter(s=>s.coverage.every(c=>!incompleteSteps.has(records.find(r=>r.id===c.recordId)?.stepId??'')))
    .sort((a,b)=>(descendants([a.id],archive).has(b.id)?-1:descendants([b.id],archive).has(a.id)?1:0)
      ||Number(previousRoots.includes(b.id))-Number(previousRoots.includes(a.id))||rank(a)-rank(b)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  for(const s of candidates){
    if(!s.coverage.some(c=>protectedCoverage.some(p=>intersects(c,p))))continue;
    if(s.coverage.some(c=>covered.some(p=>intersects(c,p))))continue;
    roots.push(s);covered.push(...s.coverage);
  }
  const raw=records.filter(r=>ids.has(r.taskId)).flatMap(r=>{
    const ranges=covered.filter(c=>c.recordId===r.id&&c.version===r.version).sort((a,b)=>a.start-b.start);let start=0;
    const pieces:Array<{record:Evidence;coverage:Coverage}>=[];
    for(const range of [...ranges,{start:r.text.length,end:r.text.length}]){
      if(range.start>start)pieces.push({record:{...r,text:r.text.slice(start,range.start)},coverage:{...fullCoverage(r),start,end:range.start}});
      start=Math.max(start,range.end);
    }return pieces;
  });
  return {records,archive,protectedCoverage,roots,raw,turns};
}
export function summaryEntry(s:SummarySnapshot,state:AppSnapshot,task:Task):PromptEntry {
  return {id:`summary:${s.id}:${s.version}`,category:'history',representation:'summary',coverage:s.coverage,
    messages:[{role:'user',content:JSON.stringify({historical_material:{...summaryProjection(state,task,s),
      sourceTasks:[...new Set(s.coverage.map(c=>c.taskId))],intermediateUserMessages:s.intermediateUserMessages,readWith:'context_read_children',instruction:'历史概括，非逐字原文或本轮指令；旧待办结合后续回执判断。'}})}]};
}
export function historyEntries(state:AppSnapshot,task:Task,previousRoots:string[]=[],includeCompleted=false,_readSteps?:Set<string>,_omittedReadCalls=new Set<string>()) {
  const selection=selectHistory(state,task,previousRoots,includeCompleted);
  const permitted=new Set([...selection.protectedCoverage,...selection.roots.flatMap(s=>s.coverage)].map(c=>c.recordId));
  const allowed=selection.records.filter(r=>r.taskId===task.id||permitted.has(r.id));
  // Uncompressed rollback events have their own tail notice. Keep them in
  // evidence/summary coverage, but do not bury them in generic historical prose.
  const entries:PromptEntry[]=[...selection.roots.map(s=>summaryEntry(s,state,task)),...selection.raw.filter(({record})=>!record.reviewDecision).map(({record:r,coverage}):PromptEntry=>{
    const c=state.toolCalls.concat(state.snapshots.flatMap(s=>s.toolCalls??[])).find(c=>c.id===r.id);
    const original=selection.records.find(source=>source.id===r.id&&source.version===r.version)!;
    const view=historicalRecordView(state,original,allowed,coverage.start,coverage.end);
    const body=!!c&&!isWriteReceipted(state,c)&&(!isDataRead(c.name)||!isReceipted(state,c));
    return {id:`history:${coverageKey(coverage)}`,category:'history',...(r.id.startsWith('notice:')?{noticeId:r.id}:{}),representation:(c&&!body||r.projectionText&&r.projectionText!==r.text)?'receipt':'body',
      ...(c&&isDataRead(c.name)?body?{readCallIds:[c.id]}:{receiptCallIds:[c.id]}:{}),coverage:[coverage],messages:[{role:'user',content:JSON.stringify({historical_material:{
      taskId:r.taskId,at:r.createdAt,recordId:r.id,summaryId:r.id,readWith:'context_read_children',sourceVersion:r.version,
      content:c?JSON.stringify(historicalCallProjection(state,c)):r.projectionText??view.text,...(view.viewedContent?{viewedContent:view.viewedContent}:{}),instruction:'历史资料，非本轮新指令。'}})}]};
  })];
  const order=(e:PromptEntry)=>Math.min(...e.coverage.map(c=>selection.turns.findIndex(t=>t.taskId===c.taskId)).filter(n=>n>=0));
  const eventOrder=(e:PromptEntry)=>Math.min(...e.coverage.map(c=>selection.records.find(r=>r.id===c.recordId)?.order??0));
  entries.sort((a,b)=>order(a)-order(b)||eventOrder(a)-eventOrder(b));return {...selection,entries};
}
export function receipt(call:ToolCallRecord) {
  let value:Record<string,unknown>={};try{value=JSON.parse(call.result??'{}');}catch{/* Keep real execution status. */}
  let args:Record<string,unknown>={};try{args=JSON.parse(call.arguments);}catch{/* Invalid original arguments remain archived. */}
  // Public conversation is carried by these arguments, not by their delivery receipts.
  const publicContent=['ui_present','task_finish'].includes(call.name)?{text:args.text,targetRefs:args.targetRefs,sourceRefs:args.sourceRefs}
    :call.name==='interaction_ask'?{question:args.question,options:args.options}:undefined;
  const data=value.data&&typeof value.data==='object'?value.data as Record<string,unknown>:{};
  const readRange=Object.fromEntries(['refId','scope','field','version','start','end','contentLength','directoryVersion','directDataVersion','relationVersion']
    .filter(key=>data[key]!==undefined).map(key=>[key,data[key]]));
  return {function:call.name,callId:call.id,operationId:call.operationId,status:value.status??call.status,code:value.code,
    outcome:value.outcome,changeSetId:value.changeSetId,pointerId:value.pointerId,executed:value.executed,
    page:value.page,totalPages:value.totalPages,hasMorePages:value.hasMorePages,isLastPage:value.isLastPage,nextCursor:value.nextCursor,requestedCursor:value.requestedCursor,coverage:value.coverage,stale:value.stale,
    ...(Object.keys(readRange).length?{readRange}:{}),
    error:value.message??value.error,...(value.details?{details:value.details}:{}),archiveEntry:call.id,readWith:'context_read_children',bodyOmitted:true,...(publicContent?{publicContent}:{}),
    sources:call.resultSources,...(call.name==='workspace_update_work_notes'?{noteId:value.noteId,version:value.version}:{}),
    ...(call.name==='graph_propose_changes'?{temporary:value.temporary,affectedRefs:value.affectedRefs}:{}),
    ...(call.name==='graph_apply_changes'?{affectedRefs:value.affectedRefs,userReview:value.userReview}: {})};
}
export function historicalCallBody(call:ToolCallRecord) {
  return {function:call.name,callId:call.id,operationId:call.operationId,status:call.status,
    bodyOmitted:false,arguments:call.arguments,result:call.result};
}
/** One canonical derived wrapper for matching public history; archive bytes stay untouched. */
export function historicalCallProjection(state:AppSnapshot,call:ToolCallRecord,group=false) {
  const omitted=isWriteReceipted(state,call)||isReceipted(state,call);
  const args=visibleCallArguments(state,call),result=visibleCallResult(state,call);
  return group?{...historicalCallBody({...call,arguments:args,result}),bodyOmitted:omitted}
    :omitted?{function:call.name,callId:call.id,arguments:args,result:JSON.parse(result!),operationId:call.operationId,bodyOmitted:true}
    :historicalCallBody({...call,arguments:args,result});
}
/** Native assistant/tool groups are indivisible. Settled old groups may become ordinary data receipts. */
export function protectedCurrentSteps(state:AppSnapshot,task:Task):Set<string> {
  const completed=state.steps.filter(s=>s.taskId===task.id&&s.purpose==='agent'&&s.status==='completed').sort((a,b)=>a.ordinal-b.ordinal);
  return new Set([...completed.slice(-AUTO_CONTEXT.recentGroups).map(s=>s.id),...state.steps.filter(s=>s.taskId===task.id&&s.purpose==='agent'&&s.status!=='completed').map(s=>s.id)]);
}
export function currentEntries(state:AppSnapshot,task:Task,_clean=false,_readSteps?:Set<string>,_omittedReadCalls=new Set<string>()):PromptEntry[] {
  const records=allEvidence(state,task),archive=summaryArchive(state,task),steps=state.steps.filter(s=>s.taskId===task.id&&s.purpose==='agent');
  const history=selectHistory(state,task,state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.residentRoots);
  const permitted=new Set([...history.protectedCoverage,...history.roots.flatMap(s=>s.coverage)].map(c=>c.recordId));
  const allowed=records.filter(r=>r.taskId===task.id||permitted.has(r.id));
  const entries:Array<PromptEntry&{order:number}>=[];
  const protectedSteps=protectedCurrentSteps(state,task);
  const summaries=archive.filter(s=>s.semanticType==='task'&&s.coverage.every(c=>c.taskId===task.id&&c.recordId!==task.rootUserMessageId
    &&!protectedSteps.has(records.find(r=>r.id===c.recordId)?.stepId??''))&&validSummary(s,records,archive));
  const replaced=(id:string)=>summaries.some(s=>s.coverage.some(c=>c.recordId===id&&records.some(r=>r.id===id&&coverageKey(c)===coverageKey(fullCoverage(r)))));
  const users=state.messages.filter(m=>m.taskId===task.id&&m.role==='user'&&m.status!=='streaming');
  for(const m of users){const r=records.find(r=>r.id===m.id);if(!r||m.id!==task.rootUserMessageId&&replaced(m.id))continue;entries.push({id:`current:${m.id}:${m.version}`,category:'current_request',coverage:[fullCoverage(r)],order:m.sequence??Date.parse(m.createdAt),
    taskId:task.id,messages:[{role:'user',content:JSON.stringify({current_message:{id:m.id,content:m.text,selectedRefs:m.targetRefs,sources:m.sourceRefs,selected_progress:m.selectedProgress,
      ...(m.viewedPart?{viewedContent:viewedContent(state,m.viewedPart,allowed,r)}:m.viewedPartUnavailable?{viewedContent:{records:[],unavailable:true}}:{})}})}]});}
  // Evidence and the archive are fixed during this synchronous build. Validate
  // once here, rather than recursively rechecking every tree for every step.
  // Never retain this selection across builds: source versions can change in place.
  const validTasks=steps.length?summaries:[];
  const partialRoots=validTasks.filter(s=>s.coverage.every(c=>c.taskId===task.id)&&!validTasks.some(p=>p.children.includes(s.id)));
  const emitted=new Set<string>();
  for(const step of steps){
    const messages=state.messages.filter(m=>m.stepId===step.id&&m.role==='assistant'&&!m.presentationCallId).sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    const msg=messages[0];
    const calls=state.toolCalls.filter(c=>c.taskId===task.id&&c.stepId===step.id).sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    if(!msg?.text&&!calls.length)continue;
    const evidence=records.filter(r=>messages.some(m=>m.id===r.id)||calls.some(c=>c.id===r.id));
    const covering=validTasks.filter(s=>evidence.length&&evidence.every(r=>s.coverage.some(c=>coverageKey(c)===coverageKey(fullCoverage(r)))));
    const summary=covering.sort((a,b)=>b.coverage.length-a.coverage.length)[0];
    const coveredAll=evidence.length>0&&evidence.every(r=>{let at=0;for(const c of partialRoots.flatMap(s=>s.coverage).filter(c=>c.recordId===r.id&&c.version===r.version).sort((a,b)=>a.start-b.start)){if(c.start>at)return false;at=Math.max(at,c.end);}return at>=r.text.length;});
    if(!summary&&coveredAll){for(const s of partialRoots.filter(s=>s.coverage.some(c=>evidence.some(r=>r.id===c.recordId))))if(!emitted.has(s.id)){entries.push({...summaryEntry(s,state,task),category:'progress',order:msg?.sequence??calls[0]?.sequence??0});emitted.add(s.id);}continue;}
    if(summary){if(!emitted.has(summary.id)){entries.push({...summaryEntry(summary,state,task),category:'progress',order:msg?.sequence??calls[0]?.sequence??0});emitted.add(summary.id);}continue;}
    // A shortened argument object no longer satisfies the original tool schema.
    // Convert the entire settled group to ordinary execution records, keeping
    // the assistant text and every unabridged sibling result. No native call (or
    // private provider continuation) may survive for only part of this group.
    const structured=calls.some(c=>isWriteReceipted(state,c));
    const native:ProtocolMessage[]=structured?[
      ...(messages.some(m=>m.text)?[{role:'assistant' as const,content:messages.map(m=>m.text).join('\n')}]:[]),
      ...calls.map(c=>({role:'user' as const,content:JSON.stringify({historical_material:{
        taskId:task.id,stepId:step.id,recordId:c.id,sourceVersion:records.find(r=>r.id===c.id)?.version,
        content:JSON.stringify(historicalCallProjection(state,c,true)),
        instruction:'本任务已执行步骤的记录，非新要求或待执行调用；仅回执部分可按档案入口恢复。'}})})),
    ]:[{role:'assistant',content:messages.map(m=>m.text).join('\n'),stepId:step.id,...(calls.length?{toolCalls:calls.map(c=>({id:c.providerCallId,name:c.name,arguments:visibleCallArguments(state,c)}))}:{})},
      ...calls.filter(c=>c.result!==undefined).map(c=>({role:'tool' as const,toolCallId:c.providerCallId,content:visibleCallResult(state,c)!}))];
    const receipts=calls.filter(c=>isDataRead(c.name)&&isReceipted(state,c)).map(c=>c.id);
    entries.push({id:`step:${step.id}`,taskId:task.id,stepId:step.id,category:'current_protocol',coverage:evidence.map(fullCoverage),
      order:msg?.sequence??calls[0]?.sequence??Date.parse(step.createdAt),representation:'body',
      readCallIds:calls.filter(c=>isDataRead(c.name)&&c.result!==undefined&&!receipts.includes(c.id)).map(c=>c.id),
      receiptCallIds:receipts,messages:native});
  }
  const nativeIds=new Set(entries.flatMap(e=>e.coverage.map(c=>c.recordId)));
  for(const r of records.filter(r=>r.taskId===task.id&&!r.reviewDecision&&!nativeIds.has(r.id)&&!replaced(r.id)&&!users.some(m=>m.id===r.id)&&!r.stepId)){
    entries.push({id:`record:${r.id}:${r.version}`,taskId:task.id,category:'progress',...(r.id.startsWith('notice:')?{noticeId:r.id}:{}),representation:r.projectionText&&r.projectionText!==r.text?'receipt':'body',coverage:[fullCoverage(r)],order:r.order,
      messages:[{role:'user',content:JSON.stringify({task_progress:{recordId:r.id,content:r.projectionText??r.text}})}]});
  }
  for(const summary of summaries.filter(s=>!summaries.some(parent=>parent.children.includes(s.id))))if(!emitted.has(summary.id))
    entries.push({...summaryEntry(summary,state,task),category:'progress',order:Math.min(...summary.coverage.map(c=>records.find(r=>r.id===c.recordId)?.order??0))});
  return entries.sort((a,b)=>a.order-b.order).map(({order:_order,...entry})=>entry);
}
export function makeSummary(type:SummarySnapshot['semanticType'],text:string,coverage:Coverage[],children:string[],sources:SourceRef[],objectBindings:SummaryObjectBinding[]=[]):SummarySnapshot {
  requireValue(text.trim()&&coverage.length,'摘要缺少正文或来源','INVALID_SUMMARY');
  const tasks=new Set(coverage.map(c=>c.taskId));
  requireValue(type!=='task'||tasks.size===1,'任务摘要不能跨任务','SUMMARY_TASK_LIMIT');
  const sourceBindings:SummaryObjectBinding[]=[...new Map(sources.filter(s=>['node','document','edge'].includes(s.kind)&&s.version!==undefined)
    .map(s=>{const b={key:digest([s.kind,s.id,s.version]).slice(0,16),kind:s.kind as SummaryObjectBinding['kind'],id:s.id,version:s.version};return[b.key,b] as const;})).values()];
  const id=`summary:${randomUUID()}`;return{id,retentionPolicyVersion:RETENTION_POLICY_VERSION,version:digest([text,coverage,children,objectBindings,sourceBindings]),semanticType:type,text,coverage,children,sourceRefs:sources,sourceBindings,...(objectBindings.length?{objectBindings}:{}),createdAt:new Date().toISOString()};
}
export function artifactEvidence(artifacts:Artifact[]):Evidence[] {
  return artifacts.filter(a=>a.status!=='deleted').flatMap(a=>a.chunks.map(c=>({id:c.id,taskId:`artifact:${a.id}`,version:digest(c.text),
    text:c.text,sources:[{kind:'artifact' as const,id:a.id,version:a.version,start:c.start,end:c.end}],user:false,order:c.ordinal,createdAt:a.createdAt})));
}
export function validArtifactSummary(summary:SummarySnapshot,artifact:Artifact,archive:SummarySnapshot[]):boolean {
  return summary.semanticType==='artifact'&&summary.artifactId===artifact.id&&summary.artifactVersion===artifact.version
    && validSummary(summary,artifactEvidence([artifact]),archive)
    && [...descendants([summary.id],archive)].every(id=>{const s=archive.find(s=>s.id===id);return s?.semanticType==='artifact'&&s.artifactId===artifact.id&&s.artifactVersion===artifact.version;});
}
export function copySelectedSummaries(archive:SummarySnapshot[],records:Evidence[],artifacts:Artifact[]=[] ) {
  return structuredClone(archive.filter(s=>s.semanticType==='artifact'
    ?artifacts.some(a=>validArtifactSummary(s,a,archive)):validSummary(s,records,archive)));
}

export function snapshotEvidence(messages:ChatMessage[],calls:ToolCallRecord[],progress:import('../contextState').ProgressEvent[],notes:import('../domain').Note[]=[],fallbackTaskId='',state?:Pick<AppSnapshot,'changes'|'canvasReviewStates'>,taskNotices:import('./taskNotices').TaskNotice[]=[]):Evidence[]{
  const result:Evidence[]=[];
  const changeIds=new Set(calls.filter(c=>c.name==='graph_apply_changes').flatMap(c=>{try{return [JSON.parse(c.result??'{}').changeSetId];}catch{return [];}}));
  if(state)for(const d of allReviewDecisions(state).filter(d=>d.action==='revert'&&d.changes.some(c=>changeIds.has(c.changeSetId)))){
    const text=reviewDecisionText(d);result.push({id:d.id,taskId:d.changes[0]?.taskId??fallbackTaskId,version:digest(text),text,sources:[],user:false,order:Date.parse(d.createdAt),createdAt:d.createdAt});
  }
  for(const m of messages)if(m.status!=='streaming'&&!m.presentationCallId&&m.phase!=='status'){
    const text=JSON.stringify({role:m.role,text:m.text,targetRefs:m.targetRefs,attachments:m.attachments,selected_progress:m.selectedProgress,viewedPart:m.viewedPart,viewedPartUnavailable:m.viewedPartUnavailable});
    result.push({id:m.id,taskId:m.taskId,stepId:m.stepId,version:digest([m.version,text]),text,sources:[],user:m.role==='user',part:m.partSeq,order:m.sequence??0,createdAt:m.createdAt});
  }
  for(const c of calls)if(c.result!==undefined){const text=JSON.stringify({function:c.name,arguments:c.arguments,result:c.result,operationId:c.operationId});
    result.push({id:c.id,taskId:c.taskId,stepId:c.stepId,readData:isDataRead(c.name),representation:c.resultRepresentation??'body',version:digest(text),text,sources:[],user:false,part:c.partSeq,order:c.sequence??0,createdAt:c.createdAt});}
  for(const p of progress){const text=JSON.stringify({progress:p.text,version:p.version});result.push({id:p.id,taskId:p.taskId,version:digest(text),text,sources:p.sourceRefs,user:false,order:p.sequence,createdAt:p.createdAt});}
  for(const note of notes){const text=JSON.stringify({historical_note:{id:note.id,version:note.version,text:note.text,type:note.type,sourceRefs:note.sourceRefs}});
    const taskId=note.sourceRefs.map(s=>messages.find(m=>s.kind==='message'&&s.id===m.id)?.taskId).find(Boolean)??fallbackTaskId;
    result.push({id:note.id,taskId,version:digest([note.version,text]),text,sources:[],user:false,order:Date.parse(note.updatedAt),createdAt:note.updatedAt});}
  for(const notice of taskNotices)if(notice.taskId)result.push({id:notice.id,taskId:notice.taskId,version:notice.version,text:notice.content,
    sources:notice.sourceRefs,user:false,order:notice.sequence,createdAt:notice.createdAt});
  return result;
}
