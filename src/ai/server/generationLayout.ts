import type { ChangeSet } from '../domain';
import type { CanvasRecord, GraphState } from '@/v3/types';

/** A generation spans tool calls. Committed creation receipts survive restarts,
 * and the task identity naturally stops granting mobility to later tasks. */
export function generationLayoutIds(
  graph: GraphState, canvasId: string, members: ReadonlySet<string>, taskId: string,
  changes: readonly ChangeSet[], insertedIds: readonly string[],
): string[] {
  const created = new Set(insertedIds);
  for (const change of changes) {
    if (change.taskId !== taskId || change.status !== 'committed') continue;
    for (const patch of change.patches) {
      if ((patch.collection === 'nodes' || patch.collection === 'documents') && patch.before === null && patch.after !== null)
        created.add(patch.id);
      if (patch.collection === 'canvases' && patch.after) {
        const before = (patch.before as CanvasRecord | null)?.directories ?? {};
        for (const id of Object.keys((patch.after as CanvasRecord).directories ?? {}))
          if (!Object.hasOwn(before, id)) created.add(id);
      }
    }
  }
  // User placement always wins, including a drag between two AI tool calls.
  const manual = new Set<string>();
  for (const container of [...Object.values(graph.documents), ...graph.canvases.filter(canvas => canvas.canvasId === canvasId)])
    for (const [id, placement] of Object.entries(container.placements))
      if (placement.source === 'manual' || placement.manualAnchor) manual.add(id);
  return [...created].filter(id => members.has(id) && !manual.has(id)).sort();
}
