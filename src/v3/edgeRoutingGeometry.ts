import type { RenderBlock, RenderEdge, RenderModel } from './layout';
import type { ConnectionSide, Point, Rect } from './types';
import { RECORD_HEADER_HEIGHT } from './types';
import { attachmentPoint, choosePorts, pointOnRoute, portPoint, type EdgeRoute } from './edgeGeometry';
import { routeAroundObstacles } from './obstacleRouter';
import { RectangleIndex } from './rectangleIndex';

export type RoutingModel = Pick<RenderModel, 'blocks' | 'edges' | 'parentOf'>;
export const PORT_SEAT = { gap: 18, minGap: 6, margin: 8 } as const;
export interface SeatLayout { offsets: number[]; capacity: number; usable: number }

/** Keep each end near its desired boundary position. Pool neighbouring ends only
 * when their spacing would overlap; distant ends do not pull one another around. */
export function assignSeats(count: number, length: number, options: { gap: number; minGap: number; margin: number } = PORT_SEAT,
  preferred?: readonly number[]): SeatLayout {
  const low = Math.min(options.margin, length / 2), usable = Math.max(0, length - low * 2);
  const capacity = Math.max(1, Math.floor(usable / options.minGap) + 1);
  if (count > capacity) return { capacity, usable, offsets: Array.from({ length: count }, (_, i) =>
    low + (capacity <= 1 ? usable / 2 : Math.round(i * (capacity - 1) / (count - 1)) * usable / (capacity - 1))) };
  const gap = count <= 1 ? 0 : Math.min(options.gap, usable / (count - 1));
  const pools: Array<{ sum: number; count: number }> = [];
  for (let i = 0; i < count; i++) {
    pools.push({ sum: (preferred?.[i] ?? length / 2) - i * gap, count: 1 });
    while (pools.length > 1) {
      const b = pools[pools.length - 1], a = pools[pools.length - 2];
      if (a.sum / a.count <= b.sum / b.count) break;
      pools.splice(-2, 2, { sum: a.sum + b.sum, count: a.count + b.count });
    }
  }
  const offsets: number[] = [], high = low + usable - Math.max(0, count - 1) * gap;
  for (const pool of pools) {
    const at = Math.max(low, Math.min(high, pool.sum / pool.count));
    for (let i = 0; i < pool.count; i++) offsets.push(at + offsets.length * gap);
  }
  return { offsets, capacity, usable };
}

export interface ConnectionContext { obstacles: Rect[]; terminals: Rect[]; constraint?: Rect; sourceAncestors: string[]; targetAncestors: string[]; commonRegion?: string }

/** One geometry policy shared by immediate previews and worker routing. Expanded
 * ancestor regions contribute their headers; unrelated regions remain obstacles. */
