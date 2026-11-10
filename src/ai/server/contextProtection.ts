import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import { residentHistoryTurns } from '../history';
import { AUTO_CONTEXT } from '../contextState';
import { allRetainedCalls, isReceipted, originResultId } from './readVisibility';
import { isDataRead } from './toolContextKinds';

export function completedContextGroups(state: AppSnapshot, task: Task, taskIds?: Set<string>) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const visible = taskIds ?? new Set([task.id, ...residentHistoryTurns(state, task.sessionId, task.id).map(t => t.taskId)]);
  const calls = allRetainedCalls(state);
  const groups = new Map<string, { id: string; order: number }>();
  for (const step of state.steps) if (visible.has(step.taskId) && step.purpose === 'agent' && step.status === 'completed'
    && calls.filter(c => c.stepId === step.id).every(c => ['completed', 'rejected'].includes(c.status))) {
    const message = state.messages.find(m => m.stepId === step.id && m.role === 'assistant');
    groups.set(step.id, { id: step.id, order: step.completedSequence ?? message?.sequence
      ?? calls.find(c => c.stepId === step.id)?.sequence ?? Date.parse(step.createdAt) });
  }
  for (const memory of state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked)) {
    for (const group of memory.completedStepGroups ?? []) if (visible.has(group.taskId)) groups.set(group.id, group);
    // Old isolated fixtures can omit step metadata; real pre-policy memory is reset at upgrade.
    for (const row of memory.conversationOrder ?? []) if (row.stepId && visible.has(row.taskId) && !groups.has(row.stepId))
      groups.set(row.stepId, { id: row.stepId, order: row.sequence ?? Date.parse(row.createdAt) });
  }
  const order=[...(taskIds??new Set(workspace.sessionContext?.residentTaskIds??[]))];
  const taskFor=(id:string)=>state.steps.find(s=>s.id===id)?.taskId??state.snapshots.flatMap(s=>s.completedStepGroups??[]).find(g=>g.id===id)?.taskId;
  return [...groups.values()].sort((a,b)=>order.indexOf(taskFor(a.id)??'')-order.indexOf(taskFor(b.id)??'')||a.order-b.order||a.id.localeCompare(b.id));
}
export function localCompletedGroupCount(state: AppSnapshot, task: Task): number {
  const ids = new Set(state.tasks.filter(t => t.workspaceId === task.workspaceId).map(t => t.id));
  return completedContextGroups(state, task, ids).length;
}
export function contextProtection(state: AppSnapshot, task: Task, taskIds?: Set<string>, _includeBranches = true) {
  const resident=taskIds??new Set([...residentHistoryTurns(state,task.sessionId,task.id).map(t=>t.taskId),task.id]);
  const groups=completedContextGroups(state,task,resident);
  const recentSteps=new Set(groups.slice(-AUTO_CONTEXT.recentGroups).map(g=>g.id));
  const protectedSteps=new Set(recentSteps),protectedCalls=new Set<string>(),hardProtectedCalls=new Set<string>();
  const hardReasons:Record<string,string[]>={};
  const calls=allRetainedCalls(state).filter(call=>resident.has(call.taskId));
  const incompleteSteps=new Set(state.steps.filter(step=>resident.has(step.taskId)&&step.status!=='completed').map(step=>step.id));
  for(const call of calls)if(call.presentedAt===undefined||call.result===undefined||!['completed','rejected'].includes(call.status))incompleteSteps.add(call.stepId);
  for(const call of calls){
    // A model step is indivisible, including delivery: a settled sibling cannot
    // be compacted while another result in the same group is still pending.
    const unsettled=incompleteSteps.has(call.stepId);
    if(unsettled||recentSteps.has(call.stepId)){
      protectedCalls.add(originResultId(call));protectedSteps.add(call.stepId);
      if(unsettled){hardProtectedCalls.add(originResultId(call));hardReasons[originResultId(call)]=['undelivered'];}
    }
  }
  return {groups,recentSteps,protectedSteps,protectedCalls,hardProtectedCalls,immovableCalls:new Set(hardProtectedCalls),hardReasons};
}
export function eligibleRead(call: ToolCallRecord, state: AppSnapshot, protectedCalls: Set<string>): boolean {
  return isDataRead(call.name) && !isReceipted(state, call) && call.result !== undefined && call.presentedAt !== undefined
    && ['completed', 'rejected'].includes(call.status) && !protectedCalls.has(originResultId(call));
}
