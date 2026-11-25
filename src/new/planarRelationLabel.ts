import type { Cubic } from '@/v3/edgeGeometry';
import type { Point, Rect } from '@/v3/types';

type Axis = 'x' | 'y';

export function relationLabelBounds(point: Point & { angle: number }, width: number, height: number): Rect {
  const radians = point.angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const w = width * cos + height * sin, h = width * sin + height * cos;
  return { x: point.x - w / 2, y: point.y - h / 2, width: w, height: h };
}

function coordinate(curve: Cubic, axis: Axis, t: number) {
  const u = 1 - t;
  return u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
    + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis];
}

// On each monotone interval, a rectangle boundary has at most one crossing.
// This also catches a short visible arc between two offscreen endpoints.
function extrema(curve: Cubic, axis: Axis) {
  const d0 = curve[1][axis] - curve[0][axis], d1 = curve[2][axis] - curve[1][axis], d2 = curve[3][axis] - curve[2][axis];
  const a = d0 - 2 * d1 + d2, b = 2 * (d1 - d0);
  const disc = b * b - 4 * a * d0;
  const roots = Math.abs(a) < 1e-10 ? (b ? [-d0 / b] : []) : disc > 0
    ? [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)] : [];
  return [0, ...roots.filter(t => t > 0 && t < 1).sort((x, y) => x - y), 1];
}

function crossings(curve: Cubic, axis: Axis, knots: number[], boundary: number, cuts: number[]) {
  for (let i = 1; i < knots.length; i++) {
    let lo = knots[i - 1], hi = knots[i];
    const start = coordinate(curve, axis, lo), end = coordinate(curve, axis, hi);
    if (boundary === start) cuts.push(lo);
    if (boundary === end) cuts.push(hi);
    if (boundary <= Math.min(start, end) || boundary >= Math.max(start, end)) continue;
    for (let n = 0; n < 32; n++) {
      const mid = (lo + hi) / 2;
      if ((coordinate(curve, axis, mid) < boundary) === (start < end)) lo = mid;
      else hi = mid;
    }
    cuts.push((hi + lo) / 2);
  }
}

function anchor(curve: Cubic, t: number) {
  return { x: coordinate(curve, 'x', t), y: coordinate(curve, 'y', t) };
}
function pad(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy };
}
function inside(p: Point, r: Rect) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}
const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x
  && a.y <= b.y + b.height && a.y + a.height >= b.y;

export function prepareRelationCurve(curve: Cubic) {
  const xs = curve.map(p => p.x), ys = curve.map(p => p.y);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  return { curve, bounds, x: extrema(curve, 'x'), y: extrema(curve, 'y'), middle: anchor(curve, .5) };
}
type PreparedCurve = ReturnType<typeof prepareRelationCurve>;

function visibleParameter(path: PreparedCurve, area: Rect, masks: readonly Rect[]): number | undefined {
  if (area.width <= 0 || area.height <= 0 || !intersects(path.bounds, area)) return;
  const blockers = masks.filter(r => intersects(path.bounds, r));
  const visible = (p: Point) => inside(p, area) && !blockers.some(r => inside(p, r));
  if (visible(path.middle)) return .5;
  const cuts = [0, 1];
  for (const r of [area, ...blockers]) {
    crossings(path.curve, 'x', path.x, r.x, cuts);
    crossings(path.curve, 'x', path.x, r.x + r.width, cuts);
    crossings(path.curve, 'y', path.y, r.y, cuts);
    crossings(path.curve, 'y', path.y, r.y + r.height, cuts);
  }
  cuts.sort((a, b) => a - b);
  let start: number | undefined, best = 0, result: number | undefined;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1], b = cuts[i];
    if (b <= a) continue;
    if (!visible(anchor(path.curve, (a + b) / 2))) { start = undefined; continue; }
    start ??= a;
    if (b - start > best) { best = b - start; result = (b + start) / 2; }
  }
  return result;
}

// An edge can graze the viewport with too little room for centered text.
// The nearest feasible center lies on a boundary of the inset view or a mask.
export function fitLabel(point: Point, area: Rect, masks: Rect[]) {
  if (area.width < 0 || area.height < 0) return point;
  const xs = [Math.max(area.x, Math.min(area.x + area.width, point.x))];
  const ys = [Math.max(area.y, Math.min(area.y + area.height, point.y))];
  for (const r of masks) { xs.push(r.x, r.x + r.width); ys.push(r.y, r.y + r.height); }
  xs.sort((a, b) => Math.abs(a - point.x) - Math.abs(b - point.x));
  ys.sort((a, b) => Math.abs(a - point.y) - Math.abs(b - point.y));
  let best = point, distance = Infinity;
  for (const x of xs) {
    const dx2 = (x - point.x) ** 2;
    if (dx2 >= distance) break;
    if (x < area.x || x > area.x + area.width) continue;
    const crossing = masks.filter(r => x > r.x && x < r.x + r.width);
    for (const y of ys) {
      const d = dx2 + (y - point.y) ** 2;
      if (d >= distance) break;
      if (y < area.y || y > area.y + area.height || crossing.some(r => y > r.y && y < r.y + r.height)) continue;
      best = { x, y }; distance = d;
      break;
    }
  }
  return best;
}

export function relationLabel(path: PreparedCurve, area: Rect, masks: readonly Rect[], width: number, height: number) {
  const radius = Math.hypot(width, height) / 2;
  const safeT = visibleParameter(path, pad(area, -radius), masks.map(r => pad(r, radius)));
  const t = safeT ?? visibleParameter(path, area, masks);
  if (t === undefined) return;
  const u = 1 - t, c = path.curve;
  const tangent = (k: Axis) => u * u * (c[1][k] - c[0][k]) + 2 * u * t * (c[2][k] - c[1][k]) + t * t * (c[3][k] - c[2][k]);
  const radians = Math.atan2(tangent('y'), tangent('x'));
  const angle = ((radians * 180 / Math.PI + 270) % 180) - 90;
  let point = anchor(c, t);
  if (safeT === undefined) {
    const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
    const dx = (width * cos + height * sin) / 2, dy = (height * cos + width * sin) / 2;
    point = fitLabel(point, pad(area, -dx, -dy), masks.map(r => pad(r, dx, dy)));
  }
  return { ...point, angle };
}
