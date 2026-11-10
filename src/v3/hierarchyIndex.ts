import { canvasDirectoryEntries } from './canvas';
import type { GraphState } from './types';

export interface HierarchyIndex {
  documentParents: Map<string, string>;
  nodeParents: Map<string, string>;
  treeRoots: Map<string, string>;
  canvasParents: Map<string, Map<string, string>>;
  /** Direct canvas mounts; canonical ancestors are handled by documentParents. */
  mounts: Map<string, Array<{ canvasId: string; parentId: string }>>;
}
const retained = new WeakMap<GraphState, HierarchyIndex>();

/** Published states are immutable. Uncommitted transaction drafts are never
 * retained, so changing a draft cannot leave a stale parent index behind. */
export function getHierarchyIndex(state: GraphState): HierarchyIndex {
  const cached = retained.get(state); if (cached) return cached;
  const documentParents = new Map<string, string>(); const nodeParents = new Map<string, string>();
  for (const record of Object.values(state.documents)) {
    for (const id of record.childDocumentIds) {
      if (documentParents.has(id)) throw new Error(`目录归属冲突：${state.documents[id]?.name ?? id} 有多个原始父级`);
      documentParents.set(id, record.documentId);
    }
    record.childNodeIds.forEach(id => nodeParents.set(id, record.documentId));
  }
  const treeRoots = new Map<string, string>(); const visiting = new Set<string>();
  const root = (id: string): string => {
    if (treeRoots.has(id)) return treeRoots.get(id)!;
    if (visiting.has(id)) throw new Error('图文档目录不能成环');
    visiting.add(id);
    const parent = documentParents.get(id); const outer = parent ? root(parent) : undefined;
    const result = outer && state.documents[outer]?.kind === 'document' ? outer : id;
    treeRoots.set(id, result); visiting.delete(id); return result;
  };
  Object.keys(state.documents).forEach(root);
  const canvasParents = new Map<string, Map<string, string>>();
  const mounts: HierarchyIndex['mounts'] = new Map();
  for (const canvas of state.canvases) {
    const parents = new Map<string, string>(); canvasParents.set(canvas.canvasId, parents);
    for (const [parentId, directory] of canvasDirectoryEntries(canvas)) for (const id of directory.childIds) {
      parents.set(id, parentId);
      if (state.documents[id]) mounts.set(id, [...(mounts.get(id) ?? []), { canvasId: canvas.canvasId, parentId }]);
    }
  }
  return { documentParents, nodeParents, treeRoots, canvasParents, mounts };
}

export function retainHierarchyIndex(state: GraphState, index = getHierarchyIndex(state)): void { retained.set(state, index); }
export function invalidateHierarchyIndex(state: GraphState): void { retained.delete(state); }
