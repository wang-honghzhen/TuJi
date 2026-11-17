import { digest } from './directGraph';
import type { Evidence } from './historyRepresentations';
import type { TaskSummaryInput, TaskSummaryUnit } from './taskSummaryEngine';
import { summaryUnitBindings, summaryUnitGuide } from './taskSummaryWindow';

export interface SummaryRange {
  rangeId: string; inputHash: string; taskId: string; start: number; end: number;
  weight: number; unitIds: string[];
  payload: {
    rangeId: string; taskId: string; initialMessage: unknown;
    referenceCatalog: TaskSummaryInput['referenceCatalog'];
    executionFunctionGuide: TaskSummaryInput['executionFunctionGuide'];
    units: Array<Pick<TaskSummaryUnit, 'id' | 'weight' | 'content'>>;
  };
}
export interface SummaryRangePlan {
  ranges: SummaryRange[];
  retainedUnitIds: Array<{ taskId: string; unitIds: string[] }>;
}

function material(input: TaskSummaryInput, start: number, end: number) {
  const units = input.units.slice(start, end);
  return { taskId: input.taskId, start, end, initialMessage: input.initialMessage,
    referenceCatalog: summaryUnitBindings(units), executionFunctionGuide: summaryUnitGuide(units), units };
}

function makeRange(input: TaskSummaryInput, start: number, end: number, weight: number): SummaryRange {
  const value = material(input, start, end), inputHash = digest(['summary-range-input-v1', value]);
  const rangeId = `range:${digest(['summary-range-id-v1', input.taskId, start, end, inputHash]).slice(0, 24)}`;
  return { rangeId, inputHash, taskId: input.taskId, start, end, weight, unitIds: value.units.map(unit => unit.id),
    payload: structuredClone({ rangeId, taskId: input.taskId, initialMessage: value.initialMessage,
      referenceCatalog: value.referenceCatalog, executionFunctionGuide: value.executionFunctionGuide,
      units: value.units.map(({ id, weight, content }) => ({ id, weight, content })) }) };
}

/** Quarter-unit arithmetic keeps every whole step/root indivisible. Minimize
 * groups first, then squared weights so a short tail is balanced into all groups.
 * At most 20 units fit in a group: O(20n) work and O(n) bookkeeping. */
function partition(input: TaskSummaryInput, from: number, to: number): SummaryRange[] {
  type Path = { groups: number; squares: number; previous: number; weight: number };
  const paths: Array<Path | undefined> = Array(to - from + 1);
  paths[0] = { groups: 0, squares: 0, previous: -1, weight: 0 };
  for (let end = 1; end < paths.length; end++) {
    let weight = 0;
    for (let start = end - 1; start >= 0; start--) {
      weight += input.units[from + start].weight * 4;
      if (weight > 20) break;
      const prior = paths[start];
      if (weight < 8 || !prior) continue;
      const next = { groups: prior.groups + 1, squares: prior.squares + weight * weight, previous: start, weight };
      const best = paths[end];
      if (!best || next.groups < best.groups || next.groups === best.groups && next.squares < best.squares) paths[end] = next;
    }
  }
  if (!paths[to - from]) return [];
  const ranges: SummaryRange[] = [];
  for (let end = to - from; end > 0;) {
    const path = paths[end]!;
    ranges.push(makeRange(input, from + path.previous, from + end, path.weight / 4));
    end = path.previous;
  }
  return ranges.reverse();
}

/** Return the original-evidence span only when the unit still covers its whole
 * span. Missing protected steps must remain a boundary, not disappear because
 * the filtered units happen to be adjacent. */
function unitSpan(unit: TaskSummaryUnit, records: Evidence[], positions: Map<string, number>): [number, number] | undefined {
  if (!unit.coverage.length || !unit.records.length) return;
  const indices: number[] = [];
  for (const coverage of unit.coverage) {
    const index = positions.get(coverage.recordId), record = index === undefined ? undefined : records[index];
    if (!record || record.taskId !== coverage.taskId || record.taskId !== unit.taskId || record.version !== coverage.version
      || coverage.start < 0 || coverage.end > record.text.length || coverage.end <= coverage.start) return;
    indices.push(index!);
  }
  const covered = new Set(unit.coverage.map(item => item.recordId));
  if (unit.records.some(record => !covered.has(record.id) || digest(records[positions.get(record.id) ?? -1]) !== digest(record))) return;
  if ([...covered].some(id => !unit.records.some(record => record.id === id))) return;
  const start = Math.min(...indices), end = Math.max(...indices);
  for (let index = start; index <= end; index++) if (!covered.has(records[index].id)) return;
  // The production validator uses inclusive order bounds, including ties.
  if (start > 0 && records[start - 1].order === records[start].order || end + 1 < records.length && records[end + 1].order === records[end].order) return;
  return [start, end];
}

