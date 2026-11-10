import type { AppSnapshot, Task } from '../domain';
import type { FrozenRead } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { estimateTokens } from '../tokens';
import { digest, graphIndex, observe } from './directGraph';
import { childDirectories, directoryCard, type DirectoryNode } from './directoryRead';
import { expandTree, treeListBranch } from './treeExpansion';
import { subgraphVersion } from './subgraphVersions';
import { GRAPH_READ_DEPENDENCIES_VERSION } from './graphReadDependencies';
import { GRAPH_READ_LIMITS, checkFrozenStorage, resourceLimit } from './graphReadLimits';
import { READ_FORMAT_VERSION, readCoverage } from './readCoverage';
import { requireValue } from './errors';
import type { DirectoryView } from './directoryCacheState';

/** Measure the actual user-message envelope, including JSON escaping. */
export function directoryMessageTokens(payload: unknown): number {
  return estimateTokens(JSON.stringify({ role: 'user', content: JSON.stringify(payload) }));
}
export const mainDirectoryPayload = (tree: unknown) => ({ canvas_directory: tree });
export const cacheDirectoryPayload = (views: Pick<DirectoryView, 'canvasId' | 'rootRefId' | 'currentPath' | 'tree'>[]) => ({
  canvas_directory_cache: views.map(v => ({canvasId:v.canvasId,rootRefId:v.rootRefId,currentPath:v.currentPath,tree:v.tree})),
});

/** Pure arbitrary-root directory preparation; neither observations nor pages are installed. */
export function prepareDirectoryView(state: AppSnapshot, task: Task, options: {
  rootRefId: string; mode: 'children' | 'recursive'; budget: number; viewId: string;
  payload: (view: Pick<DirectoryView, 'canvasId' | 'rootRefId' | 'currentPath' | 'tree'>) => unknown;
}): DirectoryView {
  const index = graphIndex(state, task.canvasId), root = index.rows.get(options.rootRefId);
  requireValue(root && root.kind !== 'node' && (root.readable || root.id === index.rootId), '目录不属于当前画布', 'OUT_OF_SCOPE');
  const currentPath = root.segments.map(s => ({refId:s.id,name:s.name}));
  resourceLimit(Buffer.byteLength(JSON.stringify(currentPath))<=GRAPH_READ_LIMITS.sourceBytes,'sourceBytes');
  const frame = (tree: DirectoryNode) => options.payload({canvasId:task.canvasId,rootRefId:root.id,currentPath,tree});
  const pageBudget = Math.min(AUTO_CONTEXT.readTokens, Math.floor(inputCapacity(state) * AUTO_CONTEXT.recentShare));
  const fitsPage = (data: unknown) => estimateTokens(JSON.stringify(data)) + 400 <= pageBudget;
  const result = expandTree(root.id, id => options.mode === 'children' && id !== root.id ? [] : childDirectories(index,id),
    id => directoryCard(index,id), tree => directoryMessageTokens(frame(tree as DirectoryNode)) <= options.budget, 'childrenState',
    (id, ids, rows) => {
      const branch = treeListBranch(id,ids,rows,pageBudget,
        items => ({kind:'directory_children',scope:id,directoryVersion:subgraphVersion(index,id,'directory'),listOnly:true,totalChildren:ids.length,items}),fitsPage);
      if (branch) branch.id = `read:directory-${digest([options.viewId,id,branch.pages,pageBudget]).slice(0,32)}`;
      return branch;
    });
  // children-mode's unvisited children remain omitted, not complete empty directories.
  const shown = result.expanded.filter(id => options.mode !== 'children' || id === root.id || childDirectories(index,id).length === 0);
  const drafts: FrozenRead[] = result.branches.map(branch => {
    const pageObservations = branch.pages.map(page => {
      const refs = (page.items as Record<string,unknown>[] ?? []).flatMap(row => typeof row.refId === 'string' ? [row.refId] : []);
      const observation = observe(state,task,index,[branch.parentId,...refs],[],true); observation.sources=[]; return observation;
    });
    const snapshotObservation = observe(state,task,index,[branch.parentId,...branch.childIds],[branch.parentId],true);
    snapshotObservation.sources=[];
    return {id:branch.id,taskId:task.id,callId:`directory-view:${options.viewId}`,canvasId:task.canvasId,kind:'graph_read_directory_children',directoryView:true as const,
      directoryReplay:{schemaVersion:1 as const,canvasId:task.canvasId,rootRefId:branch.parentId,mode:'children' as const,requestedBudget:pageBudget},
      pageBudget,readFormatVersion:READ_FORMAT_VERSION,coverage:readCoverage('directory'),pages:branch.pages,
      pageSources:branch.pages.map(()=>[]),pageObservations,snapshotObservation,observation:pageObservations[0],sources:[],
      graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,pageReadHashes:pageObservations.map(o=>o.readHashes??{}),
      createdAt:new Date().toISOString(),expiresAt:Date.now()+GRAPH_READ_LIMITS.ttlMs};
  });
  checkFrozenStorage([],drafts);
  const observation=observe(state,task,index,result.refs,shown,true);observation.sources=[];
  return {tree:result.tree as DirectoryNode,canvasId:task.canvasId,rootRefId:root.id,currentPath,observation,drafts};
}

/** Backwards-compatible main-directory result. */
export function prepareContextDirectory(state: AppSnapshot, task: Task, budget: number) {
  const index=graphIndex(state,task.canvasId);
  const view=prepareDirectoryView(state,task,{rootRefId:index.rootId,mode:'recursive',budget,
    viewId:`main:${task.canvasId}:${state.graphRevision}`,payload:v=>mainDirectoryPayload(v.tree)});
  return {data:view.tree,tokens:directoryMessageTokens(mainDirectoryPayload(view.tree)),observation:view.observation,drafts:view.drafts};
}
