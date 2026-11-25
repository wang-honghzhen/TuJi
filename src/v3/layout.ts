import { nodeGeometry } from './nodeGeometry';
import { canvasDirectory } from './canvas';
import type {
  CanvasDirectory,
  CanvasRecord,
  ConnectionSide,
  GraphEdge,
  GraphRecord,
  GraphState,
  Placement,
  Point,
  Rect,
} from './types';
import { cachedPortChooser, facingSide, makeEdgeRoute, makeStubRoute, makeUnobstructedRoute, placeEdgeLabel, portPoint,
  type EdgeLabel, type EdgeRoute } from './edgeGeometry';
import { getCanvasPaths, type PathSegment } from './paths';
import { getNaturalGeometry, measureNaturalRegions, nearestRegionSpace, type RegionGeometry } from './regionLayout';
import { getCanvasMembership, canvasEdgeScope, type CanvasEdgeScope } from './hierarchyIndex';
import { RectangleIndex } from './rectangleIndex';
import { presentationGeometry, presentationPlacement } from './presentationLayout';
import {
  BLOCK_GAP,
  COLLAPSED_HEIGHT,
  COLLAPSED_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  RECORD_HEADER_HEIGHT, PLANAR_HEADER_HEIGHT,
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
  /** An expanded planar frame may reserve a shorter title above its children. */
  headerHeight?: number;
  /** Full world footprint of a group represented by a compact 3D overview card. */
  spatialSummary?: { expandedRect: Rect; unfoldScale: number };
}

