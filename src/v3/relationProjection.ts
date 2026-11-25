import { canvasEdgeScope, getCanvasMembership } from './hierarchyIndex';
import type { CanvasRecord, GraphState } from './types';

export interface ProjectedTerminal { source: string; target: string; count: number }
export interface ProjectedRelation { source: string; target: string; weight: number; edgeIds: string[]; directed?: boolean; terminals?: ProjectedTerminal[] }
export interface LayoutRegion { key: string; id: string; canvasId?: string; depth: number; relations: ProjectedRelation[] }
export const regionKey = (id: string, canvasId?: string) => JSON.stringify([canvasId ?? null, id]);
const cache = new WeakMap<GraphState, Map<string, Map<string, LayoutRegion>>>();

function canvasProjection(state: GraphState, canvas: CanvasRecord): Map<string, LayoutRegion> {
  let byCanvas = cache.get(state);
  if (!byCanvas) { byCanvas = new Map(); cache.set(state, byCanvas); }
  const saved = byCanvas.get(canvas.canvasId);
  if (saved) return saved;
  const result = new Map<string, LayoutRegion>();
  const membership = getCanvasMembership(state, canvas);
  const byEndpoints = new Map<string, ProjectedRelation>();
  for (const edge of state.edges) {
    if (edge.removed || edge.sourceNodeId === edge.targetNodeId || canvasEdgeScope(state, membership, edge) !== 'internal') continue;
    const parent = membership.parents.get(edge.sourceNodeId)!;
    const owner = state.documents[parent] ? undefined : canvas.canvasId;
    const key = regionKey(parent, owner);
    let region = result.get(key);
    if (!region) {
      let depth = 0, ancestor = membership.parents.get(parent);
      while (ancestor) { depth++; ancestor = membership.parents.get(ancestor); }
      region = { key, id: parent, canvasId: owner, depth, relations: [] };
      result.set(key, region);
    }
    const directed = edge.directed !== false;
    const [source, target] = !directed && edge.sourceNodeId > edge.targetNodeId
      ? [edge.targetNodeId, edge.sourceNodeId] : [edge.sourceNodeId, edge.targetNodeId];
    const pair = JSON.stringify([source, target, directed]);
    const existing = byEndpoints.get(pair);
    if (existing) {
      existing.edgeIds.push(edge.edgeId);
      existing.weight = Math.min(4, Math.sqrt(existing.edgeIds.length));
    } else {
      const relation = { source, target, directed, weight: 1, edgeIds: [edge.edgeId] };
      region.relations.push(relation);
      byEndpoints.set(pair, relation);
    }
  }
  byCanvas.set(canvas.canvasId, result);
  return result;
}

export function getRelationProjection(state: GraphState, canvasId?: string): Map<string, LayoutRegion> {
  if (canvasId !== undefined) {
    const canvas = state.canvases.find(item => item.canvasId === canvasId);
    return canvas ? canvasProjection(state, canvas) : new Map();
  }
  const result = new Map<string, LayoutRegion>();
  for (const canvas of state.canvases) for (const [key, region] of canvasProjection(state, canvas)) {
    if (!result.has(key)) result.set(key, region);
  }
  return result;
}

/** Only a new or changed local affinity can trigger automatic placement. A
 * reparent can introduce one without changing the edge record. */
export function changedInternalEdgeIds(before: GraphState, after: GraphState, canvasId: string): string[] {
  const nextCanvas = after.canvases.find(canvas => canvas.canvasId === canvasId);
  if (!nextCanvas) return [];
  const oldCanvas = before.canvases.find(canvas => canvas.canvasId === canvasId);
  const oldMembership = oldCanvas && getCanvasMembership(before, oldCanvas);
  const nextMembership = getCanvasMembership(after, nextCanvas);
  if (oldMembership === nextMembership && before.edges === after.edges) return [];
  const previous = new Map(before.edges.map(edge => [edge.edgeId, edge]));
  return after.edges.filter(edge => {
    const old = previous.get(edge.edgeId);
    if (old === edge && oldMembership === nextMembership) return false;
    if (edge.removed || edge.sourceNodeId === edge.targetNodeId || canvasEdgeScope(after, nextMembership, edge) !== 'internal') return false;
    return !old || old.removed || old.sourceNodeId !== edge.sourceNodeId || old.targetNodeId !== edge.targetNodeId ||
      old.directed !== edge.directed || !oldMembership || canvasEdgeScope(before, oldMembership, old) !== 'internal' ||
      oldMembership.parents.get(old.sourceNodeId) !== nextMembership.parents.get(edge.sourceNodeId);
  }).map(edge => edge.edgeId);
}
