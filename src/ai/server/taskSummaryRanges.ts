import { digest } from './directGraph';
import type { Evidence } from './historyRepresentations';
import type { TaskSummaryInput, TaskSummaryUnit } from './taskSummaryEngine';
import { summaryUnitBindings, summaryUnitGuide } from './taskSummaryWindow';

export interface SummaryRange {
  rangeId: string; inputHash: string; taskId: string; start: number; end: number;
  weight: number; unitIds: string[];
  payload: {
    rangeId: string; taskId: string; initialMessage: unknown;
    referenceCatalog: ReturnType<typeof rangeMetadata>['referenceCatalog'];
    fieldCitationInstruction?:string;
    executionFunctionGuide: TaskSummaryInput['executionFunctionGuide'];
    units: Array<Pick<TaskSummaryUnit, 'id' | 'weight' | 'content'>>;
  };
}
export interface SummaryRangePlan {
  ranges: SummaryRange[];
  retainedUnitIds: Array<{ taskId: string; unitIds: string[] }>;
}

export function rangeMetadata(units: TaskSummaryUnit[], rangeId: string) {
  // The marker identifies a verified native page in the host catalog. The author
  // needs the record, field and delivered span, without the private page/hash.
  const referenceCatalog=summaryUnitBindings(units).map(b=>{
    if(!b.fieldRead)return b;
    const {recordId,field,start,end}=b.fieldRead;
    return {key:b.key,id:b.id,kind:b.kind,fieldRead:{recordId,field,...(start===undefined?{}:{start,end})}};
  });
  return {
    rangeId, referenceCatalog, executionFunctionGuide: summaryUnitGuide(units),
    ...(referenceCatalog.some(b=>b.fieldRead)?{fieldCitationInstruction:
      '每条画布结论引用实际使用的字段 [[ref:key]]。fieldRead.field 区分正文 content、名称 name、目录路径 path、空间层级 spatial、成员 members/node_members/directory_members、关系集合 relations、边详情 edge。保留子摘要结论时带上对应标记，只引用仍在本次摘要中的事实。全量结论须有完整列表依据。缺少字段依据时保留普通对象引用或标明无法确认。'
      +(referenceCatalog.some(b=>b.fieldRead?.field.startsWith('depend'))?'依赖边的方向和端点用 dependencyEdge，数量用 dependencyCount_，完整名单用 dependencies_ 对应方向的标记。':'')}:{})
  };
}
export function rangeBody(units: TaskSummaryUnit[], rangeId: string) {
  return {...rangeMetadata(units,rangeId),units:units.map(({id,weight,content})=>({id,weight,content}))};
}

export function makeRange(input: TaskSummaryInput, start: number, units: TaskSummaryUnit[], weight: number, backgroundHash = digest(input.initialMessage)): SummaryRange {
  const end = start + units.length;
  const inputHash = digest(['summary-range-input-v2', input.taskId, start, end, backgroundHash, units]);
  const rangeId = `range:${digest(['summary-range-id-v1', input.taskId, start, end, inputHash]).slice(0, 24)}`;
  const { taskId, initialMessage } = input;
  const {rangeId: _rangeId, ...body} = rangeBody(units, rangeId);
  return {
    rangeId, inputHash, taskId, start, end, weight, unitIds: units.map(unit => unit.id),
    payload: { rangeId, taskId, initialMessage, ...body }
  };
}

/** Quarter-unit arithmetic keeps every whole step/root indivisible. Minimize
 * groups first, then squared weights so a short tail is balanced into all groups.
 * At most 20 units fit in a group: O(20n) work and O(n) bookkeeping. */
