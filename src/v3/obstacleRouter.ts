import { makeEdgeRoute, makePolylineRoute, makeWaypointRoute, sideVector, type EdgeRoute } from './edgeGeometry';
import { RectangleIndex } from './rectangleIndex';
import type { ConnectionSide, EdgeRouteStyle, Point, Rect } from './types';
import { clearSegment, routeIsClear } from './routeValidation';

export interface RoutingHints { previous?: EdgeRoute; nearby?: EdgeRoute[] }
const SEARCH_LIMIT = 2500;

/** Corner rounding per style: a curve detour is drawn with the widest arc that
 *  still clears the obstacles, an orthogonal route keeps its small elbow radius. */
const CORNER_RADIUS: Record<EdgeRouteStyle, number[]> = { curve: [140, 96, 64, 40, 24, 12, 4], orthogonal: [8, 3, 0] };
/** A simple curve first, a local detour second, and bounded pathfinding last.
 * Every returned non-fallback route is checked after smoothing. Previous paths
 * and other edges never change the geometry through a visual score. */
export function routeAroundObstacles(source: Point, target: Point, sourceSide: ConnectionSide, targetSide: ConnectionSide,
  input: Rect[] | RectangleIndex, _budgetMs = 8, terminals: Rect[] = [], constraint?: Rect,
  _hints: RoutingHints = {}, style: EdgeRouteStyle = 'curve'): EdgeRoute {
  const index = input instanceof RectangleIndex ? input : new RectangleIndex(input);
  const a = sideVector(sourceSide), b = sideVector(targetSide);
  const curve = style === 'curve';
  const blocked = (p: Point, q: Point, terminal = true) => !clearSegment(p, q, index, terminal ? terminals : [], constraint);
  const fallback = (retryable = false) => ({ ...makeEdgeRoute(source, target, sourceSide, targetSide), fallback: true, retryable });
  const plain = makeEdgeRoute(source, target, sourceSide, targetSide);
  if (curve && routeIsClear(plain, index, terminals, constraint)) return plain;
  const stub = (lead: number) => ({
    start: { x: source.x + a.x * lead, y: source.y + a.y * lead },
    end: { x: target.x + b.x * lead, y: target.y + b.y * lead },
  });
  // The short stub is the feasibility anchor: no route may need a longer free
  // corridor than the port itself guarantees. A curved detour prefers the longer
  // exit only when that whole stub is free, so its first round corner has room.
  const short = stub(18);
  if (blocked(source, short.start, false) || blocked(short.end, target, false)) return fallback();
  const extended = curve ? stub(36) : short;
  const { start, end } = !blocked(source, extended.start, false) && !blocked(extended.end, target, false) ? extended : short;
  const rounded = (points: Point[]) => {
    for (const radius of CORNER_RADIUS[style]) {
      const route = makePolylineRoute(points, radius);
      if (routeIsClear(route, index, terminals, constraint)) return route;
    }
  };
  const dx = target.x - source.x, dy = target.y - source.y, distance = Math.hypot(dx, dy) || 1;
  if ((dx * a.x + dy * a.y) / distance > .999 && (-dx * b.x - dy * b.y) / distance > .999) {
    const straight = rounded([source, target]); if (straight) return straight;
  }
  // A symmetric bulge peaks at the chord midpoint, which misses an off-centre
  // blocker. Aim the peak at the blockers themselves, on both sides.
  if (curve) {
    const chordBox: Rect = { x: Math.min(source.x, target.x) - 80, y: Math.min(source.y, target.y) - 240,
      width: Math.abs(target.x - source.x) + 160, height: Math.abs(target.y - source.y) + 480 };
    const blockers = index.query(chordBox).filter(rect => !routeIsClear(plain, [rect]))
      .sort((a, b) => a.x - b.x || a.y - b.y).slice(0, 8);
    const nx = -dy / distance, ny = dx / distance;
    for (const blocker of blockers) {
      const cx = blocker.x + blocker.width / 2, cy = blocker.y + blocker.height / 2;
      const along = ((cx - source.x) * dx + (cy - source.y) * dy) / (distance * distance);
      const base = { x: source.x + dx * Math.max(0, Math.min(1, along)), y: source.y + dy * Math.max(0, Math.min(1, along)) };
      const side = (cx - base.x) * nx + (cy - base.y) * ny;
      const halfWidth = Math.abs(nx) * blocker.width / 2 + Math.abs(ny) * blocker.height / 2;
      const offsets = [side - halfWidth - 40, side + halfWidth + 40].sort((a, b) => Math.abs(a) - Math.abs(b));
      for (const scale of [1, 1.6, 2.4, 3.2]) for (const offset of offsets) {
        const lead = Math.max(18, Math.min(32, distance * 0.12));
        const aimed = makeWaypointRoute(source, target, sourceSide, targetSide,
          { x: base.x + nx * offset * scale, y: base.y + ny * offset * scale },
          { lead, bend: lead });
        if (routeIsClear(aimed, index, terminals, constraint)) return aimed;
      }
    }
  }
  if (!blocked(start, end)) {
    const route = rounded([source, start, end, target]); if (route) return route;
  }
  for (const middle of [{ x: end.x, y: start.y }, { x: start.x, y: end.y }]) {
    if (!blocked(start, middle) && !blocked(middle, end)) { const route = rounded([source, start, middle, end, target]); if (route) return route; }
  }
  // Deterministic last resort: fixed candidate lines, a fixed iteration cap and
  // no clock. The same geometry must give the same path on first draw and after
  // a reload — a time budget here is exactly what made routes unreproducible and
  // forced the retry flags, the deferred states and the preview deformations.
  const corridor: Rect = { x: Math.min(start.x, end.x) - 400, y: Math.min(start.y, end.y) - 400,
    width: Math.abs(end.x - start.x) + 800, height: Math.abs(end.y - start.y) + 800 };
  const nearby = [...index.query(corridor), ...terminals].sort((p, q) => Math.hypot(p.x - start.x, p.y - start.y) - Math.hypot(q.x - start.x, q.y - start.y)).slice(0, 32);
  // A curved detour needs room for its round corner: the same clearance that is
  // enough for an 8px elbow clips a 100px arc, so curve routes keep their corridor wider.
  const margin = curve ? 40 : 14;
  // A container constraint rejects any point outside it, so the search grid must
  // offer lines inside the container instead of only lines around the obstacles.
  const insideX = constraint ? [constraint.x + 2, constraint.x + constraint.width - 2] : [];
  const insideY = constraint ? [constraint.y + 2, constraint.y + constraint.height - 2] : [];
  const clampX = (value: number) => constraint ? Math.max(constraint.x + 2, Math.min(constraint.x + constraint.width - 2, value)) : value;
  const clampY = (value: number) => constraint ? Math.max(constraint.y + 2, Math.min(constraint.y + constraint.height - 2, value)) : value;
  const xs = [...new Set([start.x, end.x, ...nearby.flatMap(r => [r.x - margin, r.x + r.width + margin]), ...insideX].map(clampX))].sort((p, q) => p - q);
  const ys = [...new Set([start.y, end.y, ...nearby.flatMap(r => [r.y - margin, r.y + r.height + margin]), ...insideY].map(clampY))].sort((p, q) => p - q);
  const width = xs.length, toId = (x: number, y: number) => y * width + x;
  const startId = toId(xs.indexOf(start.x), ys.indexOf(start.y)), endId = toId(xs.indexOf(end.x), ys.indexOf(end.y));
  const point = (id: number) => ({ x: xs[id % width], y: ys[Math.floor(id / width)] });
  const cost = new Map<number, number>([[startId, 0]]), previous = new Map<number, number>();
  const open = new Map<number, number>([[startId, Math.abs(start.x - end.x) + Math.abs(start.y - end.y)]]);
  let finish: number | undefined, iterations = 0;
  while (open.size && iterations++ < SEARCH_LIMIT) {
    let key = -1, priority = Infinity;
    for (const [candidate, value] of open) if (value < priority) { priority = value; key = candidate; }
    open.delete(key); const id = key;
    if (id === endId) { finish = key; break; }
    const x = id % width, y = Math.floor(id / width), p = point(id);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const nextId = toId(nx, ny), q = point(nextId); if (blocked(p, q)) continue;
      const nextKey = nextId;
      const value = cost.get(key)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (value >= (cost.get(nextKey) ?? Infinity)) continue;
      cost.set(nextKey, value); previous.set(nextKey, key);
      open.set(nextKey, value + Math.abs(q.x - end.x) + Math.abs(q.y - end.y));
    }
  }
  if (finish === undefined) return fallback();
  const points: Point[] = []; let key: number | undefined = finish;
  while (key !== undefined) { points.push(point(key)); key = previous.get(key); }
  points.reverse();
  const simple = points.filter((p, i) => !i || i === points.length - 1 ||
    (points[i - 1].x !== p.x || points[i + 1].x !== p.x) && (points[i - 1].y !== p.y || points[i + 1].y !== p.y));
  const shortcut: Point[] = [simple[0]];
  for (let i = 0; i < simple.length - 1;) {
    let next = i + 1;
    for (let j = simple.length - 1; j > i + 1; j--) if (!blocked(simple[i], simple[j])) { next = j; break; }
    shortcut.push(simple[next]); i = next;
  }
  return rounded([source, ...shortcut, target]) ?? rounded([source, ...simple, target]) ?? fallback();
}
