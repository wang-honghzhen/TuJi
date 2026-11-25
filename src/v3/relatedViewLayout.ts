import { canvasDirectory } from './canvas';
import { getCanvasMembership } from './hierarchyIndex';
import { nodeGeometry } from './nodeGeometry';
import { getNaturalGeometry } from './regionLayout';
import { getRelationProjection, type ProjectedRelation } from './relationProjection';
import { presentationGeometry, presentationPlacement } from './presentationLayout';
import { relationEndpointGeometry } from './relationEndpointGeometry';
import { measureArrangement } from './arrangementMetrics';
import { refineEndpointPlacements } from './endpointRefinement';
import { manualMovementCost, manualProtection, recentManualPlacement } from './placementPolicy';
import type { RelationshipLayoutOptions, RelationshipLayoutResult } from './relationshipLayout';
import type { CanvasRecord, GraphState, Placement } from './types';
import { BLOCK_GAP, COLLAPSED_WIDTH, COLLAPSED_HEIGHT, NODE_WIDTH, RECORD_PADDING, RECORD_HEADER_HEIGHT } from './types';

/** Adjust a single canvas after a manual drop or expand. Shared content and all
 * other canvases retain their original geometry. The dragged object is fixed. */
export function layoutRelatedView(input: GraphState, options: RelationshipLayoutOptions): RelationshipLayoutResult {
  const started = performance.now(), deadline = started + (options.budgetMs ?? 100);
  const stats = { regions: 0, candidates: 0, moved: 0, elapsedMs: 0, exhausted: false };
  let canvas = input.canvases.find(item => item.canvasId === options.canvasId); if (!canvas) return { state: input, stats };
  const { members, parents } = getCanvasMembership(input, canvas);
  const protectedIds = new Set(options.protectedIds), queue = [...protectedIds];
  for (let index = 0; index < queue.length; index++) {
    const parent = parents.get(queue[index]); if (parent && !protectedIds.has(parent)) { protectedIds.add(parent); queue.push(parent); }
  }
  const permitted = options.permittedIds && new Set(options.permittedIds), changed = new Set(options.changedObjectIds), changedEdges = new Set(options.changedEdgeIds);
  const affected = (relation: ProjectedRelation) => relation.edgeIds.some(id => changedEdges.has(id))
    || changed.has(relation.source) || changed.has(relation.target);
  const visible = (id: string) => {
    if (!members.has(id)) return false;
    let parent = parents.get(id);
    while (parent) { if (canvas!.collapsed[parent]) return false; parent = parents.get(parent); }
    return true;
  };
  let state = input;
  const regions = [...getRelationProjection(input, options.canvasId).values()].filter(region => (!region.canvasId || region.canvasId === options.canvasId)
    && (!options.regionId || options.regionId === region.id) && region.relations.some(affected))
    .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
  for (const region of regions) {
    if (performance.now() >= deadline) { stats.exhausted = true; break; }
    if (canvas.collapsed[region.id] || !visible(region.id)) continue;
    const doc = region.canvasId ? undefined : state.documents[region.id];
    const ids = (doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : canvasDirectory(canvas, region.id)?.childIds ?? [])
      .filter(id => !canvas!.excludedDocumentIds?.includes(id));
    const base = doc?.placements ?? canvas.placements;
    const positions = Object.fromEntries(ids.filter(id => base[id]).map(id => [id, presentationPlacement(canvas!, id, region.id, base[id])]));
    const geometry = presentationGeometry(state, canvas, getNaturalGeometry(state));
    const sizes = new Map(ids.map(id => [id, state.nodes[id] ? nodeGeometry(state.nodes[id]) : canvas!.collapsed[id]
      ? { x: 0, y: 0, width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT }
      : state.documents[id] ? geometry.document(id) : geometry.directory(canvas!, id)]));
    const relations = region.relations.filter(relation => positions[relation.source] && positions[relation.target]);
    const touched = new Set(relations.filter(affected).flatMap(relation => [relation.source, relation.target]));
    const movable = ids.filter(id => touched.has(id) && (!permitted || permitted.has(id)) && !protectedIds.has(id)
      && !recentManualPlacement(base[id], options.solveTime)).sort();
    if (!movable.length) continue;
    stats.regions++;
    const endpoints = relationEndpointGeometry(state, canvas, ids, sizes, relations);
    // A drop/expand may nudge a neighbour by one card and its gap. Base this
    // window on saved geometry so repeated drops cannot accumulate view drift.
    const gesture = changed.size > 0;
    const rest = gesture ? base : positions;
    const preferences = new Map(movable.map(id => [id, manualProtection(base[id], options.solveTime)]));
    const cache = new WeakMap<object, number>();
    const score = (next: Record<string, Placement>) => {
      const saved = cache.get(next); if (saved !== undefined) return saved;
      let value = measureArrangement(ids, sizes, next, relations, endpoints).score;
      for (const id of movable) {
        value += Math.hypot(next[id].x - rest[id].x, next[id].y - rest[id].y) / 180 * .3
          + manualMovementCost(base[id], positions[id], next[id], preferences.get(id)!);
      }
      cache.set(next, value); return value;
    };
    const root = region.id === canvas.canvasId;
    const frame = doc ? geometry.document(region.id) : geometry.directory(canvas, region.id);
    const result = refineEndpointPlacements({ ids, sizes, relations, endpoints, positions, movable, root, deadline, score,
      ...(gesture ? { restPositions: rest, maxMove: NODE_WIDTH + BLOCK_GAP, maxStep: options.dragDistance } : {}),
      bounds: root ? undefined : { width: frame.width - RECORD_PADDING * 2, height: frame.height - RECORD_HEADER_HEIGHT - RECORD_PADDING * 2 } });
    stats.candidates += result.trials;
    const moved = movable.filter(id => result.positions[id].x !== positions[id].x || result.positions[id].y !== positions[id].y);
    if (!moved.length) continue;
    const overrides: NonNullable<CanvasRecord['presentationPlacements']> = { ...canvas.presentationPlacements };
    for (const id of moved) overrides[id] = { x: result.positions[id].x, y: result.positions[id].y,
      baseX: base[id].x, baseY: base[id].y, parentId: region.id };
    canvas = { ...canvas, presentationPlacements: overrides, updatedAt: new Date(options.solveTime).toISOString() };
    state = { ...state, canvases: state.canvases.map(item => item.canvasId === options.canvasId ? canvas! : item) };
    stats.moved += moved.length;
  }
  stats.elapsedMs = performance.now() - started;
  stats.exhausted ||= performance.now() > deadline;
  return { state, stats };
}
