import { nodeGeometry } from './nodeGeometry';
import { canvasDirectory, canvasDirectoryIds } from './canvas';
import type { CanvasRecord, GraphState, Placement, Point, Rect } from './types';
import { BLOCK_GAP, COLLAPSED_HEIGHT, COLLAPSED_WIDTH,
  RECORD_HEADER_HEIGHT, RECORD_MIN_WIDTH, RECORD_PADDING } from './types';
import { RectangleIndex } from './rectangleIndex';
import { getHierarchyIndex, retainHierarchyIndex } from './hierarchyIndex';
import { PersistentMap } from './persistentMap';
import { manualProtection } from './placementPolicy';

export const REGION_LAYOUT_VERSION = 3;
const validPoint = (p?: Point): p is Point => Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
const bounds = (rects: Rect[], root = false): Rect => {
  if (root) {
    const x = Math.min(0, ...rects.map(r => r.x)); const y = Math.min(0, ...rects.map(r => r.y));
    return { x, y, width: Math.max(0, ...rects.map(r => r.x + r.width)) - x,
      height: Math.max(0, ...rects.map(r => r.y + r.height)) - y };
  }
  return { x: 0, y: 0, width: Math.max(RECORD_MIN_WIDTH, COLLAPSED_WIDTH,
    ...rects.map(r => r.x + r.width + RECORD_PADDING * 2)),
  height: Math.max(COLLAPSED_HEIGHT, RECORD_HEADER_HEIGHT + RECORD_PADDING * 2,
    ...rects.map(r => r.y + r.height + RECORD_HEADER_HEIGHT + RECORD_PADDING * 2)) };
};

/** Finite edge candidates, then an unbounded-plane fallback. No trial grid limit
 * can leave an overlap. The root accepts negative positions; content does not. */
export function nearestRegionSpace(size: Rect, preferred: Point, input: Rect[] | RectangleIndex, root = false): Point {
  const index = input instanceof RectangleIndex ? input : new RectangleIndex(input);
  const obstacles = index.rects;
  const clamp = (p: Point) => ({ x: root ? p.x : Math.max(0, p.x), y: root ? p.y : Math.max(0, p.y) });
  const start = clamp(validPoint(preferred) ? preferred : { x: 0, y: 0 });
  const free = (p: Point) => !index.collides({ ...size, ...p }, BLOCK_GAP);
  if (free(start)) return start;
  const candidates: Point[] = [];
  for (const r of obstacles) {
    const left = r.x - size.width - BLOCK_GAP; const right = r.x + r.width + BLOCK_GAP;
    const top = r.y - size.height - BLOCK_GAP; const bottom = r.y + r.height + BLOCK_GAP;
    candidates.push({ x: left, y: start.y }, { x: right, y: start.y }, { x: start.x, y: top }, { x: start.x, y: bottom },
      { x: right, y: r.y }, { x: r.x, y: bottom }, { x: left, y: top }, { x: right, y: bottom });
  }
  // These two candidates guarantee a result even in extremely dense layouts.
  candidates.push({ x: Math.max(...obstacles.map(r => r.x + r.width)) + BLOCK_GAP, y: start.y },
    { x: start.x, y: Math.max(...obstacles.map(r => r.y + r.height)) + BLOCK_GAP });
  const distance = (p: Point) => (p.x - start.x) ** 2 + (p.y - start.y) ** 2;
  const unique = new Map<string, Point>();
  candidates.forEach(p => { const q = clamp(p); unique.set(`${q.x}/${q.y}`, q); });
  return [...unique.values()].sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x).find(free)!;
}

export interface RegionGeometry {
  documents: Map<string, Rect>;
  directories: Map<string, Map<string, Rect>>;
  document(id: string): Rect;
  directory(canvas: CanvasRecord, id: string): Rect;
  /** Actual cache misses, useful for verifying that unrelated regions stay cold. */
  measurements: number;
}
interface DirtyRegions { documents: Set<string>; directories: Map<string, Set<string>> }
type Solver = (ids: string[], placements: Record<string, Placement>, sizes: Map<string, Rect>,
  root: boolean, parentId: string, canvas?: CanvasRecord) => Record<string, Placement>;
