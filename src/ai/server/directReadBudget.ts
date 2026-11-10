import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { estimateTokens } from '../tokens';
import { readCoverage, readKind } from './readCoverage';
import { requestTokens, imageTokens } from './providers';
import { isDataRead } from './toolContextKinds';

/** All reads in one native tool group share a quota, including their result envelopes. */
export function directReadBudget(state:AppSnapshot,task:Task,call:ToolCallRecord,requested:unknown=AUTO_CONTEXT.readTokens):number {
  return directReadBudgets(state,task,call,requested).availableTokens;
}

/** Page geometry uses the original single-read allowance; admission still spends the shared remainder. */
export function directReadBudgets(state:AppSnapshot,task:Task,call:ToolCallRecord,requested:unknown=AUTO_CONTEXT.readTokens){
  const capacity=Math.max(0,inputCapacity(state));
  const consumed=state.toolCalls.filter(c=>c.taskId===task.id&&c.stepId===call.stepId&&c.id!==call.id)
    .reduce((n,c)=>n+estimateTokens(c.result??'')+imageTokens(c.resultImages),0);
  const submitted=state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.lastRequest;
  const sent=submitted?.tokens??0;
  const nextRequestReserve=Math.min(AUTO_CONTEXT.readTokens,capacity*.05);
  const limit=typeof requested==='number'&&Number.isFinite(requested)?requested:AUTO_CONTEXT.readTokens;
  // A new frozen source may outlive the five recent steps while its later pages are read.
  // Size new pages for that protected residency; existing pages keep their original geometry.
  let pageWindowLimit=Infinity;
  if(submitted?.serialized)try{
    const request=JSON.parse(submitted.serialized);
    const reads=new Set(state.toolCalls.filter(c=>isDataRead(c.name)).map(c=>c.providerCallId));
    const rawBase=requestTokens({...state.provider,...task.modelSelection},{...request,messages:request.messages.map((m:import('../domain').ProtocolMessage)=>
      m.role==='tool'&&reads.has(m.toolCallId??'')?{...m,content:'{"bodyOmitted":true}'}:m)});
    // The calibrated upper bound for the entire submitted input also bounds its base.
    // Do not infer a proportional token discount for a removed subset.
    const base=Math.min(rawBase,sent);
    const readingReserve=Math.min(AUTO_CONTEXT.readTokens,capacity*AUTO_CONTEXT.recentShare)+nextRequestReserve;
    pageWindowLimit=Math.max(0,Math.floor((capacity-base-readingReserve)/(AUTO_CONTEXT.recentGroups+1)));
  }catch{/* Isolated callers without a serialized request retain the original ceiling. */}
  return {
    maximumTokens:Math.max(0,Math.floor(Math.min(limit,capacity*AUTO_CONTEXT.recentShare,capacity-nextRequestReserve))),
    pageBudget:Math.max(0,Math.floor(Math.min(limit,capacity*AUTO_CONTEXT.recentShare,capacity-sent-nextRequestReserve,pageWindowLimit))),
    availableTokens:Math.max(0,Math.floor(Math.min(limit,capacity*AUTO_CONTEXT.recentShare-consumed,capacity-sent-consumed-nextRequestReserve))),
    // Diagnostic limits do not change admission or frozen page geometry. Already returned
    // results remain in the next request: only the native group quota resets there.
    requestedLimit:Math.max(0,Math.floor(limit)),
    groupRemainingTokens:Math.max(0,Math.floor(capacity*AUTO_CONTEXT.recentShare-consumed)),
    contextRemainingTokens:Math.max(0,Math.floor(capacity-sent-consumed-nextRequestReserve)),
    protectedWindowTokens:Number.isFinite(pageWindowLimit)?pageWindowLimit:undefined,
    nextResponseTokens:Math.max(0,Math.floor(Math.min(limit,capacity*AUTO_CONTEXT.recentShare,capacity-sent-consumed-nextRequestReserve))),
  };
}

