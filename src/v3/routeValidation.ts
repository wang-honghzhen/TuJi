import type { Cubic, EdgeRoute } from './edgeGeometry';
import { RectangleIndex } from './rectangleIndex';
import type { Point, Rect } from './types';

const bounds = (points: Point[]): Rect => {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
export function segmentEntersRect(a: Point, b: Point, r: Rect, gap = 0): boolean {
  let low = 0, high = 1;
  for (const [origin, delta, min, max] of [[a.x, b.x - a.x, r.x - gap, r.x + r.width + gap],
    [a.y, b.y - a.y, r.y - gap, r.y + r.height + gap]]) {
    if (Math.abs(delta) < 1e-10) { if (origin <= min || origin >= max) return false; continue; }
    const p = (min - origin) / delta, q = (max - origin) / delta;
    low = Math.max(low, Math.min(p, q)); high = Math.min(high, Math.max(p, q));
    if (high <= low) return false;
  }
  return high > low;
}
export function clearSegment(a: Point, b: Point, obstacles: RectangleIndex, terminals: Rect[] = [], constraint?: Rect): boolean {
  if (constraint && [a, b].some(p => p.x < constraint.x || p.y < constraint.y ||
    p.x > constraint.x + constraint.width || p.y > constraint.y + constraint.height)) return false;
  return !obstacles.query(bounds([a, b]), 5).some(r => segmentEntersRect(a, b, r, 5)) &&
    !terminals.some(r => segmentEntersRect(a, b, r, -.001));
}
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
const overlaps = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;

/** Certify the actual Bézier curves, not a few samples or the unsmoothed polyline.
 * Convex-hull subdivision is conservative: uncertainty or budget exhaustion is rejected. */
export function routeIsClear(route: Pick<EdgeRoute, 'segments'>, input: Rect[] | RectangleIndex, terminals: Rect[] = [], constraint?: Rect,
  deadline = Infinity): boolean {
  const index = input instanceof RectangleIndex ? input : new RectangleIndex(input);
  let remaining = 4096;
  const visit = (curve: Cubic, obstacles: Rect[], depth: number): boolean => {
    if (--remaining < 0 || performance.now() >= deadline) return false;
    const box = bounds(curve), candidates = obstacles.filter(r => overlaps(box, r));
    const inside = !constraint || curve.every(p => contains(constraint, p));
    if (!candidates.length && inside) return true;
    const [a, b, c, d] = curve;
    const length = Math.hypot(d.x - a.x, d.y - a.y);
    const lineDistance = (p: Point) => length ? Math.abs((d.x - a.x) * (p.y - a.y) - (d.y - a.y) * (p.x - a.x)) / length : Math.hypot(p.x - a.x, p.y - a.y);
    // Collinear control points must also lie on the chord: a curve can reverse beyond its endpoints.
    if (inside && [b, c].every(p => lineDistance(p) < 1e-7 && p.x >= Math.min(a.x, d.x) - 1e-7 &&
      p.x <= Math.max(a.x, d.x) + 1e-7 && p.y >= Math.min(a.y, d.y) - 1e-7 && p.y <= Math.max(a.y, d.y) + 1e-7))
      return !candidates.some(r => segmentEntersRect(a, d, r));
    if (depth >= 12) return false;
    const ab = middle(a, b), bc = middle(b, c), cd = middle(c, d), abc = middle(ab, bc), bcd = middle(bc, cd), mid = middle(abc, bcd);
    return visit([a, ab, abc, mid], candidates, depth + 1) && visit([mid, bcd, cd, d], candidates, depth + 1);
  };
  for (const curve of route.segments) {
    const obstacles = index.query(bounds(curve), 5).map(r => ({ x: r.x - 5, y: r.y - 5, width: r.width + 10, height: r.height + 10 }));
    // Endpoint contact is legal; the interior of either terminal is not.
    obstacles.push(...terminals.map(r => ({ x: r.x + .001, y: r.y + .001, width: Math.max(0, r.width - .002), height: Math.max(0, r.height - .002) })));
    if (!visit(curve, obstacles, 0)) return false;
  }
  return route.segments.length > 0;
}
