import type { RenderBlock, RenderEdge, RenderModel } from './layout';
import type { ConnectionSide, Point, Rect } from './types';
import { RECORD_HEADER_HEIGHT } from './types';
import { attachmentPoint, cachedPortChooser, makeStubRoute, pointOnRoute, portPoint, type EdgeRoute } from './edgeGeometry';
import { routeAroundObstacles } from './obstacleRouter';
import { RectangleIndex } from './rectangleIndex';

export type RoutingModel = Pick<RenderModel, 'blocks' | 'edges' | 'parentOf'>;
const routingPorts = cachedPortChooser();
export const PORT_SEAT = { gap: 18, minGap: 6, margin: 8 } as const;
type SeatSpacing = { gap: number; minGap: number; margin: number };
export interface SeatLayout { offsets: number[]; capacity: number; usable: number }

/** Keep each end near its desired boundary position. Pool neighbouring ends only
 * when their spacing would overlap; distant ends do not pull one another around. */
export function assignSeats(count: number, length: number, options: SeatSpacing = PORT_SEAT,
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

/** Keep local ports fixed. Fit the remaining fan into the gaps between them,
 * sharing secondary seats when the side is full. */
function fitAroundReserved(preferred: number[], length: number, reserved: number[], spacing: SeatSpacing): number[] {
  if (!reserved.length) return assignSeats(preferred.length, length, spacing, preferred).offsets;
  const gap = spacing.minGap, low = Math.min(spacing.margin, length / 2), high = length - low;
  const intervals: Array<{ start: number; end: number; first: number; count: number }> = [];
  let capacity = 0;
  const add = (start: number, end: number) => {
    if (end < start) return;
    const count = Math.floor((end - start) / gap) + 1;
    intervals.push({ start, end, first: capacity, count }); capacity += count;
  };
  let start = low, spare = low, clearance = reserved[0] - low;
  for (let i = 0; i < reserved.length; i++) {
    const at = reserved[i];
    add(start, at - gap);
    start = at + gap;
    if (i && (at - reserved[i - 1]) / 2 > clearance) {
      clearance = (at - reserved[i - 1]) / 2; spare = at - clearance;
    }
  }
  add(start, high);
  if (!capacity) return preferred.map(() => high - reserved[reserved.length - 1] > clearance ? high : spare);
  const desired = assignSeats(preferred.length, length, spacing, preferred).offsets;
  let desiredRange = 0, assignedRange = 0, previous = -1;
  return desired.map((aim, i) => {
    while (desiredRange + 1 < intervals.length && aim > (intervals[desiredRange].end + intervals[desiredRange + 1].start) / 2) desiredRange++;
    const slot = intervals[desiredRange];
    const nearest = slot.first + Math.max(0, Math.min(slot.count - 1, Math.round((aim - slot.start) / gap)));
    const index = capacity < desired.length ? Math.round(i * (capacity - 1) / (desired.length - 1))
      : Math.max(previous + 1, Math.min(nearest, capacity - desired.length + i));
    previous = index;
    while (index >= intervals[assignedRange].first + intervals[assignedRange].count) assignedRange++;
    return intervals[assignedRange].start + (index - intervals[assignedRange].first) * gap;
  });
}

export interface ConnectionContext { obstacles: Rect[]; terminals: Rect[]; constraint?: Rect; sourceAncestors: string[]; targetAncestors: string[]; commonRegion?: string }

/** One geometry policy shared by immediate previews and worker routing. Expanded
 * ancestor regions contribute their headers; unrelated regions remain obstacles. */
export function createRoutingGeometry(model: RoutingModel, expandedEdgeIds: string[] = [],
  { ports = routingPorts, spacing = PORT_SEAT }: { ports?: typeof routingPorts; spacing?: SeatSpacing } = {}) {
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
    const header = commonRegion ? blocks.get(commonRegion)!.headerHeight ?? RECORD_HEADER_HEIGHT : 0;
    const corridor = a && b ? { x: Math.min(a.x, b.x) - 450, y: Math.min(a.y, b.y) - 450,
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) + 900,
      height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) + 900 } : undefined;
    const obstacles = (corridor ? index.query(corridor) : []).flatMap(rect => {
      const id = (rect as Rect & { id: string }).id;
      if (id === edge.sourceBlockId || id === edge.targetBlockId) return [];
      // An unrelated expanded region blocks the entire rectangle. Its contents
      // contribute no additional boundary and crowd useful turns out of the
      // router's bounded search grid on long cross-region connections.
      const parent = blocks.get(model.parentOf.get(id) ?? '');
      if (parent && !ancestorIds.has(parent.id) && parent.id !== edge.sourceBlockId && parent.id !== edge.targetBlockId &&
        rect.x >= parent.rect.x && rect.y >= parent.rect.y && rect.x + rect.width <= parent.rect.x + parent.rect.width &&
        rect.y + rect.height <= parent.rect.y + parent.rect.height) return [];
      const block = blocks.get(id)!;
      return [ancestorIds.has(id) && !block.collapsed ? { ...rect, height: block.headerHeight ?? RECORD_HEADER_HEIGHT } : rect];
    });
    const terminals = [a, b].filter((r): r is Rect => Boolean(r)).filter(rect =>
      ![a, b].some(other => other && other !== rect && other.x >= rect.x && other.y >= rect.y &&
        other.x + other.width <= rect.x + rect.width && other.y + other.height <= rect.y + rect.height));
    const result: ConnectionContext = { obstacles, terminals, sourceAncestors, targetAncestors, commonRegion,
      constraint: common ? { x: common.x + 4, y: common.y + header + 6,
        width: Math.max(0, common.width - 8), height: Math.max(0, common.height - header - 10) } : undefined };
    contexts.set(edge.edge.edgeId, result); return result;
  };

  const expanded = new Set(expandedEdgeIds), groups = new Map<string, RenderEdge[]>(), hidden = new Set<string>();
  const aggregateIds = new Map<string, string[]>();
  for (const edge of model.edges) if (edge.kind === 'full' &&
    (blocks.get(edge.sourceBlockId!)?.collapsed || blocks.get(edge.targetBlockId!)?.collapsed)) {
    const ends = edge.edge.directed ? [edge.sourceBlockId, edge.targetBlockId] : [edge.sourceBlockId, edge.targetBlockId].sort();
    const key = JSON.stringify([edge.scope, ends, edge.edge.directed]);
    const group = groups.get(key) ?? []; group.push(edge); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.length > 1 && !group.some(edge => expanded.has(edge.edge.edgeId))) {
    group.sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    aggregateIds.set(group[0].edge.edgeId, group.map(edge => edge.edge.edgeId));
    group.slice(1).forEach(edge => hidden.add(edge.edge.edgeId));
  }
  const edges = model.edges.filter(edge => !hidden.has(edge.edge.edgeId)).map(edge => {
    const a = blocks.get(edge.sourceBlockId!), b = blocks.get(edge.targetBlockId!);
    const attachments = edge.kind === 'full' && a && b ? ports(edge.edge, a.rect, b.rect, context(edge).obstacles) : {};
    return { ...edge, ...attachments, aggregateEdgeIds: aggregateIds.get(edge.edge.edgeId) };
  });
  const seats = new Map<string, { block: RenderBlock; side: ConnectionSide; ends: Array<{ edge: RenderEdge; end: 'source' | 'target'; at: number; aim: number }> }>();
  for (const edge of edges) for (const end of ['source', 'target'] as const) {
    const block = blocks.get(end === 'source' ? edge.sourceBlockId! : edge.targetBlockId!); if (!block) continue;
    const side = end === 'source' ? edge.sourceSide : edge.targetSide, horizontal = side === 'top' || side === 'bottom';
    const key = `${block.id}/${side}`, group = seats.get(key) ?? { block, side, ends: [] };
    const partner = edge[end === 'source' ? 'target' : 'source'];
    // Order a fan by direction at this block. A faraway partner may be lower
    // on screen but have a shallower angle than its much closer neighbour.
    const dx = partner.x - (block.rect.x + block.rect.width / 2);
    const dy = partner.y - (block.rect.y + block.rect.height / 2);
    const outward = side === 'right' ? dx : side === 'left' ? -dx : side === 'bottom' ? dy : -dy;
    group.ends.push({ edge, end, at: horizontal ? edge[end].x : edge[end].y, aim: Math.atan2(horizontal ? dx : dy, outward) });
    seats.set(key, group);
  }
  for (const { block, side, ends } of seats.values()) {
    const horizontal = side === 'top' || side === 'bottom', start = horizontal ? block.rect.x : block.rect.y;
    const length = horizontal ? block.rect.width : block.rect.height;
    ends.sort((a, b) => a.aim - b.aim || a.edge.edge.edgeId.localeCompare(b.edge.edge.edgeId) || a.end.localeCompare(b.end));
    const local = ends.filter(item => item.edge.scope === 'internal');
    const secondary = ends.filter(item => item.edge.scope !== 'internal');
    const offsets = assignSeats(local.length, length, spacing, local.map(item => item.at - start)).offsets;
    const available = secondary.length ? fitAroundReserved(secondary.map(item => item.at - start), length, offsets, spacing) : [];
    const attach = (item: typeof ends[number], offset: number) => {
      const { edge, end } = item, old = edge[end], next = portPoint(block.rect, side, start + offset);
      edge[end] = next;
      if (edge.freeEnd) {
        const free = edge[edge.freeEnd];
        edge[edge.freeEnd] = { x: free.x + (next.x - old.x), y: free.y + (next.y - old.y) };
        edge.route = makeStubRoute(edge.source, edge.target);
      }
    };
    local.forEach((item, i) => attach(item, offsets[i]));
    secondary.forEach((item, i) => attach(item, available[i]));
  }

  const route = (edge: RenderEdge): EdgeRoute => {
    const c = context(edge);
    const result = routeAroundObstacles(edge.source, edge.target, edge.sourceSide, edge.targetSide,
      c.obstacles, 8, c.terminals, c.constraint, {}, edge.edge.routeStyle);
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