/** A fixed page cannot shrink when the configured input capacity shrinks. */
export function frozenPageCapacityReceipt(call:ToolCallRecord,args:Record<string,unknown>,availableTokens:number,requiredTokens:number,maximumTokens:number){
  const requestedBudgetTooSmall=typeof args.budget==='number'&&args.budget<requiredTokens;
  const result={status:'blocked',code:'FROZEN_PAGE_CAPACITY',executed:false,coverage:readCoverage(readKind(call.name),['capacity'],true),
    requestedCursor:{pointerId:args.pointerId,page:args.page},availableTokens,requiredTokens,maximumTokens,
    blockingReason:requestedBudgetTooSmall?'requested_budget':'frozen_page_limit',
    nextAction:requestedBudgetTooSmall?'increase_read_budget':'restore_capacity_or_read_current_source',
    instruction:(requestedBudgetTooSmall?'自设budget小于固定冻结页的完整响应；提高或省略budget，仍须满足总上下文限制。':'固定冻结页超过当前单次读取上限；恢复容量后续读，或按当前源重新读取并使用新指针。')
      +'原页和指针保持不变，新页码不能接替旧页码。尚不支持从旧冻结源重新分页，勿同参循环重试。'};
  return compactCapacityReceipt(result,availableTokens,requestedBudgetTooSmall?'提高或省略budget；原游标未读，不重分页。':'恢复容量或按当前源新读；保留旧游标，勿混拼新旧页。');
}

