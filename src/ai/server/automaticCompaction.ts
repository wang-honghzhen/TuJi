import { randomUUID } from 'node:crypto';
import type { AppSnapshot, ContextManifest, Task } from '../domain';
import type { ContextBuildOptions, SummarySnapshot } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { contextCapacity } from '../contextCapacity';
import { ensureSessionContext, residentSessionTaskIds } from '../sessionContext';
import { estimateTokens } from '../tokens';
import { Repository } from './repository';
import { callModel, requestTokens, type ModelRequest } from './providers';
import { summaryConnection } from './apiConfiguration';
import { digest } from './directGraph';
import { allEvidence } from './historyRepresentations';
import { previewReceipts } from './readVisibility';
import { previewWriteReceipts } from './writeReceipts';
import { noticeDue, noticeMaintenanceReasons } from './noticeMaintenance';
import { createDirectoryMaintenance, evictDirectoryCacheEntry } from './directoryCache';
import { createSummaryMaintenance, evictSummaryRegion } from './summaryRegions';
import { createCanvasMaintenance } from './canvasRefresh';
import { taskSummaryUnits, boundedSummaryInput, acceptTaskSummaries, TASK_SUMMARY_INSTRUCTIONS, taskSummaryBudget, summaryInputWeight, type TaskSummaryInput } from './taskSummaryEngine';

interface PrepareOptions {repo:Repository;task:Task;caller:typeof callModel;signal:AbortSignal;guard:()=>void;
  build?:(options?:ContextBuildOptions)=>ContextManifest;preview?:(clean?:boolean)=>ContextManifest}

export function progressRegionTokens(manifest:ContextManifest){
  const sums={history:0,progress:0};
  for(const entry of manifest.stageDraft?.entries??[]){
    const region=entry.category==='history'?'history':['progress','current_request','current_protocol','review'].includes(entry.category)?'progress':undefined;
    if(region)sums[region]+=estimateTokens(JSON.stringify(entry.wireMessages??entry.messages));
  }
  return sums;
}

/** Creation must settle residency without any model request or summary-count mutation. */
export function prepareInitialContext(state:AppSnapshot,task:Task,build:(options:ContextBuildOptions)=>ContextManifest):ContextManifest {
  const capacity=inputCapacity(state),reserve=Math.min(AUTO_CONTEXT.readTokens,capacity*AUTO_CONTEXT.recentShare)+Math.min(AUTO_CONTEXT.readTokens,capacity*.05);
  const trigger=capacity*AUTO_CONTEXT.trigger-reserve,target=capacity*AUTO_CONTEXT.target-reserve;
  let resident=residentSessionTaskIds(state,task.sessionId).filter(id=>id!==task.id);
  const candidate=(preferOriginals:boolean,mode:ContextBuildOptions['mode'])=>build({phase:'task_end',mode,maintenanceIntent:'capacity',residentTaskIds:resident,preferOriginals});
  let result=candidate(true,'append');
  if(result.error||result.requestTokens>trigger){
    result=candidate(true,'refactor');
    if(result.error||result.requestTokens>target)result=candidate(false,'refactor');
    while(resident.length&&(result.error||result.requestTokens>target)){
      resident=resident.slice(1);result=candidate(false,'refactor');
    }
  }
  if(result.stageDraft)result.stageDraft.residentTaskIds=[...resident];
  return result;
}

