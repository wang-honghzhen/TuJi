import { RectangleIndex } from './rectangleIndex';
import type { ProjectedRelation } from './relationProjection';
import type { Point, Rect } from './types';
import type { EndpointGeometry } from './relationEndpointGeometry';

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}
function hits(a: Point, b: Point, r: Rect): boolean {
  let low = 0, high = 1;
  for (const [origin, delta, min, max] of [[a.x, b.x - a.x, r.x, r.x + r.width], [a.y, b.y - a.y, r.y, r.y + r.height]]) {
    if (!delta) { if (origin <= min || origin >= max) return false; continue; }
    const x = (min - origin) / delta, y = (max - origin) / delta;
    low = Math.max(low, Math.min(x, y)); high = Math.min(high, Math.max(x, y));
    if (high <= low) return false;
  }
  return true;
}

/** Geometric proxy used to compare complete candidates. Every relation is
 * counted; spatial bounds avoid quadratic work for separated short edges. */
export function measureArrangement(ids: readonly string[], sizes: ReadonlyMap<string, Rect>,
  positions: Readonly<Record<string, Point>>, relations: readonly ProjectedRelation[], endpoints?: EndpointGeometry) {
  const rectangles = ids.map(id => ({ ...sizes.get(id)!, ...positions[id] }));
  const obstacles = new RectangleIndex(rectangles);
  const owners = new Map(rectangles.map((rect, index) => [rect, { owner: ids[index], id: ids[index], inner: false }]));
  for (const inner of endpoints?.obstacles ?? []) {
    const rect = { ...inner.rect, x: inner.rect.x + positions[inner.owner].x, y: inner.rect.y + positions[inner.owner].y };
    obstacles.add(rect); owners.set(rect, { owner: inner.owner, id: inner.id, inner: true });
  }
  const centre = (id: string): Point => ({ x: positions[id].x + sizes.get(id)!.width / 2,
    y: positions[id].y + sizes.get(id)!.height / 2 });
  const lines = relations.flatMap(relation => {
    const segments = endpoints?.segments.get(relation) ?? [{ source: undefined, target: undefined,
      sourceId: relation.source, targetId: relation.target, weight: relation.weight }];
    return segments.map(segment => {
    const a = segment.source ? { x: positions[relation.source].x + segment.source.x, y: positions[relation.source].y + segment.source.y } : centre(relation.source);
    const b = segment.target ? { x: positions[relation.target].x + segment.target.x, y: positions[relation.target].y + segment.target.y } : centre(relation.target);
    const length = Math.hypot(b.x - a.x, b.y - a.y), ux = length ? (b.x - a.x) / length : 0, uy = length ? (b.y - a.y) / length : 0;
    return { relation, a, b, sourceId: segment.sourceId, targetId: segment.targetId, weight: segment.weight, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.max(1e-5, Math.abs(b.x - a.x)), height: Math.max(1e-5, Math.abs(b.y - a.y)), length, ux, uy };
    });
  }).sort((a, b) => a.x - b.x);
  let crossings = 0, obstruction = 0, length = 0, congestion = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], edge = line.relation;
    length += line.length * line.weight;
    for (const rect of obstacles.query(line)) {
      const owner = owners.get(rect)!;
      const containerEndpoint = owner.owner === edge.source && line.sourceId === edge.source || owner.owner === edge.target && line.targetId === edge.target;
      const terminal = owner.inner ? containerEndpoint || owner.id === line.sourceId || owner.id === line.targetId : owner.owner === edge.source || owner.owner === edge.target;
      if (!terminal && hits(line.a, line.b, rect)) obstruction += line.weight;
    }
    for (let j = i + 1; j < lines.length && lines[j].x < line.x + line.width; j++) {
      const other = lines[j];
      if (other.y >= line.y + line.height || other.y + other.height <= line.y) continue;
      const shared = line.sourceId === other.sourceId || line.sourceId === other.targetId || line.targetId === other.sourceId || line.targetId === other.targetId;
      // Collinear edges can report zero crossings while hiding one another.
      // Discount the short common attachment stub, then penalise shared runway.
      if (line.length > 1 && Math.abs(line.ux * other.uy - line.uy * other.ux) < .01) {
        const ox = other.a.x - line.a.x, oy = other.a.y - line.a.y;
        if (Math.abs(line.ux * oy - line.uy * ox) < 8) {
          const c = ox * line.ux + oy * line.uy;
          const d = (other.b.x - line.a.x) * line.ux + (other.b.y - line.a.y) * line.uy;
          const overlap = Math.min(line.length, Math.max(c, d)) - Math.max(0, Math.min(c, d));
          congestion += Math.max(0, overlap - (shared ? 100 : 24)) / 180;
        }
      }
      if (shared) continue;
      if (crosses(line.a, line.b, other.a, other.b)) crossings++;
    }
  }
  const left = Math.min(...rectangles.map(r => r.x)), top = Math.min(...rectangles.map(r => r.y));
  const right = Math.max(...rectangles.map(r => r.x + r.width)), bottom = Math.max(...rectangles.map(r => r.y + r.height));
  const area = Math.max(0, (right - left) * (bottom - top));
  return { crossings, area, congestion, score: crossings * 12 + congestion * 6 + obstruction * 20 + length / 180 + area / 32400 * .015 };
}
