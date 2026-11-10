import { nodeGeometry } from './nodeGeometry';
import { canvasDirectory } from './canvas';
import { getNaturalGeometry, nearestRegionSpace, normalizeRegionLayout } from './regionLayout';
import { RectangleIndex, intersects } from './rectangleIndex';
import { getRelationProjection, regionKey } from './relationProjection';
import type { LayoutRegion, ProjectedRelation } from './relationProjection';
import { chooseInsertionPoint, inferGrowthDirection } from './insertionPlacement';
import type { DirectionSample, GrowthDirection, InsertionNeighbour } from './insertionPlacement';
import { packMembers } from './packingLayout';
import { layeredLayout } from './layeredSeed';
import type { LayeredFlow, LayeredRelation } from './layeredSeed';
import type { GraphState, Placement, Point, Rect } from './types';
import { BLOCK_GAP } from './types';
import { manualProtection } from './placementPolicy';
import { choosePorts, portPoint, pointOnRoute } from './edgeGeometry';
import { routeAroundObstacles } from './obstacleRouter';
export { manualProtection } from './placementPolicy';

export interface RelationshipLayoutOptions {
  canvasId: string;
  regionId?: string;
  mode: 'auto' | 'organize';
  movableIds?: string[];
  protectedIds?: string[];
  permittedIds?: string[];
  changedEdgeIds?: string[];
  /** Children that arrived without a position (the AI writes a path, never a point). */
  insertedIds?: string[];
  solveTime: number;
  budgetMs?: number;
  maxIterations?: number;
}
export interface LayoutStats {
  regions: number; candidates: number; moved: number; elapsedMs: number; exhausted: boolean;
  /** Children placed by the structural seed instead of one-by-one insertion. */
  seeded?: number;
  /** Unrelated children tidied into reading order; organise mode only. */
  packed?: number;
  /** Relation crossings and occupied area, measured before and after organising. */
  crossingsBefore?: number; crossingsAfter?: number;
  areaBefore?: number; areaAfter?: number;
  /** True when an organise result was discarded because it was not an improvement. */
  rejected?: boolean;
}
export interface RelationshipLayoutResult { state: GraphState; stats: LayoutStats }

/** Below this a batch is placed one child at a time: a rank assignment costs more than it returns. */
const LAYERED_SEED_MIN = 5;
const FLOW: Record<GrowthDirection, LayeredFlow> = { right: 'right', down: 'down', left: 'left', up: 'up' };

export interface ArrangementMetrics { score: number; crossings: number; area: number }

/** An organise request only ships when it beats the arrangement it started from.
 * More crossings is never an improvement, and a gain too small to see is not a
 * reason to move the user's children. */
