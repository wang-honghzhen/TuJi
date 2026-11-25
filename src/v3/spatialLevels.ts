import { getCanvasMembership } from './hierarchyIndex';
import { buildRenderModel } from './layout';
import { RectangleIndex } from './rectangleIndex';
import type { CanvasRecord, GraphEdge, GraphState, Rect } from './types';

/** Folding an ancestor would hide the selected object or flatten an explicitly
 * raised/lowered branch into the summary card's plane. Keep those paths open. */
export function spatialDetailAncestors(parents: ReadonlyMap<string, string>, offsets: CanvasRecord['spatialLayerOffsets'],
  targets: ReadonlySet<string>, edges: readonly GraphEdge[]) {
  const open = new Set<string>();
  const addParents = (id: string) => {
    for (let parent = parents.get(id); parent && !open.has(parent); parent = parents.get(parent)) open.add(parent);
  };
  for (const [id, offset] of Object.entries(offsets ?? {})) if (offset) addParents(id);
  for (const id of targets) addParents(id);
  for (const edge of edges) if (!edge.removed && targets.has(edge.edgeId)) {
    addParents(edge.sourceNodeId); addParents(edge.targetNodeId);
  }
  return open;
}

export function getSpatialLevels(state: GraphState, canvas: CanvasRecord): Map<string, number> {
  const { parents } = getCanvasMembership(state, canvas);
  const levels = new Map([[canvas.canvasId, 0]]);
  // Membership walks mounted parents before their children, including local references.
  for (const [id, parent] of parents) {
    const offset = state.nodes[id] ? 0 : canvas.spatialLayerOffsets?.[id] ?? 0;
    const level = levels.get(parent)! + offset;
    if (!Number.isSafeInteger(level)) throw new Error('空间层级超出可用整数范围');
    levels.set(id, level);
  }
  return levels;
}

/** Remove settings for deleted, detached or excluded regions on their own canvas. */
export function pruneSpatialLayers(state: GraphState): GraphState {
  let changed = false;
  const canvases = state.canvases.map(canvas => {
    const offsets = canvas.spatialLayerOffsets;
    if (!offsets) return canvas;
    const { parents } = getCanvasMembership(state, canvas);
    const entries = Object.entries(offsets);
    const retained = entries.filter(([id, offset]) => parents.has(id) && !state.nodes[id] && Number.isSafeInteger(offset) && offset !== 0);
    if (retained.length && retained.length === entries.length) return canvas;
    changed = true;
    const { spatialLayerOffsets: _old, ...rest } = canvas;
    return retained.length ? { ...rest, spatialLayerOffsets: Object.fromEntries(retained) } : rest;
  });
  return changed ? { ...state, canvases } : state;
}

export function setSubgraphLayer(state: GraphState, canvasId: string, id: string, offset: number): GraphState {
  const canvas = state.canvases.find(c => c.canvasId === canvasId);
  if (!canvas) throw new Error('画布不存在');
  if (!Number.isSafeInteger(offset)) throw new Error('相对层差必须是有效整数');
  const { parents } = getCanvasMembership(state, canvas);
  if (!parents.has(id) || state.nodes[id]) throw new Error('只能调整当前画布内子图或图文档的层级');
  if ((canvas.spatialLayerOffsets?.[id] ?? 0) === offset) return state;
  const spatialLayerOffsets = { ...canvas.spatialLayerOffsets };
  if (offset) spatialLayerOffsets[id] = offset; else delete spatialLayerOffsets[id];
  const next: CanvasRecord = { ...canvas, updatedAt: new Date().toISOString(), spatialLayerOffsets };
  if (!Object.keys(spatialLayerOffsets).length) delete next.spatialLayerOffsets;
  const levels = getSpatialLevels(state, next);
  const { blocks } = buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true });
  const moving = new Set([id]), ancestors = new Set<string>();
  for (let parent = parents.get(id); parent; parent = parents.get(parent)) ancestors.add(parent);
  const stationary = new Map<number, RectangleIndex>();
  const names = new Map<Rect, string>();
  const regions = blocks.filter(b => b.kind !== 'node');
  for (const region of regions) {
    if (moving.has(region.parentId)) moving.add(region.id);
    if (moving.has(region.id) || ancestors.has(region.id)) continue;
    const level = levels.get(region.id)!;
    const index = stationary.get(level) ?? new RectangleIndex();
    index.add(region.rect); stationary.set(level, index); names.set(region.rect, region.name);
  }
  // The subtree moves rigidly, so only its destination against other branches can create an overlap.
  for (const region of regions) if (moving.has(region.id)) {
    const level = levels.get(region.id)!;
    const hit = stationary.get(level)?.query(region.rect)[0];
    if (hit) throw new Error(`第 ${level} 层的「${region.name}」会与「${names.get(hit)}」重叠，请先在二维画布中调整位置`);
  }
  return { ...state, canvases: state.canvases.map(c => c === canvas ? next : c) };
}
