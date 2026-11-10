import type { FrozenRead } from '../contextState';
import type { CanvasIndex } from './canvasView';
import { requireValue } from './errors';

export const GRAPH_READ_LIMITS = Object.freeze({ batch: 20, objects: 50000, sourceBytes: 16 * 1024 * 1024,
  pages: 4096, snapshotBytes: 32 * 1024 * 1024, workspaceBytes: 64 * 1024 * 1024, ttlMs: 86400000 });
export function resourceLimit(ok: boolean, resource: string) {
  requireValue(ok, '读取超过后台资源上限；请缩小查询范围，按子项或具体对象分次读取。', 'READ_RESOURCE_LIMIT',
    { executed: false, resource, nextAction: 'narrow_query', limits: GRAPH_READ_LIMITS });
}
export function checkGraphReadSource(index: CanvasIndex, refs: string[], edgeIds: string[]) {
  resourceLimit(refs.length + edgeIds.length <= GRAPH_READ_LIMITS.objects, 'objects');
  let bytes = 0;
  const edges = new Map(index.edges.map(e => [e.edgeId, e]));
  for (const id of refs) {
    const row = index.rows.get(id);
    bytes += Buffer.byteLength(JSON.stringify(index.graph.nodes[id] ?? (row ? { name: row.segments.at(-1)?.name, content: row.content } : {})));
    resourceLimit(bytes <= GRAPH_READ_LIMITS.sourceBytes, 'sourceBytes');
  }
  for (const id of edgeIds) {
    bytes += Buffer.byteLength(JSON.stringify(edges.get(id) ?? {}));
    resourceLimit(bytes <= GRAPH_READ_LIMITS.sourceBytes, 'sourceBytes');
  }
}
export function checkFrozenStorage(existing: FrozenRead[], additions: FrozenRead[]) {
  resourceLimit(additions.reduce((n, r) => n + r.pages.length, 0) <= GRAPH_READ_LIMITS.pages, 'pages');
  const size = (reads: FrozenRead[]) => reads.reduce((n, read) => n + Buffer.byteLength(JSON.stringify(read)), 0);
  const added = size(additions);
  resourceLimit(added <= GRAPH_READ_LIMITS.snapshotBytes, 'snapshotBytes');
  resourceLimit(size(existing.filter(r => r.expiresAt > Date.now())) + added <= GRAPH_READ_LIMITS.workspaceBytes, 'workspaceBytes');
}
