import type { RenderEdge } from './layout';
import { makeUnobstructedRoute, routeBounds } from './edgeGeometry';
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
    if (!a || !b || a.parentId !== b.parentId || a.collapsed !== b.collapsed || a.headerHeight !== b.headerHeight || !same(a.rect, b.rect)) {
      if (a) changed.push(a.rect); if (b) changed.push(b.rect);
    }
  }
  const index = new RectangleIndex(changed), cache = new Map(routes.map(edge => [edge.edge.edgeId, edge]));
  return geometry.edges.map(edge => {
    const old = cache.get(edge.edge.edgeId);
    const label = old?.scope === edge.scope && old.kind === edge.kind && old.edge.edgeContent === edge.edge.edgeContent &&
      old.aggregateEdgeIds?.length === edge.aggregateEdgeIds?.length ? old.label : undefined;
    if (edge.kind !== 'full') return old?.scope === edge.scope && old.kind === edge.kind && old.route.path === edge.route.path ? { ...edge, label } : edge;
    const sameEnds = old && edge.scope === old.scope && edge.kind === old.kind && edge.sourceBlockId === old.sourceBlockId && edge.targetBlockId === old.targetBlockId &&
      edge.sourceSide === old.sourceSide && edge.targetSide === old.targetSide &&
      edge.source.x === old.source.x && edge.source.y === old.source.y && edge.target.x === old.target.x && edge.target.y === old.target.y;
    if (sameEnds && edge.edge.routeStyle === old.edge.routeStyle && !old.route.fallback && !index.collides(routeBounds(old.route), 24))
      return { ...edge, route: old.route, label, routeSeed: old.routeSeed };
    if (!old) return { ...edge, route: makeUnobstructedRoute(edge.source, edge.target, edge.sourceSide, edge.targetSide, edge.edge.routeStyle), routeSeed: false };
    const route = geometry.route(edge);
    const delta = { x: route.middle.x - old.route.middle.x, y: route.middle.y - old.route.middle.y };
    const shift = (p: Point) => ({ x: p.x + delta.x, y: p.y + delta.y });
    return { ...edge, route: { ...route, provisional: true }, routeSeed: !route.fallback,
      label: label && { ...label, point: shift(label.point), anchor: shift(label.anchor), rect: { ...label.rect, ...shift(label.rect) } } };
  });
}
