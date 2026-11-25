import { nodeGeometry } from './nodeGeometry';
import { canvasDirectory } from './canvas';
import { getNaturalGeometry, nearestRegionSpace, normalizeRegionLayout } from './regionLayout';
import { RectangleIndex, intersects } from './rectangleIndex';
import { getRelationProjection, regionKey } from './relationProjection';
import type { LayoutRegion, ProjectedRelation } from './relationProjection';
import { chooseInsertionPoint, inferGrowthDirection } from './insertionPlacement';
import type { DirectionSample, GrowthDirection, InsertionNeighbour } from './insertionPlacement';
import { packMembers } from './packingLayout';
import type { LayeredFlow } from './layeredSeed';
import { structuralCandidates } from './structuralLayout';
import { slotCandidates } from './slotLayout';
import { measureArrangement } from './arrangementMetrics';
import type { GraphState, Placement, Point, Rect } from './types';
import { BLOCK_GAP, NODE_WIDTH, NODE_HEIGHT } from './types';
import { choosePorts, portPoint, pointOnRoute } from './edgeGeometry';
import { routeAroundObstacles } from './obstacleRouter';
import { getCanvasMembership, getHierarchyIndex } from './hierarchyIndex';
import { layoutRelatedView } from './relatedViewLayout';
import { automaticPlacement, hasManualIntent, manualMovementCost, manualProtection, recentManualPlacement } from './placementPolicy';
export { manualProtection } from './placementPolicy';

export interface RelationshipLayoutOptions {
  canvasId: string;
  regionId?: string;
  mode: 'auto' | 'organize';
  movableIds?: string[];
  protectedIds?: string[];
  permittedIds?: string[];
  changedEdgeIds?: string[];
  /** Objects moved or expanded by the user in the current view. */
  changedObjectIds?: string[];
  /** Visible distance from pointer-down to the committed drop, in canvas units. */
  dragDistance?: number;
  /** Keep shared canonical placements intact; adjust only this canvas's view. */
  viewOnly?: boolean;
  /** Children that arrived without a position (the AI writes a path, never a point). */
  insertedIds?: string[];
  /** Unsettled members of the current generation, across tool submissions. */
  provisionalIds?: string[];
  solveTime: number;
  /** Soft refinement budget. The inexpensive coverage pass always finishes. */
  budgetMs?: number;
  maxIterations?: number;
}
export interface LayoutStats {
  regions: number; candidates: number; moved: number; elapsedMs: number; exhausted: boolean;
  /** Children placed by the structural seed instead of one-by-one insertion. */
  seeded?: number;
  /** Unrelated children tidied into reading order; organise mode only. */
  packed?: number;
  /** Objects with a previous manual placement included in the organise preview. */
  manualMoved?: number;
  /** Relation crossings and occupied area, measured before and after organising. */
  crossingsBefore?: number; crossingsAfter?: number;
  areaBefore?: number; areaAfter?: number;
  /** True when an organise result was discarded because it was not an improvement. */
  rejected?: boolean;
}
export interface RelationshipLayoutResult { state: GraphState; stats: LayoutStats }

/** Below this a batch is placed one child at a time: a rank assignment costs more than it returns. */
const LAYERED_SEED_MIN = 3;
const FLOW: Record<GrowthDirection, LayeredFlow> = { right: 'right', down: 'down', left: 'left', up: 'up' };

export interface ArrangementMetrics { score: number; crossings: number; area: number }

/** An organise request only ships when it beats the arrangement it started from.
 * More crossings is never an improvement, and a gain too small to see is not a
 * reason to move the user's children. */
