import type { CanvasTargetGroup } from './domain';

/** Membership is per group; only the compatibility projection merges duplicates. */
export function targetGroupRefs(groups: readonly CanvasTargetGroup[]): string[] {
  return [...new Set(groups.flatMap(group => group.targetIds))];
}

export function filterTargetGroups(groups: readonly CanvasTargetGroup[], members: ReadonlySet<string>): CanvasTargetGroup[] {
  return groups.map(group => ({ ...group, targetIds: [...new Set(group.targetIds.filter(ref => members.has(ref)))] }));
}

/** A legacy selection is one group for display, without rewriting historical records. */
export function displayTargetGroups(groups: CanvasTargetGroup[] | undefined, refs: string[]): CanvasTargetGroup[] {
  return groups ?? (refs.length ? [{ groupId: 'legacy', targetIds: [...new Set(refs)] }] : []);
}