export interface RenderEdge {
  edge: GraphEdge;
  kind: 'full' | 'filtered' | 'outside';
  scope: CanvasEdgeScope;
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

export function regionContentOrigin(block: RenderBlock): Point {
  return { x: block.anchor.x + RECORD_PADDING,
    y: block.anchor.y + (block.headerHeight ?? RECORD_HEADER_HEIGHT) + RECORD_PADDING };
}

export interface EdgeVisibilityOptions {
  showOutsideEdges?: boolean;
  showInternalEdges?: boolean;
  showCrossEdges?: boolean;
  revealedEdgeIds?: ReadonlySet<string>;
}

export interface RenderOptions extends EdgeVisibilityOptions {
  zoom: number;
  /** The planar projection supplies measured frames and local child origins. */
  projection?: { edges: readonly GraphEdge[]; compactGroups: ReadonlySet<string>;
    frames: ReadonlyMap<string, Rect>; positions: ReadonlyMap<string, Point> };
  ignoreCollapse?: boolean;
  previousLod?: ReadonlySet<string>;
  focusIds?: ReadonlySet<string>;
  /** In 3D, these branches stay open when their descendants occupy another
   * plane or are selected. Explicitly folded groups still follow canvas state. */
  spatialDetailAncestors?: ReadonlySet<string>;
  visibleIds?: ReadonlySet<string>;
  /** Geometry readers never pay for paths and labels. The UI delegates precise routing to a worker. */
  skipEdges?: boolean;
  deferRouting?: boolean;
}

export function isEdgeScopeVisible(scope: CanvasEdgeScope, id: string, options: EdgeVisibilityOptions): boolean {
  if (scope === 'outside') return options.showOutsideEdges !== false;
  if (scope === 'internal') return options.showInternalEdges !== false;
  return options.showCrossEdges !== false || Boolean(options.revealedEdgeIds?.has(id));
}

const empty: Rect = { x: 0, y: 0, width: 0, height: 0 };
const projectionPorts = cachedPortChooser();
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

export function fallbackPlacementAt(index: number): Placement {
  return {
    x: (index % 3) * (NODE_WIDTH + BLOCK_GAP),
    y: Math.floor(index / 3) * (NODE_HEIGHT + BLOCK_GAP),
    source: 'auto',
  };
}

function placement(id: string, siblings: string[], positions: Record<string, Placement>): Placement {
  return positions[id] ?? fallbackPlacementAt(Math.max(0, siblings.indexOf(id)));
}

/** The 3D camera supplies the square root of projected area per world unit.
 * Keep very long groups open if they still span a substantial part of the view. */
function spatialGroupThreshold(full: Rect, state: GraphState, dir?: CanvasDirectory, doc?: GraphRecord) {
  if (!dir?.childIds.length && !doc?.childNodeIds.length && !doc?.childDocumentIds.length) return undefined;
  const directNodes = doc ? doc.childNodeIds.length : dir!.childIds.reduce((count, id) => count + Number(!!state.nodes[id]), 0);
  const span = Math.sqrt(full.width * full.height);
  const bySize = Math.min(210 / span, 360 / Math.max(full.width, full.height));
  // A single broad, densely populated leaf can fill the view even when each
  // member has less than a readable thumbnail's worth of screen space.
  const byDensity = 44 * Math.sqrt(directNodes) / span;
  const fold = Math.min(.28, Math.max(bySize, byDensity));
  return { fold, unfold: fold * 1.25 };
}

/** Display detail changes never change reserved geometry or child origins. */
function displayRegionBounds(full: Rect, id: string, canvas: CanvasRecord | undefined,
  options: RenderOptions, lod: Set<string>, stableZoom?: ZoomRange, spatial?: ReturnType<typeof spatialGroupThreshold>): Rect {
  if (options.ignoreCollapse || !canvas || options.focusIds?.has(id)) return full;
  if (canvas.collapsed[id]) return collapsedRect;
  if (options.spatialDetailAncestors && (!spatial || options.spatialDetailAncestors.has(id))) return full;
  const wasFolded = options.previousLod?.has(id) ?? false;
  // 2D folds only tiny regions. 3D also considers the members' projected density.
  const foldAt = spatial?.fold ?? Math.max(56 / full.width, 30 / full.height);
  const unfoldAt = spatial?.unfold ?? Math.max(72 / full.width, 40 / full.height);
  if (options.zoom < (wasFolded ? unfoldAt : foldAt)) {
    lod.add(id);
    if (stableZoom) stableZoom.max = Math.min(stableZoom.max, unfoldAt);
    if (spatial) {
      // Preserve the group's center while opening corridors between adjacent summaries.
      const width = Math.min(full.width * .74, full.height * 2.4);
      const height = Math.min(full.height * .66, width * .62);
      return { x: full.x + (full.width - width) / 2, y: full.y + (full.height - height) / 2, width, height };
    }
    return collapsedRect;
  }
  if (stableZoom) stableZoom.min = Math.max(stableZoom.min, foldAt);
  return full;
}

export function measureDocument(state: GraphState, documentId: string, canvas?: CanvasRecord,
  options: RenderOptions = { zoom: 1 }, _visited = new Set<string>(), lod = new Set<string>(),
  geometry = getNaturalGeometry(state)): Rect {
  const doc = state.documents[documentId], full = doc ? geometry.document(documentId) : empty;
  const spatial = options.spatialDetailAncestors && spatialGroupThreshold(full, state, undefined, doc);
  return displayRegionBounds(full, documentId, canvas, options, lod, undefined, spatial);
}

function measureDirectory(state: GraphState, canvas: CanvasRecord, directoryId: string,
  options: RenderOptions, lod: Set<string>, geometry?: RegionGeometry): Rect {
  // An import can measure a canvas that is not attached to the graph yet.
  const measured = geometry ?? getNaturalGeometry(state.canvases.includes(canvas) ? state : { ...state });
  const dir = canvasDirectory(canvas, directoryId), full = dir ? measured.directory(canvas, directoryId) : empty;
  if (directoryId === canvas.canvasId) return full;
  const spatial = options.spatialDetailAncestors && spatialGroupThreshold(full, state, dir);
  return displayRegionBounds(full, directoryId, canvas, options, lod, undefined, spatial);
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function edgeHash(id: string): number {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

interface ZoomRange { min: number; max: number }

/** Reuse world geometry while all visible regions stay on the same side of
 * their next fold/unfold threshold. Callers replace the projector on graph,
 * filter or layout changes. Screen-space culling still runs at every zoom. */
export function createZoomProjection(state: GraphState, canvas: CanvasRecord, options: Omit<RenderOptions, 'zoom'>) {
  let model: RenderModel | undefined;
  let range: ZoomRange;
  return (zoom: number) => {
    if (model && zoom >= range.min && zoom < range.max) return model;
    range = { min: 0, max: Infinity };
    model = buildRenderModel(state, canvas, { ...options, zoom, previousLod: model?.lodCollapsed ?? options.previousLod }, range);
    return model;
  };
}

export function buildRenderModel(
  state: GraphState,
  canvas: CanvasRecord,
  options: RenderOptions,
  stableZoom?: ZoomRange
): RenderModel {
  const geometry = options.projection ? undefined : presentationGeometry(state, canvas,
    measureNaturalRegions(state.canvases.includes(canvas) ? state : { ...state }, canvas), options.ignoreCollapse);
  const blocks: RenderBlock[] = [];
  const blockIndex = new RectangleIndex();
  const byId = new Map<string, RenderBlock>();
  const lod = new Set<string>();
  const membership = getCanvasMembership(state, canvas);
  const { members, parents } = membership;
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
    const full = options.projection?.frames.get(id) ?? (dir ? geometry!.directory(canvas, id) : doc ? geometry!.document(id) : nodeGeometry(node!));
    const spatial = options.spatialDetailAncestors && spatialGroupThreshold(full, state, dir, doc);
    const local = !options.projection && (dir || doc) && id !== canvas.canvasId
      ? displayRegionBounds(full, id, canvas, options, lod, stableZoom, spatial) : full;
    const manualCollapse = Boolean(canvas.collapsed[id]) && !options.focusIds?.has(id);
    const folded = options.projection ? options.projection.compactGroups.has(id)
      : kind !== 'node' && !options.ignoreCollapse && (manualCollapse || lod.has(id));
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
      ...(options.projection && kind !== 'node' && { headerHeight: PLANAR_HEADER_HEIGHT }),
      ...(spatial && lod.has(id) && { spatialSummary: { expandedRect: translate(full, anchor), unfoldScale: spatial.unfold } }),
    };
    blocks.push(block);
    byId.set(id, block);
    if (folded || node) return;
    const childIds = dir ? dir.childIds.filter((child) => !canvas.excludedDocumentIds?.includes(child)).sort() : doc ? childrenOf(doc, canvas) : [];
    const positions = dir ? canvas.placements : doc?.placements ?? {};
    const contentOrigin = regionContentOrigin(block);
    for (const childId of childIds) {
      if (options.visibleIds && !options.visibleIds.has(childId)) continue;
      const pos = options.projection?.positions.get(childId) ?? presentationPlacement(canvas, childId, id, placement(childId, childIds, positions));
      visit(childId, id, { x: contentOrigin.x + pos.x, y: contentOrigin.y + pos.y }, depth + 1);
    }
  };
  const root = canvasDirectory(canvas, canvas.canvasId);
  if (root) {
    for (const childId of [...root.childIds].sort()) {
      if (options.visibleIds && !options.visibleIds.has(childId)) continue;
      const pos = options.projection?.positions.get(childId) ?? presentationPlacement(canvas, childId, canvas.canvasId, placement(childId, root.childIds, canvas.placements));
      visit(childId, canvas.canvasId, { x: pos.x, y: pos.y }, 0);
    }
  }

  const edges: RenderEdge[] = [];
  const bounds = blocks.reduce((acc, block) => unionRect(acc, block.rect), blocks[0]?.rect ?? empty);
  if (options.skipEdges) return { blocks, edges, bounds, membership: members, parentOf: parents, lodCollapsed: lod };
  const rootBlock: RenderBlock = { id: canvas.canvasId, kind: 'directory', name: canvas.canvasName, rect: bounds,
    anchor: { x: 0, y: 0 }, parentId: '', depth: -1, collapsed: false };
  const representative = (id: string): RenderBlock | null => {
    if (!members.has(id)) return null;
    if (options.visibleIds && !options.visibleIds.has(id)) return null;
    if (id === canvas.canvasId && blocks.length) return rootBlock;
    const visible = byId.get(id);
    if (visible) return visible;
    let current = parents.get(id);
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const block = byId.get(current);
      if (block) return block;
      current = parents.get(current);
    }
    return null;
  };

