import assert from 'node:assert/strict';
import type { Session, Task, ToolCallRecord, Workspace } from '../src/ai/domain';
import { registerSessionTask } from '../src/ai/sessionContext';
import { buildAutomaticContext } from '../src/ai/server/automaticContext';
import { directGraphRead } from '../src/ai/server/directGraph';
import { allEvidence, fullCoverage, makeSummary } from '../src/ai/server/historyRepresentations';
import { emptyState } from '../src/ai/server/repository';
import { emptyGraph } from '../src/v3/storage';

export const stamp = '2026-11-15T00:00:00.000Z';
export const originalContent = (i: number) => `Original body ${i}. ${'Evidence text. '.repeat(8)}`;
export const encode = (id: string) => id;

/** In-memory state with actual graph_read deliveries; no repository or provider is opened. */
export function versionFixture(count = 6) {
  const state = emptyState();
  state.graph = emptyGraph();
  state.provider.contextWindow = 400000;
  state.provider.maxOutputTokens = 4096;
  const canvasId = state.graph.canvases[0].canvasId;
  const session: Session = { id: 'version-session', canvasId, workspaceId: 'version-workspace', mode: 'explore',
    title: 'Version regression', lifecycle: 'active', createdAt: stamp };
  const workspace: Workspace = { id: session.workspaceId, sessionId: session.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] };
  const task: Task = { id: 'version-task', sessionId: session.id, workspaceId: workspace.id, canvasId,
    rootUserMessageId: 'version-user', clientRequestId: 'version-request', instructionRevision: 1, appliedInstructionRevision: 1,
    status: 'running', createdAt: stamp, updatedAt: stamp, inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} },
    maxSteps: 100, maxTokens: 1000000, usedTokens: 0, stepCount: 1, fencingToken: 0 };
  state.sessions.push(session);
  state.workspaces.push(workspace);
  state.tasks.push(task);
  registerSessionTask(state, session.id, task.id);
  state.messages.push({ id: task.rootUserMessageId, taskId: task.id, workspaceId: workspace.id, role: 'user',
    text: 'Read the nodes and identify changes.', version: 1, status: 'complete', phase: 'request', createdAt: stamp,
    sequence: 1, targetRefs: [], sourceRefs: [], relatedOperationIds: [] });
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    state.graph.nodes[id] = { nodeId: id, name: `Node ${i}`, content: originalContent(i) };
    state.graph.canvases[0].childIds.push(id);
  }
  state.steps.push({ id: 'version-step', taskId: task.id, runId: 'version-run', ordinal: 1, purpose: 'agent', status: 'completed',
    inputInstructionRevision: 1, contextManifestId: 'version-manifest', provider: 'offline', model: 'offline', createdAt: stamp, completedSequence: 10000 });
  for (let i = 0; i < count; i++) {
    const call: ToolCallRecord = { id: `read-${i}`, providerCallId: `read-${i}`, operationId: `op-${i}`, taskId: task.id,
      stepId: 'version-step', name: 'graph_read', arguments: JSON.stringify({ refs: [`n${i}`] }), status: 'prepared', createdAt: stamp, sequence: i + 2 };
    state.toolCalls.push(call);
    call.result = JSON.stringify(directGraphRead(state, task, call, { refs: [`n${i}`] }));
    call.status = 'completed';
    assert.ok(call.canvasOrigins?.length, 'The fixture must retain verified graph deliveries');
  }
  workspace.contextStage = buildAutomaticContext(state, task, [], encode).stageDraft;
  assert.ok(workspace.contextStage);
  return { state, task, workspace };
}

export function addVersionSummary({ state, task, workspace }: ReturnType<typeof versionFixture>) {
  // Five settled later groups release the original reads from recent-group protection.
  for (const call of state.toolCalls) call.presentedAt = Date.parse(stamp);
  for (let i = 2; i <= 6; i++) state.steps.push({ ...state.steps[0], id: `later-step-${i}`, ordinal: i, completedSequence: 10000 + i });
  const records = allEvidence(state, task).filter(record => record.id.startsWith('read-'));
  assert.equal(records.length, state.toolCalls.length);
  const summary = makeSummary('task', 'Previously read node bodies.', records.map(fullCoverage), [], records.flatMap(record => record.sources));
  workspace.summaries = [summary];
  return summary;
}
