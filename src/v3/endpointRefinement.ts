import { RectangleIndex } from './rectangleIndex';
import type { EndpointGeometry } from './relationEndpointGeometry';
import type { ProjectedRelation } from './relationProjection';
import type { Placement, Point, Rect } from './types';
import { BLOCK_GAP } from './types';

export interface EndpointRefinementInput {
  ids: readonly string[];
  sizes: ReadonlyMap<string, Rect>;
  relations: readonly ProjectedRelation[];
  endpoints: EndpointGeometry;
  positions: Record<string, Placement>;
  movable: readonly string[];
  root: boolean;
  deadline: number;
  maxMove?: number;
  /** A small drag may move neighbours by at most the same visible distance. */
  maxStep?: number;
  /** During a gesture, clip alignment targets to a neighbourhood of each
   * canonical placement. Repeated refinements then cannot walk across the canvas. */
  restPositions?: Readonly<Record<string, Point>>;
  /** Optional current parent content bounds: view refinement may not grow a
   * shared/fixed ancestor into unrelated neighbouring objects. */
  bounds?: { width: number; height: number };
  score: (positions: Record<string, Placement>) => number;
}

/** Translate siblings using the actual connection sites inside their frames.
 * Internal placements are immutable. Only direct affected neighbours compete,
 * and every candidate clears all same-directory objects before being scored. */
export function refineEndpointPlacements(input: EndpointRefinementInput) {
  let positions = input.positions, value = input.score(positions), trials = 0;
  const incidents = new Map(input.movable.map(id => [id, [] as Array<{ other: string; local: Point; remote: Point; weight: number }>]));
  for (const relation of input.relations) for (const segment of input.endpoints.segments.get(relation) ?? []) {
    incidents.get(relation.source)?.push({ other: relation.target, local: segment.source, remote: segment.target, weight: segment.weight });
    incidents.get(relation.target)?.push({ other: relation.source, local: segment.target, remote: segment.source, weight: segment.weight });
  }
  // More connected objects first stabilises shared hubs. ID is a deterministic tie-breaker.
  const order = input.movable.slice().sort((a, b) => incidents.get(b)!.length - incidents.get(a)!.length || a.localeCompare(b));
  for (let pass = 0; pass < 2; pass++) for (const id of order) {
    if (performance.now() >= input.deadline) return { positions, trials };
    const links = incidents.get(id)!; if (!links.length) continue;
    const current = positions[id], size = input.sizes.get(id)!;
    const rest = input.restPositions?.[id] ?? current;
    const occupied = new RectangleIndex(input.ids.filter(other => other !== id).map(other => ({ ...input.sizes.get(other)!, ...positions[other] })));
    const fits = (point: Point) => (!input.bounds || point.x + size.width <= input.bounds.width && point.y + size.height <= input.bounds.height)
      && !occupied.collides({ ...size, ...point }, BLOCK_GAP - .01);
    let weight = 0, x = 0, y = 0;
    for (const link of links) {
      weight += link.weight;
      x += (positions[link.other].x + link.remote.x - link.local.x) * link.weight;
      y += (positions[link.other].y + link.remote.y - link.local.y) * link.weight;
    }
    if (!weight) continue;
    const average = { x: x / weight, y: y / weight };
    const candidates: Point[] = [{ x: rest.x, y: average.y }, { x: average.x, y: rest.y }];
    for (const link of links.slice().sort((a, b) => b.weight - a.weight || a.other.localeCompare(b.other)).slice(0, 8)) {
      const other = positions[link.other], otherSize = input.sizes.get(link.other)!;
      const alignedX = other.x + link.remote.x - link.local.x, alignedY = other.y + link.remote.y - link.local.y;
      candidates.push({ x: other.x + otherSize.width + BLOCK_GAP, y: alignedY },
        { x: other.x - size.width - BLOCK_GAP, y: alignedY },
        { x: alignedX, y: other.y + otherSize.height + BLOCK_GAP },
        { x: alignedX, y: other.y - size.height - BLOCK_GAP });
      // Keep the current side, but align the true sites exactly; this often
      // removes a long diagonal without changing the reader's overall map.
      candidates.push({ x: rest.x, y: alignedY }, { x: alignedX, y: rest.y });
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (performance.now() >= input.deadline) return { positions, trials };
      const x = input.root ? candidate.x : Math.max(0, candidate.x);
      const y = input.root ? candidate.y : Math.max(0, candidate.y);
      let point = { x: Math.round(x), y: Math.round(y) };
      if (input.restPositions && input.maxMove) point = withinRadius(point, rest, input.maxMove);
      if (input.maxStep !== undefined) point = withinRadius(point, input.positions[id], input.maxStep);
      if (!fits(point)) {
        const start = input.positions[id];
        if (!input.restPositions || !fits(start)) continue;
        // A clipped target can land inside another card or past the parent
        // boundary. Try a legal partial move along the same alignment.
        let outside = point, inside: Point = start;
        for (let i = 0; i < 8 && Math.hypot(outside.x - inside.x, outside.y - inside.y) > 1; i++) {
          const mid = { x: (inside.x + outside.x) / 2, y: (inside.y + outside.y) / 2 };
          if (fits(mid)) inside = mid; else outside = mid;
        }
        point = inside;
      }
      const key = `${point.x}/${point.y}`; if (seen.has(key)) continue; seen.add(key);
      const limit = Math.min(input.maxMove ?? 1600, input.maxStep ?? Infinity);
      if (Math.hypot(point.x - input.positions[id].x, point.y - input.positions[id].y) > limit) continue;
      const proposed = { ...positions, [id]: { ...current, ...point } }; trials++;
      const score = input.score(proposed);
      const minimumGain = Math.min(.2, Math.max(.05, limit / 1000));
      if (score < value - minimumGain) { positions = proposed; value = score; }
    }
  }
  return { positions, trials };
}

function withinRadius(point: Point, origin: Point, radius: number): Point {
  const dx = point.x - origin.x, dy = point.y - origin.y, distance = Math.hypot(dx, dy);
  if (distance <= radius) return point;
  return { x: origin.x + Math.trunc(dx * radius / distance), y: origin.y + Math.trunc(dy * radius / distance) };
}