export function createRoutingGeometry(model: RoutingModel, expandedEdgeIds: string[] = []) {
  const blocks = new Map(model.blocks.map(block => [block.id, block]));
  const index = new RectangleIndex(model.blocks.map(block => Object.assign({ ...block.rect }, { id: block.id })));
  const ancestry = new Map<string, string[]>(), contexts = new Map<string, ConnectionContext>();
  const ancestors = (id?: string): string[] => {
    if (!id) return [];
    if (ancestry.has(id)) return ancestry.get(id)!;
    const result: string[] = []; let parent = model.parentOf.get(id);
    while (parent && !result.includes(parent)) { result.push(parent); parent = model.parentOf.get(parent); }
    ancestry.set(id, result); return result;
  };
  const context = (edge: RenderEdge): ConnectionContext => {
    const existing = contexts.get(edge.edge.edgeId); if (existing) return existing;
    const a = blocks.get(edge.sourceBlockId!)?.rect, b = blocks.get(edge.targetBlockId!)?.rect;
    const sourceAncestors = ancestors(edge.sourceBlockId), targetAncestors = ancestors(edge.targetBlockId);
    const ancestorIds = new Set([...sourceAncestors, ...targetAncestors]);
    const commonRegion = sourceAncestors.find(id => targetAncestors.includes(id) && blocks.has(id));
    const common = commonRegion && blocks.get(commonRegion)!.rect;
    const corridor = a && b ? { x: Math.min(a.x, b.x) - 450, y: Math.min(a.y, b.y) - 450,
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) + 900,
      height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) + 900 } : undefined;
    const obstacles = (corridor ? index.query(corridor) : []).flatMap(rect => {
      const id = (rect as Rect & { id: string }).id;
      if (id === edge.sourceBlockId || id === edge.targetBlockId) return [];
      return [ancestorIds.has(id) && !blocks.get(id)!.collapsed ? { ...rect, height: RECORD_HEADER_HEIGHT } : rect];
    });
    const terminals = [a, b].filter((r): r is Rect => Boolean(r)).filter(rect =>
      ![a, b].some(other => other && other !== rect && other.x >= rect.x && other.y >= rect.y &&
        other.x + other.width <= rect.x + rect.width && other.y + other.height <= rect.y + rect.height));
    const result: ConnectionContext = { obstacles, terminals, sourceAncestors, targetAncestors, commonRegion,
      constraint: common ? { x: common.x + 4, y: common.y + RECORD_HEADER_HEIGHT + 6,
        width: Math.max(0, common.width - 8), height: Math.max(0, common.height - RECORD_HEADER_HEIGHT - 10) } : undefined };
    contexts.set(edge.edge.edgeId, result); return result;
  };

  const expanded = new Set(expandedEdgeIds), groups = new Map<string, RenderEdge[]>(), hidden = new Set<string>();
  const aggregateIds = new Map<string, string[]>();
  for (const edge of model.edges) if (edge.kind === 'full' &&
    (blocks.get(edge.sourceBlockId!)?.collapsed || blocks.get(edge.targetBlockId!)?.collapsed)) {
    const ends = edge.edge.directed ? [edge.sourceBlockId, edge.targetBlockId] : [edge.sourceBlockId, edge.targetBlockId].sort();
    const key = JSON.stringify([ends, edge.edge.directed]);
    const group = groups.get(key) ?? []; group.push(edge); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.length > 1 && !group.some(edge => expanded.has(edge.edge.edgeId))) {
    group.sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    aggregateIds.set(group[0].edge.edgeId, group.map(edge => edge.edge.edgeId));
    group.slice(1).forEach(edge => hidden.add(edge.edge.edgeId));
  }
  const edges = model.edges.filter(edge => !hidden.has(edge.edge.edgeId)).map(edge => {
    const a = blocks.get(edge.sourceBlockId!), b = blocks.get(edge.targetBlockId!);
    const ports = edge.kind === 'full' && a && b ? choosePorts(a.rect, b.rect, context(edge).obstacles) : {};
    return { ...edge, ...ports, aggregateEdgeIds: aggregateIds.get(edge.edge.edgeId) };
  });
  const seats = new Map<string, { block: RenderBlock; side: ConnectionSide; ends: Array<{ edge: RenderEdge; end: 'source' | 'target'; at: number; aim: number }> }>();
  for (const edge of edges) if (edge.kind === 'full') for (const end of ['source', 'target'] as const) {
    const block = blocks.get(end === 'source' ? edge.sourceBlockId! : edge.targetBlockId!); if (!block) continue;
    const side = end === 'source' ? edge.sourceSide : edge.targetSide, horizontal = side === 'top' || side === 'bottom';
    const key = `${block.id}/${side}`, group = seats.get(key) ?? { block, side, ends: [] };
    const partner = edge[end === 'source' ? 'target' : 'source'];
    group.ends.push({ edge, end, at: horizontal ? edge[end].x : edge[end].y, aim: horizontal ? partner.x : partner.y }); seats.set(key, group);
  }
  for (const { block, side, ends } of seats.values()) {
    const horizontal = side === 'top' || side === 'bottom', start = horizontal ? block.rect.x : block.rect.y;
    const length = horizontal ? block.rect.width : block.rect.height;
    ends.sort((a, b) => a.aim - b.aim || a.edge.edge.edgeId.localeCompare(b.edge.edge.edgeId) || a.end.localeCompare(b.end));
    const { offsets } = assignSeats(ends.length, length, PORT_SEAT, ends.map(end => end.at - start));
    ends.forEach((item, i) => { item.edge[item.end] = portPoint(block.rect, side, start + offsets[i]); });
  }

  const route = (edge: RenderEdge): EdgeRoute => {
    const c = context(edge);
    const result = routeAroundObstacles(edge.source, edge.target, edge.sourceSide, edge.targetSide, c.obstacles, 8, c.terminals, c.constraint);
    if (result.fallback) return result;
    // Boundary crossings describe the resulting curve. They never force it to
    // visit arbitrary coordinates or depend on an edge's identifier.
    const gateways: NonNullable<EdgeRoute['gateways']> = [];
    const crossing = (id: string, reverse: boolean) => {
      const rect = blocks.get(id)?.rect; if (!rect) return;
      const inside = (p: Point) => p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
      const point = (t: number) => pointOnRoute(result, reverse ? 1 - t : t);
      if (!inside(point(0))) return;
      for (let i = 1; i <= 64; i++) if (!inside(point(i / 64))) {
        let low = (i - 1) / 64, high = i / 64;
        for (let step = 0; step < 24; step++) { const mid = (low + high) / 2; if (inside(point(mid))) low = mid; else high = mid; }
        const p = point((low + high) / 2), side = attachmentPoint(rect, p).side;
        gateways.push({ regionId: id, side, point: portPoint(rect, side, side === 'top' || side === 'bottom' ? p.x : p.y) }); return;
      }
    };
    for (const id of c.sourceAncestors) { if (id === c.commonRegion) break; crossing(id, false); }
    const entering: string[] = [];
    for (const id of c.targetAncestors) { if (id === c.commonRegion) break; entering.push(id); }
    entering.reverse().forEach(id => crossing(id, true));
    return gateways.length ? { ...result, gateways } : result;
  };
  return { blocks, edges, context, route };
}
