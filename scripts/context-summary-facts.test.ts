import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContextManifest, ModelStep, Task, ToolCallRecord } from '../src/ai/domain';
import type { ContextStage, SummarySnapshot } from '../src/ai/contextState';
import { emptyState } from '../src/ai/server/repository';
import { directGraphRead, digest } from '../src/ai/server/directGraph';
import { directContextRead } from '../src/ai/server/directContextReads';
import { allEvidence, fullCoverage } from '../src/ai/server/historyRepresentations';
import { summaryProjection } from '../src/ai/server/summaryBindings';
import { summaryReceiptFacts } from '../src/ai/server/summaryReceiptFacts';
import { acknowledgeReadDelivery } from '../src/ai/server/readDelivery';
import { visibleTaskPages, verifiedDeliveryPage } from '../src/ai/server/readDeliveryEvidence';
import { visibleObservations } from '../src/ai/server/contextFreshness';
import { hasCompleteNodeRead } from '../src/ai/server/nodeReadEvidence';
import { emptyGraphReferences, graphReferenceCodec, seedAddressableReferences, seedPayloadReferences, translateGraphPayload } from '../src/ai/server/graphReferences';
import { projectPromptEntries } from '../src/ai/server/promptProjection';
import { reviewDecisionText } from '../src/ai/changeReview';
import { RETENTION_POLICY_VERSION } from '../src/ai/server/readVisibility';
import { estimateTokens } from '../src/ai/tokens';
import { attachmentRead } from '../src/ai/server/attachmentReads';
import type { ImageAssetRef } from '../src/ai/attachments';

const stamp = '2026-11-15T00:00:00.000Z';
function fixture() {
  const state = emptyState(), canvasId = 'private-canvas-summary-test';
  const ids = Array.from({ length: 12 }, (_, i) => `private-node-summary-test-${i}`);
  state.graph = { layoutVersion: 3, documents: {}, nodes: Object.fromEntries(ids.map((id, i) => [id,
    { nodeId: id, name: `Node ${i}`, content: `Body ${i} `.repeat(60) }])), edges: [],
    canvases: [{ canvasId, canvasName: 'Test', childIds: ids, directories: {}, collapsed: {}, placements: {}, updatedAt: stamp }] };
  state.provider.contextWindow = 1000000;
  state.provider.maxOutputTokens = 4096;
  state.sessions.push({ id: 'private-session-test', canvasId, workspaceId: 'private-workspace-test', mode: 'explore', title: 'Test', lifecycle: 'active', createdAt: stamp });
  state.workspaces.push({ id: 'private-workspace-test', sessionId: 'private-session-test', workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] });
  const task: Task = { id: 'private-task-test', sessionId: 'private-session-test', workspaceId: 'private-workspace-test', canvasId,
    rootUserMessageId: 'private-user-test', clientRequestId: 'test', instructionRevision: 1, appliedInstructionRevision: 1, status: 'running', createdAt: stamp, updatedAt: stamp,
    inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} }, maxSteps: 100, maxTokens: 1000000, usedTokens: 0, stepCount: 0, fencingToken: 0 };
  state.tasks.push(task);
  const read = (name: string, args: Record<string, unknown>, acknowledge = true, images?: ImageAssetRef[]) => {
    const sequence = state.toolCalls.length + 1;
    const call: ToolCallRecord = { id: `private-call-test-${sequence}`, providerCallId: `provider-${sequence}`, taskId: task.id,
      stepId: `step-${sequence}`, operationId: `operation-${sequence}`, name, arguments: JSON.stringify(args), status: 'prepared', createdAt: stamp, sequence };
    state.toolCalls.push(call);
    // Execute the actual production readers. The fixtures never invent a result or page proof.
    const result = name.startsWith('graph_') ? directGraphRead(state, task, call, args)
      : name === 'workspace_view_artifact' ? attachmentRead(state, task, call, args, images) : directContextRead(state, task, call, args);
    call.result = JSON.stringify(result); call.status = 'completed';
    if (acknowledge) {
      const step = { id: call.stepId, taskId: task.id, ordinal: sequence, status: 'completed', completedSequence: sequence } as ModelStep;
      acknowledgeReadDelivery(state, { id: `manifest-${sequence}`, messages: [], readBodyResultIds: [call.id] } as unknown as ContextManifest, step);
    }
    return { call, result: result as Record<string, any> };
  };
  const summary = (calls = state.toolCalls): SummarySnapshot => {
    const wanted = new Set(calls.map(c => c.id));
    return { id: 'private-summary-test', version: '1', semanticType: 'task', text: '已检查部分历史资料。', children: [], sourceRefs: [], createdAt: stamp,
      retentionPolicyVersion: RETENTION_POLICY_VERSION, coverage: allEvidence(state, task).filter(r => wanted.has(r.id)).map(fullCoverage) };
  };
  return { state, task, ids, read, summary };
}
type Fixture = ReturnType<typeof fixture>;
function firstPage(env: Fixture) {
  const first = env.read('graph_read', { refs: env.ids, budget: 1200 });
  assert.equal(first.result.status, 'ok');
  assert.ok(first.result.totalPages >= 3, 'fixture must use actual multiple native pages');
  assert.ok(verifiedDeliveryPage(env.state, first.call, first.result));
  return first;
}
function stageFor(task: Task, summary: SummarySnapshot, projection: unknown): ContextStage {
  return { version: 1, generation: 1, taskId: task.id, entries: [{ id: 'summary-entry', category: 'history', coverage: summary.coverage,
    representation: 'summary', messages: [{ role: 'user', content: JSON.stringify({ historical_material: projection }) }] }],
    eventIds: [], protectedCoverage: [], residentRoots: [summary.id], noteVersions: {}, pinnedHash: '', sourceRevision: '', policyRevision: '', sentIds: [], lastCompactionStep: 0 };
}