/** Maintenance changes one candidate projection; it never mutates archived tool records. */
export async function prepareAutomaticContext(options:PrepareOptions):Promise<ContextManifest>{
  const {repo,task,caller,signal,guard}=options,started=Date.now(),capacity=inputCapacity(repo.state);
  const reserve=Math.min(AUTO_CONTEXT.readTokens,capacity*AUTO_CONTEXT.recentShare)+Math.min(AUTO_CONTEXT.readTokens,capacity*.05);
  const trigger=capacity*AUTO_CONTEXT.trigger-reserve,target=Math.max(0,capacity*AUTO_CONTEXT.target-reserve),hard=capacity-reserve;
  const directoryMaintenance=createDirectoryMaintenance(repo.state,task),summaryMaintenance=createSummaryMaintenance(),canvasMaintenance=createCanvasMaintenance();
  let resident=residentSessionTaskIds(repo.state,task.sessionId,task.id),builds=0,calls=0;
  const build=(mode:ContextBuildOptions['mode']='append',intent:ContextBuildOptions['maintenanceIntent']='ordinary')=>{
    const result=options.build?options.build({mode,maintenanceIntent:intent,residentTaskIds:resident,directoryMaintenance,summaryMaintenance,canvasMaintenance})
      :options.preview!(mode!=='append');
    builds+=result.contextMetrics?.maintenance?.candidateBuilds??(mode==='append'?0:1);
    return result;
  };
  const measured=(manifest:ContextManifest)=>{if(manifest.contextMetrics)manifest.contextMetrics.maintenance={candidateBuilds:builds,elapsedMs:Date.now()-started};return manifest;};
  const before=build(),notice=noticeDue(repo.state,task,before.stageDraft);
  const pendingSignature=()=>digest([resident.map(id=>[id,taskSummaryUnits(repo.state,task,id).units.map(u=>[u.id,u.coverage])]),
    repo.state.workspaces.find(w=>w.id===task.workspaceId)?.sessionContext?.historicalSummaryCounts,
    repo.state.provider,task.modelSelection,task.maxSteps,task.maxTokens]);
  const publish=(candidate:ContextManifest,reason:'capacity'|'version_notices')=>{
    const metrics={trigger:reason,adopted:true,reason,before:before.requestTokens,after:candidate.requestTokens,
      ratio:before.requestTokens?candidate.requestTokens/before.requestTokens:1,receiptCalls:candidate.stageDraft?.retentionDraft?.receiptIds.length??0,
      removedTasks:(before.stageDraft?.residentTaskIds??[]).filter(id=>!resident.includes(id)).length,removedArtifacts:0,summaryCalls:calls};
    if(candidate.stageDraft){candidate.stageDraft.residentTaskIds=[...resident];candidate.stageDraft.refactorMetrics=metrics;
      candidate.stageDraft.metrics={before:before.requestTokens,after:candidate.requestTokens,calls,elapsedMs:Date.now()-started,reason,
        targetTokens:target,triggerTokens:trigger,readingReserve:reserve,targetReached:candidate.requestTokens<=target};
      if(candidate.stageDraft.retentionDraft){candidate.stageDraft.retentionDraft.capacityMaintenance=reason==='capacity';
        candidate.stageDraft.retentionDraft.noticeMaintenance=reason==='version_notices';}}
    if(candidate.contextMetrics){candidate.contextMetrics.refactor=metrics;candidate.contextMetrics.maintenance={candidateBuilds:builds,elapsedMs:Date.now()-started};}
    return measured(candidate);
  };
  const lowerBound=(candidate:ContextManifest,message:string)=>{
    const safe=!candidate.error&&candidate.requestTokens<=hard;
    if(!safe)candidate.error??=message;
    const result=publish(candidate,'capacity');
    if(safe&&result.stageDraft){
      result.stageDraft.compactionAttempt={capacity,pendingSignature:pendingSignature(),retryAtTokens:Math.min(hard+1,candidate.requestTokens+Math.max(1024,Math.floor(capacity*.02)))};
      result.stageDraft.metrics!.lowerBound=true;result.stageDraft.metrics!.reason='irreducible_lower_bound';
    }
    return result;
  };
  const previous=before.stageDraft?.compactionAttempt;
  if(!notice&&!before.error&&before.requestTokens<=hard&&previous?.capacity===capacity&&before.requestTokens<previous.retryAtTokens
    &&previous.pendingSignature===pendingSignature())return measured(before);
  if(!before.error&&before.requestTokens<trigger){
    if(!notice)return measured(before);
    let candidate:ContextManifest;
    try{candidate=build('refactor','notice');}catch(error){
      repo.transaction(state=>{const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,notices=before.stageDraft!.versionNotices!;
        workspace.noticeMaintenanceAttempt={signature:notices.signature,status:'failed',availableTokens:notices.availableTokens,resourceBytes:notices.resourceBytes,
          reasons:[error instanceof Error?error.message:String(error)]};});
      throw error;
    }
    if(!candidate.error&&candidate.requestTokens<=hard)return publish(candidate,'version_notices');
    repo.transaction(state=>{const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
      workspace.noticeMaintenanceAttempt={signature:before.stageDraft!.versionNotices!.signature,status:'unsafe',
        availableTokens:before.stageDraft!.versionNotices!.availableTokens,resourceBytes:before.stageDraft!.versionNotices!.resourceBytes,
        reasons:[candidate.error??'capacity_or_read_reserve',...noticeMaintenanceReasons(candidate.stageDraft)]};});
    return measured(before);
  }
  let candidate=build('refactor','capacity');
  const trim=()=>{
    while(candidate.stageDraft?.directoryAreas&&(candidate.error||candidate.requestTokens>target)&&evictDirectoryCacheEntry(directoryMaintenance,candidate.stageDraft.directoryAreas!))candidate=build('refactor','capacity');
    while(candidate.stageDraft&&(candidate.error||candidate.requestTokens>target)&&evictSummaryRegion(repo.state,task,candidate.stageDraft,summaryMaintenance))candidate=build('refactor','capacity');
  };
  trim();
  if(!candidate.error&&candidate.requestTokens<=target)return publish(candidate,'capacity');
  const budgets=taskSummaryBudget(capacity),active=new Set<'history'|'progress'>();
  const first=progressRegionTokens(candidate);
  if(first.history>budgets.high)active.add('history');if(first.progress>budgets.high)active.add('progress');
  const noBenefit=new Set<string>();
  const fence=()=>digest([task.instructionRevision,repo.state.provider,task.modelSelection,repo.state.graphRevision,
    allEvidence(repo.state,task).map(r=>[r.id,r.version]),repo.state.workspaces.map(w=>[w.id,w.pinnedNotes,w.workNotes,w.sessionContext?.historicalSummaryCounts])]);
  const evictOldest=()=>{
    const oldest=resident.find(id=>id!==task.id);if(!oldest)return false;
    resident=resident.filter(id=>id!==oldest);candidate=build('refactor','capacity');return true;
  };
  while(Date.now()-started<AUTO_CONTEXT.maxDurationMs){
    guard();
    const sizes=progressRegionTokens(candidate);
    const needHistory=active.has('history')&&sizes.history>budgets.low;
    const needCurrent=active.has('progress')&&sizes.progress>budgets.low;
    if(!candidate.error&&candidate.requestTokens<=target&&!needHistory&&!needCurrent)return publish(candidate,'capacity');
    const workspace=repo.state.workspaces.find(w=>w.id===task.workspaceId)!;
    const counts=workspace.sessionContext?.historicalSummaryCounts??{};
    const draft=candidate.stageDraft?.retentionDraft;
    let materialState=previewReceipts(repo.state,draft?.receiptIds??[]);
    materialState=previewWriteReceipts(materialState,draft?.writeReceiptIds??[]);
    if(workspace.sessionContext&&candidate.stageDraft?.receiptedNoticeIds)materialState={...materialState,workspaces:materialState.workspaces.map(w=>w.id===workspace.id?{...w,sessionContext:{...w.sessionContext!,receiptedNoticeIds:candidate.stageDraft!.receiptedNoticeIds}}:w)};
    const selection=needHistory?resident.filter(id=>id!==task.id&&(counts[id]??0)<2):[];
    if(needCurrent)selection.unshift(task.id);
    const connection=summaryConnection(repo,task.modelSelection),provider={...connection.provider,maxOutputTokens:Math.min(connection.provider.maxOutputTokens,4096)};
    let inputBudget=contextCapacity(provider).inputCapacity-estimateTokens(TASK_SUMMARY_INSTRUCTIONS)-1024;
    const inputs:TaskSummaryInput[]=[];
    for(const taskId of selection){
      const raw=taskSummaryUnits(materialState,task,taskId),signature=digest(raw.units.map(u=>[u.id,u.coverage]));
      if(noBenefit.has(signature))continue;
      const bounded=boundedSummaryInput(raw,inputBudget);
      if(bounded){inputs.push(bounded);inputBudget-=estimateTokens(JSON.stringify({initialMessage:bounded.initialMessage,
        referenceCatalog:bounded.referenceCatalog,executionFunctionGuide:bounded.executionFunctionGuide,units:bounded.units.map(u=>({id:u.id,weight:u.weight,content:u.content}))}));}
      if(inputs.length>=3)break;
    }
    if(!inputs.length){
      if((needHistory||candidate.error||candidate.requestTokens>target)&&evictOldest())continue;
      return lowerBound(candidate,'当前任务受保护步骤、初始消息或无收益内容仍无法容纳；已保留全部原文，请调整模型容量后继续。');
    }
    if(calls>=AUTO_CONTEXT.maxCalls||task.maxSteps-task.stepCount-(task.memoryCalls??0)<=1){
      if(evictOldest())continue;
      return lowerBound(candidate,'摘要所需模型调用预算不足且必需内容仍无法容纳；任务与原文已保留。');
    }
    const makeRequest=():ModelRequest=>({messages:[{role:'system',content:TASK_SUMMARY_INSTRUCTIONS},{role:'user',content:JSON.stringify({tasks:inputs.map(i=>({taskId:i.taskId,initialMessage:i.initialMessage,referenceCatalog:i.referenceCatalog,executionFunctionGuide:i.executionFunctionGuide,
      units:i.units.map(u=>({id:u.id,weight:u.weight,content:u.content}))}))})}],tools:[]});
    let request=makeRequest(),tokens=requestTokens(provider,request);
    while(tokens>contextCapacity(provider).inputCapacity&&inputs.length){
      const last=inputs.at(-1)!;
      if(summaryInputWeight(last.units.slice(0,-1))>=2)last.units.pop();else inputs.pop();
      request=makeRequest();tokens=requestTokens(provider,request);
    }
    if(!inputs.length){
      if(evictOldest())continue;
      return lowerBound(candidate,'完整步骤与摘要背景无法容纳在摘要模型输入容量内；已保留全部原文。');
    }
    if(tokens+provider.maxOutputTokens+task.usedTokens>task.maxTokens){
      if(evictOldest())continue;
      return lowerBound(candidate,'摘要所需任务用量预算不足且必需内容仍无法容纳；任务与原文已保留。');
    }
    const sourceFence=fence(),roundId=randomUUID();calls++;
    repo.transaction(()=>{task.memoryCalls=(task.memoryCalls??0)+1;task.usedTokens+=tokens+provider.maxOutputTokens;
      repo.event(task.workspaceId,'context.compaction_started',{roundId,phase:'summary'},task.id);});
    let accepted:SummarySnapshot[]=[];
    let summaryStatus:'completed'|'failed'|'cancelled'|'skipped'='skipped';
    try{
      const response=await caller({...provider,timeoutMs:Math.max(1,Math.min(provider.timeoutMs,AUTO_CONTEXT.maxDurationMs-(Date.now()-started)))},connection.credential,request,{signal});
      guard();repo.transaction(()=>{task.usedTokens+=(response.outputTokens??estimateTokens(response.text))-provider.maxOutputTokens;});
      if(sourceFence!==fence())return measured(build());
      const output=JSON.parse(response.text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
      accepted=acceptTaskSummaries(materialState,task,inputs,output,roundId);
      if(accepted.length)repo.transaction(state=>{
        if(sourceFence!==fence())throw new Error('摘要来源已变化');
        const owner=state.workspaces.find(w=>w.id===task.workspaceId)!,context=ensureSessionContext(state,owner);
        const prior=owner.summaries??[];
        owner.summaries=[...prior,...accepted];
        // The authoritative saving is the serialized next executor request, including
        // user metadata, reference bindings and all summary envelopes.
        const projected=build('compact','capacity');
        if((projected.contextMetrics?.rawRequestTokens??projected.requestTokens)>=(candidate.contextMetrics?.rawRequestTokens??candidate.requestTokens)
          ||projected.error&&!projected.capacityEstimateError&&projected.error!==candidate.error){
          owner.summaries=prior;accepted=[];return;
        }
        for(const taskId of new Set(accepted.flatMap(s=>s.coverage.map(c=>c.taskId))))if(taskId!==task.id){
          const rounds=(context.countedSummaryRounds??={})[taskId]??=[];
          if(!rounds.includes(roundId)){rounds.push(roundId);context.countedSummaryRounds![taskId]=rounds;
            context.historicalSummaryCounts[taskId]=Math.min(2,(context.historicalSummaryCounts[taskId]??0)+1);}
        }
      });
      if(accepted.length)summaryStatus='completed';
    }catch(error){
      summaryStatus=signal.aborted?'cancelled':'failed';
      accepted=[];
      guard();if(signal.aborted)throw error;
      repo.transaction(()=>repo.event(task.workspaceId,'context.summary_failed',{message:error instanceof Error?error.message:String(error),calls},task.id));
    }finally{
      repo.transaction(()=>repo.event(task.workspaceId,'context.compaction_finished',{roundId,status:summaryStatus,summaries:accepted.length},task.id));
    }
    for(const input of inputs)if(!accepted.some(s=>s.coverage.some(c=>c.taskId===input.taskId)))
      noBenefit.add(digest(taskSummaryUnits(materialState,task,input.taskId).units.map(u=>[u.id,u.coverage])));
    candidate=build('compact','capacity');trim();
  }
  // The deadline bounds model work, not the deterministic capacity fallback.
  // A slow/failed summary must still release whole historical tasks in order.
  while(candidate.error||candidate.requestTokens>target
    ||active.has('history')&&progressRegionTokens(candidate).history>budgets.low){
    guard();
    if(!evictOldest())break;
    trim();
  }
  if(!candidate.error&&candidate.requestTokens<=target)return publish(candidate,'capacity');
  return lowerBound(candidate,'本次上下文整理达到时间限制，必需内容仍无法容纳；已保存已完成的摘要与全部原文。');
}
