import type { RenderBlock, RenderEdge } from './layout';
import { makeEdgeRoute, routeBounds, placeEdgeLabel, translateRoute, type EdgeLabel, type EdgeRoute } from './edgeGeometry';
import { RectangleIndex, intersects } from './rectangleIndex';
import type { Rect } from './types';
import { RECORD_HEADER_HEIGHT } from './types';
import { createRoutingGeometry, type RoutingModel } from './edgeRoutingGeometry';
export { assignSeats, PORT_SEAT, type SeatLayout } from './edgeRoutingGeometry';

export interface RoutingOptions { viewport?: Rect; labels: boolean; expandedEdgeIds?: string[]; budgetMs?: number; interactive?: boolean }
export interface RoutingStats { rerouted: number; cacheHits: number; validated: number; fallbacks: number; labels: number; pending: number; elapsedMs: number }
interface CachedRoute { signature: string; relativeGeometry?: string; source: { x: number; y: number }; route: EdgeRoute; bounds: Rect; pending: boolean }
const rectKey = (r: Rect) => `${r.x}/${r.y}/${r.width}/${r.height}`;

/** Cache geometry, never endpoint decisions. A new position always resolves its
 * floating ports again, identically to a fresh canvas and the drag preview. */
export class EdgeRoutingCache {
  private blocks = new Map<string, RenderBlock>();
  private routes = new Map<string, CachedRoute>();
  private labelCache = new Map<string, EdgeLabel>();

  route(model: RoutingModel, options: RoutingOptions): { edges: RenderEdge[]; stats: RoutingStats } {
    const started = performance.now(), deadline = started + (options.budgetMs ?? 120);
    const stats: RoutingStats = { rerouted: 0, cacheHits: 0, validated: 0, fallbacks: 0, labels: 0, pending: 0, elapsedMs: 0 };
    const geometry = createRoutingGeometry(model, options.expandedEdgeIds), changed: Rect[] = [];
    for (const id of new Set([...this.blocks.keys(), ...geometry.blocks.keys()])) {
      const a = this.blocks.get(id), b = geometry.blocks.get(id);
      if (!a || !b || rectKey(a.rect) !== rectKey(b.rect) || a.parentId !== b.parentId || a.collapsed !== b.collapsed) {
        if (a) changed.push(a.rect); if (b) changed.push(b.rect);
      }
    }
    const changes = new RectangleIndex(changed);
    if (changed.length) this.labelCache.clear();
    const expanded = new Set(options.expandedEdgeIds);
    const occupied = new RectangleIndex(model.blocks.map(b => b.kind === 'node' || b.collapsed ? b.rect : { ...b.rect, height: RECORD_HEADER_HEIGHT }));
    const ordered = geometry.edges.slice().sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    const priority = new Map(ordered.map(edge => [edge.edge.edgeId, expanded.has(edge.edge.edgeId) ? 2 :
      !options.viewport || intersects(routeBounds(edge.route), options.viewport, 100) ? 1 : 0]));
    ordered.sort((a, b) => priority.get(b.edge.edgeId)! - priority.get(a.edge.edgeId)! || a.edge.edgeId.localeCompare(b.edge.edgeId));
    const liveRoutes = new Set<string>(), edges: RenderEdge[] = [];
    for (const rendered of ordered) {
      const edge = { ...rendered, label: undefined as EdgeLabel | undefined };
      liveRoutes.add(edge.edge.edgeId);
      if (edge.kind === 'full') {
        const context = geometry.context(edge);
        const signature = JSON.stringify([edge.sourceBlockId, edge.targetBlockId, edge.source, edge.target, edge.sourceSide, edge.targetSide,
          context.sourceAncestors, context.targetAncestors, context.constraint]);
        const relativeRect = (r: Rect) => [r.x - edge.source.x, r.y - edge.source.y, r.width, r.height];
        const relativeGeometry = context.commonRegion ? JSON.stringify([edge.sourceBlockId, edge.targetBlockId, edge.sourceSide, edge.targetSide,
          edge.target.x - edge.source.x, edge.target.y - edge.source.y, context.sourceAncestors, context.targetAncestors,
          context.obstacles.map(relativeRect).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]),
          context.terminals.map(relativeRect), context.constraint && relativeRect(context.constraint)]) : undefined;
        const old = this.routes.get(edge.edge.edgeId);
        if (old?.signature === signature && !old.pending && !changes.collides(old.bounds, 24)) {
          edge.route = old.route; stats.cacheHits++;
        } else if (old && relativeGeometry && old.relativeGeometry === relativeGeometry && !old.pending && !old.route.fallback && !old.route.provisional) {
          edge.route = translateRoute(old.route, { x: edge.source.x - old.source.x, y: edge.source.y - old.source.y }); stats.cacheHits++;
        } else if (performance.now() >= deadline) {
          // A budget can defer a route, but must not carry an old attachment side
          // or an old endpoint into the new geometry.
          const samePorts = rendered.source.x === rendered.route.segments[0][0].x && rendered.source.y === rendered.route.segments[0][0].y &&
            rendered.target.x === rendered.route.segments.at(-1)![3].x && rendered.target.y === rendered.route.segments.at(-1)![3].y;
          const preview = rendered.routeSeed && samePorts ? rendered.route : makeEdgeRoute(edge.source, edge.target, edge.sourceSide, edge.targetSide);
          edge.route = { ...preview, provisional: true, retryable: true }; stats.pending++;
        } else {
          edge.route = geometry.route(edge);
          if (rendered.routeSeed && !edge.route.fallback && edge.route.path === rendered.route.path) { stats.validated++; stats.cacheHits++; }
          else stats.rerouted++;
        }
        const pending = Boolean(edge.route.retryable);
        this.routes.set(edge.edge.edgeId, { signature, relativeGeometry, source: edge.source, route: edge.route, bounds: routeBounds(edge.route), pending });
        edge.routeSeed = !edge.route.fallback && !edge.route.provisional;
      }
      if (edge.route.fallback) stats.fallbacks++;
      const bounds = routeBounds(edge.route);
      if ((options.labels || expanded.has(edge.edge.edgeId) || edge.aggregateEdgeIds) &&
        (!options.viewport || intersects(bounds, options.viewport, 80) || expanded.has(edge.edge.edgeId))) {
        const text = edge.aggregateEdgeIds ? `${edge.aggregateEdgeIds.length} 条关系` : edge.edge.edgeContent;
        const key = `${edge.edge.edgeId}/${text}/${edge.route.path}`, old = this.labelCache.get(key);
        const visible = (rect: Rect) => !options.viewport || rect.x >= options.viewport.x + 6 && rect.y >= options.viewport.y + 6
          && rect.x + rect.width <= options.viewport.x + options.viewport.width - 6 && rect.y + rect.height <= options.viewport.y + options.viewport.height - 6;
        if (options.interactive && rendered.label && rendered.route.path === edge.route.path) { edge.label = rendered.label; occupied.add(edge.label.rect); }
        else if (old && visible(old.rect) && !occupied.collides(old.rect, 5)) { edge.label = old; occupied.add(old.rect); }
        else { edge.label = placeEdgeLabel(edge.route, text, occupied, options.viewport); this.labelCache.set(key, edge.label); }
        stats.labels++;
      }
      edges.push(edge);
    }
    for (const id of this.routes.keys()) if (!liveRoutes.has(id)) this.routes.delete(id);
    if (this.labelCache.size > Math.max(100, model.edges.length * 2)) this.labelCache.clear();
    this.blocks = geometry.blocks; stats.elapsedMs = performance.now() - started;
    return { edges, stats };
  }
}