test('native graph_read and context_read_pages retain only actually delivered first/last pages', () => {
  const env = fixture(), first = firstPage(env);
  env.read('context_read_pages', { pointerId: first.result.pointerId, page: first.result.totalPages });
  const summary = env.summary(), projection = summaryProjection(env.state, env.task, summary);
  assert.deepEqual(projection.historicalReadPages?.map(p => p.page), [1, first.result.totalPages]);
  assert.ok(projection.historicalReadPages?.every(p => p.totalPages === first.result.totalPages && p.freshnessAtDelivery === 'current'));
  assert.equal(projection.content, summary.text);
  assert.equal(JSON.stringify(projection).includes('allPagesRead'), false);
  assert.match(projection.readPageInstruction!, /末页不代表已读全量/);
});

test('production unknown freshness remains unknown, while stale deliveries remain historical', () => {
  const env = fixture(), first = firstPage(env), frozen = env.state.workspaces[0].frozenReads!.find(r => r.id === first.result.pointerId)!;
  const observations = frozen.pageObservations;
  delete frozen.pageObservations;
  const unknown = env.read('context_read_pages', { pointerId: frozen.id, page: 2 });
  assert.equal(unknown.result.freshness, 'unknown'); assert.equal(unknown.result.stale, undefined);
  frozen.pageObservations = observations;
  env.state.graph!.nodes[env.ids[0]].content += ' changed';
  const stale = env.read('context_read_pages', { pointerId: frozen.id, page: 2 });
  assert.equal(stale.result.freshness, 'stale');
  const facts = summaryReceiptFacts(env.state, env.task, env.summary());
  assert.deepEqual(facts.map(p => p.freshnessAtDelivery), ['current', 'unknown', 'stale']);
  assert.ok(facts.every(p => !Object.hasOwn(p, 'stale')));
});

