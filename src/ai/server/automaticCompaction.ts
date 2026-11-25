import { randomUUID } from 'node:crypto';
import type { AppSnapshot, ContextManifest, Task } from '../domain';
import type { ContextBuildOptions, SummarySnapshot } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { contextCapacity } from '../contextCapacity';
import { ensureSessionContext, residentSessionTaskIds } from '../sessionContext';
import { estimateTokens } from '../tokens';
import { Repository } from './repository';
import { callModel, ProviderError } from './providers';
import { summaryConnection } from './apiConfiguration';
import { digest } from './directGraph';
import { allEvidence, summaryArchive } from './historyRepresentations';
import { previewReceipts } from './readVisibility';
import { previewWriteReceipts } from './writeReceipts';
import { noticeDue, noticeMaintenanceReasons } from './noticeMaintenance';
import { createDirectoryMaintenance, evictDirectoryCacheEntry } from './directoryCache';
import { createSummaryMaintenance, evictSummaryRegion } from './summaryRegions';
import { createCanvasMaintenance } from './canvasRefresh';
import { taskSummaryUnits, acceptTaskSummaries, summaryStorageBenefit, taskSummaryBudget, type TaskSummaryInput } from './taskSummaryEngine';
import { packSummaryRequest } from './taskSummaryPacking';
import { bindSummaryRangeResponse, summarySegments } from './taskSummaryRanges';
import { selectProjectedSummaries, summaryProjectionBenefits } from './summaryAdmission';

interface PrepareOptions {repo:Repository;task:Task;caller:typeof callModel;signal:AbortSignal;guard:()=>void;
  build?:(options?:ContextBuildOptions)=>ContextManifest;preview?:(clean?:boolean)=>ContextManifest}

/** Live graph/notebook versions do not change the historical bytes sent to the summary
 * model. Keep their original source bindings; the rebuilt executor request checks them.
 * Revocation, edited input records and changed summary children do invalidate the result. */
