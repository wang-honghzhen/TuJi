import type { CanvasTargetGroup } from '../domain';
import { targetGroupRefs, filterTargetGroups } from '../targetGroups';
import { requireValue, strings, text } from './errors';

export function normalizeInputTargets(input: { targetGroups?: unknown; targetIds?: unknown }, members: ReadonlySet<string>) {
  if (input.targetGroups === undefined) return { targetIds: strings(input.targetIds ?? [], '选区').filter(ref => members.has(ref)), targetGroups: undefined };
  requireValue(Array.isArray(input.targetGroups) && input.targetGroups.length <= 10000, '引用组必须是列表');
  const seen = new Set<string>();
  const groups: CanvasTargetGroup[] = input.targetGroups.map(value => {
    requireValue(value && typeof value === 'object' && !Array.isArray(value), '引用组无效');
    const groupId = text(value.groupId, '引用组 ID', 200);
    requireValue(groupId && !seen.has(groupId), '引用组 ID 不能为空或重复'); seen.add(groupId);
    return { groupId, targetIds: strings(value.targetIds, '组内对象') };
  });
  requireValue(groups.reduce((count, group) => count + group.targetIds.length, 0) <= 10000, '引用对象总数不能超过 10000');
  const targetGroups = filterTargetGroups(groups, members);
  return { targetGroups, targetIds: targetGroupRefs(targetGroups) };
}
