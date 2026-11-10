import type { AppSnapshot, SourceRef, Task } from '../domain';
import { notebookWorkspace, sameNoteContent } from '../notebook';
import { canvasMemberIds } from '../canvasScope';
import { entity } from './graph';
import { hash } from './repository';

export interface SourceChange { source: SourceRef; state: 'changed' | 'unavailable'; currentVersion?: string | number }

/** Check only permitted sources. Frozen citations remain historical; revoked sources remain unavailable. */
export function sourceChanges(state: AppSnapshot, task: Task, sources: SourceRef[], deep = true): SourceChange[] {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const notebook = notebookWorkspace(state, state.sessions.find(s => s.id === task.sessionId));
  const owners = [...new Set([workspace, notebook].filter((w): w is NonNullable<typeof w> => !!w))];
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  const liveNotes = owners.flatMap(w => [...w.workNotes, ...w.pinnedNotes]);
  const oldNotes = [...owners.flatMap(w => w.noteVersions ?? []), ...memories.flatMap(m => m.notes)];
  const messages = [...state.messages.filter(m => m.workspaceId === workspace.id), ...memories.flatMap(m => m.messages)];
  const members = state.graph ? canvasMemberIds(state.graph, task.canvasId) : new Set<string>();
  const found = new Map<string, SourceChange>();
  const visit = (source: SourceRef, visiting: Set<string>, inheritedHistorical = false): void => {
    if(source.unavailableReason){found.set(hash(source),{source,state:'unavailable'});return;}
    const key = hash(source), historical = inheritedHistorical || source.tracking === 'historical'
      || source.tracking !== 'current' && ['message', 'snapshot'].includes(source.kind);
    if (visiting.has(key)) { found.set(key, { source, state: 'unavailable' }); return; }
    const next = new Set(visiting); next.add(key);
    let current: string | number | undefined, exists = false, equivalent = false, children: SourceRef[] = [];
    if (['node', 'document', 'edge'].includes(source.kind)) {
      const value = state.graph && members.has(source.id) ? entity(state.graph, source.id) : null;
      current = value ? hash(value) : undefined;
      // A historical graph citation need not match live bytes, but still cannot regain revoked access.
      exists = !!value;
    } else if (source.kind === 'note') {
      const live = liveNotes.find(n => n.id === source.id);
      const original = [...liveNotes, ...oldNotes].find(n => n.id === source.id && n.version === source.version);
      current = live?.version; exists = historical ? !!original : !!live;
      equivalent = !!live && !!original && sameNoteContent(live,original);
      children = original?.sourceRefs ?? [];
    } else if (source.kind === 'artifact') {
      const allowedIds = new Set([...owners.flatMap(w => w.artifactIds), ...task.inputBindings.artifactIds,
        ...memories.flatMap(m => (m.artifacts ?? []).map(a => a.id))]);
      const live = state.artifacts.find(a => a.id === source.id && allowedIds.has(a.id));
      const original = memories.flatMap(m => m.artifacts ?? []).find(a => a.id === source.id && a.version === source.version && a.status !== 'deleted');
      current = live?.status !== 'deleted' ? live?.version : undefined;
      exists = historical ? !!(live?.version === source.version && live.status !== 'deleted' || original) : current !== undefined;
    } else if (source.kind === 'message') {
      const live = messages.find(m => m.id === source.id);
      const original = messages.find(m => m.id === source.id && m.version === source.version);
      current = live?.version; exists = historical ? !!original : !!live; children = original?.sourceRefs ?? [];
    } else {
      const snapshot = memories.find(m => m.id === source.id);
      current = snapshot?.contentHash; exists = !!snapshot && (!historical || current === source.version); children = snapshot?.sourceRefs ?? [];
    }
    if (!exists) found.set(key, { source, state: 'unavailable' });
    else if (!historical && current !== source.version && !equivalent) found.set(key, { source, state: 'changed', currentVersion: current });
    if (exists && deep) children.forEach(child => visit(child, next, historical));
  };
  sources.forEach(source => visit(source, new Set()));
  return [...found.values()];
}
