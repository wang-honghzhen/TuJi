import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionFixture } from './context-compaction-fixtures';
import { contextCapacity } from '../src/ai/contextCapacity';
import { estimateTokens } from '../src/ai/tokens';
import { buildAutomaticContext } from '../src/ai/server/automaticContext';
import { prepareAutomaticContext, progressRegionTokens } from '../src/ai/server/automaticCompaction';
import { allEvidence, validSummary } from '../src/ai/server/historyRepresentations';
import { requestTokens, type ModelRequest } from '../src/ai/server/providers';
import { Repository } from '../src/ai/server/repository';
import { boundedSummaryInput, summaryInputWeight, taskSummaryBudget, taskSummaryUnits, TASK_SUMMARY_INSTRUCTIONS } from '../src/ai/server/taskSummaryEngine';
import { allocateSummaryRanges, summaryRangeRequest, type SummaryRange } from '../src/ai/server/taskSummaryRanges';

globalThis.fetch = async () => { throw new Error('Network calls prohibited in context budget tests'); };

function fixture(steps: number, executionWindow: number, summaryWindow: number) {
  const { state, task } = compactionFixture({ steps, records: 8 });
  state.provider = { ...state.provider, contextWindow: executionWindow, maxOutputTokens: 1024, apiFamily: undefined, model: 'offline-context' };
  state.messages.find(message => message.id === 'user-old')!.text = '背景'.repeat(1000);
  const repo = new Repository(':memory:');
  repo.transaction(() => { repo.state = state; });
  repo.summaryConnection = { provider: { ...state.provider, contextWindow: summaryWindow } };
  const prepare = (caller: Parameters<typeof prepareAutomaticContext>[0]['caller']) => prepareAutomaticContext({
    repo, task, caller, signal: new AbortController().signal, guard: () => {},
    build: options => buildAutomaticContext(repo.state, task, [], id => id, options),
  });
  return { repo, state, task, prepare, summaryProvider: repo.summaryConnection.provider };
}

const rangesIn = (request: ModelRequest): SummaryRange['payload'][] => JSON.parse(request.messages[1].content).ranges;
const responseFor = (ranges: SummaryRange['payload'][]) => ({
  text: JSON.stringify({ summaries: ranges.map(range => ({ rangeId: range.rangeId, summary: '检查已完成，按历史记录保留结果。' })) }),
  outputTokens: 100, finishReason: 'stop', toolCalls: [],
});

test('range background overhead trims the actual summary request and retains the unsummarized tail', async () => {
  const { repo, state, task, prepare, summaryProvider } = fixture(11, 30000, 10000);
  try {
    // Reserve the last task call for execution so this test isolates the first trimmed batch.
    task.maxSteps = 2;
    const originals = structuredClone(state.messages);
    const records = allEvidence(state, task), raw = taskSummaryUnits(state, task, 'old');
    const capacity = contextCapacity(summaryProvider).inputCapacity;
    const bounded = boundedSummaryInput(raw, capacity - estimateTokens(TASK_SUMMARY_INSTRUCTIONS) - 1024);
    assert.ok(bounded);
    const beforePlan = allocateSummaryRanges([bounded], records);
    assert.ok(beforePlan.ranges.length > 1);
    const beforeRequest: ModelRequest = { messages: [{ role: 'system', content: TASK_SUMMARY_INSTRUCTIONS },
      { role: 'user', content: JSON.stringify(summaryRangeRequest(beforePlan)) }], tools: [] };
    assert.ok(requestTokens(summaryProvider, beforeRequest) > capacity, 'Repeated per-range background must exceed the actual provider budget');

    let captured: SummaryRange['payload'][] = [];
    let calls = 0;
    const manifest = await prepare(async (provider, _credential, request) => {
      calls++;
      captured = rangesIn(request);
      assert.ok(requestTokens(provider, request) <= contextCapacity(provider).inputCapacity);
      const ids = captured.flatMap(range => range.units.map(unit => unit.id));
      assert.ok(ids.length > 0 && ids.length < bounded.units.length, 'The actual request must trim the selected window');
      assert.deepEqual(ids, bounded.units.slice(0, ids.length).map(unit => unit.id), 'Trimming must preserve whole ordered units');
      const remaining = { ...bounded, units: bounded.units.slice(0, ids.length) };
      const finalPlan = allocateSummaryRanges([remaining], records);
      assert.deepEqual(captured, summaryRangeRequest(finalPlan).ranges, 'rangeIds and catalogs must be rebound to the final trimmed input');
      return responseFor(captured);
    });
    assert.equal(calls, 1);
    assert.equal(manifest.error, undefined);
    const summaries = state.workspaces[0].summaries ?? [];
    assert.equal(summaries.length, captured.length);
    const sentUnits = new Set(captured.flatMap(range => range.units.map(unit => unit.id)));
    const trimmedTail = bounded.units.filter(unit => !sentUnits.has(unit.id));
    assert.ok(trimmedTail.length > 0);
    assert.deepEqual(summaries.flatMap(summary => summary.inputUnitIds ?? []), [...sentUnits]);
    const coveredRecords = new Set(summaries.flatMap(summary => summary.coverage.map(coverage => coverage.recordId)));
    for (const unit of trimmedTail) for (const record of unit.records) assert.ok(!coveredRecords.has(record.id));
    // Capacity fallback can retire the historical task from the prompt; its original records stay intact.
    assert.deepEqual(state.messages, originals);
    assert.ok(summaries.every(summary => validSummary(summary, allEvidence(state, task), summaries)));
  } finally { repo.close(); }
});

