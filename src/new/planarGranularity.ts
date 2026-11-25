import { canvasDirectory } from '../v3/canvas';
import { buildRenderModel, fallbackPlacementAt, type EdgeVisibilityOptions } from '../v3/layout';
import { nodeGeometry } from '../v3/nodeGeometry';
import { presentationPlacement } from '../v3/presentationLayout';
import { RectangleIndex } from '../v3/rectangleIndex';
import { nearestRegionSpace } from '../v3/regionLayout';
import { COLLAPSED_HEIGHT, NODE_HEIGHT, NODE_WIDTH, PLANAR_HEADER_HEIGHT, RECORD_MIN_WIDTH, RECORD_PADDING,
  type CanvasRecord, type GraphState, type Point, type Rect } from '../v3/types';
import { groupExpanded, projectGranularity, type CanvasGranularity, type GranularityIndex,
  type GranularityProjection, type ObservationScope, type SubgraphRelation } from './canvasGranularity';

interface PlanarProjection extends GranularityProjection {
  foldedBeforeScope?: ReadonlySet<string>;
}

/** A planar group is an enclosing frame. Keep a folded frame as the visible
 * representative of every endpoint inside it, including manually opened descendants. */
export function projectPlanarGranularity(index: GranularityIndex, state: CanvasGranularity, selection: ReadonlySet<string>,
  scope: ObservationScope = 'all', visibility: EdgeVisibilityOptions = {}): PlanarProjection {
  const projection = projectGranularity(index, state, selection, scope, visibility);
  const scene = hideFoldedContents(index, projection, projection.collapsedGroupIds);
  if (scope === 'all') return scene;
  const expansion = new Map<string,boolean>(), before = new Set(scene.collapsedGroupIds);
  for (const id of scene.groupIds) if (!groupExpanded(index, state, id, expansion)) before.add(id);
  return before.size === scene.collapsedGroupIds.size ? scene : { ...scene, foldedBeforeScope: before };
}

/** A local fold closes the entire branch in every view. The spatial overview
 * can still show all the coarse shells after a global switch to coarse detail. */
export function projectSpatialGranularity(index: GranularityIndex, state: CanvasGranularity, selection: ReadonlySet<string>,
  scope: ObservationScope = 'all', visibility: EdgeVisibilityOptions = {}): GranularityProjection {
  const scene = projectGranularity(index, state, selection, scope, visibility);
  const folded = scope === 'all' && !state.defaultExpanded
    ? new Set([...scene.collapsedGroupIds].filter(id => state.groups[id]?.expanded === false)) : scene.collapsedGroupIds;
  return hideFoldedContents(index, scene, folded);
}

function hideFoldedContents(index: GranularityIndex, scene: GranularityProjection, folded: ReadonlySet<string>): GranularityProjection {
  if (!folded.size) return scene;
  const representatives = new Map<string, string>();
  function frame(id: string): string {
    const cached = representatives.get(id);
    if (cached !== undefined) return cached;
    const parent = index.parents.get(id);
    // The canvas has no enclosing card. Its direct subgraphs remain accessible
    // in the all-folded overview, even when root-level nodes are folded.
    const outer = parent && parent !== index.rootId ? frame(parent) : undefined;
    const result = outer && (outer !== parent || folded.has(outer)) ? outer : id;
    representatives.set(id, result);
    return result;
  }
  const groupIds = new Set([...scene.groupIds].map(frame));
  const collapsedGroupIds = new Set([...scene.collapsedGroupIds].filter(id => groupIds.has(id)));
  const nodeIds = new Set([...scene.nodeIds].filter(id => {
    const parent = index.parents.get(id)!;
    return groupIds.has(parent) && !folded.has(parent);
  }));
  const visible = (id: string) => index.nodeIds.has(id) ? nodeIds.has(id) : !index.groupIds.has(id) || groupIds.has(id);
  const hiddenMembers = new Map<string, string[]>();
  const edges = scene.edges.filter(edge => {
    if (visible(edge.sourceNodeId) && visible(edge.targetNodeId)) return true;
    const relationId = index.relationOfEdge.get(edge.edgeId);
    if (relationId) {
      const members = hiddenMembers.get(relationId);
      if (members) members.push(edge.edgeId); else hiddenMembers.set(relationId, [edge.edgeId]);
    }
    return false;
  });
  const residual = new Map(scene.relations.map(relation => [relation.id, relation]));
  for (const [id, hidden] of hiddenMembers) {
    const original = index.relations.get(id)!;
    const members = new Set([...(residual.get(id)?.memberEdgeIds ?? []), ...hidden]);
    const memberEdgeIds = original.memberEdgeIds.filter(member => members.has(member));
    residual.set(id, { ...original, memberEdgeIds, relationCount: memberEdgeIds.length });
  }
  const relations: SubgraphRelation[] = [];
  for (const relation of residual.values()) {
    const sourceSubgraphId = frame(relation.sourceSubgraphId), targetSubgraphId = frame(relation.targetSubgraphId);
    if (sourceSubgraphId === targetSubgraphId) continue;
    relations.push(sourceSubgraphId === relation.sourceSubgraphId && targetSubgraphId === relation.targetSubgraphId
      ? relation : { ...relation, sourceSubgraphId, targetSubgraphId });
  }
  return { nodeIds, groupIds, collapsedGroupIds, edges, relations };
}