const retained = new WeakMap<GraphState, RegionGeometry>();
const previews = new WeakMap<GraphState, GraphState>();
export const invalidateRegionGeometry = (state: GraphState): void => { retained.delete(state); previews.delete(state); };
export const isRegionPreview = (state: GraphState, previous: GraphState): boolean => previews.get(state) === previous;
export function retainRegionGeometry(state: GraphState): void { retained.set(state, getNaturalGeometry(state)); }
export function inheritRegionGeometry(previous: GraphState, next: GraphState): GraphState {
  retained.set(next, getNaturalGeometry(previous)); retainHierarchyIndex(next, getHierarchyIndex(previous)); return next;
}

/** Bottom-up canonical geometry. Canvas filters/folding never shrink a document. */
function makeGeometry(state: GraphState, solve?: Solver, seed?: RegionGeometry, dirty?: DirtyRegions, previous?: GraphState): RegionGeometry {
  const documents = new PersistentMap(seed?.documents); const directories = new PersistentMap(seed?.directories);
  dirty?.directories.forEach((_, key) => directories.set(key, new PersistentMap(seed?.directories.get(key))));
  dirty?.documents.forEach(id => documents.delete(id));
  dirty?.directories.forEach((ids, canvasId) => ids.forEach(id => directories.get(canvasId)?.delete(id)));
  const visiting = new Set<string>();
  const reusable = (ids: string[], positions: Record<string, Placement>, oldIds: string[] | undefined,
    oldPositions: Record<string, Placement> | undefined, sizes: Map<string, Rect>, oldSize: (id: string) => Rect | undefined) => {
    if (!oldIds || !oldPositions || oldIds.length !== ids.length) return false;
    const members = new Set(oldIds);
    return ids.every(id => {
      const p = positions[id], old = oldPositions[id], size = sizes.get(id)!, before = oldSize(id);
      return members.has(id) && validPoint(p) && old?.x === p.x && old.y === p.y && old.source === p.source &&
        before?.width === size.width && before.height === size.height;
    });
  };
  const rects = (ids: string[], placements: Record<string, Placement>, sizes: Map<string, Rect>) => ids.map(id => {
    const pos = placements[id]; return { ...sizes.get(id)!, ...(validPoint(pos) ? pos : { x: 0, y: 0 }) };
  });
  const doc = (id: string): Rect => {
    if (documents.has(id)) return documents.get(id)!;
    if (visiting.has(id)) throw new Error('目录成环，无法计算区域');
    visiting.add(id); const record = state.documents[id];
    const ids = [...record.childNodeIds, ...record.childDocumentIds].filter(child => state.nodes[child] || state.documents[child]).sort();
    const sizes = new Map(ids.map(child => [child, state.nodes[child] ? nodeGeometry(state.nodes[child]) : doc(child)]));
    const old = previous?.documents[id];
    if (seed?.documents.has(id) && reusable(ids, record.placements, old && [...old.childNodeIds, ...old.childDocumentIds], old?.placements,
      sizes, child => previous?.nodes[child] ? nodeGeometry(previous.nodes[child]) : previous?.documents[child] ? seed.document(child) : undefined)) {
      const size = seed.document(id); documents.set(id, size); visiting.delete(id); return size;
    }
    const placements = (!dirty || dirty.documents.has(id) ? solve?.(ids, record.placements, sizes, false, id) : undefined) ?? record.placements;
    const size = bounds(rects(ids, placements, sizes)); documents.set(id, size); visiting.delete(id); result.measurements++; return size;
  };
  const dir = (canvas: CanvasRecord, id: string): Rect => {
      const measured = directories.get(canvas.canvasId) ?? new Map<string, Rect>(); directories.set(canvas.canvasId, measured);
      if (measured.has(id)) return measured.get(id)!;
      const key = `${canvas.canvasId}/${id}`;
      if (visiting.has(key)) throw new Error('画布目录成环，无法计算区域');
      visiting.add(key);
      const ids = canvasDirectory(canvas, id).childIds.filter(child => !canvas.excludedDocumentIds?.includes(child) &&
        (state.nodes[child] || state.documents[child] || canvasDirectory(canvas, child))).sort();
      const sizes = new Map(ids.map(child => [child, state.nodes[child] ? nodeGeometry(state.nodes[child]) : state.documents[child] ? doc(child) : dir(canvas, child)]));
      const old = previous?.canvases.find(c => c.canvasId === canvas.canvasId);
      const oldIds = canvasDirectory(old, id)?.childIds.filter(child => !old?.excludedDocumentIds?.includes(child));
      if (seed?.directories.get(canvas.canvasId)?.has(id) && reusable(ids, canvas.placements, oldIds, old?.placements, sizes,
        child => previous?.nodes[child] ? nodeGeometry(previous.nodes[child]) : previous?.documents[child] ? seed.document(child) : old && canvasDirectory(old, child) ? seed.directory(old, child) : undefined)) {
        const size = seed.directory(old!, id); measured.set(id, size); visiting.delete(key); return size;
      }
      const root = id === canvas.canvasId;
      const placements = (!dirty || dirty.directories.get(canvas.canvasId)?.has(id) ? solve?.(ids, canvas.placements, sizes, root, id, canvas) : undefined) ?? canvas.placements;
      const size = bounds(rects(ids, placements, sizes), root); measured.set(id, size); visiting.delete(key); result.measurements++; return size;
  };
  const result: RegionGeometry = { documents, directories, document: doc, directory: dir, measurements: 0 };
  return result;
}

