import type { AppSnapshot, Task } from './domain';
import { ensureSessionContext, settleSessionContext } from './sessionContext';

/** Task boundaries, not model steps, determine the minimal chat's entire history window. */
export function minimalContextWindow(state: AppSnapshot, task: Task) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const local = state.tasks.filter(t => t.workspaceId === task.workspaceId);
  const byId = new Map(local.map(t => [t.id, t]));
  const ordered = [...new Set([...(workspace.sessionContext?.taskOrder ?? []), ...local.map(t => t.id)])].filter(id => byId.has(id));
  const completed = ordered.filter(id => byId.get(id)!.status === 'completed');
  const trimRound = completed.length < 10 ? 0 : 10 + Math.floor((completed.length - 10) / 5) * 5;
  const kept = new Set(completed.slice(trimRound ? trimRound - 5 : 0));
  const taskIds = ordered.filter(id => kept.has(id) || byId.get(id)!.status !== 'completed');
  if (task.status !== 'completed' && !taskIds.includes(task.id)) taskIds.push(task.id);
  return { taskIds, omittedTaskIds: ordered.filter(id => !taskIds.includes(id)), completedRounds: completed.length, trimRound };
}

/** Persist only residency. Original messages, tool records and attachment files stay available. */
export function commitMinimalContext(state: AppSnapshot, task: Task): void {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const context = ensureSessionContext(state, workspace), window = minimalContextWindow(state, task);
  context.residentTaskIds = window.taskIds;
  context.excludedTaskIds = window.omittedTaskIds;
  settleSessionContext(state, task.sessionId);
}