/** Spatial routers and ports use the visible frames, while layout, ownership,
 * original direction and the complete member lists remain tied to the graph. */
export function visibleRelationIndex(index: GranularityIndex, scene: GranularityProjection): GranularityIndex {
  let relations: Map<string, SubgraphRelation> | undefined;
  for (const { id, sourceSubgraphId, targetSubgraphId } of scene.relations) {
    const pair = index.relations.get(id);
    if (pair && (sourceSubgraphId !== pair.sourceSubgraphId || targetSubgraphId !== pair.targetSubgraphId)) {
      relations ??= new Map(index.relations);
      relations.set(id, { ...pair, sourceSubgraphId, targetSubgraphId });
    }
  }
  return relations ? { ...index, relations } : index;
}

const compactFrame: Rect = { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT };
type ViewOffsets = NonNullable<CanvasRecord['presentationPlacements']>;

/** A dragged object uses its requested anchor, even if the drop matches the
 * canonical coordinates underneath a previous expansion offset. */
export function withoutPlanarOffsets(settings: CanvasGranularity, ids: readonly string[]): CanvasGranularity {
  const offsets = settings.planarPlacements;
  if (!offsets || !ids.some(id => Object.hasOwn(offsets, id))) return settings;
  const remaining = { ...offsets };
  for (const id of ids) delete remaining[id];
  return { ...settings, planarPlacements: remaining };
}

/** Measure from the currently drawn child rectangles. The same local coordinate
 * system is used by edge routing, headers, dragging and expansion avoidance. */
