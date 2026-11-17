import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from '../src/ai/tokens';
import { acceptTaskSummaries, boundedSummaryInput, summaryStorageBenefit, taskSummaryUnits, type TaskSummaryInput, type TaskSummaryUnit } from '../src/ai/server/taskSummaryEngine';
import { allocateSummaryRanges, bindSummaryRangeResponse, summaryRangeRequest } from '../src/ai/server/taskSummaryRanges';
import { allEvidence, fullCoverage, validSummary, type Evidence } from '../src/ai/server/historyRepresentations';
import { compactionFixture } from './context-compaction-fixtures';

function random(seed: number) { return () => ((seed = Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000; }
function synthetic(weights: number[], taskId = 'task'): { input: TaskSummaryInput; records: Evidence[] } {
  const records: Evidence[] = weights.map((_, index) => ({ id: `${taskId}-record-${index}`, taskId, version: '1', text: `记录 ${index} 已检查。`,
    sources: [], user: false, order: index, createdAt: '', stepId: `${taskId}-step-${index}` }));
  const units = records.map((record, index): TaskSummaryUnit => ({ id: `${taskId}-unit-${index}`, taskId, order: index, weight: weights[index],
    coverage: [fullCoverage(record)], records: [record], stepIds: [record.stepId!], content: record.text, bindings: [], executionFunctionGuide: [] }));
  return { input: { taskId, initialMessage: '任务背景', units, referenceCatalog: [], executionFunctionGuide: [] }, records };
}

// Independent, deliberately simple specification of the original complete-window
// behavior. It lives in the regression suite rather than importing deleted trials.
function windowOracle(input: TaskSummaryInput, budget: number) {
  for (let start = 0; start < input.units.length; start++) {
    const units: TaskSummaryUnit[] = [];
    for (let index = start; index < input.units.length; index++) {
      const next = [...units, input.units[index]];
      const referenceCatalog = [...new Map(next.flatMap(unit => unit.bindings).map(binding => [binding.key, binding])).values()];
      const executionFunctionGuide = [...new Map(next.flatMap(unit => unit.executionFunctionGuide ?? []).map(guide => [guide.name, guide])).values()];
      if (estimateTokens(JSON.stringify({ initialMessage: input.initialMessage, referenceCatalog, executionFunctionGuide,
        units: next.map(({ id, weight, content }) => ({ id, weight, content })) })) > budget) break;
      units.push(input.units[index]);
    }
    if (units.reduce((weight, unit) => weight + unit.weight, 0) >= 2) return { ...input, units,
      referenceCatalog: [...new Map(units.flatMap(unit => unit.bindings).map(binding => [binding.key, binding])).values()],
      executionFunctionGuide: [...new Map(units.flatMap(unit => unit.executionFunctionGuide ?? []).map(guide => [guide.name, guide])).values()] };
  }
}

test('incremental windows exactly preserve JSON estimates, metadata maps, and source immutability', () => {
  const next = random(20261115), strings = ['ASCII', '中英混合', '🧭😀', '\ud800', '\n\t"\\', ''];
  for (let trial = 0; trial < 600; trial++) {
    const { input } = synthetic(Array.from({ length: 1 + Math.floor(next() * 35) }, () => next() < .35 ? .25 : 1));
    input.initialMessage = { message: strings[Math.floor(next() * strings.length)].repeat(Math.floor(next() * 15)) };
    for (const unit of input.units) {
      unit.content = { text: strings[Math.floor(next() * strings.length)].repeat(Math.floor(next() * 30)), optional: next() < .5 ? undefined : 'a' };
      unit.bindings = Array.from({ length: Math.floor(next() * 4) }, () => ({ key: `binding-${Math.floor(next() * 4)}`, kind: 'node', id: `node-${Math.floor(next() * 9)}`, version: strings[Math.floor(next() * strings.length)] }));
      unit.executionFunctionGuide = Array.from({ length: Math.floor(next() * 3) }, () => ({ name: `tool-${Math.floor(next() * 3)}`, meaning: strings[Math.floor(next() * strings.length)] }));
    }
    const before = structuredClone(input), selected = input.units.slice(0, 1 + Math.floor(next() * input.units.length));
    const exact = estimateTokens(JSON.stringify({ initialMessage: input.initialMessage,
      referenceCatalog: [...new Map(selected.flatMap(unit => unit.bindings).map(binding => [binding.key, binding])).values()],
      executionFunctionGuide: [...new Map(selected.flatMap(unit => unit.executionFunctionGuide ?? []).map(guide => [guide.name, guide])).values()],
      units: selected.map(({ id, weight, content }) => ({ id, weight, content })) }));
    for (const budget of [0, exact - 1, exact, exact + 1, Infinity]) assert.deepEqual(boundedSummaryInput(input, budget), windowOracle(input, budget), `trial ${trial}, budget ${budget}`);
    assert.deepEqual(input, before);
  }
});

test('window visits only the prefix needed to choose a complete range', () => {
  const { input } = synthetic([1, 1, 1, 1]);
  const budget = estimateTokens(JSON.stringify({ initialMessage: input.initialMessage, referenceCatalog: [], executionFunctionGuide: [],
    units: input.units.slice(0, 2).map(({ id, weight, content }) => ({ id, weight, content })) }));
  input.units[2].content = '大'.repeat(10000);
  Object.defineProperty(input.units[3], 'content', { get() { throw new Error('Unvisited tail must stay lazy'); } });
  assert.deepEqual(boundedSummaryInput(input, budget)?.units.map(unit => unit.id), input.units.slice(0, 2).map(unit => unit.id));
  const oversized = synthetic([1, 1, 1]); oversized.input.units[0].content = '大'.repeat(10000);
  assert.deepEqual(boundedSummaryInput(oversized.input, budget)?.units.map(unit => unit.id), oversized.input.units.slice(1).map(unit => unit.id));
});

function bruteObjective(weights: number[]): [number, number] | undefined {
  if (!weights.length) return [0, 0];
  let total = 0, best: [number, number] | undefined;
  for (let end = 1; end <= weights.length; end++) {
    total += weights[end - 1]; if (total > 5) break;
    if (total < 2) continue;
    const rest = bruteObjective(weights.slice(end)); if (!rest) continue;
    const score: [number, number] = [rest[0] + 1, rest[1] + (total * 4) ** 2];
    if (!best || score[0] < best[0] || score[0] === best[0] && score[1] < best[1]) best = score;
  }
  return best;
}

test('range allocation covers every complete unit and balances 11 steps into 4/4/3', () => {
  const eleven = synthetic(Array(11).fill(1)), plan = allocateSummaryRanges([eleven.input], eleven.records);
  assert.deepEqual(plan.ranges.map(range => range.weight), [4, 4, 3]);
  assert.deepEqual(plan.retainedUnitIds, []);
  const next = random(618033);
  for (let trial = 0; trial < 500; trial++) {
    const weights = Array.from({ length: 1 + Math.floor(next() * 32) }, () => next() < .5 ? .25 : 1);
    const { input, records } = synthetic(weights), frozen = structuredClone(input), result = allocateSummaryRanges([input], records);
    assert.deepEqual(input, frozen);
    if (weights.reduce((a, b) => a + b, 0) < 2) {
      assert.deepEqual(result.ranges, []); assert.deepEqual(result.retainedUnitIds, [{ taskId: input.taskId, unitIds: input.units.map(unit => unit.id) }]);
    } else {
      assert.deepEqual(result.retainedUnitIds, []);
      assert.deepEqual(result.ranges.flatMap(range => range.unitIds), input.units.map(unit => unit.id));
      assert.ok(result.ranges.every(range => range.weight >= 2 && range.weight <= 5));
      for (const range of result.ranges) assert.deepEqual(range.payload.units.map(unit => unit.id), range.unitIds);
    }
    if (weights.length <= 12) assert.deepEqual(result.ranges.length ? [result.ranges.length, result.ranges.reduce((sum, range) => sum + (range.weight * 4) ** 2, 0)] : undefined, bruteObjective(weights));
  }
});

test('protected source gaps split ranges and undersized segments retain every original', () => {
  const { input, records } = synthetic(Array(9).fill(1));
  input.units.splice(4, 1);
  const plan = allocateSummaryRanges([input], records);
  assert.deepEqual(plan.ranges.map(range => range.weight), [4, 4]);
  assert.equal(plan.retainedUnitIds.length, 0);
  input.units.splice(1, 2);
  const split = allocateSummaryRanges([input], records);
  assert.deepEqual(split.ranges.map(range => range.weight), [4]);
  assert.deepEqual(split.retainedUnitIds, [{ taskId: 'task', unitIds: ['task-unit-0', 'task-unit-3'] }]);
  const short = synthetic(Array(7).fill(.25));
  assert.equal(allocateSummaryRanges([short.input], short.records).retainedUnitIds[0].unitIds.length, 7);
  const duplicate = synthetic([1, 1]); duplicate.input.units[1].id = duplicate.input.units[0].id;
  assert.equal(allocateSummaryRanges([duplicate.input], duplicate.records).ranges.length, 0);
  const unsupported = synthetic([1, 1, .5]);
  assert.equal(allocateSummaryRanges([unsupported.input], unsupported.records).ranges.length, 0);
});

test('batched range responses bind only requested IDs and detect scope/source/payload tampering', () => {
  const a = synthetic(Array(11).fill(1), 'a'), b = synthetic([1, 1], 'b'), inputs = [a.input, b.input], records = [...a.records, ...b.records];
  const plan = allocateSummaryRanges(inputs, records), request = summaryRangeRequest(plan);
  assert.equal(request.ranges.length, 4);
  const response = { summaries: plan.ranges.map(range => ({ rangeId: range.rangeId, summary: `摘要 ${range.taskId}` })) };
  const bound = bindSummaryRangeResponse(plan, response, inputs, records);
  assert.deepEqual(bound.summaries.map(row => row.unitIds), plan.ranges.map(range => range.unitIds));
  assert.deepEqual(bindSummaryRangeResponse(plan, { summaries: [] }, inputs, records), { summaries: [] });
  assert.equal(bindSummaryRangeResponse({ ...plan, ranges: [plan.ranges[1]] }, { summaries: [response.summaries[1]] }, inputs, records).summaries.length, 1);
  for (const output of [null, {}, [], { summaries: response.summaries, other: true },
    { summaries: [{ rangeId: 'invented', summary: 'x' }] }, { summaries: [response.summaries[0], response.summaries[0]] },
    { summaries: [{ ...response.summaries[0], taskId: 'b' }] }, { summaries: [{ ...response.summaries[0], unitIds: ['a-unit-0'] }] },
    { summaries: [{ ...response.summaries[0], summary: ' ' }] }]) assert.throws(() => bindSummaryRangeResponse(plan, output, inputs, records));
  for (const mutate of [
    (input: TaskSummaryInput) => { input.units[0].content = 'edited'; },
    (input: TaskSummaryInput) => { input.units[0].coverage[0].version = 'edited'; },
    (input: TaskSummaryInput) => { input.units[0].bindings.push({ key: 'forged', kind: 'node', id: 'other' }); },
    (input: TaskSummaryInput) => { input.units.reverse(); },
  ]) {
    const changed = structuredClone(inputs); mutate(changed[0]);
    assert.throws(() => bindSummaryRangeResponse(plan, response, changed, records));
  }
  const changedRecords = structuredClone(records); changedRecords[0].sources.push({ kind: 'node', id: 'new-source', version: 1 });
  assert.throws(() => bindSummaryRangeResponse(plan, response, inputs, changedRecords));
  const changedPlan = structuredClone(plan); changedPlan.ranges[0].payload.units[0].content = 'injected';
  assert.throws(() => bindSummaryRangeResponse(changedPlan, response, inputs, records));
  const gapRecords = [...records, { ...records[0], id: 'late-source', order: .5 }];
  assert.throws(() => bindSummaryRangeResponse(plan, response, inputs, gapRecords));
});

test('production acceptance retains exact user metadata, source bindings, and child provenance', () => {
  const { state, task, old } = compactionFixture({ steps: 16, correction: true, sources: 1 });
  const input = taskSummaryUnits(state, task, old.id), before = structuredClone(state);
  const rows = Array.from({ length: 8 }, (_, index) => {
    const units = input.units.slice(index * 2, index * 2 + 2);
    return { taskId: old.id, unitIds: units.map(unit => unit.id), summary: `历史记录已保存，不代表当前已核验。[[ref:${units[0].bindings[0].key}]]` };
  });
  const children = acceptTaskSummaries(state, task, [input], { summaries: rows }, 'first');
  assert.deepEqual(state, before);
  assert.equal(children.length, 8);
  assert.equal(children[0].intermediateUserMessages?.[0].text, '更正：预算上限为150元，不是500元；未完成部分不能标为成功。');
  assert.equal(children[0].intermediateUserMessages?.[0].version, 2);
  assert.ok(children.every(summary => summary.sourceBindings?.length === 2));
  state.workspaces[0].summaries = children;
  const roots = taskSummaryUnits(state, task, old.id), records = allEvidence(state, task), plan = allocateSummaryRanges([roots], records);
  assert.deepEqual(roots.units.map(unit => unit.weight), Array(8).fill(.25));
  assert.equal(plan.ranges.length, 1);
  const bound = bindSummaryRangeResponse(plan, { summaries: [{ rangeId: plan.ranges[0].rangeId, summary: '记录已保存；预算150元且未完成事项仍未完成。' }] }, [roots], records);
  const parent = acceptTaskSummaries(state, task, [roots], bound, 'second')[0];
  assert.deepEqual(parent.children, children.map(summary => summary.id));
  assert.deepEqual(parent.intermediateUserMessages, children[0].intermediateUserMessages);
  assert.equal(parent.sourceBindings?.length, 16);
  assert.equal(parent.stepIds?.length, 16);
  assert.ok(validSummary(parent, records, [...children, parent]));
});

test('size becomes a preference while structural and reference guards remain mandatory', () => {
  const { state, task, old } = compactionFixture({ steps: 6, sources: 1 }), input = taskSummaryUnits(state, task, old.id), records = allEvidence(state, task);
  const plan = allocateSummaryRanges([input], records), request = summaryRangeRequest(plan);
  assert.equal(plan.ranges.length, 2);
  const first = plan.ranges[0], otherKey = request.ranges[1].referenceCatalog[0].key;
  const accept = (summary: string) => acceptTaskSummaries(state, task, [input], bindSummaryRangeResponse(plan,
    { summaries: [{ rangeId: first.rangeId, summary }] }, [input], records), 'round');
  assert.throws(() => accept(`借用另一范围引用 [[ref:${otherKey}]]`));
  assert.throws(() => accept('[[ref:invented]]'));
  const large = accept('保留未完成条件。'.repeat(400))[0];
  assert.ok(large);
  assert.equal(summaryStorageBenefit(large, [input]), false);
  assert.equal(summaryStorageBenefit({ ...large, inputUnitIds: ['missing'] }, [input]), false);
  const internalRow = { taskId: old.id, unitIds: input.units.slice(0, 2).map(unit => unit.id), summary: '历史检查结果。' };
  for (const row of [
    { ...internalRow, unitIds: [input.units[0].id] },
    { ...internalRow, unitIds: [input.units[0].id, input.units[2].id] },
    { ...internalRow, unitIds: input.units.map(unit => unit.id) },
    { ...internalRow, taskId: 'other' },
  ]) assert.throws(() => acceptTaskSummaries(state, task, [input], { summaries: [row] }, 'invalid'));
  assert.throws(() => acceptTaskSummaries(state, task, [input], { summaries: [internalRow, internalRow] }, 'overlap'));
  const withGap = { ...input, units: input.units.filter((_, index) => index !== 1) };
  assert.throws(() => acceptTaskSummaries(state, task, [withGap], { summaries: [{ ...internalRow, unitIds: withGap.units.slice(0, 2).map(unit => unit.id) }] }, 'gap'));
});