export function improvesArrangement(before: ArrangementMetrics, after: ArrangementMetrics): boolean {
  if (after.crossings > before.crossings) return false;
  return after.score <= before.score - Math.max(.5, Math.abs(before.score) * .01);
}
const center = (p: Point, size: Rect) => ({ x: p.x + size.width / 2, y: p.y + size.height / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const blank = (size: Rect): Rect => ({ x: 0, y: 0, width: size.width, height: size.height });
function hitsRect(a: Point, b: Point, rect: Rect) {
  let low = 0, high = 1;
  for (const [origin, delta, min, max] of [[a.x, b.x - a.x, rect.x, rect.x + rect.width], [a.y, b.y - a.y, rect.y, rect.y + rect.height]]) {
    if (!delta) { if (origin <= min || origin >= max) return false; continue; }
    const x = (min - origin) / delta, y = (max - origin) / delta;
    low = Math.max(low, Math.min(x, y)); high = Math.min(high, Math.max(x, y));
    if (high <= low) return false;
  }
  return true;
}
function crossing(a: Point, b: Point, c: Point, d: Point) {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** The bounded solver never mutates ownership, calls rendering, or evaluates external relations inside a child. */
export function layoutRelationships(input: GraphState, options: RelationshipLayoutOptions): RelationshipLayoutResult {
  const started = performance.now(), deadline = started + (options.budgetMs ?? (options.mode === 'auto' ? 16 : 120));
  const stats: LayoutStats = { regions: 0, candidates: 0, moved: 0, elapsedMs: 0, exhausted: false };
  const protectedIds = new Set(options.protectedIds), permitted = options.permittedIds && new Set(options.permittedIds);
  const movable = new Set(options.movableIds), changedEdges = new Set(options.changedEdgeIds);
  const inserted = new Set(options.insertedIds ?? []);
  const projection = getRelationProjection(input);
  let state = input;
  // A directory whose children carry no relations has nothing for the relation
  // solver to weigh: it is tidied into reading order instead. Organising is the
  // only operation allowed to do this, and never the AI's automatic pass.
  if (options.mode === 'organize' && options.regionId) {
    const packed = packUnrelatedChildren(state, options, projection);
    if (packed.moved) { state = packed.state; stats.packed = packed.moved; stats.regions += 1; }
  }
  const regions = [...projection.values()].filter(region =>
    (!region.canvasId || region.canvasId === options.canvasId) && (!options.regionId || region.id === options.regionId) &&
    (options.mode === 'organize' || region.relations.some(r => movable.has(r.source) || movable.has(r.target) || r.edgeIds.some(id => changedEdges.has(id)))))
    .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
  for (const region of regions) {
    if (performance.now() >= deadline) { stats.exhausted = true; break; }
    const canvas = state.canvases.find(c => c.canvasId === (region.canvasId ?? options.canvasId)); if (!canvas) continue;
    const doc = region.canvasId ? undefined : state.documents[region.id];
    const ids = (doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : canvasDirectory(canvas, region.id)?.childIds ?? []).slice().sort();
    const positions = doc?.placements ?? canvas.placements;
    const geometry = getNaturalGeometry(state);
    const sizes = new Map(ids.map(id => [id, state.nodes[id] ? nodeGeometry(state.nodes[id]) :
      state.documents[id] ? geometry.document(id) : geometry.directory(canvas, id)]));
    const relations = region.relations.filter(r => sizes.has(r.source) && sizes.has(r.target)).slice(0, 180);
    if (!relations.length) continue;
    const incident = new Set(relations.flatMap(r => [r.source, r.target]));
    const candidates = ids.filter(id => incident.has(id) && !protectedIds.has(id) && (!permitted || permitted.has(id)) &&
      (options.mode === 'organize' || movable.has(id) || (!positions[id]?.manualAnchor && positions[id]?.source !== 'manual' &&
        relations.some(r => (r.source === id || r.target === id) && r.edgeIds.some(edge => changedEdges.has(edge))))))
      .slice(0, options.mode === 'auto' ? 16 : 100);
    // Insertion is cheap and independent of the stochastic budget, so every
    // inserted child is anchored even when the region exceeds the trial cap.
    // A child the user positioned is never inserted: its intent outranks layout.
    const anchorIds = inserted.size ? ids.filter(id => inserted.has(id) && incident.has(id) &&
      !protectedIds.has(id) && (!permitted || permitted.has(id)) &&
      positions[id]?.source !== 'manual' && !positions[id]?.manualAnchor) : [];
    if (!candidates.length && !anchorIds.length) continue;
    stats.regions++;
    const initial = { ...positions }; let best = { ...positions };
    const root = Boolean(region.canvasId) && region.id === canvas.canvasId;
    const obstacleIds = [...new Set([...candidates, ...ids.slice(0, 120)])];
    const points = (r: ProjectedRelation, p: Record<string, Placement>) => [center(p[r.source], sizes.get(r.source)!), center(p[r.target], sizes.get(r.target)!)] as const;
    const score = (p: Record<string, Placement>) => {
      let value = 0;
      const lines = relations.map(r => points(r, p));
      relations.forEach((r, i) => { value += distance(...lines[i]) / 180 * r.weight; });
      relations.forEach((r, i) => {
        for (const id of obstacleIds) if (id !== r.source && id !== r.target && hitsRect(...lines[i], { ...sizes.get(id)!, ...p[id] })) value += 5 * r.weight;
      });
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        const a = relations[i], b = relations[j];
        if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue;
        if (crossing(...lines[i], ...lines[j])) value += 8;
      }
      for (const id of candidates) {
        const movement = distance(p[id], initial[id]) / 180;
        // An inserted child has no mental-map history, so moving it is free.
        // Every other child keeps the displacement cost that stabilises the layout.
        value += movement * (inserted.has(id) ? 0 : movable.has(id) ? .08 : options.mode === 'auto' ? 1.5 : .4);
        const anchor = initial[id].manualAnchor ?? (initial[id].source === 'manual' ? initial[id] : undefined);
        if (anchor) value += distance(p[id], anchor) / 180 * manualProtection(initial[id], options.solveTime) * (options.mode === 'organize' ? .15 : 1);
      }
      const right = Math.max(0, ...ids.map(id => p[id].x + sizes.get(id)!.width));
      const bottom = Math.max(0, ...ids.map(id => p[id].y + sizes.get(id)!.height));
      return value + right * bottom / (180 * 180) * .04;
    };
    const baselineScore = score(initial);
    const crossingsOf = (p: Record<string, Placement>) => {
      const lines = relations.map(r => points(r, p)); let count = 0;
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        const a = relations[i], b = relations[j];
        if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue;
        if (crossing(...lines[i], ...lines[j])) count++;
      }
      return count;
    };
    const areaOf = (p: Record<string, Placement>) => {
      const right = Math.max(0, ...ids.map(id => p[id].x + sizes.get(id)!.width));
      const bottom = Math.max(0, ...ids.map(id => p[id].y + sizes.get(id)!.height));
      return Math.round(right * bottom);
    };
    // The region's own reading direction steers where an arriving child lands,
    // so an addition to a top-down flow continues downward instead of sideways.
    // Only an insertion needs it, so the region pays for it only then.
    const settled = anchorIds.length ? ids.filter(id => !inserted.has(id) && positions[id]) : [];
    const settledSet = new Set(settled);
    const samples: DirectionSample[] = [];
    if (settled.length) for (const relation of relations) {
      if (!settledSet.has(relation.source) || !settledSet.has(relation.target)) continue;
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
    // same-region partner before any stochastic search. New children carry no
    // mental-map cost, so the placement is deterministic, never moves a settled
    // sibling, and never leaves the region it belongs to.
    const anchorInserted = (skip?: ReadonlySet<string>) => {
      for (const id of anchorIds) {
        if (skip?.has(id)) continue;
        const current = positions[id]; if (!current) continue;
        if (performance.now() >= deadline) { stats.exhausted = true; return; }
        const size = sizes.get(id)!;
        const neighbours: InsertionNeighbour[] = [];
        for (const relation of relations) {
          if (relation.source !== id && relation.target !== id) continue;
          const otherId = relation.source === id ? relation.target : relation.source;
          const otherSize = sizes.get(otherId), otherPoint = best[otherId];
          if (!otherSize || !otherPoint) continue;
          neighbours.push({ id: otherId, weight: relation.weight,
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
        const point = chooseInsertionPoint(size, neighbours, occupied, { x: 0, y: 0 }, BLOCK_GAP, direction ?? 'right');
        const placed = { ...size, ...point };
        if (ids.some(other => other !== id && best[other] && sizes.get(other) &&
          intersects(placed, { ...sizes.get(other)!, ...best[other] }, BLOCK_GAP - .01))) continue;
        best = { ...best, [id]: { ...current, ...point } };
        stats.candidates++;
      }
    };
    // A batch of new children that already carries its own structure is a rank
    // assignment problem, not a slot problem: seed it, then let the same bounded
    // acceptance test keep or discard the seed.
    let seeded: ReadonlySet<string> | undefined;
    if (options.mode === 'auto' && anchorIds.length >= LAYERED_SEED_MIN) {
      const cluster = seedLayeredCluster({ anchorIds, sizes, relations, positions: best, settled: settledRects, flow: direction, root, deadline });
      if (cluster) { best = cluster.best; seeded = cluster.placed; stats.seeded = cluster.count; }
    }
    anchorInserted(seeded);
    let bestScore = score(best), iterations = 0;
    for (let pass = 0; pass < 3; pass++) for (const id of candidates) {
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
      const before = { score: baselineScore, crossings: crossingsOf(initial), area: areaOf(initial) };
      const after = { score: bestScore, crossings: crossingsOf(best), area: areaOf(best) };
      stats.crossingsBefore = before.crossings; stats.crossingsAfter = after.crossings;
      stats.areaBefore = before.area; stats.areaAfter = after.area;
      if (!improvesArrangement(before, after)) { stats.rejected = true; continue; }
    }
    // Only the finalist receives a bounded routing check; no labels or render model are involved.
    if (performance.now() + 4 < deadline) {
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
    stats.moved += changed.length;
    if (doc) state = { ...state, documents: { ...state.documents, [doc.documentId]: { ...doc, placements: best, rev: doc.rev + 1,
      metadata: { ...doc.metadata, updatedAt: new Date(options.solveTime).toISOString() } } } };
    else state = { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: best, updatedAt: new Date(options.solveTime).toISOString() } : c) };
    state = normalizeRegionLayout(state, input);
  }
  stats.moved = Object.values(state.documents).reduce((count, doc) => count + Object.keys(doc.placements).filter(id =>
    doc.placements[id].x !== input.documents[doc.documentId]?.placements[id]?.x || doc.placements[id].y !== input.documents[doc.documentId]?.placements[id]?.y).length, 0) +
    state.canvases.reduce((count, canvas) => {
      const old = input.canvases.find(c => c.canvasId === canvas.canvasId);
      return count + Object.keys(canvas.placements).filter(id => canvas.placements[id].x !== old?.placements[id]?.x || canvas.placements[id].y !== old?.placements[id]?.y).length;
    }, 0);
  stats.elapsedMs = performance.now() - started;
  return { state, stats };
}

/**
 * Reading order for a region that has no projected relations. Hand-placed and
 * protected children keep their rectangles; only automatic ones are re-shelved,
 * and only when the whole directory has no relation to optimise — a relational
 * directory keeps the solver's arrangement instead of being flattened.
 */
function packUnrelatedChildren(
  state: GraphState,
  options: RelationshipLayoutOptions,
  projection: ReadonlyMap<string, LayoutRegion>,
): { state: GraphState; moved: number } {
  const regionId = options.regionId;
  const canvas = state.canvases.find(c => c.canvasId === options.canvasId);
  if (!regionId || !canvas) return { state, moved: 0 };
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
  const members: Array<{ id: string; size: { width: number; height: number }; position: Point }> = [];
  const fixed: Rect[] = [];
  for (const id of ids) {
    const placement = placements[id];
    if (!placement) continue;
    const size = state.nodes[id] ? nodeGeometry(state.nodes[id]) : state.documents[id] ? geometry.document(id) : geometry.directory(canvas, id);
    const rect = { x: placement.x, y: placement.y, width: size.width, height: size.height };
    if (placement.source === 'manual' || placement.manualAnchor || protectedIds.has(id)) fixed.push(rect);
    else members.push({ id, size: { width: size.width, height: size.height }, position: { x: placement.x, y: placement.y } });
  }
  if (members.length < 2) return { state, moved: 0 };
  const packed = packMembers(members, { fixed });
  if (!packed.moved.length) return { state, moved: 0 };
  const updates = Object.fromEntries(packed.moved.map(id => [id, { ...placements[id], ...packed.positions.get(id)! }]));
  const updatedAt = new Date(options.solveTime).toISOString();
  const next: GraphState = doc
    ? { ...state, documents: { ...state.documents, [doc.documentId]: { ...doc, placements: { ...doc.placements, ...updates }, rev: doc.rev + 1,
      metadata: { ...doc.metadata, updatedAt } } } }
    : { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: { ...c.placements, ...updates }, updatedAt } : c) };
  return { state: next, moved: packed.moved.length };
}

/**
 * Rank assignment for a batch that arrives already related. Returns placements
 * for the whole cluster, or undefined when the batch is cyclic, too small, or
 * not an actual structure. The caller's acceptance test still decides.
 */
function seedLayeredCluster(input: {
  anchorIds: readonly string[];
  sizes: ReadonlyMap<string, Rect>;
  relations: readonly ProjectedRelation[];
  positions: Readonly<Record<string, Placement>>;
  settled: readonly Rect[];
  flow: GrowthDirection | undefined;
  root: boolean;
  deadline: number;
}): { best: Record<string, Placement>; placed: ReadonlySet<string>; count: number } | undefined {
  const inside = new Set(input.anchorIds);
  if (input.deadline - performance.now() < 2) return undefined; // no budget left to rank
  const internal: LayeredRelation[] = [];
  for (const relation of input.relations) {
    if (relation.source === relation.target) continue;
    if (!inside.has(relation.source) || !inside.has(relation.target)) continue;
    internal.push({ source: relation.source, target: relation.target, weight: relation.weight });
  }
  if (!internal.length) return undefined;
  const participants = [...new Set(internal.flatMap(relation => [relation.source, relation.target]))].sort();
  if (participants.length < LAYERED_SEED_MIN) return undefined;
  const layout = layeredLayout(participants.map(id => ({ id, ...input.sizes.get(id)! })), internal,
    input.flow ? FLOW[input.flow] : 'down');
  if (!layout) return undefined;
  if (performance.now() >= input.deadline) return undefined;
  const member = new Set(participants);
  // The batch belongs beside whatever it links to: the child with the heaviest
  // relation to settled content decides where the whole cluster is anchored.
  const external = new Map<string, { other: string; weight: number }>();
  for (const relation of input.relations) {
    const source = member.has(relation.source), target = member.has(relation.target);
    if (source === target) continue;
    const id = source ? relation.source : relation.target, other = source ? relation.target : relation.source;
    const current = external.get(id);
    if (!current || relation.weight > current.weight || (relation.weight === current.weight && other < current.other))
      external.set(id, { other, weight: relation.weight });
  }
  const positions = new Map(layout.positions);
  const entry = [...external.entries()].sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))[0];
  const settle = (delta: Point) => { for (const [id, point] of positions) positions.set(id, { x: point.x + delta.x, y: point.y + delta.y }); };
  const entrySize = entry && input.sizes.get(entry[0]);
  const partner = entry && input.positions[entry[1].other];
  const partnerSize = entry && input.sizes.get(entry[1].other);
  if (entry && entrySize && partner && partnerSize) {
    const slot = chooseInsertionPoint(blank(entrySize),
      [{ id: entry[1].other, rect: { ...blank(partnerSize), x: partner.x, y: partner.y }, weight: entry[1].weight }],
      new RectangleIndex([...input.settled]), { x: 0, y: 0 }, BLOCK_GAP, input.flow ?? 'right');
    const seed = positions.get(entry[0])!;
    settle({ x: slot.x - seed.x, y: slot.y - seed.y });
  } else if (input.settled.length) {
    settle({ x: Math.max(...input.settled.map(rect => rect.x + rect.width)) + BLOCK_GAP, y: Math.min(...input.settled.map(rect => rect.y)) });
  }
  // Keep the seeded children legal without dissolving the rank structure: only
  // a child that actually collides is nudged, the rest keep their rank slot.
  const occupied = new RectangleIndex([...input.settled]);
  const best: Record<string, Placement> = { ...input.positions };
  const order = [...participants].sort((a, b) => positions.get(a)!.y - positions.get(b)!.y || positions.get(a)!.x - positions.get(b)!.x || a.localeCompare(b));
  for (const id of order) {
    const size = blank(input.sizes.get(id)!);
    const point = nearestRegionSpace(size, positions.get(id)!, occupied, input.root);
    best[id] = { ...input.positions[id], ...point };
    occupied.add({ ...size, ...point });
  }
  return { best, placed: new Set(participants), count: participants.length };
}