export const getNaturalGeometry = (state: GraphState): RegionGeometry => {
  let geometry = retained.get(state);
  if (!geometry) { geometry = makeGeometry(state); retained.set(state, geometry); }
  return geometry;
};

/** Run once at a committed snapshot boundary, never in a pointer-move frame. */
function changedRegions(state: GraphState, previous: GraphState): DirtyRegions {
  const dirty: DirtyRegions = { documents: new Set(), directories: new Map() };
  const a = getHierarchyIndex(previous), b = getHierarchyIndex(state);
  const local = (canvasId: string, id: string, index = b) => {
    const ids = dirty.directories.get(canvasId) ?? new Set<string>(); dirty.directories.set(canvasId, ids);
    const canvas = state.canvases.find(c => c.canvasId === canvasId), visited = new Set<string>();
    let current: string | undefined = id;
    // The old ancestry can contain a just-deleted directory. Dirty its surviving
    // ancestors without asking the layout solver to measure that missing record.
    while (current && !visited.has(current)) { visited.add(current); if (canvasDirectory(canvas, current)) ids.add(current); current = index.canvasParents.get(canvasId)?.get(current); }
  };
  const doc = (id: string, index = b) => {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current); if (state.documents[current]) dirty.documents.add(current);
      index.mounts.get(current)?.forEach(mount => local(mount.canvasId, mount.parentId, index));
      current = index.documentParents.get(current);
    }
  };
  const key = (ids: string[], placements: Record<string, Placement>) => JSON.stringify([ids.slice().sort(),
    ids.map(id => [id, placements[id]?.x, placements[id]?.y, placements[id]?.source])]);
  for (const id of new Set([...Object.keys(state.documents), ...Object.keys(previous.documents)])) {
    const next = state.documents[id], old = previous.documents[id];
    if (next === old) continue;
    if (!next || !old || key([...next.childNodeIds, ...next.childDocumentIds], next.placements) !==
      key([...old.childNodeIds, ...old.childDocumentIds], old.placements)) { doc(id); doc(id, a); }
  }
  for (const canvas of state.canvases) {
    const old = previous.canvases.find(c => c.canvasId === canvas.canvasId);
    for (const id of new Set([...canvasDirectoryIds(canvas), ...(old ? canvasDirectoryIds(old) : [])])) {
      const nextDir = canvasDirectory(canvas, id), oldDir = canvasDirectory(old, id);
      if (!nextDir) continue;
      if (!oldDir || key(nextDir.childIds, canvas.placements) !== key(oldDir.childIds, old!.placements) ||
        JSON.stringify(canvas.excludedDocumentIds) !== JSON.stringify(old!.excludedDocumentIds)) { local(canvas.canvasId, id); local(canvas.canvasId, id, a); }
    }
  }
  for (const id of new Set([...Object.keys(state.nodes), ...Object.keys(previous.nodes)])) {
    const next = state.nodes[id], old = previous.nodes[id];
    if (next === old) continue;
    if (next && old) {
      const size = nodeGeometry(next), before = nodeGeometry(old);
      if (size.width === before.width && size.height === before.height) continue;
    }
    for (const index of [a, b]) {
      const parent = index.nodeParents.get(id); if (parent) doc(parent, index);
      index.canvasParents.forEach((parents, canvasId) => { const localParent = parents.get(id); if (localParent) local(canvasId, localParent, index); });
    }
  }
  retainHierarchyIndex(state, b); return dirty;
}

