import { getCanvasMembership, getHierarchyIndex, retainHierarchyIndex } from './hierarchyIndex';
import type { GraphEdge, GraphState } from './types';

const cache = new WeakMap<readonly GraphEdge[], ReadonlyMap<string, number>>();

/** Canonical edges, independent of canvas projection, folding, viewport or placement. */
export function nodeConnectionCounts(edges: readonly GraphEdge[]): ReadonlyMap<string, number> {
  const previous = cache.get(edges);
  if (previous) return previous;
  const counts = new Map<string, number>(), seen = new Set<string>();
  for (const edge of edges) {
    if (edge.removed || seen.has(edge.edgeId)) continue;
    seen.add(edge.edgeId);
    for (const id of new Set([edge.sourceNodeId, edge.targetNodeId])) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  cache.set(edges, counts);
  return counts;
}

export const connectionLevel = (count: number): 'low' | 'medium' | 'high' => count >= 8 ? 'high' : count >= 3 ? 'medium' : 'low';

const subgraphCache = new WeakMap<GraphState, ReadonlyMap<string, number>>();

/** A raw edge crosses a group's boundary when exactly one endpoint belongs
 * to that group. Mounted documents keep their canonical groups and acquire
 * the enclosing local directories of each canvas that actually includes them. */
export function subgraphConnectionCounts(state: GraphState): ReadonlyMap<string, number> {
  const cached = subgraphCache.get(state);
  if (cached) return cached;
  const counts = new Map<string, number>();
  const valid = new Set([...Object.keys(state.nodes), ...Object.keys(state.documents)]);
  for (const canvas of state.canvases) {
    valid.add(canvas.canvasId);
    for (const id of Object.keys(canvas.directories)) valid.add(id);
  }
  const canonical = getHierarchyIndex(state);
  retainHierarchyIndex(state, canonical);
  const empty: ReadonlySet<string> = new Set();
  const canonicalGroups = new Map<string, ReadonlySet<string>>();
  function documentGroups(id: string): ReadonlySet<string> {
    const known = canonicalGroups.get(id);
    if (known) return known;
    const parent = canonical.documentParents.get(id);
    const inherited = parent ? documentGroups(parent) : empty;
    const groups = state.documents[id]?.kind === 'subgraph' ? new Set([...inherited, id]) : inherited;
    canonicalGroups.set(id, groups);
    return groups;
  }
  const ancestors = new Map<string, ReadonlySet<string>>();
  for (const [id, owner] of canonical.nodeParents) ancestors.set(id, documentGroups(owner));
  for (const id of Object.keys(state.documents)) ancestors.set(id, documentGroups(id));
  for (const canvas of state.canvases) {
    if (!Object.keys(canvas.directories).length) continue;
    const { parents } = getCanvasMembership(state, canvas);
    const localGroups = new Map<string, ReadonlySet<string>>();
    function directories(id: string): ReadonlySet<string> {
      const known = localGroups.get(id);
      if (known) return known;
      const parent = parents.get(id);
      const inherited = parent ? directories(parent) : empty;
      const groups = Object.hasOwn(canvas.directories, id) ? new Set([...inherited, id]) : inherited;
      localGroups.set(id, groups);
      return groups;
    }
    for (const id of parents.keys()) {
      const local = directories(id);
      if (!local.size) continue;
      const original = ancestors.get(id);
      ancestors.set(id, original?.size ? new Set([...original, ...local]) : local);
    }
  }
  const seen = new Set<string>();
  for (const edge of state.edges) {
    const { edgeId, sourceNodeId, targetNodeId } = edge;
    if (edge.removed || edge.membershipFor || seen.has(edgeId) || !valid.has(sourceNodeId) || !valid.has(targetNodeId)) continue;
    seen.add(edgeId);
    const from = ancestors.get(sourceNodeId) ?? empty, to = ancestors.get(targetNodeId) ?? empty;
    if (from === to) continue;
    for (const id of from) if (!to.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of to) if (!from.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  subgraphCache.set(state, counts);
  return counts;
}