/** Program-owned scopes; no source material or invalid tail is silently lost.
 * Retained units continue to use their original representation. */
export function allocateSummaryRanges(inputs: TaskSummaryInput[], records: Evidence[]): SummaryRangePlan {
  const plan: SummaryRangePlan = { ranges: [], retainedUnitIds: [] };
  const taskCounts = new Map<string, number>();
  for (const input of inputs) taskCounts.set(input.taskId, (taskCounts.get(input.taskId) ?? 0) + 1);
  for (const input of inputs) {
    const taskRecords = records.filter(record => record.taskId === input.taskId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const positions = new Map(taskRecords.map((record, index) => [record.id, index]));
    const coveredIds = input.units.flatMap(unit => [...new Set(unit.coverage.map(item => item.recordId))]);
    const invalid = taskCounts.get(input.taskId) !== 1 || positions.size !== taskRecords.length
      || new Set(input.units.map(unit => unit.id)).size !== input.units.length
      || new Set(coveredIds).size !== coveredIds.length
      || input.units.some(unit => !unit.id || unit.taskId !== input.taskId || unit.weight !== 1 && unit.weight !== .25);
    const ranges: SummaryRange[] = [];
    if (!invalid) {
      let segmentStart = 0, priorEnd: number | undefined;
      const flush = (end: number) => { if (end > segmentStart) ranges.push(...partition(input, segmentStart, end)); segmentStart = end; };
      for (let index = 0; index < input.units.length; index++) {
        const span = unitSpan(input.units[index], taskRecords, positions);
        if (!span) { flush(index); segmentStart = index + 1; priorEnd = undefined; continue; }
        if (priorEnd !== undefined && span[0] !== priorEnd + 1) flush(index);
        priorEnd = span[1];
      }
      flush(input.units.length);
    }
    plan.ranges.push(...ranges);
    const allocated = new Set(ranges.flatMap(range => range.unitIds));
    const retained = input.units.filter(unit => !allocated.has(unit.id)).map(unit => unit.id);
    if (retained.length) plan.retainedUnitIds.push({ taskId: input.taskId, unitIds: retained });
  }
  return plan;
}

export function summaryRangeRequest(plan: SummaryRangePlan) { return { ranges: plan.ranges.map(range => range.payload) }; }

/** Rebind only the ranges actually requested to unchanged evidence. This detects
 * stale JSON and scope mix-ups; the caller must still retain its live source
 * fence, production summary validation, and final full-request savings check. */
export function bindSummaryRangeResponse(plan: SummaryRangePlan, output: unknown, inputs: TaskSummaryInput[], records: Evidence[]) {
  const current = new Map(allocateSummaryRanges(inputs, records).ranges.map(range => [range.rangeId, range]));
  const requested = new Map<string, SummaryRange>();
  for (const range of plan.ranges) {
    if (requested.has(range.rangeId) || !current.has(range.rangeId) || digest(range) !== digest(current.get(range.rangeId))) throw new Error('摘要范围或来源已改变');
    requested.set(range.rangeId, range);
  }
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(key => key !== 'summaries')) throw new Error('摘要输出格式无效');
  const rows = (output as { summaries?: unknown }).summaries;
  if (!Array.isArray(rows)) throw new Error('摘要输出缺少 summaries 数组');
  const used = new Set<string>();
  return { summaries: rows.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'rangeId' && key !== 'summary')) throw new Error('摘要范围输出无效');
    const row = item as { rangeId?: unknown; summary?: unknown };
    const range = typeof row.rangeId === 'string' ? requested.get(row.rangeId) : undefined;
    if (!range || used.has(range.rangeId) || typeof row.summary !== 'string' || !row.summary.trim()) throw new Error('摘要范围或正文无效');
    used.add(range.rangeId);
    return { taskId: range.taskId, unitIds: [...range.unitIds], summary: row.summary };
  }) };
}
