import type { AppSnapshot, ChangeSet, Task, ToolCallRecord } from './domain';
import type { ReviewDecision, ReviewUnit } from './reviewTypes';

export const REVIEW_INSTRUCTION = 'AI提交的修改只按提交失败、提交成功、用户回退理解。graph_apply_changes返回committed即已生效，不需要等待用户批准；界面的待决定或已批准不改变提交结果，也不产生模型通知。graph_propose_changes仅准备提案，尚未提交。用户回退通过后续user_canvas_decision通知追加，压缩后可由回执userReview保留；以通知列出的提交和对象范围为准，部分回退不代表整批撤销。回退通知只列撤销范围，不附当前正文；当前任务需要且没有其他最新完整字段交付时才定点读取。回退是否定对应修改，不得为完成旧计划自行补回，须等用户新要求。以当前画布为准，旧结果和摘要只描述历史。';

export function allReviewChanges(state: Pick<AppSnapshot, 'changes' | 'reviewChanges'>) { return [...state.reviewChanges ?? [], ...state.changes]; }
export function reviewEntries(state: Pick<AppSnapshot, 'changes' | 'reviewChanges'>) {
  return allReviewChanges(state).filter(c => c.status === 'committed' && c.review?.callId)
    .flatMap(change => change.review!.units.map(unit => ({ change, unit })))
    .sort((a, b) => (a.change.review!.sequence ?? 0) - (b.change.review!.sequence ?? 0));
}
export function reviewGroups(state: Pick<AppSnapshot, 'canvasReviewStates'>) {
  return Object.values(state.canvasReviewStates ?? {}).flatMap(w => w.groups ?? []);
}
/** Membership changes affect the member, not every sibling sharing its container. */
export function reviewUnitRefs(unit: ReviewUnit): string[] {
  return [...new Set([...unit.refs,...unit.provides,...unit.removes,...unit.deltas.filter(d=>!d.layout)
    .flatMap(d=>d.member?[d.member]:d.collection==='edges'?[d.id]:[])])];
}
/** UI review state only; pending/approved are not model-facing write outcomes. */
export function reviewFooter(change: ChangeSet) {
  const review = change.review;
  if (!review?.callId) return undefined;
  const counts = { pending: 0, approved: 0, reverted: 0 };
  review.units.forEach(u => counts[u.state]++);
  const states = (Object.keys(counts) as Array<keyof typeof counts>).filter(k => counts[k]);
  return { revision: review.revision, state: states.length === 1 ? states[0] : 'mixed',
    decisionIds: review.decisionIds ?? [], ...(states.length > 1 ? { counts } : {}) };
}
/** Original results, including legacy footers, are immutable historical evidence. */
export function reviewedCallResult(_state: Pick<AppSnapshot, 'changes'>, call: ToolCallRecord): string | undefined {
  return call.result;
}
/** Project legacy application review metadata without exposing approval bookkeeping. */
export function rollbackReview(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const review = value as Record<string, unknown>;
  const counts = review.counts && typeof review.counts === 'object' && !Array.isArray(review.counts)
    ? review.counts as Record<string, unknown> : {};
  const count = (n: unknown): number => Number.isSafeInteger(n) && (n as number) > 0 ? n as number : 0;
  const revertedUnits = count(review.revertedUnits) || count(counts.reverted);
  if (review.state !== 'reverted' && !(review.state === 'mixed' && revertedUnits)) return;
  const partial = review.scope === 'partial' || review.state === 'mixed';
  const totalUnits = count(review.totalUnits) || count(counts.pending) + count(counts.approved) + count(counts.reverted);
  return { revision: typeof review.revision === 'number' && Number.isSafeInteger(review.revision) && review.revision >= 0 ? review.revision : 1,
    state: 'reverted' as const,
    decisionIds: Array.isArray(review.decisionIds) ? review.decisionIds.filter((id: unknown): id is string => typeof id === 'string') : [],
    ...(partial ? { scope: 'partial' as const, ...(revertedUnits ? { revertedUnits } : {}), ...(totalUnits ? { totalUnits } : {}) } : {}) };
}
export function allReviewDecisions(state: Pick<AppSnapshot,'changes'|'canvasReviewStates'>): ReviewDecision[] {
  const recorded = Object.values(state.canvasReviewStates ?? {}).flatMap(w => w.decisions ?? []);
  const known = new Set(recorded.flatMap(d => d.changes.flatMap(c => c.unitIds)));
  // Existing installations may have decisions without an independent ledger.
  const legacy = state.changes.filter(c => c.review?.callId).flatMap(c => {
    const units = c.review!.units.filter(u => u.state === 'reverted' && !known.has(u.id));
    return units.length ? [{ id: `legacy-review:${c.id}`, canvasId: c.review!.canvasId, revision: units.length,
      action: 'revert' as const, createdAt: units.at(-1)!.decidedAt ?? c.createdAt, groupIds: [],
      refs: [...new Set(units.flatMap(u => [...u.refs, ...u.provides, ...u.removes]))], affectedCanvasIds: c.affectedCanvasIds,
      changes: [{ changeSetId: c.id, taskId: c.taskId, unitIds: units.map(u => u.id), source: 'user' as const }] }] : [];
  });
  return [...recorded, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function relevantReviewDecisions(state: AppSnapshot, canvasId: string, taskId?: string) {
  const task = state.tasks.find(t => t.id === taskId), workspace = state.workspaces.find(w => w.id === task?.workspaceId);
  const inherited = new Set(state.snapshots.filter(s => workspace?.snapshotIds.includes(s.id) && !s.revoked)
    .flatMap(s => [...s.operations.map(c => c.id), ...(s.toolCalls ?? []).flatMap(c => {
      try { return c.name === 'graph_apply_changes' ? [JSON.parse(c.result ?? '{}').changeSetId] : []; } catch { return []; }
    })]));
  const retired = new Set(state.reviewChanges?.map(c => c.id));
  return allReviewDecisions(state).filter(d => d.changes.some(c => !retired.has(c.changeSetId))).filter(d => d.canvasId === canvasId || d.affectedCanvasIds.includes(canvasId)
    || d.changes.some(c => c.taskId === taskId || inherited.has(c.changeSetId)));
}
export function reviewDecisionText(decision: ReviewDecision): string {
  return JSON.stringify({ user_canvas_decision: { id: decision.id, revision: decision.revision,
    state: 'reverted', groupIds: decision.groupIds, changeSetIds: decision.changes.map(c => c.changeSetId),
    affectedRefs: decision.refs, decidedAt: decision.createdAt }, instruction: REVIEW_INSTRUCTION });
}
export function reviewFence(state: AppSnapshot, task: Task): string {
  return JSON.stringify(relevantReviewDecisions(state, task.canvasId, task.id).filter(d => d.action === 'revert').map(d => [d.id, d.revision]));
}
/** Convert UI hits into public selections without allowing a partial new group. */
export function reviewSelection(state: AppSnapshot, unitIds: string[]) {
  const ids = new Set(unitIds), entries = reviewEntries(state).filter(e => ids.has(e.unit.id));
  return { groupIds: [...new Set(entries.flatMap(e => e.change.review?.policy === 'group' && e.change.review.groupId ? [e.change.review.groupId] : []))],
    unitIds: entries.filter(e => e.change.review?.policy !== 'group').map(e => e.unit.id) };
}
export function expandReviewSelection(state: AppSnapshot, unitIds: string[]): string[] {
  const selection = reviewSelection(state, unitIds), groups = new Set(selection.groupIds);
  return reviewEntries(state).filter(e => e.unit.state === 'pending' && (selection.unitIds.includes(e.unit.id)
    || !!e.change.review?.groupId && groups.has(e.change.review.groupId))).map(e => e.unit.id);
}
export function reviewDecisionCount(state: AppSnapshot, unitIds: string[]): number {
  const selection=reviewSelection(state,unitIds);return selection.groupIds.length+selection.unitIds.length;
}
export function reviewUiVersion(state: AppSnapshot | null | undefined, canvasId: string, ids: string[]): string {
  return JSON.stringify([canvasId, [...ids].sort(), state?.graphRevision,
    Object.entries(state?.canvasReviewStates ?? {}).map(([id,w]) => [id,w.revision])]);
}
