import { nodeGeometry } from './nodeGeometry';
import { canvasDirectory } from './canvas';
import type {
  CanvasRecord,
  ConnectionSide,
  GraphEdge,
  GraphRecord,
  GraphState,
  Placement,
  Point,
  Rect,
} from './types';
import { choosePorts, facingSide, makeEdgeRoute, makeStubRoute, placeEdgeLabel, portPoint,
  type EdgeLabel, type EdgeRoute } from './edgeGeometry';
import { getCanvasPaths, type PathSegment } from './paths';
import { getNaturalGeometry, measureNaturalRegions, type RegionGeometry } from './regionLayout';
import { getHierarchyIndex, retainHierarchyIndex } from './hierarchyIndex';
import { RectangleIndex } from './rectangleIndex';
import {
  BLOCK_GAP,
  COLLAPSED_HEIGHT,
  COLLAPSED_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  RECORD_HEADER_HEIGHT,
  RECORD_PADDING,
} from './types';

export interface RenderBlock {
  id: string;
  kind: 'node' | 'document' | 'directory';
  name: string;
  content?: string;
  rect: Rect;
  anchor: Point;
  parentId: string;
  depth: number;
  collapsed: boolean;
}

export interface RenderEdge {
  edge: GraphEdge;
  kind: 'full' | 'filtered' | 'outside';
  source: Point;
  target: Point;
  /** A directed stub ending at this point still gets an arrow. */
  arrowAt: 'source' | 'target' | null;
  freeEnd?: 'source' | 'target';
  sourceSide: ConnectionSide;
  targetSide: ConnectionSide;
  sourceBlockId?: string;
  targetBlockId?: string;
  route: EdgeRoute;
  label?: EdgeLabel;
  aggregateEdgeIds?: string[];
  /** A preview computed with the shared routing policy, eligible for reuse. */
  routeSeed?: boolean;
}

export interface RenderModel {
  blocks: RenderBlock[];
  edges: RenderEdge[];
  bounds: Rect;
  membership: Set<string>;
  parentOf: Map<string, string>;
  lodCollapsed: Set<string>;
}

export interface RenderOptions {
  zoom: number;
  showOutsideEdges?: boolean;
  ignoreCollapse?: boolean;
  previousLod?: ReadonlySet<string>;
  focusIds?: ReadonlySet<string>;
  visibleIds?: ReadonlySet<string>;
  /** Geometry readers never pay for paths and labels. The UI delegates precise routing to a worker. */
  skipEdges?: boolean;
  deferRouting?: boolean;
}

const empty: Rect = { x: 0, y: 0, width: 0, height: 0 };
const collapsedRect: Rect = {
  x: 0,
  y: 0,
  width: COLLAPSED_WIDTH,
  height: COLLAPSED_HEIGHT,
};

