import type { AppSnapshot, ContextManifest, SourceRef, Task, ToolCallRecord } from '../domain';
import { fullyObservedNodeIds } from './canvasReadEvidence';
import { graphIndex } from './directGraph';
import { captureNotebookCheck } from './notebookChecks';
import { captureSourceClosure, sourceChanges } from './sourceFreshness';
import { requireValue } from './errors';

export interface ProposalSourceBasis {
  requestId: string;
  notebookId: string | null;
  bindingRevision: number;
  sources: SourceRef[];
}

/** Own receipts may replace a body binding, never its independently frozen children. */
export function requestSourceEvidence(state: AppSnapshot, task: Task, input: ContextManifest, calls: ToolCallRecord[] = []) {
  const sources = structuredClone(input.sourceClosure ?? captureSourceClosure(state, task, input.currentSources ?? []));
  for (const call of calls) {
    const ack = call.noteWriteAcknowledgement;
    if (call.taskId !== task.id || call.status !== 'completed' || !ack || ack.notebookId !== input.notebookCheck?.notebookId) continue;
    for (const source of sources) if (source.kind === 'note' && source.id === ack.noteId && source.tracking !== 'historical') source.version = ack.version;
    // New dependencies of successful own notes must also be checked. Retain all
    // old dependencies even if the note was rewritten without sourceRefs.
    sources.push(...captureSourceClosure(state, task, [{ kind: 'note', id: ack.noteId, version: ack.version, tracking: 'current' }]));
  }
  if (!sources.length) return sources;
  const response = task.responseReadHashes?.stepId === input.stepId ? task.responseReadHashes : undefined;
  const expected = response?.hashes ?? input.canvasReadHashes ?? {};
  const complete = new Set(state.graph ? fullyObservedNodeIds(graphIndex(state, task.canvasId), response?.observations ?? input.canvasChecks ?? []) : []);
  const delivered = [
    ...(input.canvasSources ?? []).filter(s => s.kind === 'node' && complete.has(s.id))
      .map(s => ({ ...s, version: expected[`nodes:${s.id}`] ?? s.version })),
    ...sources.filter(s => s.kind === 'note' && input.toolVersions?.notes[s.id] === s.version),
  ];
  const changes = sourceChanges(state, task, sources, false);
  // Resolve old provenance only with a complete, actually delivered current read.
  // Persist that exact version in proposals, never refresh it when apply arrives.
  for (const change of changes) {
    const fresh = delivered.find(s => change.state === 'changed' && s.kind === change.source.kind && s.id === change.source.id
      && s.tracking !== 'historical' && s.version === change.currentVersion
      && (s.start === undefined || change.source.start !== undefined && s.start <= change.source.start && (s.end ?? 0) >= (change.source.end ?? Infinity))
      && !sourceChanges(state, task, [s], false).length);
    if (fresh) for (const source of sources) if (JSON.stringify(source) === JSON.stringify(change.source)) source.version = fresh.version;
  }
  return [...new Map(sources.map(s => [JSON.stringify(s), s])).values()];
}

/** Notebook additions deliberately do not invalidate a proposal. Finish still
 * checks the collection; only delivered sources and the binding guard writes. */
export function captureProposalSourceBasis(state: AppSnapshot, task: Task, input: ContextManifest, calls: ToolCallRecord[]) {
  requireValue(input.notebookCheck, '缺少原请求的笔记范围，请在新请求中重新规划', 'VERSION_BINDING_REQUIRED',
    { executed: false, nextAction: 'replan_in_next_request' });
  const basis: ProposalSourceBasis = { requestId: input.id, notebookId: input.notebookCheck.notebookId,
    bindingRevision: input.notebookCheck.bindingRevision, sources: requestSourceEvidence(state, task, input, calls) };
  assertProposalSourceBasis(state, task, basis);
  return basis;
}

export function assertProposalSourceBasis(state: AppSnapshot, task: Task, basis: ProposalSourceBasis | undefined) {
  requireValue(basis, '旧提案缺少请求依据，请重新提出修改', 'VERSION_BINDING_REQUIRED', { executed: false, nextAction: 'replan_changes' });
  const current = captureNotebookCheck(state, task);
  requireValue(current.notebookId === basis.notebookId && current.bindingRevision === basis.bindingRevision,
    '本次写入的笔记范围已改变，本次未执行，请重新规划', 'SOURCE_CHANGED', { executed: false, nextAction: 'replan_changes' });
  const changes = sourceChanges(state, task, basis.sources, false);
  requireValue(!changes.length, '已读笔记或其依据已变化，本次未执行；请核对来源后重新规划本次写入', 'SOURCE_CHANGED',
    { executed: false, originRequestId: basis.requestId, sources: changes, nextAction: 'review_sources_and_replan' });
}
