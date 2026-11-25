import type { Observation } from '../contextState';
import type { AppSnapshot, SourceRef, Task } from '../domain';
import { resolveNoteReference } from '../noteReferences';
import { currentGraphReadSources } from './currentReadSources';
import { graphIndex } from './directGraph';
import { captureSourceClosure } from './sourceFreshness';

/** Freeze every original transitive dependency. A complete replacement note can add
 * dependencies of its own but cannot erase independent roots from the original. */
export function submittedSourceResolution(state: AppSnapshot, task: Task, observations: Observation[],
  visibleNotes: () => ReadonlyMap<string, {complete: ReadonlySet<number>}>) {
  let graph: ReturnType<typeof currentGraphReadSources> | undefined;
  function graphReads() {
    if (state.graph) graph ??= currentGraphReadSources(graphIndex(state, task.canvasId), observations);
    return graph;
  }
  function freeze(roots: SourceRef[]): SourceRef[] {
    if (!roots.length) return [];
    const queue = captureSourceClosure(state, task, roots);
    const visited = new Set<string>(), resolved = new Map<string, SourceRef>();
    for (const original of queue) {
      const key = JSON.stringify(original);
      if (visited.has(key)) continue;
      visited.add(key);
      let source = original;
      if (!original.unavailableReason && original.tracking === 'current') {
        if (original.kind === 'node' || original.kind === 'edge') source = graphReads()?.body(original) ?? original;
        if (original.kind === 'note') {
          const note = resolveNoteReference(state, task.sessionId, original);
          if (note.status === 'ok' && note.current && note.current.version !== original.version &&
              visibleNotes().get(original.id)?.complete.has(note.current.version)) {
            source = { ...original, version: note.current.version };
            // Freeze the current roots too, including any cyclic or inaccessible dependencies.
            queue.push(...captureSourceClosure(state, task, [source]));
          }
        }
      }
      resolved.set(JSON.stringify(source), source);
    }
    return [...resolved.values()];
  }
  return { graphReads, freeze };
}