export function translate(rect: Rect, point: Point): Rect {
  return { ...rect, x: rect.x + point.x, y: rect.y + point.y };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

function childrenOf(record: GraphRecord, canvas?: CanvasRecord): string[] {
  // The arrays are membership lists; iteration order has no product meaning.
  return [...record.childNodeIds, ...record.childDocumentIds].filter((id) => !canvas?.excludedDocumentIds?.includes(id)).sort();
}

function fallbackPlacement(id: string, siblings: string[]): Placement {
  const index = Math.max(0, siblings.indexOf(id));
  return {
    x: (index % 3) * (NODE_WIDTH + BLOCK_GAP),
    y: Math.floor(index / 3) * (NODE_HEIGHT + BLOCK_GAP),
    source: 'auto',
  };
}

function placement(id: string, siblings: string[], positions: Record<string, Placement>): Placement {
  return positions[id] ?? fallbackPlacement(id, siblings);
}

/** Display detail changes never change reserved geometry or child origins. */
function displayRegionBounds(full: Rect, id: string, canvas: CanvasRecord | undefined,
  options: RenderOptions, lod: Set<string>): Rect {
  if (options.ignoreCollapse || !canvas || options.focusIds?.has(id)) return full;
  if (canvas.collapsed[id]) return collapsedRect;
  const wasFolded = options.previousLod?.has(id) ?? false;
  // Text has a screen-space font floor. Only a genuinely tiny region needs an
  // overview; zooming through a text-size threshold must not remove its nodes.
  const tooSmall = full.width * options.zoom < (wasFolded ? 72 : 56) || full.height * options.zoom < (wasFolded ? 40 : 30);
  if (tooSmall) { lod.add(id); return collapsedRect; }
  return full;
}

export function measureDocument(state: GraphState, documentId: string, canvas?: CanvasRecord,
  options: RenderOptions = { zoom: 1 }, _visited = new Set<string>(), lod = new Set<string>(),
  geometry = getNaturalGeometry(state)): Rect {
  const full = state.documents[documentId] ? geometry.document(documentId) : empty;
  return displayRegionBounds(full, documentId, canvas, options, lod);
}

function measureDirectory(state: GraphState, canvas: CanvasRecord, directoryId: string,
  options: RenderOptions, lod: Set<string>, geometry?: RegionGeometry): Rect {
  // An import can measure a canvas that is not attached to the graph yet.
  const measured = geometry ?? getNaturalGeometry(state.canvases.includes(canvas) ? state : { ...state });
  const full = canvasDirectory(canvas, directoryId) ? measured.directory(canvas, directoryId) : empty;
  if (directoryId === canvas.canvasId) return full;
  return displayRegionBounds(full, directoryId, canvas, options, lod);
}

function indexMembership(state: GraphState, canvas: CanvasRecord): {
  members: Set<string>;
  parents: Map<string, string>;
} {
  const cached = membershipCache.get(state)?.get(canvas);
  if (cached) return cached;
  const hierarchy = getHierarchyIndex(state); retainHierarchyIndex(state, hierarchy);
  const membershipKey = JSON.stringify([canvas.canvasId, canvas.excludedDocumentIds]);
  const shared = membershipByHierarchy.get(hierarchy)?.get(membershipKey);
  if (shared) return shared;
  const members = new Set<string>();
  const parents = new Map<string, string>();
  const walkDoc = (id: string, parent: string, visited: Set<string>) => {
    if (!state.documents[id] || visited.has(id) || canvas.excludedDocumentIds?.includes(id)) return;
    visited.add(id);
    members.add(id);
    parents.set(id, parent);
    const record = state.documents[id];
    for (const nodeId of record.childNodeIds) {
      if (!state.nodes[nodeId]) continue;
      members.add(nodeId);
      parents.set(nodeId, id);
    }
    for (const childId of record.childDocumentIds) walkDoc(childId, id, visited);
  };
  const visitedDocs = new Set<string>();
  const visitedDirs = new Set<string>();
  const walkDir = (id: string, parent?: string) => {
    if (visitedDirs.has(id) || !canvasDirectory(canvas, id)) return;
    visitedDirs.add(id);
    members.add(id);
    if (parent) parents.set(id, parent);
    for (const childId of canvasDirectory(canvas, id).childIds) {
      if (canvasDirectory(canvas, childId)) walkDir(childId, id);
      else if (state.documents[childId]) walkDoc(childId, id, visitedDocs);
      else if (state.nodes[childId]) {
        members.add(childId);
        parents.set(childId, id);
      }
    }
  };
  walkDir(canvas.canvasId);
  const result = { members, parents };
  const byCanvas = membershipCache.get(state) ?? new WeakMap(); byCanvas.set(canvas, result); membershipCache.set(state, byCanvas);
  const byHierarchy = membershipByHierarchy.get(hierarchy) ?? new Map();
  if (byHierarchy.size >= 24) byHierarchy.delete(byHierarchy.keys().next().value!);
  byHierarchy.set(membershipKey, result); membershipByHierarchy.set(hierarchy, byHierarchy);
  return result;
}
const membershipCache = new WeakMap<GraphState, WeakMap<CanvasRecord, { members: Set<string>; parents: Map<string, string> }>>();
const membershipByHierarchy = new WeakMap<object, Map<string, { members: Set<string>; parents: Map<string, string> }>>();

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function edgeHash(id: string): number {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function buildRenderModel(
  state: GraphState,
  canvas: CanvasRecord,
  options: RenderOptions
): RenderModel {
  const geometry = measureNaturalRegions(state.canvases.includes(canvas) ? state : { ...state }, canvas);
  const blocks: RenderBlock[] = [];
  const blockIndex = new RectangleIndex();
  const byId = new Map<string, RenderBlock>();
  const lod = new Set<string>();
  const { members, parents } = indexMembership(state, canvas);
  const visited = new Set<string>();
  const visit = (id: string, parentId: string, anchor: Point, depth: number) => {
    if (canvas.excludedDocumentIds?.includes(id)) return;
    if (options.visibleIds && !options.visibleIds.has(id)) return;
    if (visited.has(id)) return;
    visited.add(id);
    const dir = canvasDirectory(canvas, id);
    const doc = state.documents[id];
    const node = state.nodes[id];
    if (!dir && !doc && !node) return;
    const kind: RenderBlock['kind'] = dir ? 'directory' : doc ? 'document' : 'node';
    const local = dir
      ? measureDirectory(state, canvas, id, options, lod, geometry)
      : doc
        ? measureDocument(state, id, canvas, options, new Set(), lod, geometry)
        : nodeGeometry(node!);
    const manualCollapse = Boolean(canvas.collapsed[id]) && !options.focusIds?.has(id);
    const folded = kind !== 'node' && !options.ignoreCollapse && (manualCollapse || lod.has(id));
    const block: RenderBlock = {
      id,
      kind,
      name: dir?.name ?? doc?.name ?? node?.name ?? '',
      content: node?.content,
      rect: translate(local, anchor),
      anchor,
      parentId,
      depth,
      collapsed: folded,
    };
    blocks.push(block);
    byId.set(id, block);
    if (folded || node) return;
    const childIds = dir ? dir.childIds.filter((child) => !canvas.excludedDocumentIds?.includes(child)).sort() : doc ? childrenOf(doc, canvas) : [];
    const positions = dir ? canvas.placements : doc?.placements ?? {};
    const contentOrigin = {
      x: anchor.x + RECORD_PADDING,
      y: anchor.y + RECORD_HEADER_HEIGHT + RECORD_PADDING,
    };
    for (const childId of childIds) {
      const pos = placement(childId, childIds, positions);
      visit(childId, id, { x: contentOrigin.x + pos.x, y: contentOrigin.y + pos.y }, depth + 1);
    }
  };
  const root = canvasDirectory(canvas, canvas.canvasId);
  if (root) {
    for (const childId of [...root.childIds].sort()) {
      const pos = placement(childId, root.childIds, canvas.placements);
      visit(childId, canvas.canvasId, { x: pos.x, y: pos.y }, 0);
    }
  }

  const representative = (id: string): RenderBlock | null => {
    if (!members.has(id)) return null;
    if (options.visibleIds && !options.visibleIds.has(id)) return null;
    if (id === canvas.canvasId && blocks.length) {
      const rect = blocks.reduce((acc, block) => unionRect(acc, block.rect), blocks[0].rect);
      return { id, kind: 'directory', name: canvas.canvasName, rect, anchor: { x: 0, y: 0 }, parentId: '', depth: -1, collapsed: false };
    }
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const block = byId.get(current);
      if (block) return block;
      current = parents.get(current);
    }
    return null;
  };

  const edges: RenderEdge[] = [];
  const bounds = blocks.length ? blocks.reduce((acc, block) => unionRect(acc, block.rect), blocks[0].rect) : empty;
  if (options.skipEdges) return { blocks, edges, bounds, membership: members, parentOf: parents, lodCollapsed: lod };
  const naturalById = options.visibleIds
    ? new Map(buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true }).blocks.map((block) => [block.id, block]))
    : null;
  const endpointExists = (id: string) => Boolean(state.nodes[id] || state.documents[id] || state.canvases.some(item => canvasDirectory(item, id)));
  for (const block of blocks) blockIndex.add(block.rect);
  const blockByRect = new Map(blocks.map(block => [block.rect, block]));
  for (const edge of state.edges) {
    if (edge.removed) continue;
    if (!members.has(edge.sourceNodeId) && !members.has(edge.targetNodeId)) continue;
    if (!endpointExists(edge.sourceNodeId) || !endpointExists(edge.targetNodeId)) continue;
    const source = representative(edge.sourceNodeId);
    const target = representative(edge.targetNodeId);
    if (!source && !target) continue;
    if (source && target && source.id === target.id) continue;
    if (source && target) {
      // Ports avoid the blocks between them: the pair is chosen from the actual
      // corridor, so an edge does not leave through a side that immediately
      // heads into a neighbour.
      const corridor = unionRect(source.rect, target.rect);
      const ancestorIds = new Set<string>();
      for (const block of [source, target]) {
        let id = parents.get(block.id);
        while (id && !ancestorIds.has(id)) { ancestorIds.add(id); id = parents.get(id); }
      }
      const between = blockIndex.query(corridor, 12).filter(rect => rect !== source.rect && rect !== target.rect).map(rect =>
        ancestorIds.has(blockByRect.get(rect)!.id) ? { ...rect, height: RECORD_HEADER_HEIGHT } : rect);
      const { sourceSide, targetSide, source: sourcePoint, target: targetPoint } = choosePorts(source.rect, target.rect, between);
      edges.push({
        edge,
        kind: 'full',
        source: sourcePoint,
        target: targetPoint,
        arrowAt: edge.directed ? 'target' : null,
        sourceSide, targetSide, sourceBlockId: source.id, targetBlockId: target.id,
        route: makeEdgeRoute(sourcePoint, targetPoint, sourceSide, targetSide),
      });
      continue;
    }
    const otherId = source ? edge.targetNodeId : edge.sourceNodeId;
    const filtered = members.has(otherId) && Boolean(options.visibleIds) && !options.visibleIds?.has(otherId);
    if (!filtered && options.showOutsideEdges === false) continue;
    const visible = source ?? target;
    if (!visible) continue;
    const otherCenter = naturalById?.get(otherId) ? center(naturalById.get(otherId)!.rect) : null;
    const angle = (edgeHash(edge.edgeId) % 7 - 3) * 0.18;
    const outward = otherCenter
      ? { x: otherCenter.x - center(visible.rect).x, y: otherCenter.y - center(visible.rect).y }
      : source ? { x: 1, y: angle } : { x: -1, y: angle };
    const side = facingSide(visible.rect, { x: center(visible.rect).x + outward.x, y: center(visible.rect).y + outward.y });
    const magnitude = Math.hypot(outward.x, outward.y) || 1;
    outward.x /= magnitude;
    outward.y /= magnitude;
    const start = portPoint(visible.rect, side);
    const length = filtered ? 64 : 44;
    const end = { x: start.x + outward.x * length, y: start.y + outward.y * length };
    edges.push({
      edge,
      kind: filtered ? 'filtered' : 'outside',
      source: source ? start : end,
      target: source ? end : start,
      arrowAt: edge.directed ? 'target' : null,
      freeEnd: source ? 'target' : 'source',
      sourceSide: source ? side : 'right', targetSide: target ? side : 'left',
      sourceBlockId: source?.id, targetBlockId: target?.id,
      route: makeStubRoute(source ? start : end, source ? end : start),
    });
  }
  const parallel = new Map<string, RenderEdge[]>();
  for (const rendered of edges) {
    if (rendered.kind !== 'full') continue;
    const key = [rendered.sourceBlockId, rendered.targetBlockId].sort().join('\u0000');
    parallel.set(key, [...(parallel.get(key) ?? []), rendered]);
  }
  for (const group of parallel.values()) {
    group.sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    group.forEach((rendered, index) => {
      const lane = index - (group.length - 1) / 2;
      rendered.route = makeEdgeRoute(rendered.source, rendered.target, rendered.sourceSide, rendered.targetSide,
        lane, options.zoom, (rendered.sourceBlockId ?? '') < (rendered.targetBlockId ?? ''));
    });
  }
  // Parallel half-edges fan out at their free ends, keeping a manual port exact.
  const parallelStubs = new Map<string, RenderEdge[]>();
  for (const rendered of edges) {
    if (rendered.kind === 'full') continue;
    const visibleId = rendered.sourceBlockId ?? rendered.targetBlockId;
    const side = rendered.freeEnd === 'target' ? rendered.sourceSide : rendered.targetSide;
    const key = [visibleId, side, rendered.kind, ...[rendered.edge.sourceNodeId, rendered.edge.targetNodeId].sort()].join('\u0000');
    parallelStubs.set(key, [...(parallelStubs.get(key) ?? []), rendered]);
  }
  for (const group of parallelStubs.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    const fixed = group[0].freeEnd === 'target' ? group[0].source : group[0].target;
    const free = group.reduce((sum, rendered) => {
      const point = rendered.freeEnd === 'target' ? rendered.target : rendered.source;
      return { x: sum.x + point.x / group.length, y: sum.y + point.y / group.length };
    }, { x: 0, y: 0 });
    const length = Math.hypot(free.x - fixed.x, free.y - fixed.y) || 1;
    group.forEach((rendered, index) => {
      const offset = (index - (group.length - 1) / 2) * 18;
      const point = { x: free.x - (free.y - fixed.y) / length * offset, y: free.y + (free.x - fixed.x) / length * offset };
      if (rendered.freeEnd === 'target') rendered.target = point; else rendered.source = point;
      rendered.route = makeStubRoute(rendered.source, rendered.target);
    });
  }
  const occupiedLabels = blocks.filter((block) => block.kind === 'node').map((block) => ({ ...block.rect }));
  for (const rendered of options.deferRouting ? [] : [...edges].sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId))) {
    if (rendered.kind === 'full') rendered.label = placeEdgeLabel(rendered.route, rendered.edge.edgeContent, occupiedLabels);
  }
  return { blocks, edges, bounds, membership: members, parentOf: parents, lodCollapsed: lod };
}

