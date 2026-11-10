import { canvasDirectory } from './canvas';
import type { CanvasRecord, GraphState } from './types';

export type PathKind = 'root' | 'document' | 'subgraph' | 'node';
export interface PathSegment { id: string; name: string; kind: PathKind }
export interface GraphPath { id: string; path: string; kind: PathKind; parentId?: string; segments: PathSegment[] }

/** Keep path identity separate from display names, including names containing slashes. */
export function getCanvasPaths(state: GraphState, canvas: CanvasRecord): GraphPath[] {
  const rows: GraphPath[] = [];
  const visit = (id: string, parentId: string | undefined, ancestors: PathSegment[]) => {
    if (canvas.excludedDocumentIds?.includes(id)) return;
    const record = state.documents[id]; const directory = canvasDirectory(canvas, id); const node = state.nodes[id];
    const name = id === canvas.canvasId ? canvas.canvasName : directory?.name ?? record?.name ?? node?.name ?? id;
    const kind: PathKind = id === canvas.canvasId ? 'root' : node ? 'node' : record?.kind === 'document' ? 'document' : 'subgraph';
    const segments = [...ancestors, { id, name, kind }];
    rows.push({ id, parentId, kind, segments, path: segments.map((item) => item.name).join(' / ') });
    (directory?.childIds ?? (record ? [...record.childDocumentIds, ...record.childNodeIds] : [])).forEach((child) => visit(child, id, segments));
  };
  visit(canvas.canvasId, undefined, []); return rows;
}
