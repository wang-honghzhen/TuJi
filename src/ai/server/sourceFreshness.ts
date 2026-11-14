import type { AppSnapshot, SourceRef, Task } from '../domain';
import { notebookWorkspace, sameNoteContent } from '../notebook';
import { canvasMemberIds } from '../canvasScope';
import { entity } from './graph';
import { hash } from './repository';
import { resolveNoteReference } from '../noteReferences';

export interface SourceChange { source: SourceRef; state: 'changed' | 'unavailable'; currentVersion?: string | number }

const isHistorical = (source: SourceRef, inherited = false) => inherited || source.tracking === 'historical'
  || source.tracking !== 'current' && ['message', 'snapshot'].includes(source.kind);
interface SourceState { current?: string | number; exists: boolean; equivalent: boolean; children: SourceRef[] }

/** Resolve the version actually cited, within this reader's permitted scope. */
function sourceResolver(state: AppSnapshot, task: Task) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const notebook = notebookWorkspace(state, state.sessions.find(s => s.id === task.sessionId));
  const owners = [...new Set([workspace, notebook].filter((w): w is NonNullable<typeof w> => !!w))];
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  const messages = [...state.messages.filter(m => m.workspaceId === workspace.id), ...memories.flatMap(m => m.messages)];
  const members = state.graph ? canvasMemberIds(state.graph, task.canvasId) : new Set<string>();
  const allowedArtifactIds = new Set([...owners.flatMap(w => w.artifactIds), ...task.inputBindings.artifactIds,
    ...memories.flatMap(m => (m.artifacts ?? []).map(a => a.id))]);
  return (source: SourceRef, historical: boolean): SourceState => {
    if (source.unavailableReason) return { exists: false, equivalent: false, children: [] };
    let current: string | number | undefined, exists = false, equivalent = false, children: SourceRef[] = [];
    if (['node', 'document', 'edge'].includes(source.kind)) {
      const value = state.graph && members.has(source.id) ? entity(state.graph, source.id) : null;
      current = value ? hash(value) : undefined;
      // A historical graph citation need not match live bytes, but still cannot regain revoked access.
      exists = !!value;
    } else if (source.kind === 'note') {
      const resolved = resolveNoteReference(state, task.sessionId, source);
      if (resolved.status !== 'ok') return { exists: false, equivalent: false, children: [] };
      const original = resolved.note;
      // Host-created delivery archives are immutable notebook-owned material,
      // not deleted live notes. Current citations still recurse into their
      // dependencies; ordinary deleted notes remain unavailable.
      const live = resolved.current ?? (original?.id.startsWith('note:delivery-source:') ? original : undefined);
      current = live?.version; exists = historical ? !!original : !!live;
      equivalent = !!live && !!original && sameNoteContent(live,original);
      children = original?.sourceRefs ?? [];
    } else if (source.kind === 'artifact') {
      const live = state.artifacts.find(a => a.id === source.id && allowedArtifactIds.has(a.id));
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
    return { current, exists, equivalent, children };
  };
}

/** Check only permitted sources. Memoization is scoped to this invocation and
 * includes effective tracking: a historical visit cannot suppress a current one. */
export function sourceChanges(state: AppSnapshot, task: Task, sources: SourceRef[], deep = true): SourceChange[] {
  const resolve = sourceResolver(state, task), found = new Map<string, SourceChange>();
  const active = new Set<string>(), checked = new Set<string>();
  const visit = (source: SourceRef, inheritedHistorical = false): void => {
    const historical = isHistorical(source, inheritedHistorical), key = hash([source, historical]);
    if (active.has(key)) { found.set(key, { source, state: 'unavailable' }); return; }
    if (checked.has(key)) return;
    active.add(key);
    const { current, exists, equivalent, children } = resolve(source, historical);
    if (!exists) found.set(key, { source, state: 'unavailable' });
    else if (!historical && current !== source.version && !equivalent) found.set(key, { source, state: 'changed', currentVersion: current });
    if (exists && deep) children.forEach(child => visit(child, historical));
    active.delete(key); checked.add(key);
  };
  sources.forEach(source => visit(source));
  return [...found.values()];
}

/** Freeze roots AND their original transitive dependencies when submitting a
 * request. Checking this list with deep=false prevents a later rewrite of a
 * root note from discarding the sources the request actually depended on.
 * Each row has its effective tracking explicitly recorded, so flattening a
 * historical parent does not accidentally promote its children to current.
 * Missing/ambiguous sources and cycles remain blockers for this request. */
export function captureSourceClosure(state: AppSnapshot, task: Task, sources: SourceRef[]): SourceRef[] {
  const resolve = sourceResolver(state, task), captured = new Map<string, SourceRef>();
  const active = new Set<string>();
  const visit = (source: SourceRef, inheritedHistorical = false): void => {
    const historical = isHistorical(source, inheritedHistorical);
    const frozen: SourceRef = { ...structuredClone(source), tracking: historical ? 'historical' : 'current' };
    const key = hash(frozen);
    if (active.has(key)) {
      captured.set(key, { ...frozen, unavailableReason: 'source_cycle' }); return;
    }
    if (captured.has(key)) return;
    const { exists, children } = resolve(frozen, historical);
    captured.set(key, exists ? frozen : { ...frozen, unavailableReason: frozen.unavailableReason ?? 'source_unavailable' });
    if (!exists) return;
    active.add(key);
    children.forEach(child => visit(child, historical));
    active.delete(key);
  };
  sources.forEach(source => visit(source));
  return [...captured.values()];
}
