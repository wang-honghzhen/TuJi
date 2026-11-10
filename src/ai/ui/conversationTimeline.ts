import type { AppSnapshot, ChatMessage, Session, Task, ToolCallRecord } from '../domain';
import type { HistoryTurn } from '../history';
import { hiddenPresentationCall } from '../modelVisibility';

export type ConversationEntry = { key: string; sequence: number; at: string } & (
  { kind: 'message'; message: ChatMessage; continuation?:boolean } | { kind: 'tool'; call: ToolCallRecord; calls?: ToolCallRecord[] }
  | { kind: 'compaction'; task: Task; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' }
  | { kind: 'time' | 'state'; task: Task }
);

/** Text separated by br remains one visual reply, with ordinary paragraph spacing. */
function joinReplyParts(entries:ConversationEntry[]):ConversationEntry[] {
  for(let i=1;i<entries.length;i++){
    const entry=entries[i],previous=entries[i-1];
    if(entry.kind==='message'&&previous.kind==='message'&&entry.message.role==='assistant'&&previous.message.role==='assistant'
      &&entry.message.stepId&&entry.message.stepId===previous.message.stepId&&entry.message.taskId===previous.message.taskId)entry.continuation=true;
  }
  const grouped:ConversationEntry[]=[];
  for(const entry of entries){
    const previous=grouped.at(-1);
    if(entry.kind==='tool'&&previous?.kind==='tool'&&entry.call.taskId===previous.call.taskId)
      (previous.calls??=[previous.call]).push(entry.call);
    else grouped.push(entry);
  }
  return grouped;
}

/** Highest event cursor at or before a timestamp, over an already time-sorted event list. */
function highestGlobalSeq(events: Array<{ createdAt: string; globalSeq: number }>, at: string): number {
  if (!events.length) return 0;
  let low = 0, high = events.length - 1, found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (events[middle].createdAt <= at) { found = Math.max(found, events[middle].globalSeq); low = middle + 1; }
    else high = middle - 1;
  }
  // Events sharing the boundary timestamp can sit right after the probe, so finish the tie group.
  for (let index = Math.min(low, events.length - 1); index < events.length && events[index].createdAt === at; index++) found = Math.max(found, events[index].globalSeq);
  return found;
}

/** One ordered stream, including user messages queued while another reply is still running. */
export function conversationTimeline(snapshot: AppSnapshot, sessionId: string): ConversationEntry[] {
  const tasks = snapshot.tasks.filter(task => task.sessionId === sessionId);
  const ids = new Set(tasks.map(task => task.id));
  // Sequence-less records inherit their order from the event log; scanning it once per record was
  // the most expensive part of a long conversation, so it is sorted once and searched.
  const events = snapshot.events.filter(event => event.taskId && ids.has(event.taskId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.globalSeq - b.globalSeq);
  const rank = (sequence: number | undefined, at: string) => sequence ?? highestGlobalSeq(events, at) + .25;
  const entries: ConversationEntry[] = [];
  for (const message of snapshot.messages) if (ids.has(message.taskId) && (message.text.trim() || message.role==='user'&&(message.targetRefs.length||message.attachments?.length))) {
    entries.push({ kind: 'message', key: message.id, message, at: message.createdAt, sequence: rank(message.sequence, message.createdAt) });
  }
  for (const call of snapshot.toolCalls) if (ids.has(call.taskId) && !hiddenPresentationCall(call) && !['ui_present', 'ui_focus', 'task_finish'].includes(call.name)
    && (call.sequence !== undefined || call.status !== 'prepared')) {
    const at = call.startedAt ?? call.createdAt;
    entries.push({ kind: 'tool', key: call.id, call, at, sequence: rank(call.sequence, at) });
  }
  const finishes=new Map(events.filter(e=>e.type==='context.compaction_finished').map(e=>[e.payload.roundId,e]));
  for(const event of events)if(event.type==='context.compaction_started'){
    const task=tasks.find(t=>t.id===event.taskId)!;
    const result=finishes.get(event.payload.roundId);
    const status=result?.payload.status as 'completed'|'failed'|'cancelled'|'skipped'|undefined;
    entries.push({kind:'compaction',key:event.id,task,status:status??(['running','queued'].includes(task.status)?'running':'cancelled'),at:event.createdAt,sequence:event.globalSeq});
  }
  for (const task of tasks) {
    if (task.status === 'completed') {
      const at = task.finishedAt ?? task.updatedAt;
      entries.push({ kind: 'time', key: `time:${task.id}`, task, at, sequence: rank(task.finishedSequence, at) });
    } else {
      const last = entries.filter(entry => ('message' in entry ? entry.message.taskId : 'call' in entry ? entry.call.taskId : entry.task.id) === task.id)
        .reduce((value, entry) => Math.max(value, entry.sequence), rank(undefined, task.createdAt));
      entries.push({ kind: 'state', key: `state:${task.id}`, task, at: task.updatedAt, sequence: last + .5 });
    }
  }
  const priority = { tool: 0, message: 1, compaction: 2, time: 3, state: 4 };
  return joinReplyParts(entries.sort((a, b) => a.sequence - b.sequence || a.at.localeCompare(b.at) || priority[a.kind] - priority[b.kind]));
}

/** Frozen parent functions and their original public replies share one display order. */
export function inheritedTimeline(snapshot: AppSnapshot, turn: HistoryTurn): ConversationEntry[] {
  const entries: ConversationEntry[] = turn.messages.filter(message => message.text.trim() || message.role==='user'&&(message.targetRefs.length||message.attachments?.length))
    .map(message => ({ kind: 'message', key: `history:${message.id}:${message.version}`, message, at: message.createdAt,
      sequence: message.sequence ?? Date.parse(message.createdAt) }));
  const calls = [...new Map(snapshot.snapshots.filter(memory => turn.memoryIds.includes(memory.id)).flatMap(memory => memory.toolCalls ?? [])
    .filter(call => call.taskId === turn.taskId && !hiddenPresentationCall(call) && !['ui_present', 'ui_focus', 'task_finish'].includes(call.name))
    .map(call => [call.id, call])).values()];
  for (const call of calls) entries.push({ kind: 'tool', key: `history-tool:${call.id}`, call, at: call.startedAt ?? call.createdAt,
    sequence: call.sequence ?? Date.parse(call.startedAt ?? call.createdAt) });
  return joinReplyParts(entries.sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence || Number(a.kind === 'message') - Number(b.kind === 'message')));
}

