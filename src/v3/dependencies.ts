import type { GraphEdge } from './types';

/** A dependency is visible only when both node endpoints are accessible. */
export function visibleDependency(edge: GraphEdge, visibleNode: (id: string) => boolean) {
  return edge.relationKind === 'dependency' && edge.directed && !edge.membershipFor && !edge.removed
    && visibleNode(edge.sourceNodeId) && visibleNode(edge.targetNodeId);
}
