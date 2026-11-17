import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppSnapshot, ContextManifest, Task } from '../src/ai/domain';
import type { ContextStage } from '../src/ai/contextState';
import { buildAutomaticContext } from '../src/ai/server/automaticContext';
import { canvasNoticeLabels, canvasObservationChanges, pendingCanvasChanges, visibleCanvasEvidence } from '../src/ai/server/contextFreshness';
import { renderNoticeFacts } from '../src/ai/server/contextUpdates';
import { graphReadContext } from '../src/ai/server/graphReadContext';
import { currentObservationReadHashes } from '../src/ai/server/graphReadDependencies';
import { captureNoticeState } from '../src/ai/server/noticeMaintenance';
import { noteVersionNotices } from '../src/ai/server/noteFreshness';
import { projectPromptEntries } from '../src/ai/server/promptProjection';
import { requestTokens } from '../src/ai/server/providers';
import { previewReceipts } from '../src/ai/server/readVisibility';
import { summarySourceEvidence } from '../src/ai/server/summaryFreshness';
import { previewWriteReceipts } from '../src/ai/server/writeReceipts';
import { addVersionSummary, encode, originalContent, versionFixture } from './context-version-fixtures';

function candidateState(state: AppSnapshot, stage: ContextStage) {
  const draft = stage.retentionDraft;
  return draft ? previewWriteReceipts(previewReceipts(state, draft.receiptIds), draft.writeReceiptIds ?? []) : state;
}

/** Recompute from the finished candidate without passing the builder's resolved evidence. */
function assertIndependentEvidence(state: AppSnapshot, task: Task, manifest: ContextManifest) {
  assert.equal(manifest.error, undefined);
  const stage = manifest.stageDraft;
  assert.ok(stage);
  const view = candidateState(state, stage), readContext = graphReadContext(view);
  const observations = visibleCanvasEvidence(view, task, stage);
  const pending = pendingCanvasChanges(view, task, stage, readContext, observations);
  const summary = summarySourceEvidence(view, task, stage, observations, encode);
  const notes = noteVersionNotices(view, task, stage, encode);
  const canvasLines=renderNoticeFacts([...pending.values()].map(({change,observation})=>canvasNoticeLabels(view,task,change,observation,encode,readContext)));
  const noticeText = [...canvasLines,
    ...notes.lines, ...renderNoticeFacts(summary.facts)].join('\n');
  const noticeItem = manifest.items.find(item => item.category === 'version_notices');
  assert.equal(noticeItem?.text ?? '', noticeText, 'The model-facing notice must match independent rendering');
  if (noticeText) assert.deepEqual(manifest.messages.at(-1), { role: 'user', content: noticeText });
  const config = { ...view.provider, ...task.modelSelection };
  const plainMessages = noticeText ? manifest.messages.slice(0, -1) : manifest.messages;
  const fullTokens = requestTokens(config, { messages: manifest.messages, tools: [] });
  const noticeTokens = Math.max(0, fullTokens - requestTokens(config, { messages: plainMessages, tools: [] }));
  assert.equal(manifest.requestTokens, fullTokens);
  assert.deepEqual(stage.versionNotices, captureNoticeState(view, task, stage, noticeTokens, encode, fullTokens, readContext),
    'Cached evidence must yield exactly the same facts, signature, labels, token costs and thresholds');
  assert.deepEqual(manifest.canvasPendingChanges, [...pending.values(), ...summary.pending.values()].map(value => value.change));
  assert.deepEqual(manifest.canvasChecks, observations.filter(observation => !canvasObservationChanges(view, observation, readContext).length));
  assert.deepEqual(manifest.summaryChecks, summary.observations.filter(observation => !canvasObservationChanges(view, observation, readContext).length));
  assert.deepEqual(manifest.canvasReadHashes, currentObservationReadHashes(view.graph!, observations, task.canvasId, readContext));
  assert.deepEqual(manifest.currentSources, [...notes.sources, ...summary.sources]);
  return { stage, pending, summary, observations, noticeText, view };
}

test('unchanged real reads remain current without version notices', () => {
  const { state, task } = versionFixture();
  const manifest = buildAutomaticContext(state, task, [], encode, { mode: 'append' });
  const evidence = assertIndependentEvidence(state, task, manifest);
  assert.ok(evidence.observations.length >= 6);
  assert.equal(manifest.canvasPendingChanges?.length, 0);
  assert.equal(evidence.noticeText, '');
  assert.equal(manifest.canvasChecks?.length, evidence.observations.length);
});