export function reconcileRegionGeometry(previous: GraphState | null | undefined, next: GraphState): void {
  if (!previous || previous === next) { getNaturalGeometry(next); return; }
  const dirty = changedRegions(next, previous);
  retained.set(next, makeGeometry(next, undefined, getNaturalGeometry(previous), dirty, previous));
}
export function measureNaturalRegions(state: GraphState, canvas?: CanvasRecord): RegionGeometry {
  const geometry = getNaturalGeometry(state);
  if (canvas) geometry.directory(canvas, canvas.canvasId);
  else { Object.keys(state.documents).forEach(geometry.document);
    state.canvases.forEach(c => canvasDirectoryIds(c).forEach(id => geometry.directory(c, id))); }
  return geometry;
}

/** Pure normalization; every structural write and drag preview uses this path.
 * User positions may overlap nodes or containers. New automatic placements avoid
 * occupied space, while unchanged siblings keep their coordinates during a drag.
 * Old 'manual' flags were also produced by automatic operations: migrate them
 * to preferences once, preserving coordinates wherever they are still legal. */
export function normalizeRegionLayout(state: GraphState, previous?: GraphState): GraphState {
  return normalizeRegions(state, previous, previous && state.layoutVersion === REGION_LAYOUT_VERSION ? changedRegions(state, previous) : undefined);
}
function normalizeRegions(state: GraphState, previous?: GraphState, dirty?: DirtyRegions): GraphState {
  const solveTime = Date.now();
  const migrate = state.layoutVersion !== REGION_LAYOUT_VERSION;
  const oldGeometry = previous ? getNaturalGeometry(previous) : undefined;
  const docs = { ...state.documents }; const canvases = [...state.canvases];
  let changed = migrate;
  const geometry = makeGeometry(state, (ids, placements, sizes, root, parentId, canvas) => {
    const oldCanvas = previous?.canvases.find(c => c.canvasId === canvas?.canvasId);
    const oldPlacements = canvas ? oldCanvas?.placements : previous?.documents[parentId]?.placements;
    const oldMembers = new Set(canvas ? canvasDirectory(oldCanvas, parentId)?.childIds : previous?.documents[parentId] &&
      [...previous.documents[parentId].childNodeIds, ...previous.documents[parentId].childDocumentIds]);
    const preferred = (id: string): Placement => {
      const p = placements[id];
      return validPoint(p) ? { ...p, source: (state.layoutVersion ?? 0) >= 1 && p.source === 'manual' ? 'manual' : 'auto' } : { x: 0, y: 0, source: 'auto' };
    };
    const pinned = (id: string) => preferred(id).source === 'manual';
    const grew = (id: string) => {
      if (!previous?.nodes[id] || !state.nodes[id]) return false;
      const before = nodeGeometry(previous.nodes[id]), size = sizes.get(id)!;
      return size.width > before.width || size.height > before.height;
    };
    const stable = (id: string) => {
      if (!previous) return validPoint(placements[id]);
      if (!oldMembers.has(id)) return false;
      const old = oldPlacements?.[id]; const p = preferred(id);
      const oldSize = previous.nodes[id] ? nodeGeometry(previous.nodes[id]) : previous.documents[id] ? oldGeometry?.document(id) : oldCanvas && canvasDirectory(oldCanvas, id) ? oldGeometry?.directory(oldCanvas, id) : undefined;
      return old?.x === p.x && old.y === p.y && old.source === p.source && oldSize?.width === sizes.get(id)!.width && oldSize.height === sizes.get(id)!.height;
    };
    const stability = new Map(ids.map(id => [id, Number(stable(id))]));
    const order = [...ids].sort((a, b) => Number(grew(a)) - Number(grew(b)) || manualProtection(preferred(b), solveTime) - manualProtection(preferred(a), solveTime) ||
      Number(pinned(b)) - Number(pinned(a)) || stability.get(b)! - stability.get(a)! ||
      Number(Boolean(state.nodes[b])) - Number(Boolean(state.nodes[a])) || a.localeCompare(b));
    const occupied = new RectangleIndex(); const automatic = new RectangleIndex();
    let result = placements;
    for (const id of order) {
      const p = preferred(id); const manual = pinned(id) && !grew(id); const size = sizes.get(id)!;
      const point = manual ? { x: root ? p.x : Math.max(0, p.x), y: root ? p.y : Math.max(0, p.y) }
        : nearestRegionSpace(size, p, stability.get(id) ? automatic : occupied, root);
      const next = { ...p, ...point }; const old = placements[id];
      if (!old || old.x !== next.x || old.y !== next.y || old.source !== next.source) {
        if (result === placements) result = { ...placements };
        result[id] = next;
      }
      const rect = { ...size, ...point }; occupied.add(rect); if (!manual) automatic.add(rect);
    }
    if (result !== placements) {
      changed = true;
      if (canvas) {
        const index = canvases.findIndex(c => c.canvasId === canvas.canvasId);
        // Multiple folders share the canvas placement table.
        const updates = Object.fromEntries(ids.map(id => [id, result[id]]));
        canvases[index] = { ...canvases[index], placements: { ...canvases[index].placements, ...updates }, updatedAt: new Date().toISOString() };
      } else {
        const record = docs[parentId];
        docs[parentId] = { ...record, placements: result, rev: record.rev + 1,
          metadata: { ...record.metadata, updatedAt: new Date().toISOString() } };
      }
    }
    return result;
  }, dirty ? oldGeometry : undefined, dirty, previous);
  if (dirty) {
    dirty.documents.forEach(geometry.document);
    dirty.directories.forEach((ids, canvasId) => { const canvas = state.canvases.find(c => c.canvasId === canvasId)!; ids.forEach(id => geometry.directory(canvas, id)); });
  } else {
    Object.keys(state.documents).sort().forEach(geometry.document);
    state.canvases.forEach(canvas => canvasDirectoryIds(canvas).sort().forEach(id => geometry.directory(canvas, id)));
  }
  const next = changed ? { ...state, documents: docs, canvases, layoutVersion: REGION_LAYOUT_VERSION } : state;
  // Rebind lazy callbacks to the normalized state, keeping all computed sizes.
  const published = makeGeometry(next, undefined, geometry); published.measurements = geometry.measurements;
  retained.set(next, published);
  return next;
}