test('new source versions keep different native frozen pointers and are never unioned', () => {
  const env = fixture(), old = firstPage(env);
  env.state.graph!.nodes[env.ids[0]].content += ' changed';
  const current = firstPage(env);
  assert.notEqual(old.result.pointerId, current.result.pointerId);
  const facts = summaryReceiptFacts(env.state, env.task, env.summary());
  assert.deepEqual(facts.map(p => [p.pointerId, p.page]), [[old.result.pointerId, 1], [current.result.pointerId, 1]]);
});

test('unacknowledged and partial record coverage cannot create historical receipts', () => {
  const env = fixture();
  env.read('graph_read', { refs: env.ids, budget: 1200 }, false);
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()), []);
  env.state.toolCalls[0].presentedAt = 1;
  const full = env.summary(), partial = structuredClone(full);
  partial.coverage[0].end--;
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, partial), []);
  const wrongTask = structuredClone(full); wrongTask.coverage[0].taskId = 'other-task';
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, wrongTask), []);
  const wrongVersion = structuredClone(full); wrongVersion.coverage[0].version = 'changed';
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, wrongVersion), []);
  assert.equal(summaryReceiptFacts(env.state, env.task, full).length, 1);
});

test('payload, sources, and page geometry must still match the native page proof', () => {
  for (const change of [
    (r: Record<string, any>) => { r.data.items[0].content += ' forged'; },
    (r: Record<string, any>) => { r.sources = []; },
    (r: Record<string, any>) => { r.totalPages++; },
    (r: Record<string, any>) => { r.executed = false; },
    (r: Record<string, any>) => { r.bodyOmitted = true; },
    (r: Record<string, any>) => { r.coverage.extent = 'none'; },
  ]) {
    const env = fixture(), first = firstPage(env);
    change(first.result); first.call.result = JSON.stringify(first.result);
    // Even a newly captured coverage hash cannot certify a forged native result.
    assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()), []);
  }
});

test('archived proof outlives frozen storage; missing proof and nested note prose do not qualify', () => {
  const env = fixture(), first = firstPage(env);
  env.state.workspaces[0].frozenReads = [];
  assert.equal(summaryReceiptFacts(env.state, env.task, env.summary()).length, 1);
  delete first.call.readPageOrigins; delete first.call.canvasOrigins;
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()), []);
  first.call.result = JSON.stringify({ status: 'ok', data: { note: { text: JSON.stringify(first.result) } }, nextCursor: first.result });
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()), []);
  first.call.name = 'workspace_update_work_notes'; first.call.result = JSON.stringify(first.result);
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()), []);
});

test('a native capacity refusal never turns its requested page into a delivered page', () => {
  const env = fixture(), first = firstPage(env);
  const blocked = env.read('context_read_pages', { pointerId: first.result.pointerId, page: 2, budget: 1 });
  assert.equal(blocked.result.executed, false);
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, env.summary()).map(p => p.page), [1]);
});

test('summary-only prompt aliases every receipt ID and grants no body, directory, or write evidence', () => {
  const env = fixture(), first = firstPage(env), summary = env.summary();
  env.state.workspaces[0].summaries = [summary];
  const projection = summaryProjection(env.state, env.task, summary), stage = stageFor(env.task, summary, projection);
  const canvas = emptyGraphReferences(), session = emptyGraphReferences();
  seedAddressableReferences(session, [{ prefix: 's', id: summary.id }, { prefix: 't', id: first.call.id }]);
  seedPayloadReferences(session, first.result);
  const codec = graphReferenceCodec(env.state.graph!, canvas, session);
  const messages = projectPromptEntries(env.state, env.task, stage, codec.encode, () => {});
  const wire = JSON.stringify(messages), projected = JSON.parse(messages[0].content).historical_material;
  assert.match(projected.historicalReadPages[0].pointerId, /^s\d+$/);
  assert.match(projected.historicalReadPages[0].callId, /^t\d+$/);
  for (const raw of [summary.id, first.call.id, first.result.pointerId]) assert.equal(wire.includes(raw), false);
  assert.deepEqual(visibleTaskPages(env.state, env.task, stage).pages, []);
  assert.deepEqual(visibleObservations(stage, env.state.workspaces[0].observations ?? [], env.task, env.state.toolCalls, env.state), []);
  delete env.task.nodeReadEvidence;
  acknowledgeReadDelivery(env.state, { id: 'summary-only', messages, stageDraft: stage, readBodyResultIds: [] } as unknown as ContextManifest,
    { id: 'summary-step', taskId: env.task.id, ordinal: 10, status: 'completed', completedSequence: 10 } as ModelStep);
  assert.ok(env.ids.every(id => !hasCompleteNodeRead(env.task, env.state.graph!.nodes[id])));
  assert.equal(env.task.nodeReadEvidence, undefined);
});

