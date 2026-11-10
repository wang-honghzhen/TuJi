import { canvasDirectoryEntries } from './canvas';
import type { GraphState } from './types';
import { getHierarchyIndex } from './hierarchyIndex';

/** Canvas references never participate in this parent index. */
export function documentParents(state: GraphState): Map<string, string> {
  return getHierarchyIndex(state).documentParents;
}

export interface DocumentTree { rootId: string; name: string }
export function getDocumentTree(state: GraphState, id: string): DocumentTree {
  if (!state.documents[id]) throw new Error('图文档目录不存在');
  const rootId = getHierarchyIndex(state).treeRoots.get(id) ?? id;
  return { rootId, name: `${state.documents[rootId].name}目录树` };
}

export function getRootDocumentIds(state: GraphState): string[] {
  const roots = getHierarchyIndex(state).treeRoots;
  return Object.values(state.documents).filter(record => record.kind === 'document' && roots.get(record.documentId) === record.documentId).map(record => record.documentId);
}

/** Confirmation applies to an exact hierarchy, not an earlier view of it. */
export function structureRevision(state: GraphState): string {
  return JSON.stringify([
    Object.values(state.documents).sort((a, b) => a.documentId.localeCompare(b.documentId)).map((record) =>
      [record.documentId, record.kind, record.name, [...record.childNodeIds].sort(), [...record.childDocumentIds].sort()]),
    [...state.canvases].sort((a, b) => a.canvasId.localeCompare(b.canvasId)).map((canvas) => [canvas.canvasId,
      canvasDirectoryEntries(canvas).sort(([a], [b]) => a.localeCompare(b)).map(([id, directory]) => [id, directory.name, [...directory.childIds].sort()]),
      [...(canvas.excludedDocumentIds ?? [])].sort(), [...(canvas.nodeReferenceIds ?? [])].sort()]),
  ]);
}
