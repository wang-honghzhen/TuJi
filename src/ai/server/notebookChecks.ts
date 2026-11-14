import type { AppSnapshot, Note, Task, ToolCallRecord } from '../domain';
import { notebookWorkspace } from '../notebook';
import { hash } from './repository';

/** The request's notebook collection, independent of abbreviated notification text. */
export interface NotebookCheck {
  notebookId: string | null;
  bindingRevision: number;
  notes: Record<string, { version: number; contentHash: string }>;
  /** Visible notebook entries not fully delivered at submission. A notice is not a body. */
  unreadNoteIds?: string[];
}
const stamp = (note: Note) => ({ version: note.version, contentHash: hash([note.text, note.type, note.sourceRefs]) });
export function captureNotebookCheck(state: AppSnapshot, task: Task): NotebookCheck {
  const session = state.sessions.find(s => s.id === task.sessionId), notebook = notebookWorkspace(state, session);
  return { notebookId: notebook?.id ?? null, bindingRevision: session?.temporaryContext?.revision ?? 0,
    notes: Object.fromEntries((notebook?.workNotes ?? []).map(note => [note.id, stamp(note)])) };
}

/** Only successful writes in this response can advance the submitted baseline.
 * Use their exact archived version, never a later live edit of the same note. */
export function notebookCheckChanges(state: AppSnapshot, task: Task, submitted: NotebookCheck | undefined, calls: ToolCallRecord[] = []) {
  const current = captureNotebookCheck(state, task);
  if (!submitted) return [{ kind: 'unknown', notebookId: current.notebookId }];
  if (submitted.notebookId !== current.notebookId || submitted.bindingRevision !== current.bindingRevision)
    return [{ kind: 'binding', notebookId: current.notebookId }];
  if(submitted.unreadNoteIds?.length)return submitted.unreadNoteIds.map(noteId=>({kind:'unread',noteId}));
  const expected = structuredClone(submitted.notes), notebook = state.workspaces.find(w => w.id === current.notebookId);
  for (const call of calls) {
    if (call.status !== 'completed' || call.taskId !== task.id) continue;
    const ack = call.noteWriteAcknowledgement;
    if (ack && ack.notebookId === current.notebookId) {
      const note = [...notebook?.workNotes ?? [], ...notebook?.noteVersions ?? []].find(n => n.id === ack.noteId && n.version === ack.version);
      if (note) expected[note.id] = stamp(note);
    }
    if (call.name === 'workspace_delete_work_notes') try {
      const result = JSON.parse(call.result ?? '{}');
      if (result.status === 'ok' && typeof result.id === 'string') delete expected[result.id];
    } catch { /* A malformed receipt cannot acknowledge deletion. */ }
  }
  return [...new Set([...Object.keys(expected), ...Object.keys(current.notes)])].sort().flatMap(id => {
    const before = expected[id], after = current.notes[id];
    if (before?.contentHash === after?.contentHash) return [];
    return [{ kind: !before ? 'added' : !after ? 'deleted' : 'changed', noteId: id,
      expectedVersion: before?.version ?? null, currentVersion: after?.version ?? null }];
  });
}
