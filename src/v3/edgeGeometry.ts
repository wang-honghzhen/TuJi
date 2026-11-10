import type { ConnectionSide, Point, Rect } from './types';
import { RectangleIndex } from './rectangleIndex';
import { routeIsClear } from './routeValidation';

export const CONNECTION_SIDES: ConnectionSide[] = ['top', 'right', 'bottom', 'left'];
const vectors: Record<ConnectionSide, Point> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};
export function sideVector(side: ConnectionSide): Point { return vectors[side]; }
export function portPoint(rect: Rect, side: ConnectionSide, at?: number): Point {
  switch (side) {
    case 'top': return { x: at ?? rect.x + rect.width / 2, y: rect.y };
    case 'right': return { x: rect.x + rect.width, y: at ?? rect.y + rect.height / 2 };
    case 'bottom': return { x: at ?? rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left': return { x: rect.x, y: at ?? rect.y + rect.height / 2 };
  }
}
export function facingSide(rect: Rect, toward: Point): ConnectionSide {
  const dx = toward.x - rect.x - rect.width / 2;
  const dy = toward.y - rect.y - rect.height / 2;
  return Math.abs(dx / rect.width) > Math.abs(dy / rect.height)
    ? dx >= 0 ? 'right' : 'left'
    : dy >= 0 ? 'bottom' : 'top';
}
/** Where a relation leaves a rect when it aims at `toward`: the border point on
 *  the line between the two centres. Continuous, so there is no side to score
 *  and no tie to break — the pair the eye would draw is the only answer. */
export function attachmentPoint(rect: Rect, toward: Point, perpendicular = false): { side: ConnectionSide; at: number } {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { side: 'right', at: cy };
  const tx = dx ? rect.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy ? rect.height / 2 / Math.abs(dy) : Infinity;
  // The smaller ratio is the first border the ray meets; the other one is the
  // fallback used when a neighbour sits on the direct line.
  const vertical = (tx <= ty) !== perpendicular;
  if (vertical) return { side: dx >= 0 ? 'right' : 'left', at: cy + dy * (Number.isFinite(tx) ? tx : 0) };
  return { side: dy >= 0 ? 'bottom' : 'top', at: cx + dx * (Number.isFinite(ty) ? ty : 0) };
}

/** Keep a floating attachment away from corners, without centring it again. */
export function sideAttachment(rect: Rect, side: ConnectionSide, at: number): Point {
  const horizontal = side === 'top' || side === 'bottom';
  const start = horizontal ? rect.x : rect.y, length = horizontal ? rect.width : rect.height;
  const margin = Math.min(8, length / 2);
  return portPoint(rect, side, Math.max(start + margin, Math.min(start + length - margin, at)));
}

export function choosePorts(source: Rect, target: Rect, obstacles: readonly Rect[] = []) {
  const sourceCentre = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCentre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const a = attachmentPoint(source, targetCentre), b = attachmentPoint(target, sourceCentre);
  const pair = (sourceSide: ConnectionSide, targetSide: ConnectionSide, sourceAt?: number, targetAt?: number) => ({
    sourceSide, targetSide,
    source: sideAttachment(source, sourceSide, sourceAt ?? (sourceSide === 'top' || sourceSide === 'bottom' ? targetCentre.x : targetCentre.y)),
    target: sideAttachment(target, targetSide, targetAt ?? (targetSide === 'top' || targetSide === 'bottom' ? sourceCentre.x : sourceCentre.y)),
  });
  const direct = pair(a.side, b.side, a.at, b.at);
  if (!obstacles.length) return direct;
  const clear = (candidate: ReturnType<typeof pair>) => {
    const route = makeEdgeRoute(candidate.source, candidate.target, candidate.sourceSide, candidate.targetSide), box = routeBounds(route);
    // Most edges have no obstacle near their curve. Avoid rebuilding a large
    // spatial index for every clear edge during a pointer move.
    const nearby = obstacles.filter(rect => rect.x <= box.x + box.width + 5 && rect.x + rect.width >= box.x - 5 &&
      rect.y <= box.y + box.height + 5 && rect.y + rect.height >= box.y - 5);
    return routeIsClear(route, nearby, [source, target]);
  };
  if (clear(direct)) return direct;

  // First slide on the facing sides, using the actual obstacle boundaries.
  // The first feasible simple curve wins; there is no weighted visual score.
  const horizontal = a.side === 'top' || a.side === 'bottom';
  for (const rect of obstacles) for (const at of horizontal ? [rect.x - 14, rect.x + rect.width + 14] : [rect.y - 14, rect.y + rect.height + 14]) {
    const shifted = pair(a.side, b.side, at, at);
    if (clear(shifted)) return shifted;
  }
  const alternateA = attachmentPoint(source, targetCentre, true).side;
  const alternateB = attachmentPoint(target, sourceCentre, true).side;
  const candidates = [pair(alternateA, alternateB), pair(a.side, alternateB), pair(alternateA, b.side)];
  // Aligned nodes may bypass a blocker on either common side.
  if (Math.abs(sourceCentre.y - targetCentre.y) < 1e-6) candidates.push(pair('top', 'top'), pair('bottom', 'bottom'));
  if (Math.abs(sourceCentre.x - targetCentre.x) < 1e-6) candidates.push(pair('left', 'left'), pair('right', 'right'));
  for (const candidate of candidates) if (clear(candidate)) return candidate;
  const index = new RectangleIndex([...obstacles]);
  const exitsClear = (candidate: ReturnType<typeof pair>) => {
    const a = sideVector(candidate.sourceSide), b = sideVector(candidate.targetSide);
    return routeIsClear(makePolylineRoute([candidate.source, { x: candidate.source.x + a.x * 18, y: candidate.source.y + a.y * 18 }], 0), index) &&
      routeIsClear(makePolylineRoute([candidate.target, { x: candidate.target.x + b.x * 18, y: candidate.target.y + b.y * 18 }], 0), index);
  };
  return [direct, ...candidates].find(exitsClear) ?? direct;
}

export type Cubic = [Point, Point, Point, Point];
export interface EdgeRoute { path: string; middle: Point; segments: Cubic[]; fallback?: boolean; retryable?: boolean;
  /** Endpoint following is displayed immediately and certified by the bounded router. */
  provisional?: boolean;
  gateways?: Array<{ regionId: string; point: Point; side: ConnectionSide }> }
function cubicPoint(curve: Cubic, t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = curve;
  return { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y };
}
const routeSamples = new WeakMap<EdgeRoute, Array<{ point: Point; length: number }>>();
function samples(route: EdgeRoute) {
  let result = routeSamples.get(route); if (result) return result;
  result = [{ point: route.segments[0][0], length: 0 }];
  for (const segment of route.segments) for (let i = 1; i <= 12; i++) {
    const point = cubicPoint(segment, i / 12), old = result[result.length - 1];
    result.push({ point, length: old.length + Math.hypot(point.x - old.point.x, point.y - old.point.y) });
  }
  routeSamples.set(route, result); return result;
}
export function pointOnRoute(route: EdgeRoute, t: number): Point {
  const points = samples(route), length = points[points.length - 1].length * Math.max(0, Math.min(1, t));
  let low = 1, high = points.length - 1;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].length < length) low = mid + 1; else high = mid; }
  const a = points[low - 1], b = points[low], fraction = (length - a.length) / (b.length - a.length || 1);
  return { x: a.point.x + (b.point.x - a.point.x) * fraction, y: a.point.y + (b.point.y - a.point.y) * fraction };
}
export function routeBounds(route: EdgeRoute): Rect {
  const points = route.segments.flat();
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}
export function translateRoute(route: EdgeRoute, delta: Point): EdgeRoute {
  const segments = route.segments.map(segment => segment.map(p => ({ x: p.x + delta.x, y: p.y + delta.y })) as Cubic);
  const start = segments[0][0];
  const path = `M ${start.x} ${start.y}` + segments.map(s => ` C ${s[1].x} ${s[1].y} ${s[2].x} ${s[2].y} ${s[3].x} ${s[3].y}`).join('');
  return { ...route, path, segments, middle: { x: route.middle.x + delta.x, y: route.middle.y + delta.y },
    gateways: route.gateways?.map(gate => ({ ...gate, point: { x: gate.point.x + delta.x, y: gate.point.y + delta.y } })) };
}
export function makePolylineRoute(input: Point[], cornerRadius = 8): EdgeRoute {
  const points = input.filter((p, i) => !i || p.x !== input[i - 1].x || p.y !== input[i - 1].y);
  if (points.length < 2) return makeStubRoute(input[0], input[0]);
  const segments: Cubic[] = []; let last = points[0]; let path = `M ${last.x} ${last.y}`;
  const line = (p: Point) => { segments.push([last, last, p, p]); path += ` L ${p.x} ${p.y}`; last = p; };
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], next = points[i + 1];
    const before = Math.hypot(p.x - last.x, p.y - last.y), after = Math.hypot(next.x - p.x, next.y - p.y);
    if (!before || !after) continue;
    const radius = Math.min(cornerRadius, before / 3, after / 3);
    if (!radius) { line(p); continue; }
    const a = { x: p.x + (last.x - p.x) * radius / before, y: p.y + (last.y - p.y) * radius / before };
    const b = { x: p.x + (next.x - p.x) * radius / after, y: p.y + (next.y - p.y) * radius / after };
    line(a);
    const c1 = { x: a.x + (p.x - a.x) * 2 / 3, y: a.y + (p.y - a.y) * 2 / 3 };
    const c2 = { x: b.x + (p.x - b.x) * 2 / 3, y: b.y + (p.y - b.y) * 2 / 3 };
    segments.push([a, c1, c2, b]); path += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`; last = b;
  }
  line(points[points.length - 1]);
  const route: EdgeRoute = { path, middle: points[0], segments }; route.middle = pointOnRoute(route, .5); return route;
}
/** Handle length from a port to its control point. Facing ports get the classic
 *  third of the gap; a port whose normal points away from the target gets a
 *  shorter handle, so the curve turns just outside the node instead of looping
 *  back over it. */
function portReach(distance: number, facing: number): number {
  const tighten = facing >= 0 ? 1 : .55 + .45 * (1 + facing);
  return Math.max(22, Math.min(170, distance * .34 * tighten));
}

/** Two port-tangent cubics joined at a waypoint. The join tangent is the mean of
 *  the inbound and outbound chords, so both halves turn evenly and a waypoint on
 *  the chord reproduces the plain route. */
export function makeWaypointRoute(source: Point, target: Point, sourceSide: ConnectionSide, targetSide: ConnectionSide,
  middle: Point, tuning: { lead?: number; bend?: number } = {}): EdgeRoute {
  const a = vectors[sourceSide]; const b = vectors[targetSide];
  const inLength = Math.hypot(middle.x - source.x, middle.y - source.y) || 1;
  const outLength = Math.hypot(target.x - middle.x, target.y - middle.y) || 1;
  const inbound = { x: (middle.x - source.x) / inLength, y: (middle.y - source.y) / inLength };
  const outbound = { x: (target.x - middle.x) / outLength, y: (target.y - middle.y) / outLength };
  const sum = { x: inbound.x + outbound.x, y: inbound.y + outbound.y };
  const sumLength = Math.hypot(sum.x, sum.y);
  const join = sumLength > 1e-6 ? { x: sum.x / sumLength, y: sum.y / sumLength } : outbound;
  const reachIn = tuning.lead ?? Math.max(16, Math.min(140, inLength * .5));
  const reachOut = tuning.bend ?? Math.max(16, Math.min(140, outLength * .5));
  const first: Cubic = [source, { x: source.x + a.x * reachIn, y: source.y + a.y * reachIn },
    { x: middle.x - join.x * reachIn, y: middle.y - join.y * reachIn }, middle];
  const second: Cubic = [middle, { x: middle.x + join.x * reachOut, y: middle.y + join.y * reachOut },
    { x: target.x + b.x * reachOut, y: target.y + b.y * reachOut }, target];
  const path = `M ${source.x} ${source.y} C ${first[1].x} ${first[1].y} ${first[2].x} ${first[2].y} ${middle.x} ${middle.y} C ${second[1].x} ${second[1].y} ${second[2].x} ${second[2].y} ${target.x} ${target.y}`;
  const route: EdgeRoute = { path, middle, segments: [first, second] };
  route.middle = pointOnRoute(route, .5); return route;
}

/** One port-tangent cubic. The handles sit on the two port normals, so the curve
 *  leaves and enters perpendicular to the node border and inside the convex hull
 *  of its controls: it cannot overshoot the endpoints or double back, which is
 *  what the old midpoint construction did whenever a port faced away. */
export function makeEdgeRoute(source: Point, target: Point, sourceSide: ConnectionSide, targetSide: ConnectionSide,
  lane = 0, zoom = 1, canonicalForward = true): EdgeRoute {
  const dx = target.x - source.x; const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  const tangent = { x: dx / distance, y: dy / distance };
  const normal = { x: -tangent.y * (canonicalForward ? 1 : -1), y: tangent.x * (canonicalForward ? 1 : -1) };
  void zoom;
  const offset = lane * 64;
  const a = vectors[sourceSide]; const b = vectors[targetSide];
  const sourceReach = portReach(distance, a.x * tangent.x + a.y * tangent.y);
  const targetReach = portReach(distance, -(b.x * tangent.x + b.y * tangent.y));
  const first = { x: source.x + a.x * sourceReach + normal.x * offset, y: source.y + a.y * sourceReach + normal.y * offset };
  const second = { x: target.x + b.x * targetReach + normal.x * offset, y: target.y + b.y * targetReach + normal.y * offset };
  const curve: Cubic = [source, first, second, target];
  const path = `M ${source.x} ${source.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${target.x} ${target.y}`;
  const route: EdgeRoute = { path, middle: cubicPoint(curve, .5), segments: [curve] };
  return route;
}
export function makeStubRoute(source: Point, target: Point): EdgeRoute {
  const middle = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  return { path: `M ${source.x} ${source.y} L ${target.x} ${target.y}`, middle,
    segments: [[source, source, middle, middle], [middle, middle, target, target]] };
}

/** Distance from a point to the drawn line, in world units. Overlapping hit
 *  bands are resolved by this: the band you press is the line you aimed at, not
 *  whichever one happened to be painted last. Sampled finer than rendering,
 *  because a press that lands on the line must measure as touching it. */
export function distanceToRoute(route: EdgeRoute, point: Point): number {
  let best = Infinity;
  for (const curve of route.segments) {
    for (let step = 0; step <= 16; step += 1) {
      const sample = cubicPoint(curve, step / 16);
      const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
      if (distance < best) best = distance;
    }
  }
  return best;
}

export interface EdgeLabel { text: string; point: Point; anchor: Point; rect: Rect }

/** Air kept between a label and the line it labels. The previous offset was a
 *  fixed 12px above the anchor — one pixel off the box edge — so a short or
 *  sloped edge looked like a label sitting on its own line, and the label took
 *  the hit zone near both endpoints. */
export const LABEL_CLEARANCE = 6;

/** True when the label box keeps the required air from its own line. */
export function labelClearsRoute(route: EdgeRoute, rect: Rect, clearance = LABEL_CLEARANCE): boolean {
  for (const sample of samples(route)) {
    const point = sample.point;
    if (point.x > rect.x - clearance && point.x < rect.x + rect.width + clearance &&
      point.y > rect.y - clearance && point.y < rect.y + rect.height + clearance) return false;
  }
  return true;
}

/** Local direction of the line, used to lift a label along its normal instead
 *  of straight up: on a sloped edge a vertical offset walks into the line. */
function tangentOnRoute(route: EdgeRoute, t: number): Point {
  const delta = .01;
  const a = pointOnRoute(route, Math.max(0, t - delta)), b = pointOnRoute(route, Math.min(1, t + delta));
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

export function placeEdgeLabel(route: EdgeRoute, content: string, occupied: Rect[] | RectangleIndex, viewport?: Rect): EdgeLabel {
  const index = occupied instanceof RectangleIndex ? occupied : new RectangleIndex(occupied);
  const text = content.trim() || '关系';
  const lineWidths = text.split(/\r?\n/).map(line => [...line].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.5), 0));
  const width = Math.min(240, Math.max(64, lineWidths.reduce((max, length) => Math.max(max, length), 0) + 16));
  const rows = Math.min(3, lineWidths.reduce((sum, length) => sum + Math.max(1, Math.ceil(length / (width - 16))), 0));
  const height = rows * 22;
  const lift = height / 2 + LABEL_CLEARANCE;
  const place = (anchor: Point, point: Point): EdgeLabel => {
    const rect = { x: point.x - width / 2, y: point.y - height / 2, width, height };
    index.add(rect); if (Array.isArray(occupied)) occupied.push(rect);
    return { text, point, anchor, rect };
  };
  // Along the line's normal, further out in whole label heights on each ring:
  // the box must not sit on the line it describes, and a crowded area pushes it
  // further out instead of letting it cover its own relation.
  for (let ring = 0; ring < 6; ring += 1) {
    for (const t of [0.5, 0.32, 0.68, 0.2, 0.8]) {
      const anchor = pointOnRoute(route, t), tangent = tangentOnRoute(route, t);
      const normal = { x: -tangent.y, y: tangent.x };
      for (const sign of [-1, 1]) {
        const distance = lift + ring * 28;
        const point = { x: anchor.x + normal.x * distance * sign, y: anchor.y + normal.y * distance * sign };
        const rect = { x: point.x - width / 2, y: point.y - height / 2, width, height };
        if (viewport && (rect.x < viewport.x + 6 || rect.y < viewport.y + 6 || rect.x + width > viewport.x + viewport.width - 6
          || rect.y + height > viewport.y + viewport.height - 6)) continue;
        if (index.collides(rect, 5) || !labelClearsRoute(route, rect)) continue;
        return place(anchor, point);
      }
    }
  }
  // Bounded search failed: a readable label at the nearest offset beats none.
  const anchor = pointOnRoute(route, .5);
  return place(anchor, { x: anchor.x, y: anchor.y - lift });
}

export function nearestPort(blocks: Array<{ id: string; rect: Rect }>, point: Point, zoom: number, excludedId?: string) {
  let result: { id: string; side: ConnectionSide; point: Point; distance: number } | null = null;
  for (const block of blocks) {
    if (block.id === excludedId) continue;
    // Creation and reconnection share the one visible handle. Routed edge
    // attachments may use any side, but they are never extra drag targets.
    const port = portPoint(block.rect, 'top');
    const distance = Math.hypot(port.x - point.x, port.y - point.y) * zoom;
    if (distance <= 20 && (!result || distance < result.distance)) result = { id: block.id, side: 'top', point: port, distance };
  }
  return result;
}