test('multiple ranges count once per round and historical tasks stop after two rounds', async () => {
  const { repo, state, task, prepare } = fixture(25, 40000, 18000);
  try {
    const originals = structuredClone(state.messages), batches: SummaryRange['payload'][][] = [];
    const manifest = await prepare(async (provider, _credential, request) => {
      const ranges = rangesIn(request);
      assert.ok(requestTokens(provider, request) <= contextCapacity(provider).inputCapacity);
      assert.ok(ranges.length > 1, 'Each accepted round must contain multiple independently assigned ranges');
      batches.push(ranges);
      return responseFor(ranges);
    });
    const workspace = state.workspaces[0], summaries = workspace.summaries ?? [];
    assert.equal(manifest.error, undefined);
    assert.equal(batches.length, 2);
    assert.equal(task.memoryCalls, 2);
    assert.equal(summaries.length, batches.reduce((count, ranges) => count + ranges.length, 0));
    assert.equal(workspace.sessionContext?.historicalSummaryCounts.old, 2);
    const rounds = workspace.sessionContext?.countedSummaryRounds?.old ?? [];
    assert.equal(rounds.length, 2);
    assert.equal(new Set(rounds).size, 2);
    for (const round of rounds) assert.ok(summaries.filter(summary => summary.summaryRoundId === round).length > 1);
    assert.deepEqual(new Set(summaries.map(summary => summary.summaryRoundId)), new Set(rounds));
    assert.ok(summaryInputWeight(taskSummaryUnits(state, task, 'old').units) >= 2, 'Eligible original units still exist after the round limit');
    assert.deepEqual(state.messages, originals);

    // A fresh maintenance invocation under renewed pressure must honor persisted round counts.
    state.provider.contextWindow = 22000;
    const before = buildAutomaticContext(state, task, [], id => id, { mode: 'refactor', maintenanceIntent: 'capacity' });
    assert.ok(progressRegionTokens(before).history > taskSummaryBudget(contextCapacity(state.provider).inputCapacity).high);
    let extraCalls = 0;
    const limited = await prepare(async () => { extraCalls++; return responseFor([]); });
    assert.equal(extraCalls, 0);
    assert.equal(limited.error, undefined);
    assert.equal(task.memoryCalls, 2);
    assert.equal(workspace.sessionContext?.historicalSummaryCounts.old, 2);
    assert.deepEqual(workspace.sessionContext?.countedSummaryRounds?.old, rounds);
    assert.deepEqual(state.messages, originals);
  } finally { repo.close(); }
});
