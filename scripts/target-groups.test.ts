import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useAiStore, getDraft } from '../src/ai/client';
import type { CanvasTargetGroup } from '../src/ai/domain';
import { normalizeInputTargets } from '../src/ai/server/inputTargetGroups';
import { targetGroupRefs } from '../src/ai/targetGroups';
import { allEvidence, currentEntries, snapshotEvidence } from '../src/ai/server/historyRepresentations';
import { taskArchiveRecords } from '../src/ai/server/taskArchive';
import { sessionProgressRecords } from '../src/ai/sessionContext';
import { translateGraphPayload } from '../src/ai/server/graphReferences';
import { acceptTaskSummaries, taskSummaryUnits } from '../src/ai/server/taskSummaryEngine';
import { summaryProjection } from '../src/ai/server/summaryBindings';
import { Repository } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { digest } from '../src/ai/server/directGraph';
import { compactionFixture } from './context-compaction-fixtures';
import { versionFixture } from './context-version-fixtures';

const groups: CanvasTargetGroup[] = [
  { groupId: 'group-a', targetIds: ['n0', 'n1'] },
  { groupId: 'group-b', targetIds: ['n1', 'n2'] },
  { groupId: 'group-c', targetIds: ['n0', 'n1'] },
];

test('groups keep repeated objects and batches while their compatibility projection is unique', () => {
  const input = { targetGroups: [{ groupId: 'first', targetIds: ['n0', 'n0', 'n1'] }, ...groups], targetIds: ['untrusted'] };
  const normalized = normalizeInputTargets(input, new Set(['n0', 'n1', 'n2']));
  assert.deepEqual(normalized.targetGroups, [{ groupId: 'first', targetIds: ['n0', 'n1'] }, ...groups]);
  assert.deepEqual(normalized.targetIds, ['n0', 'n1', 'n2']);
  assert.deepEqual(input.targetGroups[0].targetIds, ['n0', 'n0', 'n1']);
  assert.deepEqual(normalizeInputTargets({ targetIds: ['n0', 'n0', 'outside'] }, new Set(['n0'])), { targetIds: ['n0'], targetGroups: undefined });
  assert.deepEqual(normalizeInputTargets({ targetGroups: groups }, new Set()).targetGroups?.map(group => group.groupId), groups.map(group => group.groupId));
  assert.throws(() => normalizeInputTargets({ targetGroups: [groups[0], groups[0]] }, new Set(['n0'])), /引用组 ID/);
});

test('draft groups are independent per session, repeatable and restore the entire selection', () => {
  useAiStore.setState({ draftsBySession: {}, canvasSelectionRequest: null });
  const store = useAiStore.getState();
  const first = store.addInputGroup('session-a', ['n0', 'n1', 'n0']);
  const second = store.addInputGroup('session-a', ['n0', 'n1']);
  store.addInputGroup('session-b', ['n2']);
  assert.notEqual(first, second);
  assert.deepEqual(getDraft('session-a').targetGroups?.map(group => group.targetIds), [['n0', 'n1'], ['n0', 'n1']]);
  store.requestCanvasSelection('canvas', getDraft('session-a').targetGroups![1].targetIds);
  assert.deepEqual(useAiStore.getState().canvasSelectionRequest, { canvasId: 'canvas', refs: ['n0', 'n1'], sequence: 1 });
  useAiStore.setState({ canvasSelectionRequest: null });
  store.requestCanvasSelection('canvas', ['n2']);
  assert.equal(useAiStore.getState().canvasSelectionRequest?.sequence, 2);
  store.removeInputGroup('session-a', first);
  assert.equal(getDraft('session-a').targetGroups?.[0].groupId, second);
  assert.deepEqual(getDraft('session-b').targetGroups?.[0].targetIds, ['n2']);
});