export function improvesArrangement(before: ArrangementMetrics, after: ArrangementMetrics): boolean {
  if (after.crossings > before.crossings) return false;
  return after.score <= before.score - Math.max(.5, Math.abs(before.score) * .01);
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const blank = (size: Rect): Rect => ({ x: 0, y: 0, width: size.width, height: size.height });

/** The bounded solver never mutates ownership, calls rendering, or evaluates external relations inside a child. */
export function layoutRelationships(input: GraphState, options: RelationshipLayoutOptions): RelationshipLayoutResult {
  if (options.viewOnly) return layoutRelatedView(input, options);
  const started = performance.now(), deadline = started + (options.budgetMs ?? (options.mode === 'auto' ? 160 : 300));
  const stats: LayoutStats = { regions: 0, candidates: 0, moved: 0, elapsedMs: 0, exhausted: false };
  const protectedIds = new Set(options.protectedIds), permitted = options.permittedIds && new Set(options.permittedIds);
  // Editing or dragging a child also fixes its visible ancestors. Otherwise a
  // parent move would bypass the child's protection without changing its local
  // coordinates. Shared document mounts are protected in every affected canvas.
  if (protectedIds.size) {
    const hierarchy = getHierarchyIndex(input), queue = [...protectedIds];
    const protect = (id?: string) => { if (id && !protectedIds.has(id)) { protectedIds.add(id); queue.push(id); } };
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      protect(hierarchy.nodeParents.get(id)); protect(hierarchy.documentParents.get(id));
      for (const parents of hierarchy.canvasParents.values()) protect(parents.get(id));
    }
  }
  const movable = new Set(options.movableIds), changedEdges = new Set(options.changedEdgeIds);
  const inserted = new Set([...(options.provisionalIds ?? []), ...(options.insertedIds ?? [])]);
  const triggers = options.movableIds || options.insertedIds || options.changedEdgeIds
    ? new Set([...movable, ...(options.insertedIds ?? [])]) : inserted;
  const projection = getRelationProjection(input, options.canvasId);
  let state = input;
  // A directory whose children carry no relations has nothing for the relation
  // solver to weigh: it is tidied into reading order instead. Organising is the
  // only operation allowed to do this, and never the AI's automatic pass.
  if (options.mode === 'organize' && options.regionId) {
    const packed = packUnrelatedChildren(state, { ...options, protectedIds: [...protectedIds] }, projection);
    if (packed.moved) { state = packed.state; stats.packed = packed.moved; stats.regions += 1; }
  }
  const regions = [...projection.values()].filter(region =>
    (!region.canvasId || region.canvasId === options.canvasId) && (!options.regionId || region.id === options.regionId) &&
    (options.mode === 'organize' || region.relations.some(r => triggers.has(r.source) || triggers.has(r.target) || r.edgeIds.some(id => changedEdges.has(id)))))
    .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
  for (const region of regions) {
    // The deadline bounds refinement, not coverage: every affected directory
    // still receives its linear structural pass, even when earlier ones ran long.
    if (performance.now() >= deadline) stats.exhausted = true;
    const canvas = state.canvases.find(c => c.canvasId === (region.canvasId ?? options.canvasId)); if (!canvas) continue;
    const doc = region.canvasId ? undefined : state.documents[region.id];
    const ids = (doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : canvasDirectory(canvas, region.id)?.childIds ?? []).slice().sort();
    const positions = doc?.placements ?? canvas.placements;
    const geometry = getNaturalGeometry(state);
    const sizes = new Map(ids.map(id => [id, state.nodes[id] ? nodeGeometry(state.nodes[id]) :
      state.documents[id] ? geometry.document(id) : geometry.directory(canvas, id)]));
    const relations = region.relations.filter(r => sizes.has(r.source) && sizes.has(r.target));
    if (!relations.length) continue;
    const incident = new Set(relations.flatMap(r => [r.source, r.target]));
    const touched = new Set(relations.filter(r => r.edgeIds.some(edge => changedEdges.has(edge))).flatMap(r => [r.source, r.target]));
    const candidates = ids.filter(id => incident.has(id) && !protectedIds.has(id) && (!permitted || permitted.has(id)) &&
      !recentManualPlacement(positions[id], options.solveTime) &&
      (options.mode === 'organize' || movable.has(id) || inserted.has(id) || touched.has(id)));
    // Every provisional child participates, independent of the refinement
    // budget. A partial batch must not strand later members at their first slot.
    // A child the user positioned is never inserted: its intent outranks layout.
    const anchorIds = options.mode === 'organize' ? candidates : inserted.size ? ids.filter(id => inserted.has(id) && incident.has(id) &&
      !protectedIds.has(id) && (!permitted || permitted.has(id)) &&
      positions[id]?.source !== 'manual' && !positions[id]?.manualAnchor) : [];
    if (!candidates.length && !anchorIds.length) continue;
    stats.regions++;
    const initial = { ...positions }; let best = initial;
    const root = Boolean(region.canvasId) && region.id === canvas.canvasId;
    const obstacleIds = ids;
    const preferences = new Map(candidates.map(id => [id, manualProtection(initial[id], options.solveTime)]));
    const scoreCache = new WeakMap<Record<string, Placement>, number>();
    const score = (p: Record<string, Placement>) => {
      const cached = scoreCache.get(p); if (cached !== undefined) return cached;
      let value = measureArrangement(ids, sizes, p, relations).score;
      for (const id of candidates) {
        const weight = options.mode === 'organize' ? .45 : inserted.has(id) ? 0 : movable.has(id) ? .05 : 2;
        value += distance(p[id], initial[id]) / 180 * weight
          + manualMovementCost(initial[id], initial[id], p[id], preferences.get(id)!);
      }
      scoreCache.set(p, value); return value;
    };
    const baselineMetrics = measureArrangement(ids, sizes, initial, relations);
    const baselineScore = baselineMetrics.score;
    scoreCache.set(initial, baselineScore);
    // The region's own reading direction steers where an arriving child lands,
    // so an addition to a top-down flow continues downward instead of sideways.
    // Only an insertion needs it, so the region pays for it only then.
    const anchorSet = new Set(anchorIds);
    const settled = anchorIds.length ? ids.filter(id => !anchorSet.has(id) && positions[id]) : [];
    const settledSet = new Set(settled);
    const samples: DirectionSample[] = [];
    const organizing = options.mode === 'organize';
    if (organizing || settled.length) for (const relation of relations) {
      if (relation.directed === false) continue;
      if (!organizing && (!settledSet.has(relation.source) || !settledSet.has(relation.target))) continue;
      const sourceSize = sizes.get(relation.source), targetSize = sizes.get(relation.target);
      const source = initial[relation.source], target = initial[relation.target];
      if (!sourceSize || !targetSize || !source || !target) continue;
      samples.push({ source: { ...sourceSize, ...source }, target: { ...targetSize, ...target }, weight: relation.weight });
    }
    const settledExtent = settled.length > 1 ? {
      width: Math.max(...settled.map(id => initial[id].x + sizes.get(id)!.width)) - Math.min(...settled.map(id => initial[id].x)),
      height: Math.max(...settled.map(id => initial[id].y + sizes.get(id)!.height)) - Math.min(...settled.map(id => initial[id].y)),
    } : undefined;
    const direction = inferGrowthDirection(samples, settledExtent);
    const settledRects = settled.map(id => ({ ...sizes.get(id)!, ...initial[id] }));
    // A child that arrived without coordinates is placed beside its strongest
    // same-region partner before local refinement. New children carry no
    // mental-map cost, so the placement is deterministic, never moves a settled
    // sibling, and never leaves the region it belongs to.
    const anchorInserted = (skip?: ReadonlySet<string>) => {
      for (const id of anchorIds) {
        if (skip?.has(id)) continue;
        const current = positions[id]; if (!current) continue;
        // A historical anchor participates in optimisation, but starts from
        // its current slot instead of being reinserted beside its strongest link.
        if (hasManualIntent(current)) continue;
        if (performance.now() >= deadline) stats.exhausted = true;
        const size = sizes.get(id)!;
        const neighbours: InsertionNeighbour[] = [];
        for (const relation of relations) {
          if (relation.source !== id && relation.target !== id) continue;
          const otherId = relation.source === id ? relation.target : relation.source;
          const otherSize = sizes.get(otherId), otherPoint = best[otherId];
          if (!otherSize || !otherPoint) continue;
          neighbours.push({ id: otherId, weight: relation.weight, upstream: relation.directed !== false && relation.source === id,
            rect: { x: otherPoint.x, y: otherPoint.y, width: otherSize.width, height: otherSize.height } });
        }
        if (!neighbours.length) continue;
        const occupiedRects: Rect[] = [];
        for (const other of ids) {
          if (other === id) continue;
          const otherSize = sizes.get(other), otherPoint = best[other];
          if (!otherSize || !otherPoint || !Number.isFinite(otherPoint.x) || !Number.isFinite(otherPoint.y)) continue;
          occupiedRects.push({ x: otherPoint.x, y: otherPoint.y, width: otherSize.width, height: otherSize.height });
        }
        const occupied = new RectangleIndex(occupiedRects);
        const point = chooseInsertionPoint(size, neighbours, occupied, { x: 0, y: 0 }, BLOCK_GAP, direction ?? 'right', root);
        const placed = { ...size, ...point };
        if (ids.some(other => other !== id && best[other] && sizes.get(other) &&
          intersects(placed, { ...sizes.get(other)!, ...best[other] }, BLOCK_GAP - .01))) continue;
        best = { ...best, [id]: { ...current, ...point } };
        stats.candidates++;
      }
    };
    // Compare whole structural candidates before considering individual slots.
    let seeded: ReadonlySet<string> | undefined;
    if (anchorIds.length >= LAYERED_SEED_MIN) {
      const cluster = seedLayeredCluster({ anchorIds, sizes, relations, positions: best, settled: settledRects, flow: direction,
        preservePosition: organizing, root, deadline, score });
      if (cluster) { best = cluster.best; seeded = cluster.placed; stats.seeded = (stats.seeded ?? 0) + cluster.count; }
    }
    anchorInserted(seeded);
    if (options.mode === 'organize' && score(best) >= baselineScore) best = initial;
    let bestScore = score(best), iterations = 0;
    const localCandidates = seeded ? candidates.filter(id => hasManualIntent(initial[id])) : candidates;
    for (let pass = 0; pass < 2; pass++) for (const id of localCandidates) {
      if (performance.now() >= deadline || iterations >= (options.maxIterations ?? 500)) { stats.exhausted = true; break; }
      const size = sizes.get(id)!; const current = best[id];
      const maxMove = movable.has(id) ? 1600 : options.mode === 'auto' ? 160 : 800;
      const otherIds = relations.filter(r => r.source === id || r.target === id).map(r => r.source === id ? r.target : r.source).slice(0, 8);
      const trial: Point[] = [];
      for (const other of otherIds) {
        const p = best[other], s = sizes.get(other)!;
        trial.push({ x: p.x - size.width - BLOCK_GAP, y: p.y }, { x: p.x + s.width + BLOCK_GAP, y: p.y },
          { x: p.x, y: p.y - size.height - BLOCK_GAP }, { x: p.x, y: p.y + s.height + BLOCK_GAP });
      }
      for (const step of [48, 112, 228]) trial.push({ x: current.x + step, y: current.y }, { x: current.x - step, y: current.y },
        { x: current.x, y: current.y + step }, { x: current.x, y: current.y - step });
      if (preferences.get(id) && current !== initial[id]) {
        for (const fraction of [0, .25, .5, .75]) trial.push({
          x: initial[id].x + fraction * (current.x - initial[id].x), y: initial[id].y + fraction * (current.y - initial[id].y),
        });
      }
      const seen = new Set<string>();
      for (const point of trial) {
        if (performance.now() >= deadline || iterations++ >= (options.maxIterations ?? 500)) { stats.exhausted = true; break; }
        if (!region.canvasId || region.id !== canvas.canvasId) { point.x = Math.max(0, point.x); point.y = Math.max(0, point.y); }
        const key = `${point.x}/${point.y}`; if (seen.has(key)) continue; seen.add(key);
        if (distance(point, initial[id]) > maxMove) continue;
        const rect = { ...size, ...point };
        if (ids.some(other => other !== id && intersects(rect, { ...sizes.get(other)!, ...best[other] }, BLOCK_GAP - .01))) continue;
        stats.candidates++;
        const proposed = { ...best, [id]: { ...current, ...point } };
        const value = score(proposed);
        if (value < bestScore - .12) { best = proposed; bestScore = value; }
      }
    }
    const changed = [...new Set([...candidates, ...anchorIds])]
      .filter(id => best[id] && initial[id] && (best[id].x !== initial[id].x || best[id].y !== initial[id].y));
    if (!changed.length) continue;
    // An organise request is a promise to improve, so it must beat its own
    // baseline on the same measure: more crossings or a negligible gain is
    // discarded instead of shipped. The user keeps the arrangement they had.
    if (options.mode === 'organize') {
      const before = { ...baselineMetrics, score: baselineScore };
      const after = { ...measureArrangement(ids, sizes, best, relations), score: bestScore };
      stats.crossingsBefore = before.crossings; stats.crossingsAfter = after.crossings;
      stats.areaBefore = before.area; stats.areaAfter = after.area;
      if (!improvesArrangement(before, after)) { stats.rejected = true; continue; }
    }
    // Only the finalist receives a bounded routing check; no labels or render model are involved.
    if (!seeded && performance.now() + 4 < deadline) {
      const selected = relations.filter(r => changed.includes(r.source) || changed.includes(r.target)).slice(0, 4);
      const routeCost = (p: Record<string, Placement>) => {
        let cost = 0;
        for (const r of selected) {
          if (performance.now() >= deadline) return undefined;
          const a = { ...sizes.get(r.source)!, ...p[r.source] }, b = { ...sizes.get(r.target)!, ...p[r.target] };
          const ports = choosePorts(a, b);
          const obstacles = obstacleIds.filter(id => id !== r.source && id !== r.target).map(id => ({ ...sizes.get(id)!, ...p[id] }));
          const route = routeAroundObstacles(portPoint(a, ports.sourceSide), portPoint(b, ports.targetSide), ports.sourceSide, ports.targetSide, obstacles, .6, [a, b]);
          let last = pointOnRoute(route, 0), length = 0;
          for (let i = 1; i <= 12; i++) { const point = pointOnRoute(route, i / 12); length += distance(last, point); last = point; }
          cost += length / 180 + (route.fallback ? 10 : 0);
        }
        return cost;
      };
      const before = routeCost(initial), after = routeCost(best);
      if (before !== undefined && after !== undefined && after > before * 1.25 + 2 && baselineScore - bestScore < 4) continue;
    }
    for (const id of changed) best[id] = automaticPlacement(initial[id], best[id]);
    if (doc) state = { ...state, documents: { ...state.documents, [doc.documentId]: { ...doc, placements: best, rev: doc.rev + 1,
      metadata: { ...doc.metadata, updatedAt: new Date(options.solveTime).toISOString() } } } };
    else state = { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: best, updatedAt: new Date(options.solveTime).toISOString() } : c) };
    state = normalizeRegionLayout(state, input, protectedIds);
  }
  const countChanges = (placements: Record<string, Placement>, before?: Record<string, Placement>) => {
    for (const [id, p] of Object.entries(placements)) {
      const old = before?.[id];
      if (p.x === old?.x && p.y === old.y) continue;
      stats.moved++;
      if (options.mode === 'organize' && hasManualIntent(old)) stats.manualMoved = (stats.manualMoved ?? 0) + 1;
    }
  };
  stats.moved = 0;
  for (const doc of Object.values(state.documents)) countChanges(doc.placements, input.documents[doc.documentId]?.placements);
  for (const canvas of state.canvases) countChanges(canvas.placements, input.canvases.find(c => c.canvasId === canvas.canvasId)?.placements);
  stats.elapsedMs = performance.now() - started;
  if (performance.now() > deadline) stats.exhausted = true;
  return { state, stats };
}