/** A position drag preserves ownership and follows the pointer, including over
 * sibling nodes and regions. Only the affected ancestor geometry is recomputed. */
export function previewBlockMove(state: GraphState, canvasId: string, id: string, parentId: string, point: Point): GraphState {
  if (!validPoint(point)) return state;
  const canvas = state.canvases.find(c => c.canvasId === canvasId); if (!canvas) return state;
  const parent = state.documents[parentId];
  const ids = parent ? [...parent.childNodeIds, ...parent.childDocumentIds] : canvasDirectory(canvas, parentId)?.childIds;
  if (!ids?.includes(id)) return state;
  const geometry = getNaturalGeometry(state);
  const placements = parent?.placements ?? canvas.placements;
  if (!state.nodes[id] && !state.documents[id] && !canvasDirectory(canvas, id)) return state;
  const root = parentId === canvas.canvasId;
  const pos: Placement = { ...placements[id], x: root ? point.x : Math.max(0, point.x), y: root ? point.y : Math.max(0, point.y), source: 'manual' };
  const next: GraphState = parent ? { ...state, documents: { ...state.documents,
    [parentId]: { ...parent, placements: { ...parent.placements, [id]: pos }, rev: parent.rev + 1,
      metadata: { ...parent.metadata, updatedAt: new Date().toISOString() } } } } :
    { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: { ...c.placements, [id]: pos }, updatedAt: new Date().toISOString() } : c) };
  if (state.layoutVersion !== REGION_LAYOUT_VERSION) return normalizeRegionLayout(next, state);
  const index = getHierarchyIndex(state);
  const dirty: DirtyRegions = { documents: new Set(), directories: new Map() };
  const local = (viewId: string, start: string) => {
    const ids = dirty.directories.get(viewId) ?? new Set<string>(); dirty.directories.set(viewId, ids);
    let current: string | undefined = start;
    while (current && !ids.has(current)) { ids.add(current); current = index.canvasParents.get(viewId)?.get(current); }
  };
  if (parent) {
    let current: string | undefined = parentId;
    while (current) {
      dirty.documents.add(current);
      index.mounts.get(current)?.forEach(mount => local(mount.canvasId, mount.parentId));
      current = index.documentParents.get(current);
    }
  } else local(canvasId, parentId);
  // Ensure the old lazy sizes are retained before seeding the affected branch.
  retained.set(state, geometry);
  const result = normalizeRegions(next, state, dirty);
  validateRegions(result, dirty);
  retainHierarchyIndex(result, index); previews.set(result, state);
  return result;
}

