import type { GraphState } from '@/v3/types';
import { getHierarchyIndex } from '@/v3/hierarchyIndex';
import { requireValue } from './errors';

export const AI_STRUCTURE_RULES = '可调整画布局部目录和已有展示入口，或在同一所属图文档内整理普通内容；共享修改会同步。禁止跨归属迁移、改变图文档原始路径（含移动上层子图）。越界交由用户手动管理，不询问剪切或复制，不自动创建副本。';
export const AI_STRUCTURE_BOUNDARY_MESSAGE = '此操作会改变图文档原始路径或内容归属，请由用户在图文档管理入口处理；AI不能通过剪切或复制继续。';

/** Canonical ownership excludes canvas display mounts, including mounts of shared nodes. */
function contentOwner(state: GraphState) {
  const index = getHierarchyIndex(state), owners = new Map<string, string | undefined>();
  const directoryOwner = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    if (owners.has(id)) return owners.get(id);
    const owner = state.documents[id]?.kind === 'document' ? id : directoryOwner(index.documentParents.get(id));
    owners.set(id, owner); return owner;
  };
  return (id: string) => directoryOwner(state.nodes[id] ? index.nodeParents.get(id) : id);
}

/** Check the whole graph, including invisible descendants, without exposing outside content. */
export function assertAiStructureBoundary(before: GraphState, after: GraphState): void {
  const documents = Object.values(before.documents).filter(record => record.kind === 'document').map(record => record.documentId);
  requireValue(documents.length === Object.values(after.documents).filter(record => record.kind === 'document').length
    && documents.every(id => after.documents[id]?.kind === 'document'), '图文档注册、删除和解散仅由用户执行', 'USER_ONLY_MANAGEMENT');
  const oldParents = getHierarchyIndex(before).documentParents, newParents = getHierarchyIndex(after).documentParents;
  const checked = new Set<string>();
  for (const id of documents) {
    let current: string | undefined = id;
    while (current && !checked.has(current)) {
      checked.add(current);
      requireValue(oldParents.get(current) === newParents.get(current), AI_STRUCTURE_BOUNDARY_MESSAGE, 'AI_STRUCTURE_BOUNDARY');
      current = oldParents.get(current);
    }
  }
  const oldOwner = contentOwner(before), newOwner = contentOwner(after);
  // Deletion remains an ordinary edit; surviving content must retain its owning document.
  const ordinary = [...Object.keys(before.nodes), ...Object.values(before.documents)
    .filter(record => record.kind === 'subgraph').map(record => record.documentId),
    ...before.canvases.flatMap(canvas => Object.keys(canvas.directories))];
  const retained = new Set([...Object.keys(after.nodes), ...Object.keys(after.documents),
    ...after.canvases.flatMap(canvas => Object.keys(canvas.directories))]);
  for (const id of ordinary) if (retained.has(id))
    requireValue(oldOwner(id) === newOwner(id), AI_STRUCTURE_BOUNDARY_MESSAGE, 'AI_STRUCTURE_BOUNDARY');
}