/**
 * Reading order for loose notes. Try leaving historical placements alone
 * before allowing the shelf to reclaim space they occupy.
 */
function packUnrelatedChildren(
  state: GraphState,
  options: RelationshipLayoutOptions,
  projection: ReadonlyMap<string, LayoutRegion>,
): { state: GraphState; moved: number } {
  const regionId = options.regionId;
  const canvas = state.canvases.find(c => c.canvasId === options.canvasId);
  if (!regionId || !canvas || !getCanvasMembership(state, canvas).members.has(regionId)) return { state, moved: 0 };
  const doc = state.documents[regionId];
  const directory = doc ? undefined : canvasDirectory(canvas, regionId);
  if (!doc && !directory) return { state, moved: 0 };
  const region = projection.get(doc ? regionKey(regionId) : regionKey(regionId, options.canvasId));
  if (region?.relations.length) return { state, moved: 0 };
  const ids = (doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : directory!.childIds)
    .filter(id => doc ? Boolean(state.nodes[id] || state.documents[id])
      : Boolean(!canvas.excludedDocumentIds?.includes(id) && (state.nodes[id] || state.documents[id] || canvasDirectory(canvas, id))))
    .sort();
  const placements = doc?.placements ?? canvas.placements;
  const geometry = getNaturalGeometry(state);
  const protectedIds = new Set(options.protectedIds);
  const permittedIds = options.permittedIds && new Set(options.permittedIds);
  const members: Array<{ id: string; size: { width: number; height: number }; position: Point }> = [];
  const fixed: Rect[] = [];
  for (const id of ids) {
    const placement = placements[id];
    if (!placement) continue;
    const size = state.nodes[id] ? nodeGeometry(state.nodes[id]) : state.documents[id] ? geometry.document(id) : geometry.directory(canvas, id);
    const rect = { x: placement.x, y: placement.y, width: size.width, height: size.height };
    if (recentManualPlacement(placement, options.solveTime) || protectedIds.has(id) || permittedIds && !permittedIds.has(id)) fixed.push(rect);
    else members.push({ id, size: { width: size.width, height: size.height }, position: { x: placement.x, y: placement.y } });
  }
  if (members.length < 2) return { state, moved: 0 };
  // Tidy this cluster where it is already visible, including on a canvas
  // panned far from its origin. The top left of a tidy shelf is a fixed point.
  const shelf = (items: typeof members, obstacles: Rect[]) => {
    const origin = { x: Math.min(...items.map(m => m.position.x)), y: Math.min(...items.map(m => m.position.y)) };
    return packMembers(items, { fixed: obstacles, origin });
  };
  let packed = shelf(members, fixed);
  const anchored = members.filter(m => hasManualIntent(placements[m.id]));
  if (anchored.length) {
    const cost = (points: ReadonlyMap<string, Point>) => {
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, travel = 0;
      for (const { id, position, size } of members) {
        const p = points.get(id) ?? position, base = placements[id];
        left = Math.min(left, p.x); right = Math.max(right, p.x + size.width);
        top = Math.min(top, p.y); bottom = Math.max(bottom, p.y + size.height);
        travel += .45 * distance(position, p) / NODE_WIDTH + manualMovementCost(base, position, p, manualProtection(base, options.solveTime));
      }
      return (right - left) * (bottom - top) / (NODE_WIDTH * NODE_HEIGHT) + travel;
    };
    const automatic = members.filter(m => !hasManualIntent(placements[m.id]));
    if (automatic.length) {
      const preserved = shelf(automatic, [...fixed, ...anchored.map(m => ({ ...m.position, ...m.size }))]);
      if (cost(preserved.positions) <= cost(packed.positions)) packed = preserved;
    }
    if (cost(packed.positions) + .5 >= cost(new Map())) return { state, moved: 0 };
  }
  if (!packed.moved.length) return { state, moved: 0 };
  const updates = Object.fromEntries(packed.moved.map(id => [id, automaticPlacement(placements[id], packed.positions.get(id)!)]));
  const updatedAt = new Date(options.solveTime).toISOString();
  const next: GraphState = doc
    ? { ...state, documents: { ...state.documents, [doc.documentId]: { ...doc, placements: { ...doc.placements, ...updates }, rev: doc.rev + 1,
      metadata: { ...doc.metadata, updatedAt } } } }
    : { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: { ...c.placements, ...updates }, updatedAt } : c) };
  return { state: next, moved: packed.moved.length };
}

