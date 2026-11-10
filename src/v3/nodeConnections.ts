import type { GraphEdge } from './types';

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
