import type { AppSnapshot, ContextManifest, SourcePrecondition, Task, ToolCallRecord } from '../domain';
import type { GraphEdge } from '@/v3/types';
import { canvasFactCovered, canvasKey, fullyObservedNodeIds } from './canvasReadEvidence';
import { edgeReadPayload } from './graphReadTables';
import { acknowledgedObservations } from './writeAcknowledgements';
import { hash } from './repository';
import { graphIndex } from './directGraph';
import { captureNotebookCheck } from './notebookChecks';
import { captureSourceClosure, sourceChanges, submittedSourceChanges } from './sourceFreshness';
import { requireValue } from './errors';

export interface ProposalSourceBasis {
  requestId: string;
  notebookId: string | null;
  bindingRevision: number;
  sources: SourcePrecondition[];
  sourceClosureProtocol?: 2;
}

/** Advance only the spans the submitted request knew, or the complete written
 * body. Consult the committed transition rather than any later live edge. */
function advanceCommittedEdges(state: AppSnapshot, task: Task, input: ContextManifest, sources: SourcePrecondition[], writes: ToolCallRecord[]) {
  const edges = sources.filter(s => s.kind === 'edge' && s.tracking !== 'historical' && !s.unavailableReason);
  if (!edges.length) return;
  let observations = input.canvasChecks ?? [];
  for (const call of writes) {
    if (call.name !== 'graph_apply_changes') continue;
    let receipt;
    try { receipt = JSON.parse(call.result ?? 'null'); } catch { continue; }
    if (receipt?.status !== 'committed' || receipt.repeated) continue;
    const change = state.changes.find(c => c.id === receipt.changeSetId && c.operationId === receipt.operationId &&
      c.taskId === task.id && c.status === 'committed');
    if (!change) continue;
    observations = acknowledgedObservations(observations, [call]);
    for (const patch of change.patches) {
      if (patch.collection !== 'edges' || !patch.before || !patch.after) continue;
      const before = hash(patch.before), after = hash(patch.after);
      const affected = edges.filter(s => s.id === patch.id && s.version === before);
      if (!affected.length) continue;
      const fieldVersion = canvasKey(edgeReadPayload(patch.after as GraphEdge));
      const facts = observations.filter(o => !o.evidenceUnknown && !o.historical && o.canvasId === task.canvasId &&
        o.sources.some(s => s.kind === 'edge' && s.id === patch.id && s.version === after)).flatMap(o =>
        (o.canvasFacts ?? []).filter(f => f.refId === patch.id && f.field === 'edge' && f.version === fieldVersion)
          .map(f => ({...f, pointerId: f.pointerId ?? o.canvasPage?.pointerId})));
      for (const source of affected) {
        const range = {refId: source.id, field: 'edge', version: fieldVersion, start: source.start, end: source.end};
        if (canvasFactCovered(range, facts)) source.version = after;
      }
    }
  }
}

/** Own receipts may replace a body binding, never its independently frozen children. */
export function requestSourceEvidence(state: AppSnapshot, task: Task, input: ContextManifest, calls: ToolCallRecord[] = []) {
  const sources:SourcePrecondition[] = structuredClone(input.sourceClosure ?? captureSourceClosure(state, task, input.currentSources ?? []));
  if (input.sourceClosureProtocol !== 2) for (const source of sources) {delete source.documentRead;delete source.summaryField;}
  for (const call of calls) {
    const ack = call.noteWriteAcknowledgement;
    if (call.taskId !== task.id || call.status !== 'completed' || !ack || ack.notebookId !== input.notebookCheck?.notebookId
      || input.sourceClosureProtocol === 2 && call.stepId !== input.stepId) continue;
    for (const source of sources) if (source.kind === 'note' && source.id === ack.noteId && source.tracking !== 'historical') source.version = ack.version;
    // New dependencies of successful own notes must also be checked. Retain all
    // old dependencies even if the note was rewritten without sourceRefs.
    sources.push(...captureSourceClosure(state, task, [{ kind: 'note', id: ack.noteId, version: ack.version, tracking: 'current' }]));
  }
  if (!sources.length) return sources;
  // New manifests already bind every current replacement at submission. Only
  // an acknowledged write in this same response can advance that frozen basis.
  if (input.sourceClosureProtocol === 2) {
    const writes=calls.filter(c=>c.taskId===task.id&&c.stepId===input.stepId&&c.status==='completed'&&c.graphWriteAcknowledgement);
    if (!writes.length) return [...new Map(sources.map(s => [JSON.stringify(s), s])).values()];
    advanceCommittedEdges(state,task,input,sources,writes);
  }
  const response = task.responseReadHashes?.stepId === input.stepId ? task.responseReadHashes : undefined;
  const expected = response?.hashes ?? input.canvasReadHashes ?? {};
  const observations = response?.observations ?? input.canvasChecks ?? [];
  const index = state.graph && graphIndex(state, task.canvasId);
  const complete = new Set(index ? fullyObservedNodeIds(index, observations) : []);
  const delivered = [
    ...(input.canvasSources ?? []).filter(s => s.kind === 'node' && complete.has(s.id))
      .map(s => ({ ...s, version: expected[`nodes:${s.id}`] ?? s.version })),
    ...sources.filter(s => s.kind === 'note' && input.toolVersions?.notes[s.id] === s.version),
  ];
  const changes = submittedSourceChanges(state, task, sources);
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

/** Only delivered sources and the submitted notebook binding guard writes. */
export function captureProposalSourceBasis(state: AppSnapshot, task: Task, input: ContextManifest, calls: ToolCallRecord[]) {
  requireValue(input.notebookCheck, '缺少原请求的笔记范围，请在新请求中重新规划', 'VERSION_BINDING_REQUIRED',
    { executed: false, nextAction: 'replan_in_next_request' });
  const basis: ProposalSourceBasis = { requestId: input.id, notebookId: input.notebookCheck.notebookId,
    bindingRevision: input.notebookCheck.bindingRevision, sources: requestSourceEvidence(state, task, input, calls),
    sourceClosureProtocol: input.sourceClosureProtocol };
  assertProposalSourceBasis(state, task, basis);
  return basis;
}

export function assertProposalSourceBasis(state: AppSnapshot, task: Task, basis: ProposalSourceBasis | undefined) {
  requireValue(basis, '旧提案缺少请求依据，请重新提出修改', 'VERSION_BINDING_REQUIRED', { executed: false, nextAction: 'replan_changes' });
  const current = captureNotebookCheck(state, task);
  requireValue(current.notebookId === basis.notebookId && current.bindingRevision === basis.bindingRevision,
    '本次写入的笔记范围已改变，本次未执行，请重新规划', 'SOURCE_CHANGED', { executed: false, nextAction: 'replan_changes' });
  const changes = basis.sourceClosureProtocol === 2 ? submittedSourceChanges(state, task, basis.sources) : sourceChanges(state,task,basis.sources,false);
  requireValue(!changes.length, '已读笔记或其依据已变化，本次未执行；请核对来源后重新规划本次写入', 'SOURCE_CHANGED',
    { executed: false, originRequestId: basis.requestId, sources: changes, nextAction: 'review_sources_and_replan' });
}
