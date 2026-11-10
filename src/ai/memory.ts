import type { AppSnapshot, Artifact, ChatMessage, SourceRef, Task } from './domain';
import { TERMINAL_TASK_STATUSES } from './domain';
import { historyTurns, residentHistoryTurns } from './history';
import { residentSessionTaskIds } from './sessionContext';
import { contextCapacity } from './contextCapacity';

// Preserve the former defaults' relative sizes; every region scales with available input.
export const DEFAULT_CONTEXT_WEIGHTS = { fixed_requirements: 8, canvas: 12, references: 32, work_notes: 4, history: 24, progress: 24 } as const;
export const HANDOFF_LIMIT = 800;
export const READ_PAGE_BUDGET = 1200;
export const inputCapacity = (state: AppSnapshot) => contextCapacity(state.provider).inputCapacity;
export function sectionBudgets(state: AppSnapshot) {
  const capacity = Math.max(0, inputCapacity(state));
  const total = Object.values(DEFAULT_CONTEXT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const share = (weight: number) => Math.floor(capacity * weight / total);
  return { fixed_requirements: share(DEFAULT_CONTEXT_WEIGHTS.fixed_requirements), canvas: share(DEFAULT_CONTEXT_WEIGHTS.canvas),
    references: share(DEFAULT_CONTEXT_WEIGHTS.references), work_notes: state.provider.workNotesPercent === undefined
      ? share(DEFAULT_CONTEXT_WEIGHTS.work_notes) : Math.floor(capacity * state.provider.workNotesPercent / 100),
    history: share(DEFAULT_CONTEXT_WEIGHTS.history), progress: share(DEFAULT_CONTEXT_WEIGHTS.progress) };
}

/** Shared provenance check: revoked or invalid sources cannot re-enter through derived notes or summaries. */
export function sourceVisible(state: AppSnapshot, task: Task, refs: SourceRef[], visiting = new Set<string>()): boolean {
  const workspace = state.workspaces.find(value => value.id === task.workspaceId)!;
  return refs.every(ref => {
    const key = `${ref.kind}:${ref.id}:${ref.version}`;
    if (visiting.has(key)) return false;
    const next = new Set(visiting); next.add(key);
    if (ref.kind === 'message') {
      const record = [...state.messages, ...state.snapshots.flatMap(snapshot => snapshot.messages)].find(message => message.id === ref.id && message.version === ref.version);
      return !record || sourceVisible(state, task, record.sourceRefs, next);
    }
    if (ref.kind === 'note') {
      const note = [...state.workspaces.flatMap(value => [...value.pinnedNotes, ...value.workNotes, ...(value.noteVersions??[])]), ...state.snapshots.flatMap(value => value.notes)]
        .find(value => value.id === ref.id && value.version === ref.version);
      if(note?.lifecycle==='current_task'&&state.tasks.some(t=>t.id===note.taskId&&TERMINAL_TASK_STATUSES.includes(t.status)))return false;
      return !note || sourceVisible(state, task, note.sourceRefs, next);
    }
    if (ref.kind === 'snapshot') {
      const snapshot = state.snapshots.find(value => value.id === ref.id && value.contentHash === ref.version);
      return Boolean(snapshot && workspace.snapshotIds.includes(snapshot.id) && !snapshot.revoked
        && sourceVisible(state, task, snapshot.sourceRefs, next));
    }
    return true;
  });
}
export function selectedMessages(state: AppSnapshot, task: Task): ChatMessage[] {
  return [...residentHistoryTurns(state, task.sessionId, task.id).flatMap(turn => turn.messages),
    ...state.messages.filter(message => message.taskId === task.id && message.workspaceId === task.workspaceId)]
    .filter(message => sourceVisible(state, task, message.sourceRefs));
}
/** Only explicit user attachment bindings grant full files; citations grant their own ranges. */
export function messageAttachments(message: ChatMessage, state?: AppSnapshot): SourceRef[] {
  if (message.role !== 'user') return [];
  if (message.attachments) return message.attachments;
  const bound = state?.tasks.find(task => task.id === message.taskId)?.inputBindings;
  return message.sourceRefs.filter(ref => ref.kind === 'artifact' && ref.start === undefined && ref.end === undefined && ref.page === undefined
    && (!bound || bound.artifactIds.includes(ref.id) && bound.artifactVersions[ref.id] === ref.version));
}
export function effectiveArtifacts(state: AppSnapshot, task: Task, retainedTaskIds?: Iterable<string>): Array<{ ref: SourceRef; artifact?: Artifact }> {
  const workspace = state.workspaces.find(value => value.id === task.workspaceId)!;
  const memories = state.snapshots.filter(value => workspace.snapshotIds.includes(value.id) && !value.revoked);
  const resident = new Set(retainedTaskIds ?? residentSessionTaskIds(state, task.sessionId, task.id));
  const messages = [...historyTurns(state,task.sessionId).filter(t=>resident.has(t.taskId)).flatMap(t=>t.messages),
    ...state.messages.filter(m=>m.taskId===task.id&&resident.has(task.id))].filter(m=>sourceVisible(state,task,m.sourceRefs));
  const refs = [...messages.flatMap(message => messageAttachments(message, state)),
    ...(resident.has(task.id)?task.inputBindings.artifactIds.map(id => ({ kind: 'artifact' as const, id, version: task.inputBindings.artifactVersions[id] })):[])];
  return [...new Map(refs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()].map(ref => {
    const artifact = state.artifacts.find(value => value.id === ref.id && value.version === ref.version && value.status !== 'deleted')
      ?? memories.flatMap(value => value.artifacts ?? []).find(value => value.id === ref.id && value.version === ref.version && value.status !== 'deleted');
    return { ref, artifact };
  });
}
/** Keep original dependencies when a cited note block is later overwritten or cleaned. */
export function withNoteProvenance(state: AppSnapshot, refs: SourceRef[]): SourceRef[] {
  const notes = [...state.workspaces.flatMap(workspace => [...workspace.workNotes, ...workspace.pinnedNotes, ...(workspace.noteVersions??[])]), ...state.snapshots.flatMap(snapshot => snapshot.notes)];
  const found = new Map<string, SourceRef>();
  const visit = (ref: SourceRef) => {
    const key = JSON.stringify(ref); if (found.has(key)) return; found.set(key, ref);
    if (ref.kind === 'note') notes.find(note => note.id === ref.id && note.version === ref.version)?.sourceRefs.forEach(child => visit(ref.tracking === 'historical' ? { ...child, tracking: 'historical' } : child));
  };
  refs.forEach(visit); return [...found.values()];
}