/** Expand a selection snapshot along tree or one graph hop, then retain ancestor frames. */
export function getFocusVisibleIds(
  state: GraphState,
  canvas: CanvasRecord,
  selectedIds: ReadonlySet<string>,
  mode: 'selected' | 'neighbors'
): Set<string> {
  const { members, parents } = indexMembership(state, canvas);
  const result = new Set<string>();
  const addSubtree = (id: string) => {
    if (!members.has(id) || result.has(id)) return;
    result.add(id);
    const children = canvasDirectory(canvas, id)?.childIds ?? (state.documents[id]
      ? [...state.documents[id].childNodeIds, ...state.documents[id].childDocumentIds]
      : []);
    children.forEach(addSubtree);
  };
  selectedIds.forEach(addSubtree);
  if (mode === 'neighbors') {
    const initial = new Set(result);
    for (const edge of state.edges) {
      if (edge.removed) continue;
      if (initial.has(edge.sourceNodeId) && members.has(edge.targetNodeId)) addSubtree(edge.targetNodeId);
      if (initial.has(edge.targetNodeId) && members.has(edge.sourceNodeId)) addSubtree(edge.sourceNodeId);
    }
  }
  for (const id of [...result]) {
    let parent = parents.get(id);
    while (parent && !result.has(parent)) { result.add(parent); parent = parents.get(parent); }
  }
  return result;
}

