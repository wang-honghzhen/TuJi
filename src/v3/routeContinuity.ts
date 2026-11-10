import type { RenderEdge } from './layout';
import { makeEdgeRoute, routeBounds } from './edgeGeometry';
import { RectangleIndex } from './rectangleIndex';
import type { Point, Rect } from './types';
import { createRoutingGeometry, type RoutingModel } from './edgeRoutingGeometry';
export type { RoutingModel } from './edgeRoutingGeometry';

/** Previews use the worker's endpoint allocation, obstacle policy and route
 * construction. Cached paths survive only while their geometry is unchanged. */
export function previewCachedRoutes(previous: RoutingModel, routes: RenderEdge[], model: RoutingModel,
  expandedEdgeIds: string[] = [], _preserveAggregation = true): RenderEdge[] {
  const geometry = createRoutingGeometry(model, expandedEdgeIds);
  const before = new Map(previous.blocks.map(b => [b.id, b])), changed: Rect[] = [];
  const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  for (const id of new Set([...before.keys(), ...geometry.blocks.keys()])) {
    const a = before.get(id), b = geometry.blocks.get(id);
    if (!a || !b || a.parentId !== b.parentId || a.collapsed !== b.collapsed || !same(a.rect, b.rect)) {
      if (a) changed.push(a.rect); if (b) changed.push(b.rect);
    }
  }
  const index = new RectangleIndex(changed), cache = new Map(routes.map(edge => [edge.edge.edgeId, edge]));
  return geometry.edges.map(edge => {
    const old = cache.get(edge.edge.edgeId);
    if (edge.kind !== 'full') return edge;
    const sameEnds = old && edge.sourceBlockId === old.sourceBlockId && edge.targetBlockId === old.targetBlockId &&
      edge.sourceSide === old.sourceSide && edge.targetSide === old.targetSide &&
      edge.source.x === old.source.x && edge.source.y === old.source.y && edge.target.x === old.target.x && edge.target.y === old.target.y;
    if (sameEnds && !old.route.fallback && !index.collides(routeBounds(old.route), 24))
      return { ...edge, route: old.route, label: old.label, routeSeed: old.routeSeed };
    if (!old) return { ...edge, route: makeEdgeRoute(edge.source, edge.target, edge.sourceSide, edge.targetSide), routeSeed: false };
    const route = geometry.route(edge);
    const delta = { x: route.middle.x - old.route.middle.x, y: route.middle.y - old.route.middle.y };
    const shift = (p: Point) => ({ x: p.x + delta.x, y: p.y + delta.y });
    return { ...edge, route: { ...route, provisional: true }, routeSeed: !route.fallback,
      label: old.label && { ...old.label, point: shift(old.label.point), anchor: shift(old.label.anchor), rect: { ...old.label.rect, ...shift(old.label.rect) } } };
  });
}
