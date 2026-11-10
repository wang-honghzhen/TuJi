import { getCanvasPaths } from '@/v3/paths';
import type { GraphState } from '@/v3/types';

/** Resolve saved references against today's graph, independent of folding and focus filters. */
export function resolvePresentationTargets(graph: GraphState | null | undefined, canvasId: string, refs: readonly string[]) {
  const available: string[] = [], missing: string[] = [], outside: string[] = [];
  if (!graph || !refs.length) return { available, missing, outside, notice: '' };
  const canvas = graph.canvases.find(item => item.canvasId === canvasId);
  const members = new Set(canvas ? getCanvasPaths(graph, canvas).map(item => item.id) : []);
  const edges = new Map(graph.edges.map(edge => [edge.edgeId, edge]));
  const unique = new Set(refs);
  for (const id of unique) {
    const edge = edges.get(id);
    const exists = graph.nodes[id] || graph.documents[id] || edge
      || graph.canvases.some(item => item.canvasId === id || item.directories[id]);
    if (!exists) missing.push(id);
    else if (members.has(id) || edge && (members.has(edge.sourceNodeId) || members.has(edge.targetNodeId))) available.push(id);
    else outside.push(id);
  }
  const notices = [];
  if (missing.length) notices.push(missing.length === unique.size
    ? '本段指定的对象已不存在' : `本段有 ${missing.length} 个指定对象已不存在`);
  if (outside.length) notices.push(outside.length === unique.size
    ? '本段指定的对象不在当前画布中' : `本段有 ${outside.length} 个指定对象不在当前画布中`);
  return { available, missing, outside, notice: notices.join('；') };
}
