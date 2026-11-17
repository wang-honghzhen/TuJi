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
    const occupied = new RectangleIndex(input.ids.filter(other => other !== id).map(other => ({ ...input.sizes.get(other)!, ...positions[other] })));
    let weight = 0, x = 0, y = 0;
    for (const link of links) {
      weight += link.weight;
      x += (positions[link.other].x + link.remote.x - link.local.x) * link.weight;
      y += (positions[link.other].y + link.remote.y - link.local.y) * link.weight;
    }
    if (!weight) continue;
    const average = { x: x / weight, y: y / weight };
    const candidates: Point[] = [{ x: current.x, y: average.y }, { x: average.x, y: current.y }];
    for (const link of links.slice().sort((a, b) => b.weight - a.weight || a.other.localeCompare(b.other)).slice(0, 8)) {
      const other = positions[link.other], otherSize = input.sizes.get(link.other)!;
      const alignedX = other.x + link.remote.x - link.local.x, alignedY = other.y + link.remote.y - link.local.y;
      candidates.push({ x: other.x + otherSize.width + BLOCK_GAP, y: alignedY },
        { x: other.x - size.width - BLOCK_GAP, y: alignedY },
        { x: alignedX, y: other.y + otherSize.height + BLOCK_GAP },
        { x: alignedX, y: other.y - size.height - BLOCK_GAP });
      // Keep the current side, but align the true sites exactly; this often
      // removes a long diagonal without changing the reader's overall map.
      candidates.push({ x: current.x, y: alignedY }, { x: alignedX, y: current.y });
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (performance.now() >= input.deadline) return { positions, trials };
      const point = { x: Math.round(input.root ? candidate.x : Math.max(0, candidate.x)),
        y: Math.round(input.root ? candidate.y : Math.max(0, candidate.y)) };
      const key = `${point.x}/${point.y}`; if (seen.has(key)) continue; seen.add(key);
      if (input.bounds && (point.x + size.width > input.bounds.width || point.y + size.height > input.bounds.height)) continue;
      if (Math.hypot(point.x - input.positions[id].x, point.y - input.positions[id].y) > (input.maxMove ?? 1600)) continue;
      if (occupied.collides({ ...size, ...point }, BLOCK_GAP - .01)) continue;
      const proposed = { ...positions, [id]: { ...current, ...point } }; trials++;
      const score = input.score(proposed);
      if (score < value - .2) { positions = proposed; value = score; }
    }
  }
  return { positions, trials };
}
