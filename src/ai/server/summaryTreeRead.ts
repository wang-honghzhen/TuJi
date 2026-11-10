import { randomUUID } from 'node:crypto';
import { rememberReadPage } from './readVisibility';
import { rememberPageOrigin } from './readPageEvidence';
import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { FrozenRead, Observation } from '../contextState';
import { estimateTokens } from '../tokens';
import { summaryProjection } from './summaryBindings';
import { summaryReadScope } from './summaryReadScope';
import { directReadBudgets, readCapacityReceipt } from './directReadBudget';
import { requireValue } from './errors';
import { expandTree, treeListBranch, type TreeRow } from './treeExpansion';
import { checkFrozenStorage, GRAPH_READ_LIMITS } from './graphReadLimits';
import { readCoverage, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { HISTORY_VIEW_VERSION } from './historyRecordView';
import { rememberSummaryOrigin } from './summaryRegions';

export function readSummaryTree(state:AppSnapshot,task:Task,call:ToolCallRecord,args:Record<string,unknown>,
  delivered:(read:FrozenRead,result:Record<string,unknown>)=>void){
  const scope=summaryReadScope(state,task),root=scope.byId.get(String(args.summaryId));
  requireValue(root&&scope.available(root),'摘要不在当前合法保留结构中','OUT_OF_SCOPE');
  const limits=directReadBudgets(state,task,call,args.budget),{pageBudget:budget,availableTokens}=limits;
  if(availableTokens<256)return readCapacityReceipt(call,args,availableTokens,256,{limits,minimumOnly:true});
  const pointerId=`read:${randomUUID()}`;
  const frame=(data:TreeRow)=>({status:'partial',pointerId,page:99999999,totalPages:99999999,hasMorePages:true,isLastPage:false,
    data,sources:[],stale:false,coverage:pageCoverage(readCoverage('summary_tree',['tree_boundary','pagination']),2),nextCursor:{pointerId,page:99999999}});
  const fits=(data:TreeRow)=>estimateTokens(JSON.stringify(frame(data)))<=budget;
  const wrap=(tree:TreeRow)=>({kind:'summary_tree',tree});
  const at=(id:string)=>{const s=scope.byId.get(id);requireValue(s,'子摘要不存在','STALE_SUMMARY');return s;};
  const result=expandTree(root.id,id=>at(id).children,id=>summaryProjection(state,task,at(id)),tree=>fits(wrap(tree)),'summaryType',
    (id,ids,rows)=>treeListBranch(id,ids,rows,budget,items=>({kind:'summary_children',summaryId:id,listOnly:true,totalChildren:ids.length,items}),fits));
  if(!fits(wrap(result.tree)))return readCapacityReceipt(call,args,availableTokens,estimateTokens(JSON.stringify(frame(wrap(result.tree)))),{limits,usePageBudget:true});
  const allIds=[...new Set([...result.refs,...result.branches.flatMap(b=>b.childIds)])];
  const sources=[...new Map(allIds.flatMap(id=>at(id).sourceRefs).map(s=>[JSON.stringify(s),s])).values()];
  const observation:Observation={id:`observation:${randomUUID()}`,taskId:task.id,canvasId:task.canvasId,directories:{},paths:{},refs:[root.id],completeDirectories:[],sources};
  const createdAt=new Date().toISOString(),expiresAt=Date.now()+GRAPH_READ_LIMITS.ttlMs;
  const base={taskId:task.id,callId:call.id,canvasId:task.canvasId,pageBudget:budget,readFormatVersion:READ_FORMAT_VERSION,
    historyViewVersion:HISTORY_VIEW_VERSION,observation,createdAt,expiresAt,sources,
    summaryOrigin:{roots:[root.id],versions:Object.fromEntries(allIds.map(id=>[id,at(id).version])),pure:true}};
  const read:FrozenRead={...base,id:pointerId,kind:'summary_tree',coverage:readCoverage('summary_tree',result.omitted.length?['tree_boundary']:[]),
    pages:[wrap(result.tree)],pageSources:[[]],pageCoverage:[[]],targetVersions:{[root.id]:root.version}};
  const branches:FrozenRead[]=result.branches.map(b=>({...base,id:b.id,kind:'summary_children',coverage:readCoverage('summary_children'),
    summaryOrigin:{...base.summaryOrigin,parentId:b.parentId},
    pages:b.pages,pageSources:b.pages.map(()=>[]),pageCoverage:b.pages.map(()=>[]),
    targetVersions:{[b.parentId]:at(b.parentId).version},observation:{...observation,refs:[b.parentId]}}));
  const response={status:result.omitted.length?'partial':'ok',pointerId,page:1,totalPages:1,hasMorePages:false,isLastPage:true,
    data:read.pages[0],coverage:pageCoverage(read.coverage!,1),sources:[]};
  const size=estimateTokens(JSON.stringify(response));if(size>availableTokens)return readCapacityReceipt(call,args,availableTokens,size,{limits});
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,retained=(workspace.frozenReads??[]).filter(r=>r.expiresAt>Date.now());
  checkFrozenStorage(retained,[read,...branches]);workspace.frozenReads=[...retained,read,...branches];
  call.resultSources=sources;rememberReadPage(call,pointerId,1);rememberPageOrigin(call,read,1);rememberSummaryOrigin(call,read);delivered(read,response);return response;
}
