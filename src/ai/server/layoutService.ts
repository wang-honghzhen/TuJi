import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { layoutRelationships } from '@/v3/relationshipLayout';
import type { RelationshipLayoutOptions, RelationshipLayoutResult } from '@/v3/relationshipLayout';
import type { GraphState } from '@/v3/types';
import type { LayoutGeometryReply } from './layoutProtocol';
import { reconcileRegionGeometry } from '@/v3/regionLayout';

/** Each request has a bounded lifetime; no SQLite transaction spans the worker wait. */
export async function planRelationshipLayout(graph: GraphState, options: RelationshipLayoutOptions, signal?: AbortSignal): Promise<RelationshipLayoutResult> {
  if (signal?.aborted) throw new Error('布局计算已取消');
  const filename = path.join(typeof __dirname === 'string' ? __dirname : process.cwd(), 'layout-worker.cjs');
  // Source-level test bundles don't package the worker. The same bounded pure solver remains usable there.
  if (!existsSync(filename)) { await new Promise<void>(resolve => setImmediate(resolve)); if (signal?.aborted) throw new Error('布局计算已取消'); return layoutRelationships(graph, options); }
  return new Promise((resolve, reject) => {
    const worker = new Worker(filename); let finished = false;
    const finish = (error?: Error, result?: RelationshipLayoutResult) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('布局计算超时，请缩小整理范围')), 5000);
    const abort = () => finish(new Error('布局计算已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (reply: { error?: string; result?: LayoutGeometryReply }) => {
      if (reply.error || !reply.result) { finish(new Error(reply.error ?? '布局线程返回无效结果')); return; }
      const geometry = reply.result;
      let state = graph;
      if (geometry.documents.length || geometry.canvases.length || geometry.layoutVersion !== graph.layoutVersion) {
        const documents = { ...graph.documents }, canvases = [...graph.canvases];
        for (const row of geometry.documents) {
          const old = documents[row.id]; documents[row.id] = { ...old, placements: row.placements, rev: row.rev, metadata: { ...old.metadata, updatedAt: row.updatedAt } };
        }
        for (const row of geometry.canvases) {
          const index = canvases.findIndex(c => c.canvasId === row.id); canvases[index] = { ...canvases[index], placements: row.placements, updatedAt: row.updatedAt };
        }
        state = { ...graph, documents, canvases, layoutVersion: geometry.layoutVersion }; reconcileRegionGeometry(graph, state);
      }
      finish(undefined, { state, stats: geometry.stats });
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`布局线程提前结束 (${code})`)); });
    const lightweight: GraphState = { ...graph,
      nodes: Object.fromEntries(Object.keys(graph.nodes).map(id => [id, { nodeId: id, name: '', content: '' }])),
      documents: Object.fromEntries(Object.entries(graph.documents).map(([id, doc]) => [id, { ...doc, name: '', metadata: { ...doc.metadata, description: undefined } }])),
      canvases: graph.canvases.map(canvas => ({ ...canvas, canvasName: '', directories: Object.fromEntries(Object.entries(canvas.directories).map(([id, dir]) => [id, { name: '', childIds: dir.childIds }])) })),
      edges: graph.edges.map(edge => ({ ...edge, edgeContent: '' })) };
    worker.postMessage({ graph: lightweight, options });
  });
}
