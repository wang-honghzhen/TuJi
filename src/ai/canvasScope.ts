import type { GraphState } from '@/v3/types';
import { getCanvasPaths } from '@/v3/paths';

export function canvasMemberIds(graph: GraphState, canvasId: string): Set<string> {
  const canvas = graph.canvases.find(value => value.canvasId === canvasId);
  const members = new Set(canvas ? getCanvasPaths(graph, canvas).map(row => row.id) : []);
  for (const edge of graph.edges) if (!edge.removed && (members.has(edge.sourceNodeId) || members.has(edge.targetNodeId))) members.add(edge.edgeId);
  return members;
}