test('encoded native envelopes are verified through the existing codec and output canonical identities', () => {
  const env = fixture(), first = firstPage(env), canvas = emptyGraphReferences(), session = emptyGraphReferences();
  seedPayloadReferences(session, first.result);
  env.state.canvasGraphReferences[env.task.canvasId] = canvas; env.state.sessionReferences![env.task.sessionId] = session;
  const codec = graphReferenceCodec(env.state.graph!, canvas, session);
  first.call.result = JSON.stringify(translateGraphPayload(first.result, codec.encode));
  const facts = summaryReceiptFacts(env.state, env.task, env.summary());
  assert.equal(facts.length, 1); assert.equal(facts[0].pointerId, first.result.pointerId);
});

test('native summary-tree reads and repeated page copies do not replay nested receipt facts as body reads', () => {
  const env = fixture(), first = firstPage(env), source = env.summary();
  env.state.workspaces[0].summaries = [source];
  delete env.task.nodeReadEvidence;
  const tree = env.read('context_read_summary_tree', { summaryId: source.id, budget: 4000 });
  assert.equal(tree.result.status, 'ok');
  assert.equal(tree.result.data.tree.historicalReadPages[0].pointerId, first.result.pointerId);
  const copy = env.read('context_read_pages', { pointerId: tree.result.pointerId, page: 1 });
  assert.equal(copy.result.status, 'ok');
  const facts = summaryReceiptFacts(env.state, env.task, env.summary([tree.call, copy.call]));
  assert.equal(facts.length, 2);
  assert.ok(facts.every(f => f.pointerId === tree.result.pointerId && f.representation === 'summary' && f.freshnessAtDelivery === 'unknown'));
  assert.equal(env.task.nodeReadEvidence, undefined);
  assert.ok(env.ids.every(id => !hasCompleteNodeRead(env.task, env.state.graph!.nodes[id])));
});

test('fragmented context_read_children and page copies stay summaries after frozen storage is reclaimed', () => {
  const env = fixture(); firstPage(env);
  const child = env.summary(); child.text = '历史摘要保留条件。'.repeat(1000);
  const parent = { ...child, id: 'parent-summary', text: '父摘要', children: [child.id] };
  env.state.workspaces[0].summaries = [child, parent];
  delete env.task.nodeReadEvidence;
  const children = env.read('context_read_children', { summaryId: parent.id, budget: 4000 });
  assert.equal(children.result.status, 'ok');
  assert.ok(children.result.totalPages > 1);
  assert.equal(typeof children.result.data.items[0].serializedResult, 'string');
  assert.equal(children.call.readPageOrigins![0].kind, 'history');
  const copy = env.read('context_read_pages', { pointerId: children.result.pointerId, page: 2 });
  const summary = env.summary([children.call, copy.call]);
  const before = summaryReceiptFacts(env.state, env.task, summary);
  assert.deepEqual(before.map(f => f.representation), ['summary', 'summary']);
  env.state.workspaces[0].frozenReads = [];
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, summary), before);
  assert.equal(env.task.nodeReadEvidence, undefined);
  // Incomplete legacy provenance can verify page bytes without proving their type.
  delete children.call.summaryOrigins; delete copy.call.summaryOrigins;
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, summary).map(f => f.representation), ['unknown', 'unknown']);
});