test('current prompt, archive, progress selections and snapshot evidence preserve every group', () => {
  const { state, task } = versionFixture(3);
  const message = state.messages[0]; message.targetGroups = structuredClone(groups); message.targetRefs = targetGroupRefs(groups);
  const current = currentEntries(state, task).find(entry => entry.category === 'current_request')!;
  const payload = JSON.parse(current.messages[0].content);
  assert.deepEqual(payload.current_message.targetGroups, groups);
  const projected = translateGraphPayload(payload, ref => ref.startsWith('n') ? `short-${ref}` : ref) as typeof payload;
  assert.deepEqual(projected.current_message.targetGroups.map((group: CanvasTargetGroup) => group.targetIds),
    [['short-n0', 'short-n1'], ['short-n1', 'short-n2'], ['short-n0', 'short-n1']]);
  assert.equal(projected.current_message.targetGroups[0].groupId, 'group-a');
  const archived = taskArchiveRecords(state, task).find(record => record.id === message.id)!.original as { targetGroups: CanvasTargetGroup[] };
  assert.deepEqual(archived.targetGroups, groups);
  const progress = sessionProgressRecords(state, task.sessionId).find(record => record.id === message.id)!.content as { targetGroups: CanvasTargetGroup[] };
  assert.deepEqual(progress.targetGroups, groups);
  assert.deepEqual(JSON.parse(snapshotEvidence([message], [], [])[0].text).targetGroups, groups);
});

test('legacy evidence bytes and version hashes remain unchanged', () => {
  const { state, task } = versionFixture(0), message = state.messages[0];
  const before = JSON.stringify({ role: message.role, text: message.text, targetRefs: message.targetRefs, attachments: message.attachments,
    selected_progress: message.selectedProgress, viewedPart: message.viewedPart, viewedPartUnavailable: message.viewedPartUnavailable });
  const record = allEvidence(state, task).find(item => item.id === message.id)!;
  assert.equal(record.text, before);
  assert.equal(record.version, digest([message.version, before]));
  assert.equal(snapshotEvidence([message], [], [])[0].version, record.version);
});

test('accepted summaries preserve amendment groups as exact metadata', () => {
  const { state, task, old } = compactionFixture({ correction: true });
  const message = state.messages.find(item => item.id === 'correction')!;
  message.targetGroups = structuredClone(groups); message.targetRefs = targetGroupRefs(groups);
  const input = taskSummaryUnits(state, task, old.id);
  const summary = acceptTaskSummaries(state, task, [input], { summaries: [{ taskId: old.id,
    unitIds: input.units.map(unit => unit.id), summary: '已保留用户补充及分组。' }] }, 'group-test')[0];
  assert.deepEqual(summary.intermediateUserMessages?.find(item => item.id === message.id)?.targetGroups, groups);
  assert.deepEqual(summaryProjection(state, task, summary).intermediateUserMessages?.find(item => item.id === message.id)?.targetGroups, groups);
  const legacy = structuredClone(summary);
  legacy.intermediateUserMessages?.forEach(item => { delete item.targetGroups; });
  assert.equal('intermediateUserMessages' in summaryProjection(state, task, legacy), false);
  message.targetGroups[0].targetIds.push('later');
  assert.deepEqual(summary.intermediateUserMessages?.find(item => item.id === message.id)?.targetGroups, groups);
});

