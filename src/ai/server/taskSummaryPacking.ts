import { digest } from './directGraph';
import { tokenThirds } from '../tokens';
import { contextCapacity } from '../contextCapacity';
import { requestTokens, serializeRequest, type ModelRequest, type ProviderConfig } from './providers';
import { TASK_SUMMARY_INSTRUCTIONS, type TaskSummaryInput } from './taskSummaryEngine';
import { balancedGroups, makeRange, rangeBody, rangeMetadata, summaryRangeRequest, summarySegments, type SummaryRangePlan } from './taskSummaryRanges';
import { summaryUnitBindings, summaryUnitGuide } from './taskSummaryWindow';
import type { Evidence } from './historyRepresentations';

const sharedInstructions = TASK_SUMMARY_INSTRUCTIONS.replace('每个range的initialMessage', '每个task的initialMessage')
  + '\n同一task的ranges共享该task的initialMessage。';
const placeholder = 'range:' + '0'.repeat(24); // All generated range IDs have this serialized cost.
function request(rules: string, payload: unknown): ModelRequest {
  return { messages: [{ role: 'system', content: rules }, { role: 'user', content: JSON.stringify(payload) }], tools: [] };
}
function groupedPayload(plan: SummaryRangePlan) {
  type Body = ReturnType<typeof rangeBody>;
  const tasks: Array<{ taskId: string; initialMessage: unknown; ranges: Body[] }> = [];
  for (const { payload } of plan.ranges) {
    const { taskId, initialMessage, ...body } = payload;
    if (tasks.at(-1)?.taskId !== taskId) tasks.push({ taskId, initialMessage, ranges: [] });
    tasks.at(-1)!.ranges.push(body);
  }
  return { tasks };
}
// The payload is JSON inside a string in the provider's JSON request.
const fragmentCost = (value: unknown) => tokenThirds(JSON.stringify(JSON.stringify(value))) - 2;

/** Pack whole ranges in canonical order. The preferred unbounded split stays balanced.
 * Near a capacity boundary, examine at most twenty complete units per starting position.
 * A large unit or an evidence gap cannot hide a later legal range. */
export function packSummaryRequest(provider: ProviderConfig, rawInputs: Iterable<TaskSummaryInput>, records: Evidence[], remainingInputTokens = Infinity) {
  const plan: SummaryRangePlan = { ranges: [], retainedUnitIds: [] };
  const inputs: TaskSummaryInput[] = [];
  const capacity = Math.min(contextCapacity(provider).inputCapacity, remainingInputTokens);
  let flat = tokenThirds(serializeRequest(provider, request(TASK_SUMMARY_INSTRUCTIONS, { ranges: [] })));
  let grouped = tokenThirds(serializeRequest(provider, request(sharedInstructions, { tasks: [] })));
  let hasSharedBackground = false, eligible = false;
  const seenTasks = new Set<string>();
  for (const raw of rawInputs) {
    if (seenTasks.has(raw.taskId)) throw new Error('摘要任务重复');
    seenTasks.add(raw.taskId);
    const selected: TaskSummaryInput = { ...raw, units: [], referenceCatalog: [], executionFunctionGuide: [] };
    const background = { taskId: raw.taskId, initialMessage: raw.initialMessage };
    const backgroundHash = digest(raw.initialMessage);
    // Adding the two fields to an existing object costs its serialized fields and a comma.
    const flatExtra = fragmentCost(background) - 1;
    const taskFrame = fragmentCost({ ...background, ranges: [] }) + (inputs.length ? 1 : 0);
    // Measure each unit's escaped body once. Testing a shorter range must not
    // serialize the same large historical tool result for every possible cut.
    const prefix = [0];
    function unitsCost(start: number, end: number) {
      while (prefix.length <= end) {
        const { id, weight, content } = raw.units[prefix.length - 1];
        prefix.push(prefix[prefix.length - 1] + fragmentCost({ id, weight, content }));
      }
      return prefix[end] - prefix[start] + end - start - 1;
    }
    let taskRanges = 0;
    for (const { from, to } of summarySegments(raw, records)) {
      const preferred = new Map(balancedGroups(raw, from, to).map(group => [group.start, group.end]));
      for (let start = from; start < to;) {
        const ends: number[] = [];
        let weight = 0;
        for (let end = start; end < to; end++) {
          weight += raw.units[end].weight;
          if (weight > 5) break;
          if (weight >= 2) ends.push(end + 1);
        }
        if (!ends.length) break;
        eligible = true;
        const first = preferred.get(start);
        const choices = first ? [first, ...ends.reverse().filter(e => e !== first)] : ends.reverse();
        let next = start + 1;
        for (const end of choices) {
          const units = raw.units.slice(start, end);
          const metadata = { ...rangeMetadata(units,placeholder), units: [] };
          const fragment = fragmentCost(metadata) + unitsCost(start, end), hasPrior = taskRanges > 0;
          const flatNext = flat + fragment + flatExtra + (plan.ranges.length ? 1 : 0);
          const groupedNext = grouped + fragment + (hasPrior ? 1 : taskFrame);
          if (Math.min(flatNext, hasSharedBackground || hasPrior ? groupedNext : Infinity) > capacity * 3) continue;
          const range = makeRange(raw, selected.units.length, units, units.reduce((sum, u) => sum + u.weight, 0), backgroundHash);
          plan.ranges.push(range);
          selected.units.push(...units);
          flat = flatNext;
          grouped = groupedNext;
          hasSharedBackground ||= hasPrior;
          taskRanges++;
          next = end;
          break;
        }
        start = next;
      }
    }
    if (taskRanges) {
      selected.referenceCatalog = summaryUnitBindings(selected.units);
      selected.executionFunctionGuide = summaryUnitGuide(selected.units);
      inputs.push(selected);
      if (inputs.length === 3) break;
    }
  }
  // Materialize only the chosen representation. The repeated-background spelling
  // could be orders of magnitude larger than the grouped request that fits.
  const useGroups = hasSharedBackground && Math.ceil(grouped / 3) < Math.ceil(flat / 3);
  const wire = useGroups ? request(sharedInstructions, groupedPayload(plan))
    : request(TASK_SUMMARY_INSTRUCTIONS, summaryRangeRequest(plan));
  const tokens = requestTokens(provider, wire);
  if (plan.ranges.length && tokens > capacity) throw new Error('摘要请求计量与最终序列化不一致');
  return { inputs, plan, wire, tokens, eligible };
}