/** Whole-region candidates preserve a batch's structure while keeping all
 * settled/manual siblings fixed. Geometry is compared before publishing. */
function seedLayeredCluster(input: {
  anchorIds: readonly string[];
  sizes: ReadonlyMap<string, Rect>;
  relations: readonly ProjectedRelation[];
  positions: Readonly<Record<string, Placement>>;
  settled: readonly Rect[];
  flow: GrowthDirection | undefined;
  preservePosition: boolean;
  root: boolean;
  deadline: number;
  score: (positions: Record<string, Placement>) => number;
}): { best: Record<string, Placement>; placed: ReadonlySet<string>; count: number } | undefined {
  const inside = new Set(input.anchorIds);
  const internal = input.relations.filter(edge => inside.has(edge.source) && inside.has(edge.target));
  if (!internal.length) return undefined;
  const participants = [...new Set(internal.flatMap(edge => [edge.source, edge.target]))].sort();
  if (participants.length < LAYERED_SEED_MIN) return undefined;
  const member = new Set(participants);
  const fixed = [...input.settled, ...input.anchorIds.filter(id => !member.has(id)).map(id => ({ ...input.sizes.get(id)!, ...input.positions[id] }))];
  const external = input.relations.filter(edge => member.has(edge.source) !== member.has(edge.target));
  const candidates = structuralCandidates(participants.map(id => ({ id, ...input.sizes.get(id)! })), internal,
    input.flow ? FLOW[input.flow] : 'down', input.deadline);
  let winner: Record<string, Placement> | undefined, bestScore = Infinity;
  for (const candidate of candidates) {
    if (input.preservePosition && input.flow && candidate.algorithm === 'layer-sweep') {
      for (const slots of slotCandidates(candidate, input.positions, input.sizes, fixed, input.flow, input.root)) {
        const score = input.score(slots);
        if (score < bestScore) { winner = slots; bestScore = score; }
      }
    }
    const positions = new Map(candidate.positions);
    const entry = external.slice().sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))[0];
    let delta = { x: Math.min(...participants.map(id => input.positions[id].x)), y: Math.min(...participants.map(id => input.positions[id].y)) };
    if (entry) {
      const id = member.has(entry.source) ? entry.source : entry.target, other = id === entry.source ? entry.target : entry.source;
      const otherSize = input.sizes.get(other)!, partner = input.positions[other];
      const slot = chooseInsertionPoint(blank(input.sizes.get(id)!),
        [{ id: other, rect: { ...otherSize, ...partner }, weight: entry.weight, upstream: entry.directed !== false && entry.source === id }],
        new RectangleIndex([...fixed]), { x: 0, y: 0 }, BLOCK_GAP, input.flow ?? 'right', input.root);
      delta = { x: slot.x - positions.get(id)!.x, y: slot.y - positions.get(id)!.y };
    } else if (input.preservePosition || !fixed.length) {
      // A rigid translation leaves internal edge geometry unchanged. Coordinate
      // medians minimise total horizontal + vertical travel and ignore outliers.
      const offset = (axis: keyof Point) => {
        const offsets = participants.map(id => input.positions[id][axis] - positions.get(id)![axis]).sort((a, b) => a - b);
        return (offsets[Math.floor((offsets.length - 1) / 2)] + offsets[Math.floor(offsets.length / 2)]) / 2;
      };
      delta = { x: offset('x'), y: offset('y') };
    }
    if (!input.root) { delta.x = Math.max(0, delta.x); delta.y = Math.max(0, delta.y); }
    // A partially generated large graph can have hundreds of unrelated initial
    // placeholders. Reserve one clear block for its connected component rather
    // than repeatedly searching through that field for every individual card.
    if (fixed.length >= 32 && !external.length) {
      const occupied = new RectangleIndex([...fixed]);
      const block = { width: candidate.width, height: candidate.height };
      if (occupied.collides({ ...block, ...delta }, BLOCK_GAP)) {
        const right = Math.max(...fixed.map(rect => rect.x + rect.width)), bottom = Math.max(...fixed.map(rect => rect.y + rect.height));
        const alternatives = [{ x: delta.x, y: bottom + BLOCK_GAP }, { x: right + BLOCK_GAP, y: delta.y }];
        if (input.root) alternatives.push({ x: delta.x, y: Math.min(...fixed.map(rect => rect.y)) - block.height - BLOCK_GAP },
          { x: Math.min(...fixed.map(rect => rect.x)) - block.width - BLOCK_GAP, y: delta.y });
        alternatives.sort((a, b) => distance(a, delta) - distance(b, delta));
        delta = alternatives[0];
      }
    }
    const occupied = new RectangleIndex([...fixed]), best = { ...input.positions };
    const order = participants.slice().sort((a, b) => positions.get(a)!.y - positions.get(b)!.y || positions.get(a)!.x - positions.get(b)!.x || a.localeCompare(b));
    for (const id of order) {
      const wanted = positions.get(id)!, size = blank(input.sizes.get(id)!);
      const point = nearestRegionSpace(size, { x: Math.round(wanted.x + delta.x), y: Math.round(wanted.y + delta.y) }, occupied, input.root);
      best[id] = { ...input.positions[id], ...point }; occupied.add({ ...size, ...point });
    }
    const score = input.score(best);
    if (score < bestScore) { winner = best; bestScore = score; }
  }
  if (!winner) return undefined;
  // Provisional coordinates are disposable, but a new structure must still
  // improve the readable geometry. This also makes repeated commits stable.
  if (bestScore >= input.score(input.positions as Record<string, Placement>) - .12)
    return { best: input.positions as Record<string, Placement>, placed: member, count: 0 };
  return { best: winner, placed: member, count: participants.length };
}
