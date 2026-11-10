import type { AppSnapshot, Task } from '../domain';
import type { ContextStage, PromptEntry } from '../contextState';
import type { Evidence } from './historyRepresentations';
import { relevantReviewDecisions, reviewDecisionText, reviewFence } from '../changeReview';
import { digest } from './directGraph';

export function reviewEvidence(state: AppSnapshot, task: Task): Evidence[] {
  return relevantReviewDecisions(state, task.canvasId, task.id).filter(d => d.action === 'revert').map(d => {
    const text = reviewDecisionText(d);
    return { id: d.id, taskId: d.changes[0]?.taskId ?? task.id, text, version: digest(text), reviewDecision: true,
      sources: [], user: false, order: Date.parse(d.createdAt), createdAt: d.createdAt };
  });
}
/** Decisions remain resident until this reader actually carries equivalent receipts/summary. */
export function appendReviewNotices(state: AppSnapshot, task: Task, stage: ContextStage, append: (entry: PromptEntry) => void): void {
  stage.reviewFence = reviewFence(state, task);
  stage.reviewNoticeIds = []; stage.coveredReviewIds = [];
  const calls = [...state.toolCalls, ...state.snapshots.filter(s => !s.revoked).flatMap(s => s.toolCalls ?? [])];
  const covered = (record: { id: string; version: string; text: string }, summaryOnly = false) => stage.entries.some(e => e.category !== 'review'
    && (!summaryOnly || e.representation === 'summary' && e.messages.some(m=>m.content.includes('"userReviews"')&&m.content.includes(record.id)))
    && e.coverage.some(c => c.recordId === record.id && c.version === record.version && c.start === 0 && c.end === record.text.length));
  for (const decision of relevantReviewDecisions(state, task.canvasId, task.id).filter(d => d.action === 'revert')) {
    const text = reviewDecisionText(decision), version = digest(text), entryId = `review-notice:${decision.id}`;
    const absorbed = covered({ id: decision.id, text, version }, true) || decision.changes.every(change => calls.some(call => {
      const receipt = state.contextRetention?.writeReceipts?.[call.originResultId ?? call.id];
      if (!receipt?.decisionIds.includes(decision.id)) return false;
      try { if (JSON.parse(receipt.receipt).changeSetId !== change.changeSetId) return false; } catch { return false; }
      const body = JSON.stringify({ function: call.name, arguments: call.arguments, result: call.result, operationId: call.operationId });
      return covered({ id: call.id, version: digest(body), text: body })&&stage.entries.some(entry=>entry.coverage.some(c=>c.recordId===call.id)
        &&entry.messages.some(message=>message.content.includes(decision.id)));
    }));
    if (absorbed) {
      stage.coveredReviewIds.push(decision.id);
      // Retire only during a rebuild, preserving an already-sent prefix in append mode.
      continue;
    }
    stage.reviewNoticeIds.push(decision.id);
    if(covered({id:decision.id,text,version}))continue;
    append({ id: entryId, category: 'review', lifecycle: 'durable', coverage: [{ recordId: decision.id,
      taskId: decision.changes[0]?.taskId ?? task.id, version, start: 0, end: text.length }], messages: [{ role: 'user', content: text }] });
  }
}
export function commitReviewDelivery(state: AppSnapshot, task: Task, stage: ContextStage): void {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  for (const decision of relevantReviewDecisions(state, task.canvasId, task.id)) {
    const delivered = stage.reviewNoticeIds?.includes(decision.id), covered = stage.coveredReviewIds?.includes(decision.id);
    if (delivered || covered) (workspace.reviewDelivery ??= {})[decision.id] = { delivered: true, covered: !!covered, revision: decision.revision };
  }
}
