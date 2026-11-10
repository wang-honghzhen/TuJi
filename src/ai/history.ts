import type { AppSnapshot, ChangeSet, ChatMessage, MemorySnapshot, Note, Task } from './domain';
import { TERMINAL_TASK_STATUSES } from './domain';
import { accessibleSessionTaskIds, residentSessionTaskIds } from './sessionContext';

export interface HistoryTurn {
  key: string;
  taskId: string;
  sourceSessionId: string;
  sourceTitle: string;
  local: boolean;
  status: Task['status'];
  rootMessageId?: string;
  messages: ChatMessage[];
  operations: ChangeSet[];
  notes: Note[];
  memoryIds: string[];
  at: string;
}

/** Selection requires a completed task in the records visible to this session. */
export function isCompletedHistoryTask(state: AppSnapshot, sessionId: string, taskId: string): boolean {
  const session = state.sessions.find(value => value.id === sessionId);
  const workspace = state.workspaces.find(value => value.id === session?.workspaceId);
  if (!session || !workspace) return false;
  const local = state.tasks.find(task => task.id === taskId && task.workspaceId === workspace.id);
  if (local) return local.status === 'completed';
  const memories = state.snapshots.filter(memory => workspace.snapshotIds.includes(memory.id) && !memory.revoked
    && memory.messages.some(message => message.taskId === taskId));
  return memories.length > 0 && memories.every(memory => memory.sourceTaskStates?.find(task => task.id === taskId)?.status === 'completed');
}

/** Frozen parent records are earlier ordinary turns, not an always-on memory module.
 * Stored snapshots are never modified. */
export function historyTurns(state: AppSnapshot, sessionId: string, currentTaskId?: string): HistoryTurn[] {
  const session = state.sessions.find(value => value.id === sessionId);
  const workspace = state.workspaces.find(value => value.id === session?.workspaceId);
  if (!session || !workspace) return [];
  const groups = new Map<string, HistoryTurn>();
  const addUnique = <T>(target: T[], values: T[], key: (value: T) => string) => {
    const existing = new Set(target.map(key));
    for (const value of values) if (!existing.has(key(value))) { target.push(value); existing.add(key(value)); }
  };
  const group = (taskId: string, sourceSessionId: string, memory?: MemorySnapshot) => {
    let turn = groups.get(taskId);
    if (!turn) {
      turn = { key: taskId, taskId, sourceSessionId,
        sourceTitle: state.sessions.find(value => value.id === sourceSessionId)?.title ?? '来源会话', local: false,
        status: memory?.sourceTaskStates?.find(value => value.id === taskId)?.status ?? 'completed',
        messages: [], operations: [], notes: [], memoryIds: [], at: memory?.createdAt ?? session.createdAt };
      groups.set(taskId, turn);
    }
    if (memory && !turn.memoryIds.includes(memory.id)) turn.memoryIds.push(memory.id);
    return turn;
  };
  const memories = state.snapshots.filter(memory => workspace.snapshotIds.includes(memory.id)
    && !memory.revoked);
  for (const memory of memories) {
    const fallback = memory.sourceTaskIds.at(-1) ?? `note-history:${memory.id}`;
    for (const message of memory.messages) {
      const origin = state.tasks.find(task => task.id === message.taskId)?.sessionId ?? memory.sourceSessionId;
      const turn = group(message.taskId, origin, memory);
      addUnique(turn.messages, [message], value => `${value.id}:${value.version}`);
      if (message.role === 'user' && message.phase === 'request') turn.rootMessageId ??= message.id;
      turn.at = turn.messages.reduce((at, value) => value.createdAt < at ? value.createdAt : at, memory.createdAt);
    }
    for (const operation of memory.operations) {
      const turn = group(operation.taskId || fallback, memory.sourceSessionId, memory);
      addUnique(turn.operations, [operation], value => `${value.id}:${value.status}`);
    }
    // Temporary chats read the live source notebook; frozen note copies must not
    // reintroduce content the source has since edited or deleted.
    for (const note of session.mode === 'temporary' ? [] : memory.notes) {
      const taskId = note.sourceRefs.map(source => memory.messages.find(message => source.kind === 'message' && message.id === source.id)?.taskId)
        .find((value): value is string => Boolean(value)) ?? fallback;
      addUnique(group(taskId, memory.sourceSessionId, memory).notes, [note], value => `${value.id}:${value.version}`);
    }
  }
  // One pass over the messages, so a long session does not scan the whole message table per task.
  const byTask = new Map<string, ChatMessage[]>();
  for (const message of state.messages) if (message.workspaceId === workspace.id && message.status !== 'streaming') {
    const bucket = byTask.get(message.taskId); if (bucket) bucket.push(message); else byTask.set(message.taskId, [message]);
  }
  const changesByTask = new Map<string, ChangeSet[]>();
  for (const change of state.changes) {
    const bucket = changesByTask.get(change.taskId); if (bucket) bucket.push(change); else changesByTask.set(change.taskId, [change]);
  }
  for (const task of state.tasks) if (task.sessionId === sessionId && task.id !== currentTaskId && TERMINAL_TASK_STATUSES.includes(task.status)) {
    const turn = group(task.id, sessionId);
    turn.local = true; turn.status = task.status; turn.rootMessageId = task.rootUserMessageId; turn.at = task.createdAt;
    turn.sourceSessionId = sessionId; turn.sourceTitle = session.title;
    addUnique(turn.messages, byTask.get(task.id) ?? [], value => `${value.id}:${value.version}`);
    addUnique(turn.operations, changesByTask.get(task.id) ?? [], value => `${value.id}:${value.status}`);
  }
  for (const turn of groups.values()) turn.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)
    || (a.sequence ?? 0) - (b.sequence ?? 0)
    || Number(b.role === 'user' && b.phase === 'request') - Number(a.role === 'user' && a.phase === 'request')
    || a.id.localeCompare(b.id));
  const order = workspace.sessionContext?.taskOrder ?? accessibleSessionTaskIds(state, sessionId);
  return [...groups.values()].filter(turn => turn.messages.length || turn.operations.length || turn.notes.length)
    .sort((a, b) => {
      const ai = order.indexOf(a.taskId), bi = order.indexOf(b.taskId);
      return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi)
        || a.at.localeCompare(b.at) || (a.messages[0]?.sequence ?? 0) - (b.messages[0]?.sequence ?? 0);
    });
}

export function residentHistoryTurns(state: AppSnapshot, sessionId: string, currentTaskId?: string): HistoryTurn[] {
  const resident = new Set(residentSessionTaskIds(state, sessionId, currentTaskId));
  return historyTurns(state, sessionId, currentTaskId).filter(turn => resident.has(turn.taskId));
}