export function getCanvasDocumentIds(state: GraphState, canvas: CanvasRecord): Set<string> {
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id) || !state.documents[id] || canvas.excludedDocumentIds?.includes(id)) return;
    result.add(id);
    state.documents[id].childDocumentIds.forEach(visit);
  };
  const visitedDirs = new Set<string>();
  const dir = (id: string) => {
    if (visitedDirs.has(id)) return;
    visitedDirs.add(id);
    canvasDirectory(canvas, id)?.childIds.forEach((childId) => {
      if (canvasDirectory(canvas, childId)) dir(childId);
      else visit(childId);
    });
  };
  dir(canvas.canvasId);
  return result;
}

export interface CanvasNodeOption { id: string; name: string; path: string; segments: PathSegment[] }

/** Includes folded and filtered nodes: membership, not current render visibility. */
export function getCanvasNodeOptions(state: GraphState, canvas: CanvasRecord): CanvasNodeOption[] {
  return getCanvasPaths(state, canvas).filter((item) => item.kind === 'node').map((item) =>
    ({ id: item.id, name: state.nodes[item.id].name, path: item.path, segments: item.segments })).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

/** Returns a free local coordinate for a new document under a canvas directory. */
export function findFreeDocumentPlacement(
  state: GraphState,
  canvas: CanvasRecord,
  directoryId: string,
  documentId: string,
  preferredWorld?: Point
): Placement {
  const natural = buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true });
  const directory = natural.blocks.find((block) => block.id === directoryId);
  const origin = directory
    ? {
        x: directory.anchor.x + RECORD_PADDING,
        y: directory.anchor.y + RECORD_HEADER_HEIGHT + RECORD_PADDING,
      }
    : { x: 0, y: 0 };
  const newBounds = canvasDirectory(canvas, documentId)
    ? measureDirectory(state, canvas, documentId, { zoom: 1, ignoreCollapse: true }, new Set())
    : measureDocument(state, documentId, canvas, { zoom: 1, ignoreCollapse: true });
  const reservedNew = unionRect(newBounds, collapsedRect);
  // Parent frames contain children by definition. Compare whole unrelated
  // document frames and canvas-local leaf nodes; this also reserves folded data.
  const existing = natural.blocks
    .filter((block) => {
      if (block.kind === 'node') return true;
      let ancestor: string | undefined = directoryId;
      while (ancestor) {
        if (ancestor === block.id) return false;
        ancestor = natural.parentOf.get(ancestor);
      }
      return true;
    })
    .map((block) => block.rect);
  const preferred = preferredWorld
    ? { x: preferredWorld.x - origin.x, y: preferredWorld.y - origin.y }
    : { x: 0, y: 0 };
  const candidate = (point: Point): Rect =>
    translate(reservedNew, { x: origin.x + point.x, y: origin.y + point.y });
  if (!existing.some((rect) => overlaps(candidate(preferred), rect, BLOCK_GAP))) {
    return { ...preferred, source: 'auto' };
  }
  const stepX = Math.max(NODE_WIDTH + BLOCK_GAP, reservedNew.width + BLOCK_GAP);
  const stepY = Math.max(NODE_HEIGHT + BLOCK_GAP, reservedNew.height + BLOCK_GAP);
  for (let ring = 1; ring <= 24; ring += 1) {
    for (let col = -ring; col <= ring; col += 1) {
      for (const row of [-ring, ring]) {
        const point = { x: preferred.x + col * stepX, y: preferred.y + row * stepY };
        if (!existing.some((rect) => overlaps(candidate(point), rect, BLOCK_GAP))) {
          return { ...point, source: 'auto' };
        }
      }
    }
    for (let row = -ring + 1; row < ring; row += 1) {
      for (const col of [-ring, ring]) {
        const point = { x: preferred.x + col * stepX, y: preferred.y + row * stepY };
        if (!existing.some((rect) => overlaps(candidate(point), rect, BLOCK_GAP))) {
          return { ...point, source: 'auto' };
        }
      }
    }
  }
  const furthest = Math.max(0, ...existing.map((rect) => rect.x + rect.width));
  return { x: furthest - origin.x - reservedNew.x + BLOCK_GAP, y: preferred.y, source: 'auto' };
}
