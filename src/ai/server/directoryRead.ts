import { hasDirectNodes, type CanvasIndex } from './canvasView';
import { subgraphVersion } from './subgraphVersions';
import { fieldReadWith } from './graphReadFields';
import { expandTree, treeListBranch, type TreeListBranch } from './treeExpansion';

export const childDirectories = (index: CanvasIndex, refId: string) => index.rows.get(refId)!.children
  .filter(id => index.rows.get(id)!.kind !== 'node').sort();
export interface DirectoryNode extends Record<string,unknown> {refId:string;name?:string;hasDirectNodes?:boolean;childrenState?:'leaf'|'omitted';children?:DirectoryNode[]}
export function directoryMetadata(index: CanvasIndex, refId: string) {
  const spatial = index.rows.get(refId)?.spatial;
  return { directoryVersion: subgraphVersion(index, refId, 'directory'), hasDirectNodes: hasDirectNodes(index, refId), ...(spatial ? { spatial } : {}) };
}
export function directoryCard(index: CanvasIndex, refId: string): DirectoryNode {
  const row = index.rows.get(refId)!, name = row.segments.at(-1)?.name ?? '';
  return { refId, kind: row.kind, ...(name.length <= 256 ? { name } : { nameState: 'deferred', nameReadWith: fieldReadWith(index, refId, 'name') }),
    ...directoryMetadata(index, refId),
    childrenState: childDirectories(index, refId).length ? 'omitted' : 'leaf' };
}
export function directoryListBranch(index:CanvasIndex,scope:string,ids:string[],rows:Record<string,unknown>[],budget:number,
  fits:(page:Record<string,unknown>)=>boolean) {
  const metadata=directoryMetadata(index,scope);
  return treeListBranch(scope,ids,rows,budget,
    items=>({kind:'directory_children',scope,...metadata,listOnly:true,totalChildren:ids.length,items}),fits);
}
/** Never publish a proper subset of a parent's immediate children as an expanded tree. */
export function directoryTree(index: CanvasIndex, target: string, fits: (tree: Record<string, unknown>) => boolean,
  paginate?:(id:string,ids:string[],rows:Record<string,unknown>[])=>TreeListBranch|undefined) {
  const result=expandTree(target,id=>childDirectories(index,id),id=>directoryCard(index,id),fits,'childrenState',paginate);
  return {...result,tree:result.tree as DirectoryNode,shown:result.expanded};
}