export interface ConversationTurnLabel { taskId: string; preview: string; protected: boolean; starred: boolean; current?: boolean; contextRange?: string }
export function conversationTurnLabels(snapshot: AppSnapshot, session: Session, earlier: HistoryTurn[], timeline: ConversationEntry[]): ConversationTurnLabel[] {
  const settled = snapshot.workspaces.find(w=>w.id===session.workspaceId)?.sessionContext?.settled;
  const protectedIds = new Set(settled?.taskIds ?? []);
  const currentIds = new Set(snapshot.tasks.filter(t => t.sessionId === session.id && t.status !== 'completed').map(t => t.id));
  const ranges = new Map(settled?.taskRanges?.map(range => {
    const steps = [...new Set(range.records.flatMap(r => r.step === undefined ? [] : [r.step]))].sort((a,b) => a-b);
    const spans: string[] = [];
    for(let i=0;i<steps.length;i++){ const first=steps[i];while(i+1<steps.length&&steps[i+1]===steps[i]+1)i++;spans.push(first===steps[i]?`${first}`:`${first}–${steps[i]}`); }
    const count = (kind: 'body'|'receipt') => new Set(range.records.filter(r=>r.representation===kind).map(r=>r.recordId)).size;
    const summaries = new Set(range.records.filter(r=>r.representation==='summary').map(r=>r.summaryId??r.recordId)).size;
    const parts = [count('body')?`${count('body')} 条正文`:'',count('receipt')?`${count('receipt')} 条回执`:'',summaries?`${summaries} 条摘要`:''].filter(Boolean);
    return [range.taskId,parts.length?`当前提示词：${parts.join('、')}${spans.length?`；步骤 ${spans.join('、')}`:''}`:undefined] as const;
  }));
  const markedIds = new Set(snapshot.chatTurnBookmarks?.map(mark => mark.id));
  const roots = new Map(snapshot.tasks.map(task => [task.id, task.rootUserMessageId]));
  const messages = new Map<string, ChatMessage>();
  for (const entry of timeline) if (entry.kind === 'message' && entry.message.role === 'user') {
    const message = entry.message;
    if (!messages.has(message.taskId) || message.id === roots.get(message.taskId)) messages.set(message.taskId, message);
  }
  const label = (taskId: string, message?: ChatMessage): ConversationTurnLabel => ({ taskId,
    preview: message?.text.trim().replace(/\s+/g, ' ').slice(0, 240) || (message?.attachments?.length ? '用户发送了附件' : '该轮暂无用户文字'),
    protected: protectedIds.has(taskId), starred: markedIds.has(taskId), current: currentIds.has(taskId), contextRange: ranges.get(taskId) });
  const result = earlier.map(turn => label(turn.taskId, turn.messages.find(message => message.id === turn.rootMessageId)
    ?? turn.messages.find(message => message.role === 'user')));
  const seen = new Set(result.map(turn => turn.taskId));
  for (const entry of timeline) {
    const taskId = entry.kind === 'message' ? entry.message.taskId : entry.kind === 'tool' ? entry.call.taskId : entry.task.id;
    if (!seen.has(taskId)) { result.push(label(taskId, messages.get(taskId))); seen.add(taskId); }
  }
  return result;
}
