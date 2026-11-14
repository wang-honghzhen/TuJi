import type { AppSnapshot, Note, SourceRef } from './domain';

/** A fork may keep the note ID and numeric revision. Resolve only within the
 * reader's authorized notebook and snapshots, never by global array order. */
export function noteReferenceScope(state: AppSnapshot, sessionId: string) {
  const session = state.sessions.find(value => value.id === sessionId);
  const workspace = state.workspaces.find(value => value.id === session?.workspaceId);
  const owner = session?.mode === 'temporary'
    ? state.sessions.find(value => value.id === session.temporaryContext?.sourceSessionId && value.lifecycle !== 'deleted')
    : session;
  const notebook = session?.temporaryContext?.mode === 'minimal' ? undefined
    : state.workspaces.find(value => value.id === owner?.workspaceId);
  const owners = [...new Set([workspace, notebook].filter(value => !!value))];
  const memories = state.snapshots.filter(value => workspace?.snapshotIds.includes(value.id) && !value.revoked);
  return { live: owners.flatMap(value => [...value.workNotes, ...value.pinnedNotes]),
    archived: [...owners.flatMap(value => value.noteVersions ?? []), ...memories.flatMap(value => value.notes)] };
}

// Timestamps, authorship and storage location do not change what was read.
const material = (note: Note) => JSON.stringify([note.text, note.type, note.sourceRefs,
  note.lifecycle ?? 'multi_task', note.taskId ?? null]);
const uniqueMaterial = (notes: Note[]) => [...new Map(notes.map(note => [material(note), note])).values()];

export interface NoteReferenceResolution {
  status: 'ok' | 'missing' | 'ambiguous';
  note?: Note;
  current?: Note;
}

/** Identical inherited copies are one fact. Conflicting legacy copies inside
 * the allowed scope are ambiguous and must not silently choose a branch. */
export function resolveNoteReference(state: AppSnapshot, sessionId: string, ref: Pick<SourceRef, 'id' | 'version'>): NoteReferenceResolution {
  const scope = noteReferenceScope(state, sessionId);
  const current = uniqueMaterial(scope.live.filter(note => note.id === ref.id));
  const candidates = uniqueMaterial([...scope.live, ...scope.archived].filter(note => note.id === ref.id && note.version === ref.version));
  if (candidates.length > 1 || current.length > 1) return { status: 'ambiguous' };
  return { status: candidates.length ? 'ok' : 'missing', note: candidates[0], current: current[0] };
}