/** Assert geometry before publishing a transaction, independently of the packer. */
export function validateRegionLayout(state: GraphState): void {
  validateRegions(state);
}
function validateRegions(state: GraphState, dirty?: DirtyRegions): void {
  const geometry = getNaturalGeometry(state);
  const check = (ids: string[], placements: Record<string, Placement>, root: boolean, parentId: string, canvas?: CanvasRecord) => {
    const automatic = new RectangleIndex();
    for (const id of ids) {
      const p = placements[id];
      if (!validPoint(p) || (!root && (p.x < 0 || p.y < 0))) throw new Error(`区域坐标无效：${parentId}/${id}`);
      const size = state.nodes[id] ? nodeGeometry(state.nodes[id]) : state.documents[id] ? geometry.document(id) : geometry.directory(canvas!, id);
      const rect = { ...size, ...p };
      if (p.source !== 'manual') {
        if (automatic.collides(rect)) throw new Error(`区域重叠：${parentId}/${id}`);
        automatic.add(rect);
      }
    }
  };
  for (const id of dirty?.documents ?? Object.keys(state.documents)) {
    const record = state.documents[id]; check([...record.childNodeIds, ...record.childDocumentIds], record.placements, false, id);
  }
  for (const canvas of state.canvases) for (const id of dirty ? dirty.directories.get(canvas.canvasId) ?? [] : canvasDirectoryIds(canvas)) {
    check(canvasDirectory(canvas, id).childIds.filter(child => !canvas.excludedDocumentIds?.includes(child)), canvas.placements, id === canvas.canvasId, id, canvas);
  }
}
