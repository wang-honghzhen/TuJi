import { getCanvasPaths } from './paths';
import { avoidExpandedRegion } from './presentationLayout';
import type { GraphState } from './types';

/** A view offset may remain bound while a neighbouring canonical object moves
 * into it. Revalidate those offsets after content/structure layout, without
 * writing display adjustments into shared document placements. */
export function reconcilePresentationLayouts(state: GraphState, previous?: GraphState,
  protectedIds?: ReadonlySet<string>): GraphState {
  if (state === previous) return state;
  let changed = false;
  const canvases = state.canvases.map(original => {
    if (!Object.keys(original.presentationPlacements ?? {}).length) return original;
    const old = previous?.canvases.find(canvas => canvas.canvasId === original.canvasId);
    const paths = getCanvasPaths(state, original), index = new Map(paths.map(row => [row.id, row]));
    if (old && original.placements === old.placements && paths.every(row =>
      state.documents[row.id] === previous?.documents[row.id] && state.nodes[row.id] === previous?.nodes[row.id])) return original;
    const entries = Object.entries(original.presentationPlacements ?? {}).filter(([id, view]) => {
      const row = index.get(id); if (!row?.parentId || row.parentId !== view.parentId) return false;
      const base = (state.documents[row.parentId]?.placements ?? original.placements)[id];
      return base && base.x === view.baseX && base.y === view.baseY;
    });
    let canvas = entries.length === Object.keys(original.presentationPlacements ?? {}).length ? original
      : { ...original, presentationPlacements: Object.fromEntries(entries) };
    entries.sort(([a], [b]) => index.get(b)!.segments.length - index.get(a)!.segments.length || a.localeCompare(b));
    for (const [id] of entries) {
      const row = index.get(id)!;
      if (row.segments.slice(0, -1).some(segment => canvas.collapsed[segment.id])) continue;
      canvas = avoidExpandedRegion(state, canvas, canvas, id, { protectedIds, preserveExisting: false });
    }
    if (canvas !== original) changed = true;
    return canvas;
  });
  return changed ? { ...state, canvases } : state;
}
