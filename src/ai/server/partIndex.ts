import type { AppSnapshot, ChatMessage, PresentationPart, Task, ToolCallRecord } from '../domain';
import { selectedMessages, sourceVisible } from '../memory';
import { residentHistoryTurns } from '../history';
import { presentationSourceCall } from '../modelVisibility';

export interface PartIndex {
  currentTaskId: string;
  parts: PresentationPart[];
  messages: ChatMessage[];
  calls: ToolCallRecord[];
  anchors: Map<string, string>;
  byRecord: Map<string, PresentationPart[]>;
}

/** Only frozen, actually recorded segments are indexed; legacy text is never re-numbered. */
export function buildPartIndex(state: AppSnapshot, task: Task): PartIndex {
  const turns = residentHistoryTurns(state, task.sessionId, task.id);
  const memoryIds = new Set(turns.flatMap(t => t.memoryIds));
  const memories = state.snapshots.filter(s => memoryIds.has(s.id) && !s.revoked);
  const taskIds = new Set([task.id, ...turns.map(t => t.taskId)]);
  const localTaskIds=new Set(state.tasks.filter(t=>t.workspaceId===task.workspaceId&&taskIds.has(t.id)).map(t=>t.id));
  const messages = selectedMessages(state, task);
  const calls = [...new Map([...state.toolCalls.filter(c => localTaskIds.has(c.taskId)), ...memories.flatMap(s => s.toolCalls ?? [])]
    .filter(c => taskIds.has(c.taskId)&&sourceVisible(state, task, c.resultSources ?? [])).map(c => [c.id, c])).values()];
  const anchors = new Map(turns.filter(t => t.rootMessageId).map(t => [t.taskId, t.rootMessageId!]));
  anchors.set(task.id, task.rootUserMessageId);
  const byRecord = new Map<string, PresentationPart[]>();
  const parts: PresentationPart[] = [];
  for (const part of [...new Map([...(state.presentationParts??[]).filter(p=>localTaskIds.has(p.taskId)), ...memories.flatMap(s => s.presentationParts ?? [])].map(p => [p.id, p])).values()]) {
    if (!taskIds.has(part.taskId) || !anchors.has(part.taskId)) continue;
    const keys = [...new Set((part.events??[]).flatMap(event=>{
      const message=messages.find(m=>m.id===event.messageId&&m.taskId===part.taskId);
      const source=message?presentationSourceCall(message,calls):undefined;
      if(source)return [source.id,message!.id];
      if(message)return [message.id];
      return calls.some(c=>c.id===event.callId&&c.taskId===part.taskId)?[event.callId!]:[];
    }))];
    if (!keys.length) continue;
    parts.push(part);
    for (const key of keys) { const values = byRecord.get(key) ?? []; values.push(part); byRecord.set(key, values); }
  }
  return { currentTaskId:task.id, parts, messages, calls, anchors, byRecord };
}

