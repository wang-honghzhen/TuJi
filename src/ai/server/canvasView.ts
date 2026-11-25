import type { GraphState } from '@/v3/types';
import { getCanvasPaths, type GraphPath } from '@/v3/paths';
import { getSpatialLevels } from '@/v3/spatialLevels';
import { canvasOf, graphEntityLookup } from './graph';
import { hash } from './repository';
type Row = GraphPath & { children: string[]; readable: boolean; version?: string; content: string; spatial?: { layer: number; offset: number } };
export interface CanvasIndex { graph: GraphState; canvasId: string; rootId: string; rows: Map<string, Row>; edges: GraphState['edges']; members: Set<string>; knownRefs: string[]; entity: (ref: string) => unknown }

/** A structural placeholder or a node in another canvas is not a readable child. */
export function hasDirectNodes(index: CanvasIndex, refId: string): boolean {
  return index.rows.get(refId)?.children.some(id => {
    const child = index.rows.get(id);
    return child?.kind === 'node' && child.readable;
  }) ?? false;
}

/** Ancestors of explicitly attached members are structural placeholders, never extra read authority. */
export function canvasIndex(graph: GraphState, canvasId: string, allowed: Set<string>, entity = graphEntityLookup(graph)): CanvasIndex {
  const canvas = canvasOf(graph, canvasId), paths = getCanvasPaths(graph, canvas), included = new Set<string>();
  const pathsById = new Map<string, GraphPath>();
  for (const row of paths) if (!pathsById.has(row.id)) pathsById.set(row.id, row);
  for (const row of paths) if (allowed.has(row.id)) row.segments.forEach(segment => included.add(segment.id));
  const members = new Set(paths.map(row => row.id));
  const edges = graph.edges.filter(edge => !edge.removed && (members.has(edge.sourceNodeId) || members.has(edge.targetNodeId))
    && (allowed.has(edge.edgeId) || allowed.has(edge.sourceNodeId) || allowed.has(edge.targetNodeId)));
  for (const edge of edges) if (allowed.has(edge.edgeId)) for (const id of [edge.sourceNodeId, edge.targetNodeId]) {
    pathsById.get(id)?.segments.forEach(segment => included.add(segment.id));
  }
  const rows = new Map<string, Row>();
  const levels = canvas.spatialLayerOffsets && getSpatialLevels(graph, canvas);
  for (const row of paths) if (included.has(row.id)) {
    const value = entity(row.id) as { content?: string; description?: string; metadata?: { description?: string } };
    const layer = levels?.get(row.id) ?? 0, offset = canvas.spatialLayerOffsets?.[row.id] ?? 0;
    rows.set(row.id, { ...row, readable: allowed.has(row.id), children: [], version: allowed.has(row.id) ? hash(value) : undefined,
      ...(allowed.has(row.id) && row.kind !== 'node' && (layer || offset) ? { spatial: { layer, offset } } : {}),
      content: allowed.has(row.id) ? value.content ?? value.metadata?.description ?? value.description ?? '' : '' });
  }
  for (const row of rows.values()) if (row.parentId) rows.get(row.parentId)?.children.push(row.id);
  return { graph, canvasId, rootId: canvas.canvasId, rows, edges, members, knownRefs: [...members, ...edges.map(edge => edge.edgeId)], entity };
}
