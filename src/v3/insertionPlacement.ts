import type { Point, Rect } from './types';
import { BLOCK_GAP } from './types';
import { RectangleIndex } from './rectangleIndex';
import { nearestRegionSpace } from './regionLayout';

/**
 * Deterministic insertion placement.
 *
 * A region (canvas directory or document) owns the positions of its own
 * children. When a child arrives without coordinates — the AI only knows its
 * path, never a point — the region places it beside the strongest relation
 * partner it already holds. Nothing outside the region is consulted, so an
 * insertion never reflows a different directory, and no existing child moves.
 */

export interface InsertionNeighbour {
  id: string;
  rect: Rect;
  /** The projected relation weight; repeated edges between one pair count more. */
  weight: number;
  /** A predecessor belongs upstream of this neighbour's incoming edge. */
  upstream?: boolean;
}

export interface InsertionSize {
  width: number;
  height: number;
}

/** The direction a region already reads in. A new child keeps that direction
 *  instead of always arriving on its partner's right. */
export type GrowthDirection = 'right' | 'down' | 'left' | 'up';

/** Primary and secondary axes per direction, clockwise (right→down→left→up).
 *  The secondary axis is the clockwise neighbour, which keeps the eight slots
 *  in the same spiral reading order the original right-first ring used. */
const AXES: Record<GrowthDirection, readonly [Point, Point]> = {
  right: [{ x: 1, y: 0 }, { x: 0, y: 1 }],
  down: [{ x: 0, y: 1 }, { x: -1, y: 0 }],
  left: [{ x: -1, y: 0 }, { x: 0, y: -1 }],
  up: [{ x: 0, y: -1 }, { x: 1, y: 0 }],
};
const opposite: Record<GrowthDirection, GrowthDirection> = { left: 'right', right: 'left', down: 'up', up: 'down' };

const grow = (rect: Rect, amount: number): Rect => ({
  x: rect.x - amount,
  y: rect.y - amount,
  width: rect.width + amount * 2,
  height: rect.height + amount * 2,
});

/** Slots around an anchor in a stable reading order: along the primary axis,
 *  then the secondary, then the opposite pair, then the four diagonals. A new
 *  child never lands on its anchor. `right` reproduces the original order. */
export function insertionSlots(
  anchor: Rect,
  size: InsertionSize,
  gap = BLOCK_GAP,
  direction: GrowthDirection = 'right',
): Point[] {
  const [primary, secondary] = AXES[direction];
  const step = (dx: number, dy: number): Point => ({
    x: dx > 0 ? anchor.x + anchor.width + gap : dx < 0 ? anchor.x - size.width - gap : anchor.x + (anchor.width - size.width) / 2,
    y: dy > 0 ? anchor.y + anchor.height + gap : dy < 0 ? anchor.y - size.height - gap : anchor.y + (anchor.height - size.height) / 2,
  });
  const axis = (a: Point, b: Point, sa: number, sb: number): [number, number] => [a.x * sa + b.x * sb, a.y * sa + b.y * sb];
  return [
    step(primary.x, primary.y),
    step(secondary.x, secondary.y),
    step(-primary.x, -primary.y),
    step(-secondary.x, -secondary.y),
    step(...axis(primary, secondary, 1, 1)),
    step(...axis(primary, secondary, -1, -1)),
    step(...axis(primary, secondary, 1, -1)),
    step(...axis(primary, secondary, -1, 1)),
  ];
}

export interface DirectionSample { source: Rect; target: Rect; weight: number }

/** Which way the region already grows, from settled relations first and from the
 *  content's own aspect only as a weaker fallback. Returns undefined when the
 *  region offers no evidence, so each caller can pick its own default. */
export function inferGrowthDirection(
  samples: readonly DirectionSample[],
  extent?: InsertionSize,
): GrowthDirection | undefined {
  let vx = 0, vy = 0, total = 0;
  for (const { source, target, weight } of samples) {
    const dx = target.x + target.width / 2 - source.x - source.width / 2;
    const dy = target.y + target.height / 2 - source.y - source.height / 2;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue; // coincident children carry no direction
    vx += (dx / length) * weight; vy += (dy / length) * weight; total += weight;
  }
  // A diagonal relation still has a dominant axis; a tie is not evidence.
  // Opposing flows cancel. Residual noise from a few short edges should not
  // pick the orientation of a whole previously organised region.
  if (Math.abs(vx) > total * .5 && Math.abs(vx) > Math.abs(vy) * 1.05) return vx > 0 ? 'right' : 'left';
  if (Math.abs(vy) > total * .5 && Math.abs(vy) > Math.abs(vx) * 1.05) return vy > 0 ? 'down' : 'up';
  if (extent && extent.height > extent.width * 1.15) return 'down';
  if (extent && extent.width > extent.height * 1.15) return 'right';
  return undefined;
}

/** Place the child relative to the strongest partner, on the appropriate side
 * of its edge. The root canvas permits negative coordinates. */
export function chooseInsertionPoint(
  size: InsertionSize,
  neighbours: readonly InsertionNeighbour[],
  occupied: RectangleIndex,
  origin: Point = { x: 0, y: 0 },
  gap = BLOCK_GAP,
  direction: GrowthDirection = 'right',
  root = false,
): Point {
  const free = (point: Point) => (root || point.x >= 0 && point.y >= 0) && !occupied.collides({ ...size, ...point }, gap);
  const ordered = [...neighbours].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const slots = (neighbour: InsertionNeighbour, ring: number) => insertionSlots(
    ring ? grow(neighbour.rect, ring * gap) : neighbour.rect, size, gap, neighbour.upstream ? opposite[direction] : direction);
  for (const neighbour of ordered) for (const point of slots(neighbour, 0)) if (free(point)) return point;
  // A dense neighbourhood expands outward in whole gaps, so the new child keeps
  // its partner's reading direction instead of drifting back to the origin.
  for (let ring = 1; ring <= 6; ring++) {
    for (const neighbour of ordered) {
      for (const point of slots(neighbour, ring)) if (free(point)) return point;
    }
  }
  // A fully occupied attachment area is common around a large subgraph.
  // Search from the intended attachment side, even when every ring is full.
  if (ordered.length && gap === BLOCK_GAP)
    return nearestRegionSpace({ ...size, x: 0, y: 0 }, slots(ordered[0], 0)[0], occupied, root);
  // No relation yet: a stable band anchored at the region origin.
  const stepX = size.width + gap;
  const stepY = size.height + gap;
  for (let row = 0; row < 32; row++) for (let col = 0; col < 16; col++) {
    const point = { x: origin.x + col * stepX, y: origin.y + row * stepY };
    if (free(point)) return point;
  }
  return { x: Math.max(0, origin.x, ...occupied.rects.map(rect => rect.x + rect.width + gap)), y: Math.max(0, origin.y) };
}