test('native attachment index and image pages keep their types after frozen storage is reclaimed', () => {
  const env = fixture(), artifactId = 'test-image-artifact';
  env.state.artifacts.push({ id: artifactId, workspaceId: env.task.workspaceId, name: 'Fixture image', mimeType: 'image/png', version: 1,
    createdAt: stamp, status: 'ready', size: 100, hash: 'fixture-image', chunks: [], width: 16, height: 16, visualState: 'available' });
  env.task.inputBindings.artifactIds = [artifactId]; env.task.inputBindings.artifactVersions = { [artifactId]: 1 };
  env.state.provider.supportsVision = true;
  const catalog = env.read('context_read_task_attachments', { budget: 4000 });
  const image = env.read('workspace_view_artifact', { artifactId, budget: 4000 }, true,
    [{ assetId: 'fixture-image-asset', artifactId, version: 1, mimeType: 'image/png', width: 16, height: 16 }]);
  const copy = env.read('context_read_pages', { pointerId: image.result.pointerId, page: 1, budget: 4000 });
  for (const delivery of [catalog, image, copy]) assert.equal(delivery.result.status, 'ok');
  const summary = env.summary(), before = summaryReceiptFacts(env.state, env.task, summary);
  assert.deepEqual(before.map(f => f.representation), ['index', 'image', 'image']);
  env.state.workspaces[0].frozenReads = [];
  for (const call of env.state.toolCalls) delete call.attachmentRead;
  assert.deepEqual(summaryReceiptFacts(env.state, env.task, summary), before);
});

test('opaque native attachment fragments need retained representation metadata after cleanup', () => {
  const env = fixture(), artifactId = 'test-text-artifact', text = 'needle text '.repeat(1000);
  env.state.artifacts.push({ id: artifactId, workspaceId: env.task.workspaceId, name: 'Fixture text', mimeType: 'text/plain', version: 1,
    createdAt: stamp, status: 'ready', size: text.length, hash: digest(text), chunks: [{ id: 'text-chunk', ordinal: 0, start: 0, end: text.length, text, hash: digest(text) }] });
  env.task.inputBindings.artifactIds = [artifactId]; env.task.inputBindings.artifactVersions = { [artifactId]: 1 };
  // A large native query header exercises resultPaging's opaque JSON fallback.
  const search = env.read('workspace_search_artifacts', { artifactId, query: 'needle '.repeat(1500), budget: 4000 });
  assert.equal(search.result.status, 'ok');
  assert.equal(typeof search.result.data.serializedResult, 'string');
  const summary = env.summary();
  assert.equal(summaryReceiptFacts(env.state, env.task, summary)[0].representation, 'body');
  env.state.workspaces[0].frozenReads = [];
  assert.equal(summaryReceiptFacts(env.state, env.task, summary)[0].representation, 'body');
  delete search.call.attachmentRead;
  assert.equal(summaryReceiptFacts(env.state, env.task, summary)[0].representation, 'unknown');
});

test('facts are scoped to the summary, preserve user reversions, and have no silent size cap', () => {
  const env = fixture(), first = firstPage(env), onlyFirst = env.summary();
  for (let page = 2; page <= first.result.totalPages; page++) env.read('context_read_pages', { pointerId: first.result.pointerId, page });
  assert.equal(summaryReceiptFacts(env.state, env.task, onlyFirst).length, 1);
  const summary = env.summary();
  const decision = { id: 'review-test', canvasId: env.task.canvasId, revision: 1, action: 'revert' as const, createdAt: stamp,
    groupIds: [], refs: [env.ids[0]], affectedCanvasIds: [env.task.canvasId], changes: [{ changeSetId: 'change-test', taskId: env.task.id, unitIds: ['unit-test'], source: 'user' as const }] };
  env.state.canvasReviewStates = { [env.task.canvasId]: { revision: 1, taskIds: [env.task.id], decisions: [decision] } };
  const text = reviewDecisionText(decision);
  summary.coverage.push({ recordId: decision.id, taskId: env.task.id, version: digest(text), start: 0, end: text.length });
  const projection = summaryProjection(env.state, env.task, summary);
  assert.deepEqual(projection.userReviews, [JSON.parse(text).user_canvas_decision]);
  assert.equal(projection.historicalReadPages?.length, first.result.totalPages);
  assert.ok(estimateTokens(JSON.stringify(projection)) > estimateTokens(summary.text));
  const changed = structuredClone(env.state); changed.toolCalls[0].result += ' changed';
  assert.equal(summaryReceiptFacts(changed, env.task, summary).length, first.result.totalPages - 1);
});

