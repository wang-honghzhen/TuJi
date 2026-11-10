import type { CanvasIndex } from './canvasView';
import { graphTables } from './graphReadTables';
import { requireValue } from './errors';

export const GRAPH_FIELDS = ['name', 'path', 'design'] as const;
export type GraphField = typeof GRAPH_FIELDS[number];
export function graphField(index: CanvasIndex, refId: string, field: GraphField) {
  const row = index.rows.get(refId);
  requireValue(row && (row.readable || row.kind === 'root'), '字段不在当前读取范围', 'OUT_OF_SCOPE');
  const value = field === 'name' ? row.segments.at(-1)?.name ?? '' : field === 'path' ? graphTables(index).path(refId) : index.graph.nodes[refId]?.design ?? null;
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  return { content, encoding: typeof value === 'string' ? 'text' : 'json',
    version: graphTables(index).fieldVersion(refId,field,value) };
}
export function fieldReadWith(index: CanvasIndex, refId: string, field: GraphField) {
  return { tool: 'graph_read_object_field', arguments: { refId, field, expectedVersion: graphField(index, refId, field).version } };
}
