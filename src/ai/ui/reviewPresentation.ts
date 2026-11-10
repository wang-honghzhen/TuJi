import type { AppSnapshot } from '../domain';
import { expandReviewSelection, reviewEntries, reviewUnitRefs } from '../changeReview';
import { getCanvasPaths } from '@/v3/paths';

/** User-facing scope is about actual objects; submission and unit IDs stay in details. */
export function reviewObjectRefs(state: AppSnapshot, unitIds: string[]): string[] {
  const ids = new Set(expandReviewSelection(state, unitIds));
  return [...new Set(reviewEntries(state).filter(e => ids.has(e.unit.id)).flatMap(e => reviewUnitRefs(e.unit)))];
}

export function reviewObjectName(state: AppSnapshot, canvasId: string): (ref: string) => string {
  const graph = state.graph, canvas = graph?.canvases.find(c => c.canvasId === canvasId);
  const paths = new Map(graph && canvas ? getCanvasPaths(graph, canvas).map(p => [p.id, p.segments.at(-1)?.name]) : []);
  const ghosts = new Map(reviewEntries(state).flatMap(e => e.unit.ghosts.map(g => [g.id, g.name] as const)));
  const nodeName = (id: string) => paths.get(id) || graph?.nodes[id]?.name || graph?.documents[id]?.name || ghosts.get(id);
  return ref => {
    const edge = graph?.edges.find(e => e.edgeId === ref);
    return edge ? `关系 · ${edge.edgeContent || `${nodeName(edge.sourceNodeId) || '节点'} → ${nodeName(edge.targetNodeId) || '节点'}`}`
      : nodeName(ref) || '未命名对象';
  };
}