  let naturalById: Map<string, RenderBlock> | undefined;
  const endpointExists = (id: string) => Boolean(state.nodes[id] || state.documents[id] || state.canvases.some(item => canvasDirectory(item, id)));
  for (const block of blocks) blockIndex.add(block.rect);
  const blockByRect = new Map(blocks.map(block => [block.rect, block]));
  // Folding can project many distinct relations onto the same ordered pair.
  // Corridor obstacles and attachment points are identical for that pair.
  const portsBySource = new Map<RenderBlock, Map<RenderBlock, ReturnType<typeof projectionPorts>>>();
  const portsFor = (edge: GraphEdge, source: RenderBlock, target: RenderBlock) => {
    let targets = portsBySource.get(source);
    const existing = targets?.get(target);
    if (existing) return existing;
    const corridor = unionRect(source.rect, target.rect);
    const ancestorIds = new Set<string>();
    for (const block of [source, target]) {
      let id = parents.get(block.id);
      while (id && !ancestorIds.has(id)) { ancestorIds.add(id); id = parents.get(id); }
    }
    const obstacles = blockIndex.query(corridor, 12).filter(rect => rect !== source.rect && rect !== target.rect)
      .map(rect => {
        const block = blockByRect.get(rect)!;
        return ancestorIds.has(block.id) ? { ...rect, height: block.headerHeight ?? RECORD_HEADER_HEIGHT } : rect;
      });
    const ports = projectionPorts(edge, source.rect, target.rect, obstacles);
    if (!targets) { targets = new Map(); portsBySource.set(source, targets); }
    targets.set(target, ports);
    return ports;
  };
  for (const edge of options.projection?.edges ?? state.edges) {
    if (edge.removed) continue;
    if (!members.has(edge.sourceNodeId) && !members.has(edge.targetNodeId)) continue;
    if (!endpointExists(edge.sourceNodeId) || !endpointExists(edge.targetNodeId)) continue;
    const scope = canvasEdgeScope(state, membership, edge);
    if (!isEdgeScopeVisible(scope, edge.edgeId, options)) continue;
    const source = representative(edge.sourceNodeId);
    const target = representative(edge.targetNodeId);
    if (!source && !target) continue;
    if (source && target && source.id === target.id) continue;
    if (source && target) {
      const { sourceSide, targetSide, source: sourcePoint, target: targetPoint } = portsFor(edge, source, target);
      edges.push({
        edge, scope,
        kind: 'full',
        source: sourcePoint,
        target: targetPoint,
        arrowAt: edge.directed ? 'target' : null,
        sourceSide, targetSide, sourceBlockId: source.id, targetBlockId: target.id,
        route: makeUnobstructedRoute(sourcePoint, targetPoint, sourceSide, targetSide, edge.routeStyle),
      });
      continue;
    }
    const otherId = source ? edge.targetNodeId : edge.sourceNodeId;
    const filtered = members.has(otherId) && Boolean(options.visibleIds) && !options.visibleIds?.has(otherId);
    const visible = source ?? target;
    if (!visible) continue;
    if (filtered && !naturalById) {
      const natural = buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true });
      naturalById = new Map(natural.blocks.map(block => [block.id, block]));
    }
    const otherBlock = naturalById?.get(otherId);
    const otherCenter = otherBlock ? center(otherBlock.rect) : null;
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
      edge, scope,
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
    const key = [rendered.scope, ...[rendered.sourceBlockId, rendered.targetBlockId].sort()].join('\u0000');
    const group = parallel.get(key);
    if (group) group.push(rendered); else parallel.set(key, [rendered]);
  }
  for (const group of parallel.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.edge.edgeId.localeCompare(b.edge.edgeId));
    group.forEach((rendered, index) => {
      if (rendered.edge.routeStyle === 'orthogonal') return;
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
    const key = [visibleId, side, rendered.kind, rendered.scope, ...[rendered.edge.sourceNodeId, rendered.edge.targetNodeId].sort()].join('\u0000');
    const group = parallelStubs.get(key);
    if (group) group.push(rendered); else parallelStubs.set(key, [rendered]);
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
  if (!options.deferRouting) {
    const occupiedLabels = new RectangleIndex(blocks.filter(block => block.kind === 'node').map(block => block.rect));
    for (const rendered of [...edges].sort((a, b) => Number(b.scope === 'internal') - Number(a.scope === 'internal') || a.edge.edgeId.localeCompare(b.edge.edgeId))) {
      if (rendered.kind === 'full') rendered.label = placeEdgeLabel(rendered.route, rendered.edge.edgeContent, occupiedLabels);
    }
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
  const { members, parents } = getCanvasMembership(state, canvas);
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
  // An edge needs its endpoints in the projection, even when neither endpoint is selected.
  for (const edge of state.edges) {
    if (!edge.removed && selectedIds.has(edge.edgeId)) {
      if (members.has(edge.sourceNodeId)) result.add(edge.sourceNodeId);
      if (members.has(edge.targetNodeId)) result.add(edge.targetNodeId);
    }
  }
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
  const obstacles = existing.map(rect => ({ ...rect, x: rect.x - origin.x - reservedNew.x, y: rect.y - origin.y - reservedNew.y }));
  const point = nearestRegionSpace(reservedNew, preferred, obstacles, directoryId === canvas.canvasId);
  return { ...point, source: 'auto' };
}
