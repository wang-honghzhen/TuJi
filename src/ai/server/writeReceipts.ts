import type { AppSnapshot, ToolCallRecord } from '../domain';
import { allReviewChanges, allReviewDecisions, rollbackReview } from '../changeReview';

// Authored note text is task material: only a task summary may shorten it.
export const RECEIPTABLE_WRITES = new Set(['graph_propose_changes','graph_apply_changes','workspace_delete_work_notes']);
export function writeReceiptEntry(state: AppSnapshot, call: ToolCallRecord) {
  if (!RECEIPTABLE_WRITES.has(call.name)||call.result===undefined) return;
  try {
    const value=JSON.parse(call.result),change=allReviewChanges(state).find(c=>c.id===value.changeSetId);
    const reverted=change?.review?.units.filter(u=>u.state==='reverted')??[];
    const decisions=reverted.length?allReviewDecisions(state).filter(d=>d.action==='revert'&&d.changes.some(c=>c.changeSetId===change!.id)):[];
    // Approval never changes the execution receipt or its retention revision.
    // A later rollback is folded in only during ordinary context maintenance.
    const userReview=change?.review?.callId ? reverted.length ? {
      revision:Math.max(1,...decisions.map(d=>d.revision)),state:'reverted' as const,decisionIds:decisions.map(d=>d.id),
      ...(reverted.length<change.review.units.length?{scope:'partial',revertedUnits:reverted.length,totalUnits:change.review.units.length}:{})
    } : undefined : rollbackReview(value.userReview);
    const decisionIds=userReview?.decisionIds??[];
    const callId=call.originResultId??call.id;
    const receipt=JSON.stringify({function:call.name,callId,status:value.status??call.status,
      operationId:value.operationId??call.operationId,changeSetId:value.changeSetId,noteId:value.noteId,version:value.version,
      affectedRefs:value.affectedRefs,temporaryRefs:value.temporaryRefs,code:value.code,executed:value.executed,
      applied:value.applied,repeated:value.repeated,replayed:value.replayed,nextAction:value.nextAction,
      // Failure details carry execution evidence and recovery entries, not omitted body text.
      details:value.details,
      ...(value.message?{message:String(value.message).slice(0,240)}:{}),
      ...(userReview?{userReview:{...userReview,decisionIds}}:{}),bodyOmitted:true,
      readWith:{tool:'context_restore_records',arguments:{recordIds:[callId]}}});
    const revision=userReview?.revision??1;
    return {receipt,taskId:call.taskId,stepId:call.stepId,revision,decisionIds};
  }catch{return;}
}
export function eligibleWriteReceipt(state:AppSnapshot,call:ToolCallRecord,protectedCalls:Set<string>):boolean {
  return RECEIPTABLE_WRITES.has(call.name)&&['completed','rejected'].includes(call.status)&&call.presentedAt!==undefined
    &&!protectedCalls.has(call.originResultId??call.id)&&!!writeReceiptEntry(state,call);
}
export function previewWriteReceipts(state:AppSnapshot,ids:string[]):AppSnapshot {
  if(!ids.length)return state;
  const ledger=structuredClone(state.contextRetention??{version:1,revision:0,receipts:{}});
  const calls=new Map([...state.snapshots.flatMap(s=>s.toolCalls??[]),...state.toolCalls].map(c=>[c.originResultId??c.id,c]));
  for(const id of ids){const call=calls.get(id),entry=call&&writeReceiptEntry(state,call);if(entry)(ledger.writeReceipts??={})[id]=entry;}
  return {...state,contextRetention:ledger};
}
