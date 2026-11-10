import type { CanvasIndex } from './canvasView';
import { subgraphVersion } from './subgraphVersions';
import { fieldReadWith } from './graphReadFields';
import { expandTree, type TreeListBranch } from './treeExpansion';

export const childDirectories = (index: CanvasIndex, refId: string) => index.rows.get(refId)!.children
  .filter(id => index.rows.get(id)!.kind !== 'node').sort();
export interface DirectoryNode extends Record<string,unknown> {refId:string;name?:string;childrenState?:'leaf'|'omitted';children?:DirectoryNode[]}
export function directoryCard(index: CanvasIndex, refId: string): DirectoryNode {
  const row = index.rows.get(refId)!, name = row.segments.at(-1)?.name ?? '';
  return { refId, kind: row.kind, ...(name.length <= 256 ? { name } : { nameState: 'deferred', nameReadWith: fieldReadWith(index, refId, 'name') }),
    directoryVersion: subgraphVersion(index, refId, 'directory'),
    childrenState: childDirectories(index, refId).length ? 'omitted' : 'leaf' };
}
/** Never publish a proper subset of a parent's immediate children as an expanded tree. */
export function directoryTree(index: CanvasIndex, target: string, fits: (tree: Record<string, unknown>) => boolean,
  paginate?:(id:string,ids:string[],rows:Record<string,unknown>[])=>TreeListBranch|undefined) {
  const result=expandTree(target,id=>childDirectories(index,id),id=>directoryCard(index,id),fits,'childrenState',paginate);
  return {...result,tree:result.tree as DirectoryNode,shown:result.expanded};
}