test('changed body notices and execution guards agree', () => {
  const { state, task } = versionFixture();
  state.graph!.nodes.n0.content = 'A changed body';
  state.graphRevision++;
  const manifest = buildAutomaticContext(state, task, [], encode, { mode: 'append' });
  const evidence = assertIndependentEvidence(state, task, manifest);
  assert.ok(manifest.canvasPendingChanges?.some(change => change.refId === 'n0'));
  assert.match(evidence.noticeText, /画布变动/);
  assert.match(evidence.noticeText, /n0/);
  assert.ok(!manifest.canvasChecks?.some(observation => observation.callId === 'read-0'));
  assert.ok(manifest.canvasChecks?.some(observation => observation.callId === 'read-1'));
});

test('unverified delivery is unknown, never a current or confirmed-change observation', () => {
  const { state, task } = versionFixture();
  const result = JSON.parse(state.toolCalls[0].result!);
  result.data.invalidExtra = 'Payload no longer matches the verified delivery';
  state.toolCalls[0].result = JSON.stringify(result);
  const manifest = buildAutomaticContext(state, task, [], encode, { mode: 'append' });
  const evidence = assertIndependentEvidence(state, task, manifest);
  assert.ok(manifest.canvasPendingChanges?.some(change => change.kind === 'unknown'));
  assert.match(evidence.noticeText, /版本无法确认/);
  assert.ok(!manifest.canvasChecks?.some(observation => observation.callId === 'read-0'));
  assert.ok(!manifest.canvasPendingChanges?.some(change => change.kind !== 'unknown'));
});

test('content restoration clears changes, including across builds with an unchanged graphRevision', () => {
  const { state, task } = versionFixture();
  const revision = state.graphRevision;
  const build = () => {
    const manifest = buildAutomaticContext(state, task, [], encode, { mode: 'append' });
    assertIndependentEvidence(state, task, manifest);
    assert.equal(state.graphRevision, revision);
    return manifest;
  };
  const current = build();
  state.graph!.nodes.n0.content = 'An in-place edit without a revision bump';
  const changed = build();
  assert.ok(changed.canvasPendingChanges?.some(change => change.refId === 'n0'));
  assert.notEqual(changed.stageDraft?.versionNotices?.signature, current.stageDraft?.versionNotices?.signature);
  state.graph!.nodes.n0.content = originalContent(0);
  const restored = build();
  assert.deepEqual(restored.canvasPendingChanges, current.canvasPendingChanges);
  assert.deepEqual(restored.canvasReadHashes, current.canvasReadHashes);
  assert.deepEqual(restored.stageDraft?.versionNotices, current.stageDraft?.versionNotices);
});

test('actual summary projection retains source-change evidence without claiming current bodies', () => {
  const fixture = versionFixture();
  addVersionSummary(fixture);
  fixture.state.graph!.nodes.n0.content = 'Changed after the summarized read';
  fixture.state.graphRevision++;
  const manifest = buildAutomaticContext(fixture.state, fixture.task, [], encode, { mode: 'compact' });
  const evidence = assertIndependentEvidence(fixture.state, fixture.task, manifest);
  assert.ok(evidence.stage.entries.some(entry => entry.representation === 'summary'), 'Must exercise a projected summary, not protected original reads');
  assert.ok(evidence.summary.observations.length > 0);
  assert.ok(evidence.summary.pending.size > 0);
  assert.match(evidence.noticeText, /摘要依据变动/);
  assert.ok(!manifest.summaryChecks?.some(observation => observation.callId === 'read-0'));
});

test('wire projection only fills presentation fields and preserves visible evidence', () => {
  const fixture = versionFixture();
  addVersionSummary(fixture);
  fixture.state.graph!.nodes.n0.content = 'Changed body for projection boundary';
  const manifest = buildAutomaticContext(fixture.state, fixture.task, [], encode, { mode: 'compact' });
  const stage = structuredClone(manifest.stageDraft!);
  for (const entry of stage.entries) delete entry.wireMessages;
  const view = candidateState(fixture.state, stage);
  const evidenceSnapshot = () => JSON.stringify(stage, (key, value) => key === 'wireMessages' ? undefined : value);
  const before = evidenceSnapshot();
  const observations = visibleCanvasEvidence(view, fixture.task, stage);
  const summary = summarySourceEvidence(view, fixture.task, stage, observations, encode);
  const pending = pendingCanvasChanges(view, fixture.task, stage);
  const messages = projectPromptEntries(view, fixture.task, stage, encode, () => assert.fail('Projection must not append evidence'));
  assert.ok(messages.length > 0);
  assert.ok(stage.entries.every(entry => entry.wireMessages));
  assert.equal(evidenceSnapshot(), before);
  assert.deepEqual(visibleCanvasEvidence(view, fixture.task, stage), observations);
  assert.deepEqual(pendingCanvasChanges(view, fixture.task, stage), pending);
  assert.deepEqual(summarySourceEvidence(view, fixture.task, stage, observations, encode), summary);
});
