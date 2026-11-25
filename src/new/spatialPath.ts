import type { RenderEdge } from '../v3/layout';
import type { GraphEdge } from '../v3/types';

export interface PathStep {
  from: string;
  to: string;
  edge: GraphEdge;
}

/** A hop follows a visible, original node-to-node relation. A folded group's
 * shared representative never implies that its hidden members are connected. */
export function findVisiblePath(edges: readonly Pick<RenderEdge,'edge'|'kind'|'sourceBlockId'|'targetBlockId'|'aggregateEdgeIds'>[], start: string, end: string): PathStep[] | null {
  if (start === end) return [];
  const outgoing = new Map<string, PathStep[]>();
  function append(step: PathStep) {
    const batch = outgoing.get(step.from);
    if (batch) batch.push(step); else outgoing.set(step.from, [step]);
  }
  for (const {edge, kind, sourceBlockId, targetBlockId, aggregateEdgeIds} of edges) {
    if (kind !== 'full' || edge.removed || aggregateEdgeIds?.length || sourceBlockId !== edge.sourceNodeId || targetBlockId !== edge.targetNodeId) continue;
    append({from:sourceBlockId, to:targetBlockId, edge});
    if (!edge.directed) append({from:targetBlockId, to:sourceBlockId, edge});
  }
  // Keep equal-length paths stable as the routing worker updates the scene.
  for (const batch of outgoing.values()) batch.sort((a,b)=>a.edge.edgeId < b.edge.edgeId ? -1 : a.edge.edgeId > b.edge.edgeId ? 1 : 0);
  const previous = new Map<string, PathStep>(), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const step of outgoing.get(queue[i]) ?? []) {
      if (step.to === start || previous.has(step.to)) continue;
      previous.set(step.to,step);
      if (step.to === end) {
        const path: PathStep[] = [];
        for (let at = end; at !== start;) {
          const hop = previous.get(at)!;
          path.push(hop);
          at = hop.from;
        }
        return path.reverse();
      }
      queue.push(step.to);
    }
  }
  return null;
}