/** Small recovery receipt: no unread content and no new frozen pointer on a blocked read. */
export function readCapacityReceipt(call:ToolCallRecord,args:Record<string,unknown>,availableTokens:number,requiredTokens?:number,
  diagnostics?:{limits:ReturnType<typeof directReadBudgets>;usePageBudget?:boolean;minimumOnly?:boolean}):Record<string,unknown> {
  const hasPointer=typeof args.pointerId==='string';
  const limits=diagnostics?.limits,known=requiredTokens!==undefined;
  let blockingReason='undetermined',nextAction='resolve_capacity_before_retry';
  let instruction='本次未交付正文；现有信息不能证明下一响应可容纳该结果。检查读取预算与上下文余量，必要时请求用户协助；勿同参循环重试。';
  if(known&&limits){
    if(typeof args.budget==='number'&&requiredTokens>limits.requestedLimit){
      blockingReason='requested_budget';nextAction='increase_read_budget';
      instruction='自设budget不足以容纳完整读取回执；提高或省略budget后重试。调整预算不保证总上下文余量足够。';
    }else if(requiredTokens>limits.contextRemainingTokens){
      blockingReason='context_headroom';nextAction='restore_context_capacity';
      instruction='计入本组已返回结果后，持续上下文余量不足。系统自动维护上下文，但不保证下一响应腾出足够空间；仍受阻时以partial结束或用interaction_ask请求用户调整容量，勿同参循环重试。';
    }else if(diagnostics.usePageBudget&&limits.protectedWindowTokens!==undefined&&requiredTokens>limits.protectedWindowTokens){
      blockingReason='protected_page_window';nextAction='restore_protected_page_capacity';
      instruction='连续分页所需的近期保护空间不足。系统自动维护上下文；仍受阻时以partial结束或用interaction_ask请求用户调整容量。勿为重试丢弃仍依赖的资料，也勿重复已成功页。';
    }else if(requiredTokens>limits.maximumTokens){
      blockingReason='single_read_limit';nextAction='reduce_scope_or_restore_capacity';
      instruction='结果超过当前单次读取上限；按已有入口缩小读取范围或恢复容量。没有可用小范围入口时报告阻塞，勿同参循环重试。';
    }else if(requiredTokens>limits.groupRemainingTokens){
      blockingReason='group_quota';
      if(!diagnostics.minimumOnly&&requiredTokens<=limits.nextResponseTokens
        &&(!diagnostics.usePageBudget||requiredTokens<=limits.pageBudget)){
        nextAction='retry_unread_in_next_response';
        instruction='本组共享读取额度已耗尽；按当前已知占用，下一响应单独读取可获得所需额度。仅重试未交付内容，不重复成功页；若后续上下文增长导致仍不足，按新回执处理。';
      }else instruction=diagnostics.minimumOnly?'本组共享读取额度不足；requiredTokens仅为读取最低门槛，尚不能证明完整结果可在下一响应装入。先检查预算与容量，勿重复成功页。':'本组共享读取额度不足；下一响应仍不能证明有完整结果所需空间。先检查预算与容量，勿重复成功页。';
    }
  }else if(limits){
    // Packing can fail before an exact minimum is known. Explain the binding
    // persistent limit without inventing a required size or a retry guarantee.
    const ceiling=diagnostics.usePageBudget?Math.min(limits.pageBudget,availableTokens):availableTokens;
    if(typeof args.budget==='number'&&limits.requestedLimit<=ceiling){blockingReason='requested_budget';nextAction='increase_read_budget';instruction='自设budget下无法装入完整片段；提高或省略budget后重试，仍须满足上下文及保护空间限制。';}
    else if(limits.contextRemainingTokens<=ceiling){blockingReason='context_headroom';nextAction='restore_context_capacity';instruction='持续上下文余量不足。系统自动维护上下文；仍受阻时以partial结束或请求用户调整容量，勿同参循环重试。';}
    else if(diagnostics.usePageBudget&&limits.protectedWindowTokens!==undefined&&limits.protectedWindowTokens<=ceiling){blockingReason='protected_page_window';nextAction='restore_protected_page_capacity';instruction='连续分页保护空间不足。系统自动维护上下文；仍受阻时以partial结束或请求用户调整容量，勿循环重开首页。';}
  }
  const result={status:'blocked',code:'READ_GROUP_CAPACITY',executed:false,coverage:readCoverage(readKind(call.name),['capacity'],true),callId:call.id,
    ...(call.name==='graph_read_node_edges'?{requestedRefs:Array.isArray(args.requests)?args.requests.map(r=>(r as {refId:string}).refId):[args.refId]}:{}),
    ...(hasPointer?{requestedCursor:{pointerId:args.pointerId,page:args.page}}:{requestedRead:{tool:call.name,arguments:{...args}}}),
    ...(typeof args.summaryId==='string'?{summaryId:args.summaryId}:{}),
    availableTokens, ...(requiredTokens===undefined?{}:{requiredTokens}),
    ...(diagnostics?.minimumOnly?{requiredTokensAreMinimum:true}:{}),
    blockingReason,nextAction,instruction:instruction+(hasPointer?' 保留requestedCursor的原pointerId和页码；尚未交付该页。':' 尚未创建新分页快照；requestedRead保留原参数。')};
  const compact:Record<string,string>={
    requested_budget:'提高或省略budget；仍须满足上下文余量。',
    context_headroom:'系统自动维护；仍不足时partial结束或请用户调整容量，勿循环重试。',
    protected_page_window:'保护空间不足；系统自动维护，仍不足时partial结束或请用户调整容量。',
    group_quota:nextAction==='retry_unread_in_next_response'?'本组额度耗尽；下一响应单独重试未读入口，勿重复成功页。':diagnostics?.minimumOnly?'本组额度不足；所需值只是最低门槛，尚不能保证下一响应可读。':'本组额度不足；先检查预算和容量，尚不能保证下一响应可读。',
    single_read_limit:'超过单次上限；缩小范围或恢复容量，勿循环重试。',
    undetermined:'先检查预算和容量；尚不能保证下一响应重试成功。',
  };
  compactCapacityReceipt(result,availableTokens,compact[blockingReason]+(hasPointer?'原游标未读。':'未创建快照。'));
  // This failure receipt itself will occupy the next request. A known result
  // size must still fit after that cost, not merely before reporting the failure.
  if(result.nextAction==='retry_unread_in_next_response'&&limits&&requiredTokens!==undefined
    &&requiredTokens>Math.min(limits.nextResponseTokens,limits.contextRemainingTokens-estimateTokens(JSON.stringify(result)))){
    result.blockingReason='context_headroom';result.nextAction='restore_context_capacity';
    result.instruction='计入本次失败回执后持续余量不足。系统自动维护上下文；仍受阻时以partial结束或请求用户调整容量，保留原读取入口。';
    compactCapacityReceipt(result,availableTokens,'系统自动维护；仍不足时partial结束或请用户调整容量，保留原入口。');
  }
  return result;
}

/** Diagnostics must not turn a small recovery receipt into another capacity failure.
 * Keep identities, cursor and machine-readable recovery action intact. An exhausted
 * allowance may still be smaller than this mandatory protocol-only receipt. */
function compactCapacityReceipt<T extends {instruction:string}>(result:T,availableTokens:number,compactInstruction:string):T {
  if(estimateTokens(JSON.stringify(result))>availableTokens)result.instruction=compactInstruction;
  return result;
}
