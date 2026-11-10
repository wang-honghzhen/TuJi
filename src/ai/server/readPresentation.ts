import type { AppSnapshot, ProtocolMessage, SourceRef, Task } from '../domain';
import { isDataRead } from './toolContextKinds';

/** Acknowledged model inputs establish delivery, not previewing or creating a result. */
export function markPresented(state: AppSnapshot, task: Task, messages: ProtocolMessage[], _sources: SourceRef[], readBodyIds?: string[]) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const ids = new Set(messages.filter(m => m.role === 'tool').map(m => m.toolCallId));
  for (const call of state.toolCalls) if (call.taskId === task.id && ids.has(call.providerCallId)
    && call.result !== undefined && ['completed', 'rejected'].includes(call.status)
    && (readBodyIds === undefined || !isDataRead(call.name) || readBodyIds.includes(call.id))) {
    call.presentedAt ??= task.stepCount;
    for (const use of workspace.expansionUses ?? []) if (use.callId === call.id) use.presented = true;
  }
}