test('a covered read from another session is not projected without authorized inheritance', () => {
  const env = fixture(); firstPage(env);
  const summary = env.summary(); env.state.tasks[0].sessionId = 'other-session';
  const viewer = { ...env.task, id: 'viewer-task', sessionId: 'private-session-test' };
  assert.deepEqual(summaryReceiptFacts(env.state, viewer, summary), []);
});

test('inherited native receipts require the currently authorized, non-revoked snapshot', () => {
  const env = fixture(), first = firstPage(env), summary = env.summary();
  const viewer = { ...env.task, id: 'viewer-task', workspaceId: 'viewer-workspace', sessionId: 'viewer-session' };
  env.state.tasks.push(viewer);
  env.state.sessions.push({ ...env.state.sessions[0], id: viewer.sessionId, workspaceId: viewer.workspaceId });
  const workspace = { id: viewer.workspaceId, sessionId: viewer.sessionId, workNotes: [], pinnedNotes: [], snapshotIds: ['inherited-snapshot'], artifactIds: [] };
  env.state.workspaces.push(workspace);
  const snapshot = { id: 'inherited-snapshot', sourceSessionId: env.task.sessionId, sourceTaskIds: [env.task.id], cutoffSeq: 1,
    messages: [{ id: 'source-message', workspaceId: env.task.workspaceId, taskId: env.task.id, role: 'user' as const, text: 'Read the source.', version: 1,
      status: 'complete' as const, phase: 'request' as const, createdAt: stamp, relatedOperationIds: [], targetRefs: [], sourceRefs: [] }],
    operations: [], notes: [], sourceRefs: [], contentHash: 'source-hash', createdAt: stamp, toolCalls: [structuredClone(first.call)], revoked: false };
  env.state.snapshots.push(snapshot);
  assert.equal(summaryReceiptFacts(env.state, viewer, summary).length, 1);
  snapshot.revoked = true;
  assert.deepEqual(summaryReceiptFacts(env.state, viewer, summary), []);
  snapshot.revoked = false; workspace.snapshotIds = [];
  assert.deepEqual(summaryReceiptFacts(env.state, viewer, summary), []);
});

test('a final projection rechecks deleted proof after an asynchronous boundary', async () => {
  const env = fixture(), first = firstPage(env), summary = env.summary();
  assert.equal(summaryProjection(env.state, env.task, summary).historicalReadPages?.length, 1);
  await Promise.resolve();
  env.state.workspaces[0].frozenReads = [];
  delete first.call.readPageOrigins; delete first.call.canvasOrigins;
  const projection = summaryProjection(env.state, env.task, summary);
  assert.equal(projection.historicalReadPages, undefined);
  assert.equal(projection.readPageInstruction, undefined);
});

test('all verified records remain present even when their receipts exceed the summary text budget', () => {
  const env = fixture(), first = firstPage(env);
  for (let i = 0; i < 128; i++) env.read('context_read_pages', { pointerId: first.result.pointerId, page: 1 });
  const projection = summaryProjection(env.state, env.task, env.summary());
  assert.equal(projection.historicalReadPages?.length, 129);
  assert.ok(estimateTokens(JSON.stringify(projection.historicalReadPages)) > 4000);
});