function measurePlanarFrames(graph: GraphState, canvas: CanvasRecord, parents: ReadonlyMap<string, string>,
  folded: ReadonlySet<string>, offsets?: ViewOffsets, visible?: ReadonlySet<string>, previousFrames?: ReadonlyMap<string, Rect>) {
  const frames = new Map<string, Rect>(), positions = new Map<string, Point>();
  let adjusted = offsets;
  const rootId = canvas.canvasId;
  function measure(id: string): Rect {
    if (graph.nodes[id]) return nodeGeometry(graph.nodes[id]);
    if (id !== rootId && folded.has(id)) {
      frames.set(id, compactFrame);
      return compactFrame;
    }
    const root = id === rootId, doc = graph.documents[id];
    const children = canvasDirectory(canvas, id)?.childIds ?? (doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : []);
    const order = root ? children : children.filter(child => !canvas.excludedDocumentIds?.includes(child)).sort();
    const placements = doc?.placements ?? canvas.placements;
    let left = 0, top = 0, right = 0, bottom = 0;
    const siblings = [];
    for (let i = 0; i < order.length; i++) {
      const child = order[i];
      if (parents.get(child) !== id || (visible && !visible.has(child)) || (root && folded.has(id) && graph.nodes[child])) continue;
      const base = placements[child] ?? fallbackPlacementAt(i);
      const override = offsets?.[child];
      const pos = override && override.parentId === id && override.baseX === base.x && override.baseY === base.y
        ? override : presentationPlacement(canvas, child, id, base);
      const frame = measure(child);
      const rect = { ...frame, x: pos.x + frame.x, y: pos.y + frame.y };
      const old = previousFrames?.get(child);
      const grew = previousFrames && !graph.nodes[child] && !folded.has(child)
        && (!old || rect.width > old.width || rect.height > old.height);
      siblings.push({ child, base, rect, frame, grew });
    }
    if (siblings.some(sibling => sibling.grew)) {
      // Fixed neighbours are indexed first. A bulk expansion visits each
      // sibling set once and only searches for free space on an actual collision.
      const occupied = new RectangleIndex(siblings.filter(s => !s.grew).map(s => s.rect));
      for (const { child, rect, base, frame, grew } of siblings) {
        if (!grew) continue;
        if (occupied.collides(rect)) {
          const position = nearestRegionSpace(rect, rect, occupied, root);
          Object.assign(rect, position);
          if (adjusted === offsets) adjusted = Object.assign(Object.create(null), offsets);
          adjusted![child] = { x: position.x - frame.x, y: position.y - frame.y, parentId: id, baseX: base.x, baseY: base.y };
        }
        occupied.add(rect);
      }
    }
    for (const { child, rect, frame } of siblings) {
      positions.set(child, { x: rect.x - frame.x, y: rect.y - frame.y });
      // Legacy negative local coordinates expand the enclosing frame to the
      // left/top. Preserve the children's spacing and their draggable anchors.
      left = Math.min(left, rect.x); top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
    }
    const result = { x: left, y: top, width: Math.max(RECORD_MIN_WIDTH, right - left + RECORD_PADDING * 2),
      height: Math.max(COLLAPSED_HEIGHT, bottom - top + PLANAR_HEADER_HEIGHT + RECORD_PADDING * 2) };
    frames.set(id, result);
    return result;
  }
  measure(rootId);
  return { frames, positions, adjusted };
}

export function adjustPlanarExpansion(graph: GraphState, canvas: CanvasRecord, index: GranularityIndex,
  previous: CanvasGranularity, next: CanvasGranularity): CanvasGranularity {
  if (previous.defaultExpanded === next.defaultExpanded && previous.groups === next.groups) return next;
  const oldFolded = new Set<string>(), folded = new Set<string>();
  const before = new Map<string, boolean>(), after = new Map<string, boolean>();
  let opening = false;
  for (const id of index.groupIds) {
    if (!groupExpanded(index, previous, id, before)) oldFolded.add(id);
    if (!groupExpanded(index, next, id, after)) folded.add(id);
    else if (oldFolded.has(id)) opening = true;
  }
  if (!opening) return next;
  const old = measurePlanarFrames(graph, canvas, index.parents, oldFolded, previous.planarPlacements);
  const { adjusted } = measurePlanarFrames(graph, canvas, index.parents, folded, next.planarPlacements, undefined, old.frames);
  return adjusted === next.planarPlacements ? next : { ...next, planarPlacements: adjusted };
}

export function buildPlanarGranularityModel(graph: GraphState, canvas: CanvasRecord, scene: PlanarProjection,
  parents: ReadonlyMap<string, string>, offsets?: ViewOffsets) {
  const visibleIds = new Set([...scene.nodeIds, ...scene.groupIds]);
  const compactGroups = scene.collapsedGroupIds;
  // A temporarily opened frame can cover the foreign endpoint it just
  // exposed. Resolve these new collisions without persisting scope offsets.
  const before = scene.foldedBeforeScope && measurePlanarFrames(graph, canvas, parents, scene.foldedBeforeScope, offsets, visibleIds);
  const { frames, positions } = measurePlanarFrames(graph, canvas, parents, compactGroups, offsets, visibleIds, before?.frames);
  return buildRenderModel(graph, canvas, {
    zoom: 1, visibleIds, deferRouting: true, projection: { edges: scene.edges, compactGroups, frames, positions },
  });
}
