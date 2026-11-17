import { canvasDirectory } from './canvas';
import { getNaturalGeometry, nearestRegionSpace, type RegionGeometry } from './regionLayout';
import { nodeGeometry } from './nodeGeometry';
import { getCanvasPaths } from './paths';
import { intersects } from './rectangleIndex';
import type { CanvasRecord, GraphState, Placement, Rect } from './types';
import { COLLAPSED_HEIGHT, COLLAPSED_WIDTH, RECORD_HEADER_HEIGHT, RECORD_PADDING } from './types';

const folded: Rect = { x: 0, y: 0, width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
const children = (state: GraphState, canvas: CanvasRecord, id: string) =>
  (canvasDirectory(canvas, id)?.childIds ?? (state.documents[id] ?
    [...state.documents[id].childNodeIds, ...state.documents[id].childDocumentIds] : []))
    .filter(child => !canvas.excludedDocumentIds?.includes(child));

/** A canonical move or reparent invalidates a previous view adjustment. */
export function presentationPlacement(canvas: CanvasRecord, id: string, parentId: string, base: Placement): Placement {
  const view = canvas.presentationPlacements?.[id];
  return view && view.parentId === parentId && view.baseX === base.x && view.baseY === base.y
    ? { ...base, x: view.x, y: view.y } : base;
}

/** Remove invalidated adjustments at commit boundaries so moving an object back
 * to an old coordinate/parent cannot resurrect an obsolete expansion offset. */
export function prunePresentationPlacements(state: GraphState): GraphState {
  let changed = false;
  const canvases = state.canvases.map(canvas => {
    if (!canvas.presentationPlacements) return canvas;
    const parents = new Map(getCanvasPaths(state, canvas).map(row => [row.id, row.parentId]));
    const valid = Object.entries(canvas.presentationPlacements).filter(([id, view]) => {
      if (!view || !Number.isFinite(view.x) || !Number.isFinite(view.y) || parents.get(id) !== view.parentId) return false;
      const base = (state.documents[view.parentId]?.placements ?? canvas.placements)[id];
      return base?.x === view.baseX && base.y === view.baseY;
    });
    if (valid.length === Object.keys(canvas.presentationPlacements).length) return canvas;
    changed = true; return { ...canvas, presentationPlacements: Object.fromEntries(valid) };
  });
  return changed ? { ...state, canvases } : state;
}

/** Display-only growth contains displaced children without changing canonical
 * document sizes or any other canvas. Folding retains the existing positions. */
export function presentationGeometry(state: GraphState, canvas: CanvasRecord,
  natural = getNaturalGeometry(state), ignoreCollapse = false): RegionGeometry {
  if (!Object.keys(canvas.presentationPlacements ?? {}).length) return natural;
  const sizes = new Map<string, Rect>();
  const size = (id: string): Rect => {
    const saved = sizes.get(id); if (saved) return saved;
    if (state.nodes[id]) return nodeGeometry(state.nodes[id]);
    const full = state.documents[id] ? natural.document(id) : natural.directory(canvas, id);
    let width = full.width, height = full.height;
    const root = id === canvas.canvasId, placements = state.documents[id]?.placements ?? canvas.placements;
    for (const child of children(state, canvas, id)) {
      const base = placements[child]; if (!base) continue;
      const point = presentationPlacement(canvas, child, id, base);
      const childSize = !ignoreCollapse && canvas.collapsed[child] ? folded : size(child);
      width = Math.max(width, point.x + childSize.width + (root ? 0 : RECORD_PADDING * 2));
      height = Math.max(height, point.y + childSize.height + (root ? 0 : RECORD_HEADER_HEIGHT + RECORD_PADDING * 2));
    }
    const result = { ...full, width, height }; sizes.set(id, result); return result;
  };
  return { ...natural, document: size, directory: (_canvas, id) => size(id) };
}

/** Opening a region is a view transaction. Resolve its new collisions, then
 * propagate any resulting frame growth upward. Existing manual neighbours stay
 * fixed; a manually anchored opener yields only when another manual peer blocks
 * it. Every displacement is scoped to this canvas and can be undone with it. */
export function avoidExpandedRegion(state: GraphState, previous: CanvasRecord, expanded: CanvasRecord, id: string,
  options: { protectedIds?: ReadonlySet<string>; preserveExisting?: boolean } = {}): CanvasRecord {
  let canvas = expanded;
  const paths = getCanvasPaths(state, expanded), parents = new Map(paths.map(row => [row.id, row.parentId]));
  const natural = getNaturalGeometry(state);
  const oldGeometry = presentationGeometry(state, previous, natural);
  let current: string | undefined = id;
  while (current && parents.get(current)) {
    const parentId: string = parents.get(current)!;
    const ids = children(state, canvas, parentId);
    const positions = state.documents[parentId]?.placements ?? canvas.placements;
    const geometry = presentationGeometry(state, canvas, natural);
    const rect = (child: string): Rect => {
      const size = state.nodes[child] ? nodeGeometry(state.nodes[child]) : canvas.collapsed[child] ? folded
        : state.documents[child] ? geometry.document(child) : geometry.directory(canvas, child);
      return { ...size, ...presentationPlacement(canvas, child, parentId, positions[child]) };
    };
    const base = positions[current]; if (!base) break;
    const target = rect(current), siblings = ids.filter(child => child !== current && positions[child]);
    const oldRect = (child: string): Rect => {
      const size = state.nodes[child] ? nodeGeometry(state.nodes[child]) : previous.collapsed[child] ? folded
        : state.documents[child] ? oldGeometry.document(child) : oldGeometry.directory(previous, child);
      return { ...size, ...presentationPlacement(previous, child, parentId, positions[child]) };
    };
    const original = oldRect(current);
    // Preserve deliberate overlaps that were already visible while folded.
    const blockers = siblings.filter(child => intersects(target, rect(child)) &&
      (options.preserveExisting === false || !intersects(original, oldRect(child))));
    const isManual = (child: string) => options.protectedIds?.has(child) || positions[child].source === 'manual' || Boolean(positions[child].manualAnchor);
    const place = (child: string, obstacles: Rect[]) => {
      if (options.protectedIds?.has(child)) return;
      const before = rect(child), point = nearestRegionSpace(before, before, obstacles, parentId === canvas.canvasId);
      if (point.x === before.x && point.y === before.y) return;
      const origin = positions[child];
      canvas = { ...canvas, presentationPlacements: { ...canvas.presentationPlacements,
        [child]: { ...point, parentId, baseX: origin.x, baseY: origin.y } } };
    };
    if (blockers.length) {
      if (options.protectedIds?.has(current)) {
        for (const blocker of blockers.filter(child => !isManual(child)))
          place(blocker, ids.filter(child => child !== blocker && positions[child]).map(rect));
      } else if (!isManual(current) || blockers.some(isManual)) place(current, siblings.map(rect));
      else for (const blocker of blockers) place(blocker, ids.filter(child => child !== blocker && positions[child]).map(rect));
    }
    current = parentId;
    if (canvas.collapsed[parentId]) break;
  }
  // Keep the old object when this expand needed no presentation adjustment.
  return canvas.presentationPlacements === previous.presentationPlacements ? expanded : canvas;
}
