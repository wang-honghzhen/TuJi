import type { TaskSummaryInput, TaskSummaryUnit } from './taskSummaryEngine';

type Count = { ascii: number; unicode: number };
type Fragment<T> = { value: T; count: Count };

// Match estimateTokens exactly: keep the ASCII numerator until final rounding.
function count(text: string): Count {
  let ascii = 0, unicode = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x7f) ascii++;
    else unicode += code > 0xffff ? 4 : 2;
  }
  return { ascii, unicode };
}
function fragment<T>(value: T): Fragment<T> { return { value, count: count(JSON.stringify(value)) }; }
function add(total: Count, value: Count, sign = 1) { total.ascii += value.ascii * sign; total.unicode += value.unicode * sign; }

export const summaryUnitBindings = (units: TaskSummaryUnit[]) => [...new Map(units.flatMap(u => u.bindings).map(b => [b.key, b])).values()];
export const summaryUnitGuide = (units: TaskSummaryUnit[]) => [...new Map(units.flatMap(u => u.executionFunctionGuide ?? []).map(g => [g.name, g])).values()];

/** Same ordered complete window and JSON cost as the original selector. Only
 * visited units are serialized, and counts live for this synchronous call only. */
export function boundedSummaryInput(input: TaskSummaryInput, budget: number): TaskSummaryInput | undefined {
  const empty = count(JSON.stringify({ initialMessage: input.initialMessage, referenceCatalog: [], executionFunctionGuide: [], units: [] }));
  const cache = new Map<TaskSummaryUnit, { unit: Count; bindings: Fragment<TaskSummaryUnit['bindings'][number]>[]; guide: Fragment<{ name: string; meaning: string }>[] }>();
  const parts = (unit: TaskSummaryUnit) => {
    let value = cache.get(unit);
    if (!value) {
      value = { unit: count(JSON.stringify({ id: unit.id, weight: unit.weight, content: unit.content })),
        bindings: unit.bindings.map(fragment), guide: (unit.executionFunctionGuide ?? []).map(fragment) };
      cache.set(unit, value);
    }
    return value;
  };
  for (let start = 0; start < input.units.length; start++) {
    const total = { ...empty }, units: TaskSummaryUnit[] = [];
    let weight = 0;
    const bindings = new Map<string, Fragment<TaskSummaryUnit['bindings'][number]>>();
    const guide = new Map<string, Fragment<{ name: string; meaning: string }>>();
    const merge = <T>(map: Map<string, Fragment<T>>, key: string, value: Fragment<T>) => {
      const prior = map.get(key);
      if (prior) add(total, prior.count, -1);
      else if (map.size) total.ascii++;
      map.set(key, value); add(total, value.count);
    };
    for (let index = start; index < input.units.length; index++) {
      const unit = input.units[index], part = parts(unit);
      add(total, part.unit); if (units.length) total.ascii++;
      for (const binding of part.bindings) merge(bindings, binding.value.key, binding);
      for (const item of part.guide) merge(guide, item.value.name, item);
      if (Math.ceil(total.ascii / 3) + total.unicode > budget) break;
      units.push(unit); weight += unit.weight;
    }
    if (weight >= 2) {
      // A rejected next unit can change the count maps. Derive selected metadata
      // once from accepted units, preserving Map order and last-value wins.
      return { ...input, units, referenceCatalog: summaryUnitBindings(units), executionFunctionGuide: summaryUnitGuide(units) };
    }
  }
}