test('redo rebinds original groups by document identity while preserving amendment and historical groups', async () => {
  for (const legacyBinding of [false, true]) {
    const fixture = versionFixture(3), repo = new Repository(':memory:');
    const graph = fixture.state.graph!;
    graph.documents.shared = { documentId: 'shared', kind: 'document', name: 'Shared', childNodeIds: ['n0', 'n1', 'n2'],
      childDocumentIds: [], placements: Object.fromEntries(['n0', 'n1', 'n2'].map((ref, index) => [ref, { x: 100 + index * 2000, y: 100, source: 'auto' as const }])),
      rev: 1, metadata: { createdAt: '', updatedAt: '', version: '1' } };
    graph.canvases[0].childIds = ['shared'];
    graph.canvases[0].placements = { shared: { x: 0, y: 0, source: 'auto' } };
    repo.transaction(state => { state.graph = graph; state.provider = fixture.state.provider; state.sessions = fixture.state.sessions;
      state.workspaces = fixture.state.workspaces.map(workspace => ({ ...workspace, contextStage: undefined, sessionContext: undefined })); });
    const runtime = new Runtime(repo, async () => { throw new Error('No provider request expected'); });
    runtime.kick = () => {};
    try {
      const task = runtime.send({ sessionId: fixture.task.sessionId, text: '比较原始三组。', clientMessageId: 'original-groups',
        intent: 'new', targetIds: targetGroupRefs(groups), targetGroups: groups, artifactIds: [] });
      const amendment = [{ groupId: 'amendment-only', targetIds: ['n2'] }];
      runtime.send({ sessionId: task.sessionId, text: '补充参考这一组。', clientMessageId: 'amended-group', intent: 'amend',
        targetTaskId: task.id, targetIds: ['n2'], targetGroups: amendment, artifactIds: [] });
      assert.deepEqual(task.inputBindings.targetGroups, groups, 'amendments must not replace the original redo bindings');
      if (legacyBinding) delete task.inputBindings.targetGroups;
      await runtime.mutateGraph({ canvasId: task.canvasId, command: { type: 'replaceDocument', id: 'shared' }, operationId: 'replace-shared' });
      const identityMap = repo.state.events.find(event => event.type === 'graph.document_replaced')!.payload.identityMap as Record<string, string>;
      const rebound = groups.map(group => ({ ...group, targetIds: group.targetIds.map(ref => identityMap[ref]) }));
      assert.ok(rebound.every(group => group.targetIds.every(Boolean)));
      assert.deepEqual(task.inputBindings.targetGroups, rebound);
      assert.deepEqual(repo.state.messages.find(message => message.id === task.rootUserMessageId)!.targetGroups, groups);
      assert.deepEqual(repo.state.messages.find(message => message.id.endsWith(':amended-group'))!.targetGroups, amendment);
      repo.transaction(() => { task.status = 'completed'; });
      const redone = runtime.redoTask(task.id);
      assert.deepEqual(repo.state.messages.find(message => message.id === redone.rootUserMessageId)!.targetGroups, rebound);
    } finally { await runtime.dispose(); repo.close(); }
  }
});

test('send persists groups, retry is idempotent, redo and inherited messages retain groups', async () => {
  const fixture = versionFixture(3), repo = new Repository(':memory:');
  repo.transaction(state => { state.graph = fixture.state.graph; state.provider = fixture.state.provider;
    state.sessions = fixture.state.sessions; state.workspaces = fixture.state.workspaces.map(workspace => ({ ...workspace, contextStage: undefined, sessionContext: undefined })); });
  const runtime = new Runtime(repo, async () => { throw new Error('No provider request expected'); });
  runtime.kick = () => {}; // Exercise synchronous admission and storage without starting a provider run.
  try {
    const input = { sessionId: fixture.task.sessionId, text: '比较第一组与第二组。', clientMessageId: 'group-request', intent: 'new' as const,
      targetIds: targetGroupRefs(groups), targetGroups: groups, artifactIds: [] };
    const task = runtime.send(input);
    const message = repo.state.messages.find(item => item.id === task.rootUserMessageId)!;
    assert.deepEqual(message.targetGroups, groups);
    assert.deepEqual(message.targetRefs, ['n0', 'n1', 'n2']);
    assert.equal(runtime.send(input).id, task.id);
    assert.equal(repo.state.messages.filter(item => item.id === message.id).length, 1);
    const stored = repo.db.prepare("SELECT body FROM records WHERE kind='messages' AND id=?").get(message.id)!;
    assert.deepEqual(JSON.parse(String(stored.body)).targetGroups, groups);
    const manifest = runtime.preview(task);
    assert.ok(JSON.stringify(manifest).includes('group-a'));
    repo.transaction(() => { task.status = 'completed'; task.finishedAt = task.updatedAt; });
    const inherited = new SessionService(repo).create({ canvasId: task.canvasId,
      orderedTasks: [{ sessionId: task.sessionId, taskId: task.id }] });
    const snapshotId = repo.state.workspaces.find(workspace => workspace.id === inherited.workspaceId)!.snapshotIds[0];
    assert.deepEqual(repo.state.snapshots.find(snapshot => snapshot.id === snapshotId)!.messages.find(item => item.id === message.id)!.targetGroups, groups);
    const repeated = runtime.redoTask(task.id);
    assert.deepEqual(repo.state.messages.find(item => item.id === repeated.rootUserMessageId)!.targetGroups, groups);
  } finally { await runtime.dispose(); repo.close(); }
});
