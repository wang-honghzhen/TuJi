import type { AppSnapshot } from '../ai/domain';
import { reviewEntries, reviewUnitRefs } from '../ai/changeReview';
import { getCanvasPaths } from '../v3/paths';
import { canvasDirectory } from '../v3/canvas';
import type { CanvasRecord, GraphState, Rect } from '../v3/types';

export type GraphSearchKind = 'node' | 'subgraph' | 'document' | 'edge';
export interface GraphSearchResult {
  id: string; kind: GraphSearchKind; name: string; path: string; detail: string;
  sourcePath?: string; targetPath?: string;
}
export const searchContains = (query: string, ...values: Array<string | undefined>) => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = values.filter(Boolean).join('\n').toLocaleLowerCase();
  return terms.every(term => text.includes(term));
};
export function searchExcerpt(text: string, query: string, size = 100) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  const match = term ? clean.toLocaleLowerCase().indexOf(term) : 0;
  const start = Math.max(0, match - 25);
  return (start ? '…' : '') + clean.slice(start, start + size) + (clean.length > start + size ? '…' : '');
}

/** Keep both ends of a relation inside the usable viewport, excluding sidebars/composer. */
export function searchFocusView(rects: Rect[], area: Rect, currentZoom: number) {
  const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
  const width = Math.max(...rects.map(r => r.x + r.width)) - left;
  const height = Math.max(...rects.map(r => r.y + r.height)) - top;
  const zoom = Math.max(.12, Math.min(Math.max(.78, currentZoom), Math.max(100, area.width) / Math.max(1, width), Math.max(100, area.height) / Math.max(1, height)));
  const anchor = { x: left + width / 2, y: top + height / 2 };
  return { anchor, view: { zoom, x: area.x + area.width / 2 - anchor.x * zoom, y: area.y + area.height / 2 - anchor.y * zoom } };
}

/** Search canonical membership, never just the currently painted/expanded objects. */
export function searchCanvas(state: GraphState, canvas: CanvasRecord, query: string, edges = true): GraphSearchResult[] {
  if (!query.trim()) return [];
  const paths = getCanvasPaths(state, canvas), byId = new Map(paths.map(p => [p.id, p]));
  const results: GraphSearchResult[] = [];
  for (const row of paths) {
    if (row.kind === 'root') continue;
    const node = state.nodes[row.id], record = state.documents[row.id];
    const name = row.segments.at(-1)!.name;
    const content = node ? [node.content, node.design?.pros, node.design?.cons].filter(Boolean).join('\n')
      : canvasDirectory(canvas, row.id)?.description ?? record?.metadata.description ?? '';
    if (searchContains(query, name, content, row.path)) results.push({ id: row.id, kind: row.kind, name, path: row.path, detail: searchExcerpt(content, query) });
  }
  if (edges) for (const edge of state.edges) {
    if (edge.removed) continue;
    const source = byId.get(edge.sourceNodeId), target = byId.get(edge.targetNodeId);
    // Outside links are a viewing aid, not members of the current canvas search scope.
    if (!source || !target) continue;
    const name = `${source.segments.at(-1)!.name} ${edge.directed ? '→' : '—'} ${target.segments.at(-1)!.name}`;
    if (searchContains(query, name, edge.edgeContent, source.path, target.path)) results.push({ id: edge.edgeId, kind: 'edge', name,
      path: `${source.path} ${edge.directed ? '→' : '—'} ${target.path}`, sourcePath: source.path, targetPath: target.path, detail: searchExcerpt(edge.edgeContent, query) });
  }
  return results;
}

export interface PendingReviewResult { id: string; taskId: string; unitIds: string[]; label: string; paths: string[]; detail: string; createdAt: string }
export function searchPendingReviews(snapshot: AppSnapshot, canvasId: string, query: string): PendingReviewResult[] {
  const canvas = snapshot.graph?.canvases.find(c => c.canvasId === canvasId);
  const paths = canvas && snapshot.graph ? getCanvasPaths(snapshot.graph, canvas) : [];
  const byId = new Map(paths.map(p => [p.id, p.path]));
  const groups = new Map<string, ReturnType<typeof reviewEntries>>();
  for (const entry of reviewEntries(snapshot)) {
    if (entry.unit.state !== 'pending' || entry.change.review?.canvasId !== canvasId) continue;
    const list = groups.get(entry.change.id) ?? []; list.push(entry); groups.set(entry.change.id, list);
  }
  return [...groups.values()].flatMap(entries => {
    const change = entries[0].change;
    const objectPaths = [...new Set(entries.flatMap(e => [...reviewUnitRefs(e.unit), e.unit.parentId ?? '']).map(id => byId.get(id)).filter((p): p is string => !!p))];
    const labels = [...new Set(entries.map(e => e.unit.label))].join(' · ');
    const names = entries.flatMap(e => e.unit.ghosts.map(g => g.name));
    if (!searchContains(query, labels, change.digest, ...objectPaths, ...names)) return [];
    return [{ id: change.id, taskId: change.taskId, unitIds: entries.map(e => e.unit.id), label: labels,
      paths: objectPaths, detail: searchExcerpt(change.digest, query), createdAt: change.committedAt ?? change.createdAt }];
  }).reverse();
}
