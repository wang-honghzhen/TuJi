import { readSubgraphEdges } from './subgraphEdgeRead';
import { SUBGRAPH_EDGE_TOOLS } from './graphQueries';
import { graphReadUsage, attachFrozenDirectoryEvidence } from './directoryEvidence';
import { randomUUID } from 'node:crypto';
import type { AppSnapshot, Task, ToolCallRecord, SourceRef } from '../domain';
import type { FrozenRead } from '../contextState';
import { estimateTokens } from '../tokens';
import { graphIndex, observe } from './directGraph';
import { graphTables } from './graphReadTables';
import { fieldReadWith } from './graphReadFields';
import { assertDesignQuery, validateNodeSearch, nodeSearchMatches, designReferences, graphQueryKey, graphQueryVersion, type GraphQuery } from './graphQueries';
import { directReadBudgets, readCapacityReceipt } from './directReadBudget';
import { readCoverage, readKind, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { requireValue } from './errors';
import { GRAPH_READ_LIMITS, resourceLimit, checkFrozenStorage, checkGraphReadSource } from './graphReadLimits';
import { captureSubgraphHashes } from './subgraphVersions';
import { GRAPH_READ_DEPENDENCIES_VERSION, captureGraphReadHashes, rememberGraphReadHashes } from './graphReadDependencies';
import { rememberReadPage } from './readVisibility';
import { fittingTextEnd } from './textSlicePacking';
import { rememberCanvasRead, stampCanvasObservation } from './canvasReadEvidence';

type Row = Record<string,unknown>;
/** Literal matching keeps UTF-16 offsets even when case folding changes character length. */
export function textMatches(content: string, query: string, caseSensitive = false): Array<{start:number;end:number}> {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
  const result: Array<{start:number;end:number}> = [];
  for (const match of content.matchAll(pattern)) {
    result.push({start:match.index!,end:match.index!+match[0].length});
    resourceLimit(result.length<=GRAPH_READ_LIMITS.objects,'matches');
  }
  return result;
}
export function graphQueryRead(state:AppSnapshot,task:Task,call:ToolCallRecord,args:Row):Row {
  if(SUBGRAPH_EDGE_TOOLS.has(call.name))return readSubgraphEdges(state,task,call,args);
  const index=graphIndex(state,task.canvasId),tables=graphTables(index),workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const query:GraphQuery={tool:call.name,arguments:{...args}};
  let refs:string[]=[],rows:Row[]=[],selection:FrozenRead['searchSelection'],extra:Row={};
  const card=(refId:string):Row=>{
    const node=index.graph.nodes[refId],path=tables.path(refId);
    return {refId,kind:'node',bodyState:'not_loaded',version:tables.source(refId)!.version,
      ...(node.name.length<=256?{name:node.name}:{nameReadWith:fieldReadWith(index,refId,'name')}),
      ...(JSON.stringify(path).length<=512?{path}:{pathReadWith:fieldReadWith(index,refId,'path')}),
      ...(node.design?{designType:node.design.type}:{}),readWith:{tool:'graph_read',arguments:{refs:[refId]}}};
  };
  if(call.name==='graph_search'){
    const spec=validateNodeSearch(index,args);if(spec.designTypes)assertDesignQuery(state,task);
    const matches=nodeSearchMatches(index,spec);resourceLimit(matches.length<=GRAPH_READ_LIMITS.objects,'objects');
    refs=matches.slice(0,spec.limit==='all'?matches.length:Math.min(50,Number(spec.limit??12)));
    selection={scope:'node_names',totalMatches:matches.length,selectedMatches:refs.length,...(spec.limit===0?{countOnly:true,countComplete:true}:{})};
    rows=refs.map(card);extra={output:'cards',...(spec.limit===0?{countOnly:true}:{})};
  }else{
    requireValue(Array.isArray(args.refs)&&args.refs.length>0&&args.refs.length<=20,'需要1至20个节点','INVALID_ARGUMENT');
    refs=[...new Set(args.refs as string[])];
    requireValue(refs.every(ref=>index.rows.get(ref)?.kind==='node'&&index.rows.get(ref)?.readable),'节点不属于当前画布','OUT_OF_SCOPE');
    if(call.name==='graph_read_design_references'){
      assertDesignQuery(state,task);
      requireValue(args.direction===undefined||['incoming','outgoing','both'].includes(String(args.direction)),'direction无效','INVALID_ARGUMENT');
      requireValue(args.kinds===undefined||Array.isArray(args.kinds)&&args.kinds.length>0&&args.kinds.every(k=>['member','subject'].includes(String(k))),'kinds无效','INVALID_ARGUMENT');
      const references=designReferences(index,args);
      rows=references.map(r=>({...r,source:card(r.sourceNodeId),target:card(r.targetNodeId)}));
      extra={requestedRefs:refs,totalReferences:rows.length,referenceVersion:graphQueryVersion(index,query),scopeNotice:'仅当前画布内两端可访问的直接设计引用'};
    }else{
      requireValue(typeof args.query==='string'&&args.query.length>0,'query不能为空','INVALID_ARGUMENT');
      checkGraphReadSource(index,refs,[]);
      let totalMatches=0;
      for(const refId of refs){
        const content=index.graph.nodes[refId].content,matches=textMatches(content,args.query as string,args.caseSensitive===true);
        totalMatches+=matches.length;resourceLimit(totalMatches<=GRAPH_READ_LIMITS.objects,'matches');
        const windows:Array<{start:number;end:number;matches:typeof matches}>=[];
        for(const match of matches){
          let start=Math.max(0,match.start-120),end=Math.min(content.length,match.end+120);
          // Do not cut surrogate pairs at window boundaries.
          if(start>0&&/[\uDC00-\uDFFF]/.test(content[start]))start--;
          if(end<content.length&&/[\uDC00-\uDFFF]/.test(content[end]))end++;
          const last=windows.at(-1);
          if(last&&last.end>=start){last.end=Math.max(last.end,end);last.matches.push(match);}else windows.push({start,end,matches:[match]});
        }
        rows.push(...windows.map(w=>({refId,field:'content',objectVersion:tables.source(refId)!.version,...w,content:content.slice(w.start,w.end),contentLength:content.length,
          readWith:{tool:'graph_read_node_content',arguments:{refId,start:w.start,end:w.end,expectedVersion:tables.source(refId)!.version}}})));
      }
      extra={requestedRefs:refs,totalMatches};
    }
  }
  resourceLimit(rows.length<=GRAPH_READ_LIMITS.objects,'objects');
  const limits=directReadBudgets(state,task,call,args.budget),{pageBudget:budget,availableTokens}=limits,pointerId=`read:${randomUUID()}`;
  const sourcesFor=(items:Row[]):SourceRef[]=>call.name==='graph_search_node_content'?items.map(row=>({...tables.source(String(row.refId))!,start:Number(row.start),end:Number(row.end)})):[];
  const data=(items:Row[])=>({kind:call.name,scope:index.rootId,...extra,items});
  const limited=!!selection&&!selection.countOnly&&selection.selectedMatches<selection.totalMatches;
  const coverage=readCoverage(readKind(call.name),limited?['search_limit']:[]);
  const frame=(items:Row[])=>({status:'ok',pointerId,page:99999999,totalPages:99999999,hasMorePages:true,isLastPage:false,data:data(items),sources:sourcesFor(items),
    coverage:pageCoverage(coverage,2),...(selection?{selection}:{}),freshness:'unknown',stale:true,notice:'这是冻结版本的原文，可用于历史比较；仅需当前版本时重新读取。',nextCursor:{pointerId,page:99999999}});
  const fits=(items:Row[])=>estimateTokens(JSON.stringify(frame(items)))<=budget;
  const batches:Row[][]=[];let batch:Row[]=[];
  const push=(items:Row[])=>{batches.push(items);resourceLimit(batches.length<=GRAPH_READ_LIMITS.pages,'pages');};
  for(const row of rows){
    if(fits([...batch,row])){batch.push(row);continue;}
    if(batch.length){push(batch);batch=[];}
    if(fits([row])){batch=[row];continue;}
    if(call.name!=='graph_search_node_content')return readCapacityReceipt(call,args,availableTokens,estimateTokens(JSON.stringify(frame([row]))),{limits,usePageBudget:true});
    const content=String(row.content),base=Number(row.start);let offset=0;
    while(offset<content.length){
      const part=(end:number):Row=>{const start=base+offset,stop=base+end;return {...row,start,end:stop,content:content.slice(offset,end),
        matches:(row.matches as Array<{start:number;end:number}>).filter(m=>m.start<stop&&m.end>start),
        readWith:{tool:'graph_read_node_content',arguments:{refId:row.refId,start,end:stop,expectedVersion:row.objectVersion}}};};
      const end=fittingTextEnd(content,offset,budget,end=>fits([part(end)]));
      if(end<=offset)return readCapacityReceipt(call,args,availableTokens,undefined,{limits,usePageBudget:true});
      push([part(end)]);offset=end;
    }
  }
  if(batch.length||!batches.length)push(batch);
  if(!fits(batches[0]))return readCapacityReceipt(call,args,availableTokens,undefined,{limits,usePageBudget:true});
  const pages=batches.map(data),pageSources=batches.map(sourcesFor);
  const pageObservations=batches.map((items,i)=>{
    const ids=new Set<string>();
    const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
      const r=value as Row;if(typeof r.refId==='string'&&index.rows.get(r.refId)?.kind==='node')ids.add(r.refId);
      Object.entries(r).filter(([key])=>key!=='readWith'&&key!=='nameReadWith'&&key!=='pathReadWith').forEach(([,v])=>visit(v));};visit(items);
    const o=observe(state,task,index,[...ids],[],false,undefined,undefined,query);
    o.objects={};o.contentLengths={};o.directories={};o.paths={};o.sources=pageSources[i];
    o.readHashes={...captureGraphReadHashes(index.graph,o.sources,[],index.canvasId),
      ...captureSubgraphHashes(index,[...ids],'name'),...captureSubgraphHashes(index,[...ids],'path'),
      ...captureSubgraphHashes(index,[...ids],'design'),[graphQueryKey(index.canvasId,query)]:graphQueryVersion(index,query)};
    stampCanvasObservation(index,o,pages[i]);o.canvasPage={pointerId,page:i+1,totalPages:pages.length};return o;
  });
  const result:Row={status:'ok',pointerId,page:1,totalPages:pages.length,hasMorePages:pages.length>1,isLastPage:pages.length===1,data:pages[0],sources:pageSources[0],coverage:pageCoverage(coverage,pages.length),
    freshness:'current',stale:false,...(selection?{selection}:{}),...(pages.length>1?{nextCursor:{pointerId,page:2}}:{})};
  const needed=estimateTokens(JSON.stringify(result));if(needed>availableTokens)return readCapacityReceipt(call,args,availableTokens,needed,{limits});
  const observation=pageObservations[0];observation.callId=call.id;
  const snapshotObservation={...observation,refs:[...new Set(pageObservations.flatMap(o=>o.refs))],sources:pageSources.flat(),readHashes:Object.assign({},...pageObservations.map(o=>o.readHashes))};
  const snapshot:FrozenRead={id:pointerId,taskId:task.id,callId:call.id,canvasId:task.canvasId,kind:call.name,pages,pageBudget:budget,
    canvasOrigin:{version:1,tool:call.name,arguments:structuredClone(args)},
    pageGraphUsage:pages.map(page=>graphReadUsage(index,call.name,page,call.id)),readFormatVersion:READ_FORMAT_VERSION,coverage,searchSelection:selection,pageSources,pageObservations,snapshotObservation,observation,
    graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,pageReadHashes:pageObservations.map(o=>o.readHashes!),sources:pageSources.flat(),createdAt:new Date().toISOString(),expiresAt:Date.now()+GRAPH_READ_LIMITS.ttlMs};
  checkFrozenStorage(workspace.frozenReads??[],[snapshot]);
  (workspace.frozenReads??=[]).push(snapshot);(workspace.observations??=[]).push(observation);
  call.resultSources=pageSources[0];attachFrozenDirectoryEvidence(call,snapshot,1);rememberReadPage(call,pointerId,1,observation.readHashes);rememberGraphReadHashes(task,observation.readHashes!);
  rememberCanvasRead(call,snapshot,1);return result;
}
