import { validateAttachmentRelocations } from './attachmentCatalog';
import type { AppSnapshot, Task } from '../domain';
import { inheritedReadScope } from './inheritedReadScope';
import type { ContextStage } from '../contextState';
import { contextProtection, eligibleRead } from './contextProtection';
import { allRetainedCalls, originResultId, readReceiptEntry, retentionHash, RETENTION_POLICY_VERSION, isReceipted, receiptFamily } from './readVisibility';
import { requireValue } from './errors';
import { ensureSessionContext } from '../sessionContext';
import { validateSummaryRelocations } from './summaryRegions';
import { planFrozenReads } from './frozenReadCommit';
import { validateCanvasRefresh } from './canvasRefresh';
import { canvasEvidenceFence } from './canvasReadEvidence';
import { noticeMaintenanceReasons } from './noticeMaintenance';
import { reviewFence } from '../changeReview';
import { commitReviewDelivery } from './reviewContext';
import { eligibleWriteReceipt, writeReceiptEntry } from './writeReceipts';
import { taskNoticeBatchCurrent } from './taskNotices';

export function retentionFence(state: AppSnapshot, task: Task): string {
  state=inheritedReadScope(state,task);
  const w = state.workspaces.find(w => w.id === task.workspaceId)!;
  return retentionHash([state.contextRetention?.revision ?? 0, state.graphRevision, task.instructionRevision, reviewFence(state,task),
    state.sessions.find(s => s.id === task.sessionId), state.provider, state.attachmentLimits, task.modelSelection, w.pinnedNotes,
    state.workspaces.map(owner => [owner.id, owner.workNotes, owner.progressEvents]),
    state.tasks.map(t => [t.id, t.status]), state.changes.filter(c => c.status === 'proposed'),
    allRetainedCalls(state).map(c => [originResultId(c), c.status, c.presentedAt, c.result, c.readOriginIds, c.frozenSourceCallId,c.readPageRefs,c.readPageOrigins,c.resultReadHashes,c.firstDelivery,c.summaryOrigins,c.canvasOrigins,c.attachmentProtection,c.attachmentRead,c.resultImages]),
    state.steps.map(s => [s.id, s.status, s.completedSequence]), state.artifacts.map(a => [a.id, a.version, a.status, a.hash]),
    w.snapshotIds,w.sessionContext,w.taskNotices,w.pendingTaskNotices, state.snapshots.map(s => [s.id, s.contentHash, s.revoked]),w.contextStage?.directoryAreas,
    w.contextStage?.summaryRegions,state.workspaces.map(owner=>[owner.id,owner.summaries,owner.contextStage?.canvasRefresh,
      owner.frozenReads?.map(p=>[p.id,p.callId,p.originResultIds,p.canvasOrigin,p.expiresAt,p.canvasView?retentionHash(p):undefined])])]);
}
/** Reconcile a private request before any submission side effects. Unrelated receipts preserve its prefix. */
export function synchronizeRetentionStage(state:AppSnapshot,task:Task,stage:ContextStage):boolean {
  state=inheritedReadScope(state,task);
  if(!taskNoticeBatchCurrent(state,task,stage))return false;
  if(stage.reviewFence!==undefined&&stage.reviewFence!==reviewFence(state,task))return false;
  if(stage.pendingNoticeAttempt&&stage.pendingNoticeAttempt.fence!==retentionFence(state,task))return false;
  if(stage.canvasEvidenceFence&&stage.canvasEvidenceFence!==canvasEvidenceFence(state))return false;
  if(stage.retentionDraft&&stage.retentionDraft.fence!==retentionFence(state,task))return false;
  const bodies=new Set(stage.entries.flatMap(e=>e.readCallIds??[]));
  if([...bodies].some(id=>isReceipted(state,id)))return false;
  if(stage.retentionRevision!==(state.contextRetention?.revision??0)){
    if(allRetainedCalls(state).some(c=>bodies.has(c.id)&&isReceipted(state,c)))return false;
    stage.retentionRevision=state.contextRetention?.revision??0;
  }
  return true;
}
/** Caller owns the SQLite transaction. No mutation happens until every fence has passed. */
export function commitRetention(state: AppSnapshot, task: Task, stage: ContextStage): void {
  state=inheritedReadScope(state,task);
  requireValue(taskNoticeBatchCurrent(state,task,stage),'待发送改动已变化，请重新准备上下文','STALE_CONTEXT_PLAN');
  requireValue(stage.reviewFence===undefined||stage.reviewFence===reviewFence(state,task),'用户决定已变化，请重新准备上下文','STALE_CONTEXT_PLAN');
  validateSummaryRelocations(state,task,stage);
  validateAttachmentRelocations(state,task,stage);
  requireValue(!stage.canvasEvidenceFence||stage.canvasEvidenceFence===canvasEvidenceFence(state),
    '画布来源在请求准备后变化，请重新验证版本通知','STALE_CONTEXT_PLAN');
  const draft = stage.retentionDraft;
  const attempt=stage.pendingNoticeAttempt;
  requireValue(!attempt||attempt.fence===retentionFence(state,task),'通知维护来源已变化，请重新计算','STALE_CONTEXT_PLAN');
  const commitAttempt=()=>{const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,context=ensureSessionContext(state,workspace);
    const next=stage.residentTaskIds??context.residentTaskIds;
    context.excludedTaskIds=[...new Set([...context.excludedTaskIds,...context.residentTaskIds.filter(id=>!next.includes(id))])];
    context.residentTaskIds=[...next];context.receiptedNoticeIds=[...stage.receiptedNoticeIds??context.receiptedNoticeIds??[]];
    commitReviewDelivery(state,task,stage);if(attempt){state.workspaces.find(w=>w.id===task.workspaceId)!.noticeMaintenanceAttempt={
    signature:attempt.signature,availableTokens:attempt.availableTokens,resourceBytes:attempt.resourceBytes,status:'handled',reasons:attempt.reasons};delete stage.pendingNoticeAttempt;}};
  if (!draft) { validateCanvasRefresh(state,task,stage);commitAttempt(); return; }
  requireValue(draft.fence === retentionFence(state, task), '上下文候选来源或保护已变化，请重新计算', 'STALE_CONTEXT_PLAN');
  const calls = new Map(allRetainedCalls(state).map(c => [originResultId(c), c]));
  const protection = contextProtection(state, task);
  validateCanvasRefresh(state,task,stage);
  const relocationBlocked=new Set([...protection.immovableCalls].filter(id=>protection.hardReasons[id]?.some(r=>r==='other_task'||r==='undelivered'||r==='related_dependency')));
  requireValue([...receiptFamily(state,draft.receiptIds)].every(id=>draft.receiptIds.includes(id)||!!state.contextRetention?.receipts[id]),
    '读取副本关系已变化，请重新计算','STALE_CONTEXT_PLAN');
  for (const id of draft.receiptIds) {
    const call = calls.get(id);
    const relocated=draft.relocatedReceiptIds?.includes(id);
    requireValue(!!state.contextRetention?.receipts[id] || !!call && eligibleRead(call, state,
      relocated?relocationBlocked:protection.hardProtectedCalls),
      '读取仍受保护，清理未提交', 'PROTECTED_READ');
  }
  const pages=planFrozenReads(state,task,stage);
  for (const id of draft.writeReceiptIds ?? []) {
    const call = calls.get(id);
    requireValue(!!call && eligibleWriteReceipt(state,call,protection.protectedCalls), '写入回执仍受保护，请重新准备上下文', 'PROTECTED_WRITE');
  }
  const ledger = state.contextRetention ??= { version: RETENTION_POLICY_VERSION, revision: 0, receipts: {} };
  let changed = false;
  for (const id of draft.writeReceiptIds ?? []) {
    const receipt = writeReceiptEntry(state,calls.get(id)!)!;
    if (ledger.writeReceipts?.[id]?.receipt !== receipt.receipt) { (ledger.writeReceipts ??= {})[id]=receipt;changed=true; }
  }
  for (const id of draft.receiptIds) if (!ledger.receipts[id]) {
    const call = calls.get(id)!;
    ledger.receipts[id] = readReceiptEntry(call); changed = true;
  }
  if (changed) {
    ledger.revision++;
  }
  stage.retentionRevision = ledger.revision;
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  workspace.frozenReads=pages.reads;delete stage.frozenReadDrafts;
  stage.removedTemporaryIds = [...new Set([...(stage.removedTemporaryIds ?? []), ...draft.removedTemporaryIds])];
  if(draft.noticeMaintenance&&stage.versionNotices)
    workspace.noticeMaintenanceAttempt={signature:stage.versionNotices.signature,availableTokens:stage.versionNotices.availableTokens,
      resourceBytes:stage.versionNotices.resourceBytes,status:'handled',reasons:noticeMaintenanceReasons(stage)};
  delete stage.retentionDraft;
  commitAttempt();
}