function summaryInputFence(repo:Repository,task:Task,inputs:TaskSummaryInput[]):string {
  const state=repo.state,workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const session=state.sessions.find(s=>s.id===task.sessionId),records=allEvidence(state,task),archive=summaryArchive(state,task);
  const byId=new Map(records.map(record=>[record.id,record]));
  const evidence=inputs.map(input=>{
    const live=taskSummaryUnits(state,task,input.taskId);
    const unitsById=new Map(live.units.map(unit=>[unit.id,unit]));
    const selected=input.units.flatMap(unit=>unitsById.get(unit.id)??[]);
    // New siblings or an inserted failed step can invalidate a range while
    // every individual record previously sent still has the same version.
    const segments=summarySegments({...live,units:selected},records);
    return [input.taskId,live.initialMessage,segments,input.units.map(unit=>[
      unit.id,unitsById.get(unit.id)?.coverage,unit.summaryId?archive.find(s=>s.id===unit.summaryId):undefined,
      unit.coverage.map(span=>{
        const record=byId.get(span.recordId);
        return [span,record&&[record.taskId,record.version,record.text,record.sources,record.order]];
      })
    ])];
  });
  return digest([task.instructionRevision,state.provider,task.modelSelection,repo.summaryConnection?.provider,
    task.inputBindings,[session?.canvasId,session?.mode,session?.lifecycle,session?.temporaryContext],
    workspace.snapshotIds.map(id=>{const s=state.snapshots.find(s=>s.id===id);return [id,s?.contentHash,s?.revoked];}),
    evidence]);
}

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
  let directoryMaintenance=createDirectoryMaintenance(repo.state,task),summaryMaintenance=createSummaryMaintenance(),canvasMaintenance=createCanvasMaintenance();
  const resetMaintenance=()=>{directoryMaintenance=createDirectoryMaintenance(repo.state,task);
    summaryMaintenance=createSummaryMaintenance();canvasMaintenance=createCanvasMaintenance();};
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
  const attemptedMaterial=new Set<string>();
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
    const signatures=new Map<string,string>();
    function* availableInputs(){
      for(const taskId of new Set(selection)){
        const raw=taskSummaryUnits(materialState,task,taskId),signature=digest(raw.units.map(u=>[u.id,u.coverage]));
        if(attemptedMaterial.has(signature))continue;
        signatures.set(taskId,signature);
        yield raw;
      }
    }
    const rangeRecords=allEvidence(materialState,task);
    const remainingInput=task.maxTokens-task.usedTokens-provider.maxOutputTokens;
    const taskBudgetRestrictsInput=remainingInput<contextCapacity(provider).inputCapacity;
    const {inputs,plan:rangePlan,wire:request,tokens,eligible}=packSummaryRequest(provider,availableInputs(),rangeRecords,remainingInput);
    if(!inputs.length){
      if(signatures.size){
        const reason=!eligible?'no_legal_range':taskBudgetRestrictsInput?'task_token_budget':'input_capacity';
        repo.transaction(()=>repo.event(task.workspaceId,'context.summary_skipped',{reason,taskIds:[...signatures.keys()]},task.id));
        for(const signature of signatures.values())attemptedMaterial.add(signature);
      }
      if((needHistory||candidate.error||candidate.requestTokens>target)&&evictOldest())continue;
      if(eligible&&taskBudgetRestrictsInput)return lowerBound(candidate,'摘要所需任务用量预算不足；任务与原文已保留。');
      return lowerBound(candidate,eligible?'完整摘要范围与背景无法容纳在摘要模型输入容量内；已保留全部原文。':
        '当前任务受保护步骤或不可继续整理的内容仍无法容纳；已保留全部原文，请调整模型容量后继续。');
    }
    if(calls>=AUTO_CONTEXT.maxCalls||task.maxSteps-task.stepCount-(task.memoryCalls??0)<=1){
      if(evictOldest())continue;
      return lowerBound(candidate,'摘要所需模型调用预算不足且必需内容仍无法容纳；任务与原文已保留。');
    }
    if(tokens+provider.maxOutputTokens+task.usedTokens>task.maxTokens){
      if(evictOldest())continue;
      return lowerBound(candidate,'摘要所需任务用量预算不足且必需内容仍无法容纳；任务与原文已保留。');
    }
    if(Date.now()-started>=AUTO_CONTEXT.maxDurationMs)break;
    const sourceFence=summaryInputFence(repo,task,inputs),roundId=randomUUID();calls++;
    repo.transaction(()=>{task.memoryCalls=(task.memoryCalls??0)+1;task.usedTokens+=tokens+provider.maxOutputTokens;
      repo.event(task.workspaceId,'context.compaction_started',{roundId,phase:'summary'},task.id);});
    let accepted:SummarySnapshot[]=[];
    let commitFailed=false,invalidReferences=0,reason='no_output';
    let summaryStatus:'completed'|'failed'|'cancelled'|'skipped'='skipped';
    try{
      const response=await caller({...provider,timeoutMs:Math.max(1,Math.min(provider.timeoutMs,AUTO_CONTEXT.maxDurationMs-(Date.now()-started)))},connection.credential,request,{signal});
      // Settle usage even if a new user instruction arrived during this call.
      // The original reservation already includes the locally estimated input and output cap.
      const usage=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:undefined;
      const inputUsage=usage(response.inputTokens),outputUsage=usage(response.outputTokens);
      repo.transaction(()=>{
        const live=repo.state.tasks.find(t=>t.id===task.id);
        if(live)live.usedTokens+=(inputUsage&&inputUsage>0?inputUsage:tokens)-tokens
          +(outputUsage??estimateTokens(response.text))-provider.maxOutputTokens;
      });
      guard();
      // The await can outlive any maintenance snapshot, even when the summary's
      // immutable historical inputs are unchanged. Never reuse those memo tables.
      resetMaintenance();candidate=build('refactor','capacity');trim();
      if(sourceFence!==summaryInputFence(repo,task,inputs)){reason='source_changed';continue;}
      const output=JSON.parse(response.text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
      const proposals=acceptTaskSummaries(materialState,task,inputs,bindSummaryRangeResponse(rangePlan,output,inputs,rangeRecords),roundId,()=>{invalidReferences++;});
      reason=proposals.length?'no_projection_savings':invalidReferences?'invalid_reference':'no_output';
      if(proposals.length){
        if(sourceFence!==summaryInputFence(repo,task,inputs))throw new Error('摘要来源已变化');
        const owner=repo.state.workspaces.find(w=>w.id===task.workspaceId)!,prior=owner.summaries;
        const baseDirectory=directoryMaintenance,baseSummary=summaryMaintenance,baseCanvas=canvasMaintenance;
        let committed=false;
        // Copy eviction decisions, but never share memo tables or new evictions
        // between competing projections. Preserve stable IDs within this build.
        const project=(summaries:SummarySnapshot[])=>{
          guard();
          directoryMaintenance={...baseDirectory,replayMemo:new Map(),usageEvidenceMemo:new Map(),
            evictedReplayKeys:new Set(baseDirectory.evictedReplayKeys),diagnostics:{...baseDirectory.diagnostics}};
          summaryMaintenance={...baseSummary,memo:new Map(),evicted:new Set(baseSummary.evicted),deferred:new Set(baseSummary.deferred)};
          canvasMaintenance={...baseCanvas,memo:new Map(),evicted:new Set(baseCanvas.evicted),evictionReasons:new Map(baseCanvas.evictionReasons)};
          owner.summaries=[...(prior??[]),...summaries];
          try{return build('compact','capacity');}finally{owner.summaries=prior;}
        };
        try{
          const chosen=selectProjectedSummaries({before:candidate,preferred:proposals.filter(s=>summaryStorageBenefit(s,inputs)),
            candidates:proposals,project,canProject:()=>Date.now()-started<AUTO_CONTEXT.maxDurationMs});
          if(chosen.length){
            const projected=project(chosen);
            if(sourceFence!==summaryInputFence(repo,task,inputs))throw new Error('摘要来源已变化');
            if(summaryProjectionBenefits(projected,candidate)){
              // Probe failures are recoverable; only the final durable write owns
              // a transaction. A failed commit must stop before using a stale task.
              try{repo.transaction(state=>{
                if(sourceFence!==summaryInputFence(repo,task,inputs))throw new Error('摘要来源已变化');
                const context=ensureSessionContext(state,owner);
                owner.summaries=[...(prior??[]),...chosen];
                for(const taskId of new Set(chosen.flatMap(s=>s.coverage.map(c=>c.taskId))))if(taskId!==task.id){
                  const rounds=(context.countedSummaryRounds??={})[taskId]??=[];
                  if(!rounds.includes(roundId)){rounds.push(roundId);context.countedSummaryRounds![taskId]=rounds;
                    context.historicalSummaryCounts[taskId]=Math.min(2,(context.historicalSummaryCounts[taskId]??0)+1);}
                }
              });}catch(error){commitFailed=true;throw error;}
              accepted=chosen;candidate=projected;committed=true;
            }
          }
        }finally{
          if(!committed){owner.summaries=prior;directoryMaintenance=baseDirectory;summaryMaintenance=baseSummary;canvasMaintenance=baseCanvas;}
        }
      }
      if(accepted.length){summaryStatus='completed';reason=invalidReferences?'partial_invalid_reference':'adopted';}
    }catch(error){
      summaryStatus=signal.aborted?'cancelled':'failed';
      reason=error instanceof ProviderError?error.code:signal.aborted?'aborted':commitFailed?'commit_failed':'validation_or_projection';
      accepted=[];
      guard();if(signal.aborted||commitFailed)throw error;
      resetMaintenance();
      repo.transaction(()=>repo.event(task.workspaceId,'context.summary_failed',{message:error instanceof Error?error.message:String(error),reason,calls},task.id));
    }finally{
      repo.transaction(()=>repo.event(task.workspaceId,'context.compaction_finished',{roundId,status:summaryStatus,reason,invalidReferences,summaries:accepted.length},task.id));
    }
    for(const input of inputs)if(!accepted.some(s=>s.coverage.some(c=>c.taskId===input.taskId)))
      attemptedMaterial.add(signatures.get(input.taskId)!);
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
