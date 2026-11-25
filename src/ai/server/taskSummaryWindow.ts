import type { TaskSummaryUnit } from './taskSummaryEngine';

export const summaryUnitBindings = (units: TaskSummaryUnit[]) => [...new Map(units.flatMap(u => u.bindings).map(b => [b.key, b])).values()];
export const summaryUnitGuide = (units: TaskSummaryUnit[]) => [...new Map(units.flatMap(u => u.executionFunctionGuide ?? []).map(g => [g.name, g])).values()];
