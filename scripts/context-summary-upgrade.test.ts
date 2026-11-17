import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionFixture } from './context-compaction-fixtures';
import type { ContextManifest, ModelStep, ToolCallRecord } from '../src/ai/domain';
import type { ContextStage } from '../src/ai/contextState';
import { buildAutomaticContext } from '../src/ai/server/automaticContext';
import { directGraphRead } from '../src/ai/server/directGraph';
import { acknowledgeReadDelivery } from '../src/ai/server/readDelivery';
import { acceptTaskSummaries, taskSummaryUnits } from '../src/ai/server/taskSummaryEngine';
import { projectPromptEntries, PROMPT_PROJECTION_VERSION } from '../src/ai/server/promptProjection';
import { summaryProjection } from '../src/ai/server/summaryBindings';
import { requestTokens } from '../src/ai/server/providers';

function fixture() {
  const { state, task, old } = compactionFixture({ steps: 2 });
  const nodeId = 'summary-upgrade-node';
  state.graph!.nodes[nodeId] = { nodeId, name: 'Source', content: '已核验的历史正文。'.repeat(8) };
  state.graph!.canvases[0].childIds.push(nodeId);
  const call: ToolCallRecord = { id: 'summary-upgrade-read', providerCallId: 'provider-upgrade-read', taskId: old.id,
    stepId: 'step-0', operationId: 'summary-upgrade-operation', name: 'graph_read', arguments: JSON.stringify({ refs: [nodeId], budget: 1200 }),
    status: 'prepared', createdAt: old.createdAt, sequence: 50 };
  state.toolCalls.push(call);
  const result = directGraphRead(state, old, call, { refs: [nodeId], budget: 1200 });
  assert.equal(result.status, 'ok');
  call.result = JSON.stringify(result); call.status = 'completed';
  acknowledgeReadDelivery(state, { id: 'delivery', messages: [], readBodyResultIds: [call.id] } as unknown as ContextManifest,
    { id: call.stepId, taskId: old.id, ordinal: 1, status: 'completed', completedSequence: 90 } as ModelStep);
  const input = taskSummaryUnits(state, task, old.id);
  const summary = acceptTaskSummaries(state, task, [input], { summaries: [{ taskId: old.id,
    unitIds: input.units.map(unit => unit.id), summary: '历史检查已经记录，当前状态需另行核验。' }] }, 'upgrade')[0];
  state.workspaces[0].summaries = [summary];
  const initial = buildAutomaticContext(state, task, [], value => value, { mode: 'compact' });
  assert.ok(initial.stageDraft);
  assert.equal(summaryProjection(state, task, summary).historicalReadPages?.length, 1);
  const removeProof = () => {
    state.workspaces[0].frozenReads = [];
    delete call.readPageOrigins; delete call.canvasOrigins;
  };
  return { state, task, summary, initial, removeProof };
}

function rewrite(value: unknown, transform: (row: Record<string, unknown>) => void): unknown {
  if (Array.isArray(value)) return value.map(item => rewrite(item, transform));
  if (!value || typeof value !== 'object') return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, transform)]));
  transform(row); return row;
}
function cards(messages: ContextManifest['messages'], id: string) {
  const found: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    try { rewrite(JSON.parse(message.content), row => { if (row.summaryId === id && typeof row.content === 'string') found.push(row); }); } catch { /* Non-JSON prompt rules. */ }
  }
  return found;
}

test('saved version-27 stages rebuild through production context assembly and include page facts', () => {
  const { state, task, summary, initial, removeProof } = fixture();
  const old = structuredClone(initial.stageDraft!);
  old.projectionVersion = 27;
  for (const entry of old.entries) for (const message of [...entry.messages, ...entry.wireMessages ?? []]) {
    try { message.content = JSON.stringify(rewrite(JSON.parse(message.content), row => { delete row.historicalReadPages; delete row.readPageInstruction; })); } catch { /* Non-JSON prompt rules. */ }
  }
  state.workspaces[0].contextStage = old;
  const upgraded = buildAutomaticContext(state, task, [], value => value);
  assert.ok(PROMPT_PROJECTION_VERSION > 27);
  assert.equal(upgraded.stageDraft?.projectionVersion, PROMPT_PROJECTION_VERSION);
  assert.equal(upgraded.stageDraft?.generation, old.generation + 1);
  assert.equal(upgraded.stageDraft?.rebuildReason, 'format_upgrade');
  assert.equal(cards(upgraded.messages, summary.id)[0].historicalReadPages instanceof Array, true);
  assert.equal((cards(upgraded.messages, summary.id)[0].historicalReadPages as unknown[]).length, 1);
  assert.equal(upgraded.requestTokens, requestTokens(state.provider, { messages: upgraded.messages, tools: [] }));
  const withoutFacts = upgraded.messages.map(message => {
    try { return { ...message, content: JSON.stringify(rewrite(JSON.parse(message.content), row => { delete row.historicalReadPages; delete row.readPageInstruction; })) }; }
    catch { return message; }
  });
  assert.ok(upgraded.requestTokens > requestTokens(state.provider, { messages: withoutFacts, tools: [] }), 'The full derived sidecar contributes to the real serialized request cost');

  // A submitted prefix remains immutable. Proof cleanup alone must not rewrite
  // historical receipts; the next requested rebuild revalidates their derivation.
  state.workspaces[0].contextStage = upgraded.stageDraft;
  removeProof();
  const stable = buildAutomaticContext(state, task, [], value => value);
  assert.equal(stable.stageDraft?.generation, upgraded.stageDraft?.generation);
  assert.deepEqual(cards(stable.messages, summary.id), cards(upgraded.messages, summary.id));
  const rebuilt = buildAutomaticContext(state, task, [], value => value, { mode: 'refactor' });
  assert.equal(rebuilt.stageDraft?.generation, upgraded.stageDraft!.generation + 1);
  assert.equal(cards(rebuilt.messages, summary.id)[0].historicalReadPages, undefined);
  assert.equal(cards(rebuilt.messages, summary.id)[0].readPageInstruction, undefined);
});

test('saved summary expansions refresh derived page facts and remove obsolete fields on fresh projection', () => {
  const { state, task, summary, initial, removeProof } = fixture();
  const legacy = { summaryId: summary.id, content: '旧摘要片段', resultTextPart: 1,
    historicalReadPages: [{ pointerId: 'obsolete-proof', page: 99 }], readPageInstruction: 'old instruction' };
  const stage = (): ContextStage => ({ ...structuredClone(initial.stageDraft!), entries: [{ id: 'historical-summary-expansion',
    category: 'history', coverage: summary.coverage, messages: [{ role: 'user', content: JSON.stringify({ historical_read: { data: { items: [legacy] } } }) }] }] });
  const shown = cards(projectPromptEntries(state, task, stage(), value => value, () => {}), summary.id)[0];
  assert.equal(shown.content, legacy.content, 'Text fragments retain their actual displayed text');
  assert.deepEqual(shown.historicalReadPages, summaryProjection(state, task, summary).historicalReadPages);
  assert.equal(shown.readPageInstruction, summaryProjection(state, task, summary).readPageInstruction);
  removeProof();
  const refreshed = cards(projectPromptEntries(state, task, stage(), value => value, () => {}), summary.id)[0];
  assert.equal(refreshed.content, legacy.content);
  assert.equal(Object.hasOwn(refreshed, 'historicalReadPages'), false);
  assert.equal(Object.hasOwn(refreshed, 'readPageInstruction'), false);
});
