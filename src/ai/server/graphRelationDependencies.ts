import type { GraphReadContext } from './graphReadContext';
import type { GraphState } from '@/v3/types';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { relationMembershipVersion } from './relationMembershipVersion';
import { currentGraphQueryHashes } from './graphQueries';
import { currentSubgraphHashes } from './subgraphVersions';

const PREFIX = 'relations:';
export const relationDependencyKey = (canvasId: string, refId: string) => PREFIX + JSON.stringify([canvasId, refId]);
export function relationDependency(key: string): { canvasId: string; refId: string } | undefined {
  if (!key.startsWith(PREFIX)) return;
  try { const value: unknown = JSON.parse(key.slice(PREFIX.length));
    if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string')) return { canvasId: value[0], refId: value[1] };
  } catch { /* Unknown dependency keys fail closed in the ordinary version check. */ }
}

/** Same definition as the model-visible node relations.version, restricted to this canvas. */
export function relationVersion(index: CanvasIndex, refId: string): string | undefined {
  if (index.rows.get(refId)?.kind !== 'node' || !index.rows.get(refId)?.readable) return;
  return relationMembershipVersion(index.edges.filter(e => e.sourceNodeId === refId || e.targetNodeId === refId));
}
export function captureRelationHashes(index: CanvasIndex, refs: string[]): Record<string, string> {
  return Object.fromEntries([...new Set(refs)].flatMap(ref => {
    const version = relationVersion(index, ref); return version ? [[relationDependencyKey(index.canvasId, ref), version]] : [];
  }));
}
/** Capture delivered relation cards, including empty collections and oversized node cards. */
export function relationCardHashes(canvasId: string, data: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as { refId?: string; relations?: { version?: string } };
    if (typeof row.refId === 'string' && typeof row.relations?.version === 'string')
      result[relationDependencyKey(canvasId, row.refId)] = row.relations.version;
    Object.values(value).forEach(visit);
  };
  visit(data); return result;
}
/** Resolve only queried collections, never make an unrelated graph edit a dependency. */
export function currentRelationHashes(graph: GraphState, keys: string[], context?: GraphReadContext): Record<string, string> {
  const indices = new Map<string, CanvasIndex>(), result: Record<string, string> = {};
  for (const key of keys) {
    const query = relationDependency(key); if (!query || !graph.canvases.some(c => c.canvasId === query.canvasId)) continue;
    let index = indices.get(query.canvasId);
    if (!index) { index = context?.graph === graph ? context.index(query.canvasId) : canvasIndex(graph, query.canvasId, canvasMemberIds(graph, query.canvasId)); indices.set(query.canvasId, index); }
    const compute = () => relationVersion(index!, query.refId);
    const version = context?.graph === graph ? context.version(key,compute) : compute(); if (version) result[key] = version;
  }
  return { ...result, ...currentSubgraphHashes(graph, keys, context), ...currentGraphQueryHashes(graph, keys, context) };
}
