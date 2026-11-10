import { canvasDirectory } from './canvas';
import { getHierarchyIndex } from './hierarchyIndex';
import type { GraphEdge, GraphState } from './types';

export interface ProjectedRelation { source: string; target: string; weight: number; edgeIds: string[] }
export interface LayoutRegion { key: string; id: string; canvasId?: string; depth: number; relations: ProjectedRelation[] }
export const regionKey = (id: string, canvasId?: string) => JSON.stringify([canvasId ?? null, id]);
const cache = new WeakMap<GraphState, Map<string, LayoutRegion>>();

/** Container endpoints belong to a boundary, not to an imaginary child of themselves. */
export function projectRelation(source: string, target: string, parents: ReadonlyMap<string, string>) {
  const path = (id: string) => {
    const result: string[] = []; const seen = new Set<string>(); let current: string | undefined = id;
    while (current && !seen.has(current)) { seen.add(current); result.push(current); current = parents.get(current); }
    return result;
  };
  const a = path(source), b = path(target), other = new Set(b);
  const parent = a.find(id => other.has(id)); if (!parent) return null;
  const ai = a.indexOf(parent), bi = b.indexOf(parent);
  if (!ai || !bi) return null;
  return { parent, source: a[ai - 1], target: b[bi - 1], depth: a.length - ai - 1 };
}

export function getRelationProjection(state: GraphState): Map<string, LayoutRegion> {
  const saved = cache.get(state); if (saved) return saved;
  const index = getHierarchyIndex(state), result = new Map<string, LayoutRegion>();
  const canonical = new Map([...index.documentParents, ...index.nodeParents]);
  const append = (edge: GraphEdge, parents: Map<string, string>, canvasId?: string) => {
    const projected = projectRelation(edge.sourceNodeId, edge.targetNodeId, parents); if (!projected) return;
    if (canvasId && state.documents[projected.parent]) return; // Canonical internals are shared across canvases.
    if (!canvasId && !state.documents[projected.parent]) return;
    const key = regionKey(projected.parent, canvasId);
    const region = result.get(key) ?? { key, id: projected.parent, canvasId, depth: projected.depth, relations: [] };
    result.set(key, region);
    const relation = region.relations.find(r => r.source === projected.source && r.target === projected.target);
    if (relation) { relation.edgeIds.push(edge.edgeId); relation.weight = Math.min(4, Math.sqrt(relation.edgeIds.length)); }
    else region.relations.push({ source: projected.source, target: projected.target, weight: 1, edgeIds: [edge.edgeId] });
  };
  const edges = state.edges.filter(e => !e.removed);
  edges.forEach(edge => append(edge, canonical));
  for (const canvas of state.canvases) {
    const parents = new Map<string, string>(), visited = new Set<string>();
    const walk = (id: string, parent?: string) => {
      if (visited.has(id) || canvas.excludedDocumentIds?.includes(id)) return;
      visited.add(id); if (parent) parents.set(id, parent);
      const children = canvasDirectory(canvas, id)?.childIds ?? (state.documents[id] ?
        [...state.documents[id].childNodeIds, ...state.documents[id].childDocumentIds] : []);
      children.forEach(child => walk(child, id));
    };
    walk(canvas.canvasId);
    edges.forEach(edge => { if (visited.has(edge.sourceNodeId) && visited.has(edge.targetNodeId)) append(edge, parents, canvas.canvasId); });
  }
  cache.set(state, result); return result;
}