export function balancedGroups(input: TaskSummaryInput, from: number, to: number) {
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
  const ranges: Array<{start:number;end:number;weight:number}> = [];
  for (let end = to - from; end > 0;) {
    const path = paths[end]!;
    ranges.push({start:from+path.previous,end:from+end,weight:path.weight/4});
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
  if (new Set(unit.records.map(record=>record.id)).size!==covered.size) return;
  const start = Math.min(...indices), end = Math.max(...indices);
  for (let index = start; index <= end; index++) if (!covered.has(records[index].id)) return;
  // The production validator uses inclusive order bounds, including ties.
  if (start > 0 && records[start - 1].order === records[start].order || end + 1 < records.length && records[end + 1].order === records[end].order) return;
  return [start, end];
}

/** Every returned interval has distinct, adjacent original records. Missing or
 * protected records, including order ties, are hard boundaries. */
export function summarySegments(input: TaskSummaryInput, records: Evidence[]) {
  const rows = records.filter(record => record.taskId === input.taskId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const positions = new Map(rows.map((r, index) => [r.id, index]));
  const covered = input.units.flatMap(unit => [...new Set(unit.coverage.map(c => c.recordId))]);
  const segments: Array<{ from: number; to: number }> = [];
  if (positions.size !== rows.length || new Set(covered).size !== covered.length
    || new Set(input.units.map(u => u.id)).size !== input.units.length
    || input.units.some(u => !u.id || u.taskId !== input.taskId || u.weight !== 1 && u.weight !== .25)) return segments;
  let from = 0, priorEnd: number | undefined;
  const flush = (to: number) => { if (to > from) segments.push({ from, to }); from = to; };
  for (const [index, unit] of input.units.entries()) {
    const span = unitSpan(unit, rows, positions);
    if (!span) { flush(index); from = index + 1; priorEnd = undefined; continue; }
    if (priorEnd !== undefined && span[0] !== priorEnd + 1) flush(index);
    priorEnd = span[1];
  }
  flush(input.units.length); return segments;
}

/** Full-capacity allocation, also used by archive tooling and protocol tests. */
export function allocateSummaryRanges(inputs: TaskSummaryInput[], records: Evidence[]): SummaryRangePlan {
  const plan: SummaryRangePlan = { ranges: [], retainedUnitIds: [] };
  for (const input of inputs) {
    const segments = inputs.filter(i => i.taskId === input.taskId).length === 1 ? summarySegments(input, records) : [];
    const ranges = segments.flatMap(({ from, to }) => balancedGroups(input, from, to))
      .map(({ start, end, weight }) => makeRange(input, start, input.units.slice(start, end), weight));
    plan.ranges.push(...ranges);
    const ids = new Set(ranges.flatMap(r => r.unitIds)), retained = input.units.filter(u => !ids.has(u.id)).map(u => u.id);
    if (retained.length) plan.retainedUnitIds.push({ taskId: input.taskId, unitIds: retained });
  }
  return plan;
}

export function summaryRangeRequest(plan: SummaryRangePlan) { return { ranges: plan.ranges.map(range => range.payload) }; }

/** Rebind only the ranges actually requested to unchanged evidence. This detects
 * stale JSON and scope mix-ups; the caller must still retain its live source
 * fence, production summary validation, and final full-request savings check. */
export function bindSummaryRangeResponse(plan: SummaryRangePlan, output: unknown, inputs: TaskSummaryInput[], records: Evidence[]) {
  const requested = new Map<string, SummaryRange>();
  const tasks = new Map(inputs.map(input => [input.taskId, { input, segments: summarySegments(input, records), backgroundHash: digest(input.initialMessage), end: 0 }]));
  if (tasks.size !== inputs.length) throw new Error('摘要任务重复');
  for (const range of plan.ranges) {
    const scope = tasks.get(range.taskId);
    if (!scope || requested.has(range.rangeId) || range.start < scope.end ||
      !scope.segments.some(s => s.from <= range.start && range.start < range.end && range.end <= s.to)) throw new Error('摘要范围或来源已改变');
    const units = scope.input.units.slice(range.start, range.end), weight = units.reduce((n, u) => n + u.weight, 0);
    if (weight < 2 || weight > 5 || digest(range) !== digest(makeRange(scope.input, range.start, units, weight, scope.backgroundHash))) throw new Error('摘要范围或来源已改变');
    scope.end = range.end;
    requested.set(range.rangeId, range);
  }
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(key => key !== 'summaries')) throw new Error('摘要输出格式无效');
  const rows = (output as { summaries?: unknown }).summaries;
  if (!Array.isArray(rows)) throw new Error('摘要输出缺少 summaries 数组');
  const used = new Set<string>();
  return {
    summaries: rows.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'rangeId' && key !== 'summary')) throw new Error('摘要范围输出无效');
      const row = item as { rangeId?: unknown; summary?: unknown };
      const range = typeof row.rangeId === 'string' ? requested.get(row.rangeId) : undefined;
      if (!range || used.has(range.rangeId) || typeof row.summary !== 'string' || !row.summary.trim()) throw new Error('摘要范围或正文无效');
      used.add(range.rangeId);
      return { taskId: range.taskId, unitIds: [...range.unitIds], summary: row.summary };
    })
  };
}
