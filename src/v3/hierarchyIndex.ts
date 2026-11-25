import { canvasDirectory, canvasDirectoryEntries } from './canvas';
import type { CanvasRecord, GraphEdge, GraphState } from './types';

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
export function invalidateHierarchyIndex(state: GraphState): void {
  retained.delete(state);
  membershipCache.delete(state);
}

interface CanvasMembership {
  members: Set<string>;
  parents: Map<string, string>;
}
const membershipCache = new WeakMap<GraphState, WeakMap<CanvasRecord, CanvasMembership>>();
const membershipByHierarchy = new WeakMap<HierarchyIndex, Map<string, CanvasMembership>>();

export function getCanvasMembership(state: GraphState, canvas: CanvasRecord): CanvasMembership {
  const cached = membershipCache.get(state)?.get(canvas);
  if (cached) return cached;
  const hierarchy = getHierarchyIndex(state); retainHierarchyIndex(state, hierarchy);
  const membershipKey = JSON.stringify([canvas.canvasId, canvas.excludedDocumentIds]);
  const attached = state.canvases.includes(canvas);
  const shared = attached && membershipByHierarchy.get(hierarchy)?.get(membershipKey);
  if (shared) return shared;
  const members = new Set<string>();
  const parents = new Map<string, string>();
  const walkDoc = (id: string, parent: string, visited: Set<string>) => {
    if (!state.documents[id] || visited.has(id) || canvas.excludedDocumentIds?.includes(id)) return;
    visited.add(id);
    members.add(id);
    parents.set(id, parent);
    const record = state.documents[id];
    for (const nodeId of record.childNodeIds) {
      if (!state.nodes[nodeId]) continue;
      members.add(nodeId);
      parents.set(nodeId, id);
    }
    for (const childId of record.childDocumentIds) walkDoc(childId, id, visited);
  };
  const visitedDocs = new Set<string>();
  const visitedDirs = new Set<string>();
  const walkDir = (id: string, parent?: string) => {
    if (visitedDirs.has(id) || !canvasDirectory(canvas, id)) return;
    visitedDirs.add(id);
    members.add(id);
    if (parent) parents.set(id, parent);
    for (const childId of canvasDirectory(canvas, id).childIds) {
      if (canvasDirectory(canvas, childId)) walkDir(childId, id);
      else if (state.documents[childId]) walkDoc(childId, id, visitedDocs);
      else if (state.nodes[childId]) {
        members.add(childId);
        parents.set(childId, id);
      }
    }
  };
  walkDir(canvas.canvasId);
  const result = { members, parents };
  const byCanvas = membershipCache.get(state) ?? new WeakMap(); byCanvas.set(canvas, result); membershipCache.set(state, byCanvas);
  if (attached) {
    const byHierarchy = membershipByHierarchy.get(hierarchy) ?? new Map();
    if (byHierarchy.size >= 24) byHierarchy.delete(byHierarchy.keys().next().value!);
    byHierarchy.set(membershipKey, result); membershipByHierarchy.set(hierarchy, byHierarchy);
  }
  return result;
}

export type CanvasEdgeScope = 'internal' | 'cross' | 'outside';

/** Use actual endpoints and their mounted parents, including the canvas root. */
export function canvasEdgeScope(state: GraphState, membership: CanvasMembership,
  edge: Pick<GraphEdge, 'sourceNodeId' | 'targetNodeId'>): CanvasEdgeScope {
  const { sourceNodeId: source, targetNodeId: target } = edge;
  if (!membership.members.has(source) || !membership.members.has(target)) return 'outside';
  const parent = membership.parents.get(source);
  return state.nodes[source] && state.nodes[target] && parent !== undefined && parent === membership.parents.get(target)
    ? 'internal' : 'cross';
}
