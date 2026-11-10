import { graphQueryRead } from './graphQueryRead';
import { SUBGRAPH_EDGE_TOOLS } from './graphQueries';
import type { GraphReadContext } from './graphReadContext';
import { enhancedSearch, validateNodeSearch, nodeSearchMatches, assertDesignQuery, graphQueryKey, graphQueryVersion, currentGraphQueryHashes, type GraphQuery } from './graphQueries';
import { createHash, randomUUID } from 'node:crypto';
import { frozenReadRevoked, frozenPageRevoked, rememberReadPage } from './readVisibility';
import { inheritedReadScope } from './inheritedReadScope';
import { completedContextGroups } from './contextProtection';
import type { AppSnapshot, SourceRef, Task, ToolCallRecord } from '../domain';
import type { FrozenRead, Observation } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { estimateTokens } from '../tokens';
import { requireValue } from './errors';
import { directReadBudgets, readCapacityReceipt, frozenPageCapacityReceipt } from './directReadBudget';
import { READ_FORMAT_VERSION, readCoverage, readKind, pageCoverage, type CoverageReason } from './readCoverage';
import { graphTables } from './graphReadTables';
import { graphPaginator } from './graphPagination';
import { repeatReadNotice } from './readRepetition';
import { fittingTextEnd } from './textSlicePacking';
import { captureRelationHashes, currentRelationHashes, relationCardHashes, relationDependency } from './graphRelationDependencies';
import { bindSubgraphVersions, subgraphFacts, subgraphVersion, subgraphDependency, subgraphKey, captureSubgraphHashes, equivalentSubgraphVersion } from './subgraphVersions';
import { GRAPH_READ_LIMITS, checkGraphReadSource, checkFrozenStorage, resourceLimit } from './graphReadLimits';
import { directoryTree, directoryCard, childDirectories } from './directoryRead';
import { treeListBranch, type TreeListBranch } from './treeExpansion';
import { graphField, fieldReadWith, GRAPH_FIELDS, type GraphField } from './graphReadFields';
import { captureGraphReadHashes, frozenGraphReadHashes, GRAPH_READ_DEPENDENCIES_VERSION,
  graphReadDependenciesCurrent, rememberGraphReadHashes } from './graphReadDependencies';
import { attachFrozenDirectoryEvidence, directoryReplayRequest, graphReadUsage } from './directoryEvidence';
import { rememberCanvasRead, stampCanvasObservation, stampCanvasVersionDependencies } from './canvasReadEvidence';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const key = (canvas: string, directory: string) => `${canvas}/${directory}`;
const sorted = (values: string[]) => [...values].sort();
const isBodyRead = (kind: string) => kind === 'graph_read_node_content' || kind === 'graph_read_directory_content' || kind === 'graph_read_object_field';
export function graphIndex(state: AppSnapshot, canvasId: string, context?: GraphReadContext) {
  if (context && context.graph === state.graph) return context.index(canvasId);
  requireValue(state.graph, '画布尚未加载', 'NOT_READY');
  bindSubgraphVersions(state.graph,state.directoryVersions);
  return canvasIndex(state.graph, canvasId, canvasMemberIds(state.graph, canvasId));
}
/** One hook covers graph commits, imports, undo and redo, including old and new edge endpoints. */
export function updateDirectoryVersions(before: AppSnapshot, state: AppSnapshot) {
  if (state.directoryVersions && Object.values(state.directoryVersions).every(v=>v.directoryVersion!==undefined)
    && before.graphRevision === state.graphRevision && JSON.stringify(before.graph)===JSON.stringify(state.graph)) {
    bindSubgraphVersions(state.graph,state.directoryVersions);return;
  }
  const ledger = state.directoryVersions ??= {}, present = new Set<string>();
  for (const canvas of state.graph?.canvases ?? []) {
    const index = graphIndex(state, canvas.canvasId);
    for (const row of index.rows.values()) if (row.kind !== 'node') {
      const id = key(canvas.canvasId, row.id), facts = subgraphFacts(index, row.id), old = ledger[id]; present.add(id);
      const directDataVersion=(old?.directDataVersion??old?.version??0)+(!old||old.signature!==facts.signature?1:0);
      const directoryVersion=(old?.directoryVersion??0)+(!old||old.structure!==facts.structure||old.directoryVersion===undefined?1:0);
      ledger[id]={signature:facts.signature,structure:facts.structure,version:directDataVersion,directDataVersion,directoryVersion};
    }
  }
  for (const [id, old] of Object.entries(ledger)) if (!present.has(id) && old.signature !== 'deleted')
    ledger[id] = { version: old.version + 1, directDataVersion:(old.directDataVersion??old.version)+1,
      directoryVersion:(old.directoryVersion??0)+1, signature: 'deleted', structure: 'deleted', deleted:true };
  bindSubgraphVersions(state.graph,ledger);
}
export function directoryStamp(_state: AppSnapshot, index: CanvasIndex, ref: string, structureOnly = false) {
  return subgraphVersion(index,ref,structureOnly?'directory':'direct')!;
}
const path = (index: CanvasIndex, ref: string) => index.rows.get(ref)?.segments.map(s => ({ refId: s.id, name: s.name })) ?? [];
export function objectStamp(index: CanvasIndex, ref: string): string | undefined {
  const row = index.rows.get(ref);
  if (row) return digest([row.kind, row.segments.at(-1)?.name, row.content, index.graph.nodes[ref]?.design]);
  const edge = graphTables(index).edges.get(ref);
  return edge ? digest(edge) : undefined;
}
export function membershipStamp(index: CanvasIndex, ref: string, directoriesOnly = false): string | undefined {
  const row = index.rows.get(ref); if (!row) return;
  return digest(sorted(row.children.filter(id => directoriesOnly ? index.rows.get(id)?.kind !== 'node' : index.rows.get(id)?.kind === 'node'))
    .map(id => [id, index.rows.get(id)?.segments.at(-1)?.name, index.rows.get(id)?.kind]));
}
export function searchMatches(index: CanvasIndex, query: string, scope: 'all' | 'node_names' = 'all') {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (scope === 'node_names') return [...index.rows.values()].filter(r => r.kind === 'node' && r.readable
    && terms.some(t => r.segments.at(-1)!.name.toLowerCase().includes(t))).map(r => r.id).sort();
  return [...index.rows.values()].filter(r => r.kind !== 'root' && terms.some(t => `${r.segments.at(-1)?.name}\n${r.content}\n${JSON.stringify(index.graph.nodes[r.id]?.design ?? '')}`.toLowerCase().includes(t)))
    .map(r => r.id).concat(index.edges.filter(e=>terms.some(t=>e.edgeContent.toLowerCase().includes(t))).map(e=>e.edgeId)).sort();
}
export function observe(state: AppSnapshot, task: Task, index: CanvasIndex, refs: string[], completeDirectories: string[] = [], structureOnly = false, query?: string, queryScope?: 'all' | 'node_names', graphQuery?: GraphQuery): Observation {
  const dirs = new Set<string>(completeDirectories);
  for (const ref of refs) { const row = index.rows.get(ref); if (row) dirs.add(row.kind === 'node' ? row.parentId ?? index.rootId : ref);
    const edge=graphTables(index).edges.get(ref);if(edge)for(const endpoint of [edge.sourceNodeId,edge.targetNodeId]){const node=index.rows.get(endpoint);if(node)dirs.add(node.parentId??index.rootId);}
  }
  const directories = Object.fromEntries([...dirs].filter(id => index.rows.has(id)).map(id => [id, directoryStamp(state,index,id,structureOnly)]));
  const sources: SourceRef[] = refs.flatMap(id=>{const source=graphTables(index).source(id);return source?[source]:[];});
  const observation:Observation={ id: `observation:${randomUUID()}`, taskId: task.id, canvasId: task.canvasId, directories,
    objectParents:Object.fromEntries(refs.map(ref=>{
      const row=index.rows.get(ref),edge=graphTables(index).edges.get(ref);
      return [ref,row?[row.kind==='node'?row.parentId??index.rootId:ref]
        :edge?[...new Set([edge.sourceNodeId,edge.targetNodeId].map(id=>index.rows.get(id)?.parentId??index.rootId))]:[]];
    })),
    objects:Object.fromEntries(refs.flatMap(ref => { const stamp=objectStamp(index,ref);return stamp&&!structureOnly?[[ref,stamp]]:[]; })),
    contentLengths:Object.fromEntries(refs.map(ref=>[ref,index.rows.get(ref)?.content.length??graphTables(index).edges.get(ref)?.edgeContent.length??0])),
    directoryMembers:Object.fromEntries(completeDirectories.flatMap(ref => { const stamp=membershipStamp(index,ref,structureOnly);return stamp?[[ref,stamp]]:[]; })),
    paths: Object.fromEntries([...new Set([...dirs,...refs.filter(ref=>index.rows.has(ref))])].map(id => [id,digest(path(index,id))])), refs, completeDirectories, structureOnly,
    graphQuery, query, ...(query ? { queryScope: queryScope ?? 'all', querySignature: digest(searchMatches(index,query,queryScope)) } : {}), sources,
    graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,
    readHashes:{...(structureOnly?captureSubgraphHashes(index,refs,'directory'):captureGraphReadHashes(index.graph,sources,completeDirectories,index.canvasId)),...(graphQuery?{[graphQueryKey(index.canvasId,graphQuery)]:graphQueryVersion(index,graphQuery)}:{})} };
  stampCanvasVersionDependencies(index,observation);return observation;
}
export function observationChange(state: AppSnapshot, observation: Observation, context?: GraphReadContext) {
  if (!state.graph?.canvases.some(c => c.canvasId === observation.canvasId)) return { signature: 'deleted', changes: [{ deleted: true }] };
  const index = graphIndex(state, observation.canvasId, context);
  const changes: Record<string,unknown>[] = [];
  if(observation.objects){
    for(const [refId,stamp] of Object.entries(observation.objects)){
      if(observation.canvasFacts?.some(f=>f.refId===refId))continue;
      const currentVersion=objectStamp(index,refId);
      if(currentVersion!==stamp)changes.push({kind:'content',refId,...(currentVersion?{changed:true,currentVersion}:{deleted:true}),
        domain:'direct_data',...(index.rows.has(refId)?{subgraphRef:index.rows.get(refId)!.kind==='node'?index.rows.get(refId)!.parentId:refId}:{}),
        nextAction:'read_if_current_version_needed',readWith:{tool:'graph_read',arguments:{refs:[refId]}}});
    }
    for(const [refId,stamp] of Object.entries(observation.directoryMembers??{})){
      const currentVersion=membershipStamp(index,refId,observation.structureOnly);
      if(currentVersion!==stamp)changes.push({kind:'directory',refId,...(currentVersion?{membersChanged:true,currentVersion}:{deleted:true}),
        readWith:{tool:observation.structureOnly?'graph_read_directory':'graph_read_subgraph',arguments:refId===index.rootId?{}:{refId}}});
    }
    for(const [refId,stamp] of Object.entries(observation.paths))if(stamp!==digest(path(index,refId)))
      changes.push({kind:'path',refId,...(index.rows.has(refId)?{currentPath:path(index,refId)}:{deleted:true})});
    const current=currentRelationHashes(index.graph,Object.keys(observation.readHashes??{}),context);
    for(const [key,stamp] of Object.entries(observation.readHashes??{})){
      const group=subgraphDependency(key);
      if(group&&!equivalentSubgraphVersion(current[key],stamp)){changes.push({kind:['directory','path','owner'].includes(group.part)?'directory_data':'direct_data',refId:group.refId,
        part:group.part,...(current[key]?{changed:true,currentVersion:current[key]}:{deleted:true}),
        ...(group.part==='directory'&&index.rows.has(group.refId)?{replacement:directoryCard(index,group.refId),replaces:'previous_directory_entry_and_children'}:{}),
        readWith:index.rows.has(group.refId)&&['name','design'].includes(group.part)?fieldReadWith(index,group.refId,group.part as GraphField):index.rows.get(group.refId)?.kind==='node'?{tool:'graph_read',arguments:{refs:[group.refId]}}:
          {tool:['directory','path','owner'].includes(group.part)?'graph_read_directory':'graph_read_subgraph',arguments:group.refId===index.rootId?{}:{refId:group.refId}}});continue;}
      const relation=relationDependency(key);if(!relation||current[key]===stamp)continue;
      changes.push({kind:'relations',refId:relation.refId,...(current[key]?{changed:true,currentVersion:current[key]}:{deleted:true}),
        readWith:{tool:'graph_read_node_edges',arguments:{refId:relation.refId}}});
    }
  }else for (const [id, stamp] of Object.entries(observation.directories)) {
    if (!index.rows.has(id)) changes.push({ refId:id, deleted:true });
    else if (!equivalentSubgraphVersion(stamp,directoryStamp(state,index,id,observation.structureOnly)) || observation.paths[id] !== digest(path(index,id)))
      changes.push({ refId:id, changed:true, currentVersion:directoryStamp(state,index,id,observation.structureOnly),currentPath:path(index,id), nextAction:'read_if_current_version_needed' });
  }
  if(observation.graphQuery){
    const queryKey=graphQueryKey(index.canvasId,observation.graphQuery);
    // A saved query can outlive its scope. The dependency resolver checks that
    // scope before evaluating the query, so deletion remains a freshness fact.
    const currentVersion=currentGraphQueryHashes(index.graph,[queryKey],context)[queryKey];
    if(!currentVersion||observation.readHashes?.[queryKey]!==currentVersion)changes.push({kind:'query',queryKey,
      ...(currentVersion?{currentVersion,membersChanged:true}:{deleted:true}),readWith:observation.graphQuery});
  }
  if (!observation.graphQuery && observation.query && observation.querySignature !== digest(searchMatches(index,observation.query,observation.queryScope))) changes.push({ kind:'query',query:observation.query, scope:observation.queryScope??'all', membersChanged:true,
    currentVersion:digest(searchMatches(index,observation.query,observation.queryScope)),readWith:{tool:'graph_search',arguments:{query:observation.query,scope:observation.queryScope??'all'}} });
  return { signature: digest(changes), changes };
}
function unit(index:CanvasIndex,ref:string) {
  return graphTables(index).node(ref);
}
function graphPageSources(index:CanvasIndex,page:unknown){
  const refs=new Set<string>(),spans=new Map<string,{start:number;end:number}>();
  const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
    const r=value as Record<string,unknown>;if(typeof r.refId==='string'&&!r.field&&r.status!=='blocked'&&('content'in r||'description'in r))refs.add(r.refId);
    if(typeof r.edgeId==='string'&&r.status!=='blocked'&&'content'in r)refs.add(r.edgeId);const identity=r.refId??r.edgeId;if(!['pros','cons'].includes(String(r.field))&&typeof identity==='string'&&typeof r.start==='number'&&typeof r.end==='number')spans.set(identity,{start:r.start,end:r.end});Object.values(r).forEach(visit);};
  visit(page);return [...refs].flatMap(id=>{const s=graphTables(index).source(id);return s?[spans.has(s.id)?{...s,...spans.get(s.id)}:s]:[];});
}
export function directGraphRead(state:AppSnapshot,task:Task,call:ToolCallRecord,args:Record<string,unknown>,projectField?:(value:unknown)=>unknown):Record<string,unknown> {
  state=inheritedReadScope(state,task);
  if(SUBGRAPH_EDGE_TOOLS.has(call.name))return graphQueryRead(state,task,call,args);
  const index=graphIndex(state,task.canvasId), workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const limits=directReadBudgets(state,task,call,args.budget),{pageBudget:budget,availableTokens,maximumTokens}=limits;
  const target=typeof args.refId==='string'?args.refId:index.rootId;
  const directoryTool=call.name==='graph_read_directory',subgraph=call.name==='graph_read_subgraph';
  const recursive=directoryTool&&(args.mode===undefined||args.mode==='recursive'), directory=directoryTool||subgraph;
  requireValue(!subgraph||args.mode===undefined||args.mode==='children','子图正文仅支持直属读取；请先用graph_read_directory展开目录，再通过refs批量读取子图。','INVALID_ARGUMENT',{executed:false});
  requireValue(!subgraph||!(args.refs!==undefined&&args.refId!==undefined),'refId与refs不能同时提供','INVALID_ARGUMENT');
  const targets=subgraph&&Array.isArray(args.refs)?[...new Set(args.refs as string[])]:[target];
  if(subgraph)requireValue(targets.length>0&&targets.length<=GRAPH_READ_LIMITS.batch,'每次读取需要1至20个子图','INVALID_ARGUMENT');
  const invalidTargets=directory?targets.filter(id=>!index.rows.has(id)||index.rows.get(id)!.kind==='node'):[];
  requireValue(!invalidTargets.length,'子图不属于当前画布，整次读取未执行','OUT_OF_SCOPE',{failedRefs:invalidTargets,requestedRefs:targets,executed:false});
  if(directory) requireValue(index.rows.has(target)&&index.rows.get(target)!.kind!=='node','目录不属于当前画布','OUT_OF_SCOPE',
    {failedRefs:[target],executed:false,nextAction:'use_directory_in_current_canvas'});
  let refs=!subgraph&&Array.isArray(args.refs)?args.refs as string[]:[];
  requireValue(refs.every(id=>id!==index.rootId),'根目录请通过目录函数省略refId读取','ROOT_READ_ONLY');
  const failedRefs=refs.filter(id=>!index.rows.has(id)&&!index.edges.some(e=>e.edgeId===id));
  requireValue(!failedRefs.length,'对象不属于当前读取范围','OUT_OF_SCOPE',
    {failedRefs,executed:false,nextAction:'retry_with_in_scope_refs'});
  const searchScope=args.scope??'all';
  if(call.name==='graph_search') {
    requireValue(searchScope==='all'||searchScope==='node_names','scope必须为all或node_names','INVALID_ARGUMENT');
    requireValue(args.limit===undefined||Number.isInteger(args.limit)&&Number(args.limit)>=0,'limit必须为非负整数','INVALID_ARGUMENT');
  }
  const graphQuery:GraphQuery|undefined=call.name==='graph_search'&&enhancedSearch(args)?{tool:call.name,arguments:{...args}}:undefined;
  if(graphQuery){validateNodeSearch(index,args);if(args.designTypes!==undefined)assertDesignQuery(state,task);}
  const matches=call.name==='graph_search'?(graphQuery?nodeSearchMatches(index,args as any):searchMatches(index,String(args.query??''),searchScope as 'all'|'node_names')):[];
  if(call.name==='graph_search') refs=matches.slice(0,Math.min(50,Number(args.limit??12)));
  const countOnly=call.name==='graph_search'&&args.limit===0;
  const selection:FrozenRead['searchSelection']=call.name==='graph_search'?{...(searchScope==='node_names'?{scope:searchScope}:{}),totalMatches:matches.length,selectedMatches:refs.length,
    ...(countOnly?{countOnly:true,countComplete:true}:{})}:undefined;
  const searchLimited=!!selection&&!countOnly&&selection.selectedMatches<selection.totalMatches;
  const tables=graphTables(index),seeds=[...refs];
  const rangeRead=call.name==='graph_read_node_content'&&(args.start!==undefined||args.end!==undefined);
  if(rangeRead){
    requireValue(args.field===undefined,'正文范围读取不能同时指定field；读取优缺点时省略start/end。','INVALID_ARGUMENT',
      {executed:false,reason:'range_field_conflict'});
    requireValue(args.start!==undefined&&args.end!==undefined,'正文范围读取须同时提供start和end。','INVALID_ARGUMENT',
      {executed:false,reason:'paired_range_required'});
    requireValue(typeof args.expectedVersion==='string','正文范围读取须保留原读取入口的expectedVersion。','INVALID_ARGUMENT',
      {executed:false,reason:'expected_version_required'});
    requireValue(Number.isSafeInteger(args.start)&&Number.isSafeInteger(args.end)&&Number(args.start)>=0&&Number(args.end)>=Number(args.start),
      'start/end须为UTF-16偏移整数，满足0≤start≤end。','INVALID_ARGUMENT',{executed:false,reason:'invalid_range'});
  }
  if((isBodyRead(call.name)||call.name==='graph_read_object_field')&&args.expectedVersion!==undefined){
    const currentVersion=call.name==='graph_read_object_field'&&GRAPH_FIELDS.includes(args.field as GraphField)?graphField(index,target,args.field as GraphField).version:tables.source(target)?.version;
    requireValue(currentVersion===args.expectedVersion,'对象已变化，不能用新版补齐旧冻结结果；需要当前版本时重新读取对象。','VERSION_CONFLICT',
      {failedRefs:[target],expectedVersion:args.expectedVersion,currentVersion,executed:false,nextAction:'reread_current_object',readWith:{tool:'graph_read',arguments:{refs:[target]}}});
  }
  if(rangeRead){
    const row=index.rows.get(target);
    requireValue(row?.readable&&row.kind==='node','需要当前画布节点','OUT_OF_SCOPE');
    requireValue(Number(args.end)<=row.content.length,'请求范围超出该版本正文长度；请缩小end或使用readWith分页读取全文。','INVALID_ARGUMENT',
      {executed:false,reason:'range_out_of_bounds',contentLength:row.content.length,allowedRange:{start:0,end:row.content.length},
        expectedVersion:args.expectedVersion,nextAction:'read_within_known_content_range',
        readWith:{tool:call.name,arguments:{refId:target,expectedVersion:args.expectedVersion,...(args.budget===undefined?{}:{budget:args.budget})}}});
  }
  if(call.name==='graph_read_node_edges'){
    requireValue(!(args.requests!==undefined&&args.refId!==undefined),'单节点 refId 与批量 requests 不能同时提供','INVALID_ARGUMENT');
    const requests=(Array.isArray(args.requests)?args.requests:[{refId:args.refId,expectedRelationVersion:args.expectedRelationVersion}]) as Array<{refId:string;expectedRelationVersion?:string}>;
    requireValue(requests.length>0&&requests.length<=20,'每次关联边查询需要 1 至 20 个节点','INVALID_ARGUMENT');
    const requestedRefs=[...new Set(requests.map(r=>r.refId))];
    const invalid=requestedRefs.filter(id=>!index.rows.has(id)||index.rows.get(id)!.kind!=='node');
    requireValue(!invalid.length,'关联边查询含不在当前画布内的节点，整次未执行','OUT_OF_SCOPE',{failedRefs:invalid,requestedRefs,executed:false});
    const conflicts=requests.filter(r=>r.expectedRelationVersion!==undefined&&r.expectedRelationVersion!==tables.relationVersion(r.refId));
    requireValue(!conflicts.length,'关联边集合已变化，整次未执行；请重读冲突节点取得当前关系入口','VERSION_CONFLICT',
      {failedRefs:[...new Set(conflicts.map(r=>r.refId))],requestedRefs,executed:false,
        conflicts:conflicts.map(r=>({refId:r.refId,currentRelationVersion:tables.relationVersion(r.refId)})),nextAction:'reread_node_relations'});
    refs=requestedRefs;
  }
  if(call.name==='graph_neighbors')refs=[...new Set([...refs,...seeds.flatMap(id=>tables.related(id)).flatMap(e=>[e.sourceNodeId,e.targetNodeId]).filter(id=>index.rows.has(id))])];
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
  const queryArgs={...(call.name==='graph_read_node_edges'?{requests:refs.map(refId=>({refId}))}:args),
    budget:args.budget??AUTO_CONTEXT.readTokens,...(call.name==='graph_search'?{scope:searchScope}:{}),...(subgraph?{refs:targets,refId:undefined,mode:undefined}:directory?{refId:target,mode:args.mode??'recursive'}:{})};
  const queryKey=digest([call.name,canonical(queryArgs),'directory-batch-pages-v8-tree-envelope',...(projectField?['field-short-references-v1']:[]),...(countOnly?['count-only-complete-v1']:[])]);
  const recentPointers=new Set(state.toolCalls.filter(c=>c.taskId===task.id&&c.id!==call.id&&c.presentedAt!==undefined).slice(-8)
    .flatMap(c=>{try{const result=JSON.parse(c.result??'{}');return result.status==='ok'&&typeof result.pointerId==='string'?[result.pointerId]:[];}catch{return [];}}));
  // Repeated live queries must not keep an ever-growing family protected forever.
  // Once its source leaves the recent window, read the current graph into a new
  // frozen snapshot. Explicit context_read_pages still addresses the old snapshot.
  const recentGroups=completedContextGroups(state,task),recentSteps=new Set(recentGroups.slice(-AUTO_CONTEXT.recentGroups).map(g=>g.id));
  const previous=workspace.frozenReads?.find(r=>r.taskId===task.id&&r.canvasId===task.canvasId&&r.queryKey===queryKey&&recentPointers.has(r.id)
    &&(!recentGroups.length||recentSteps.has(state.toolCalls.find(c=>c.id===r.callId)?.stepId??''))
    &&!frozenReadRevoked(state,r)&&!r.pages.some((_,i)=>frozenPageRevoked(state,r.id,i+1))&&r.readFormatVersion===READ_FORMAT_VERSION&&r.coverage&&r.expiresAt>Date.now()+60000&&!observationChange(state,r.snapshotObservation??r.observation).changes.length&&graphReadDependenciesCurrent(index.graph,r));
  if(previous){
    call.frozenSourceCallId=previous.callId;
    const data=previous.pages[0],sources=previous.pageSources?.[0]??[],totalPages=previous.pages.length;
    const result={status:data.status==='blocked'||Array.isArray(data.boundaries)&&data.boundaries.length?'partial':'ok',pointerId:previous.id,page:1,totalPages,hasMorePages:totalPages>1,isLastPage:totalPages===1,
      data,coverage:pageCoverage(previous.coverage!,totalPages,data.status==='blocked'),sources,reused:true,freshness:'current',stale:false,
      ...(totalPages>1?{nextCursor:{pointerId:previous.id,page:2}}:{}),...(selection?{selection}:{}),...(subgraph?{requestedRefs:targets}:{})};
    const requiredTokens=estimateTokens(JSON.stringify(result));
    if(requiredTokens>maximumTokens)return frozenPageCapacityReceipt(call,{pointerId:previous.id,page:1},availableTokens,requiredTokens,maximumTokens);
    if(requiredTokens>availableTokens)return readCapacityReceipt(call,{...args,pointerId:previous.id,page:1},availableTokens,requiredTokens,{limits});
    const repeatNotice=repeatReadNotice(state,task,call,previous.id,1);
    if(repeatNotice&&estimateTokens(JSON.stringify({...result,repeatNotice}))<=availableTokens)Object.assign(result,{repeatNotice});
    const observation=structuredClone(previous.pageObservations?.[0]??previous.observation);observation.id=`observation:${randomUUID()}`;observation.callId=call.id;
    stampCanvasObservation(index,observation,data);
    (workspace.observations??=[]).push(observation);call.resultSources=sources;
    rememberReadPage(call,previous.id,1,frozenGraphReadHashes(previous,1));
    attachFrozenDirectoryEvidence(call,previous,1);
    rememberCanvasRead(call,{...previous,canvasOrigin:previous.canvasOrigin??{version:1,tool:call.name,arguments:structuredClone(args)},pageObservations:[observation]},1);
    rememberGraphReadHashes(task,frozenGraphReadHashes(previous,1));return result;
  }
  if(availableTokens<256)return readCapacityReceipt(call,args,availableTokens,256,{limits,minimumOnly:true});
  const pages:Record<string,unknown>[]=[],seen:string[]=[],complete:string[]=[],boundaries:string[]=[];
  const directoryBranches:TreeListBranch[]=[];
  const pointerId=`read:${randomUUID()}`;
  // Measure the actual wire envelope and provenance. The continuation/stale envelope is the largest.
  const frame=(data:Record<string,unknown>,page=99999999,totalPages=99999999)=>({status:'partial',pointerId,page,totalPages,hasMorePages:page<totalPages,isLastPage:page===totalPages,data,
    coverage:pageCoverage(readCoverage(readKind(call.name),['pagination','oversized_object','relations_deferred',...(recursive?['directory_boundary' as const]:[]),...(searchLimited?['search_limit' as const]:[])]),2),...(selection?{selection}:{}),freshness:'unknown',stale:true,
    notice:'这是冻结版本的原文，可用于历史比较；仅需当前版本时重新读取。',sources:graphPageSources(index,data),nextCursor:{pointerId,page:page+1},
    ...(subgraph?{requestedRefs:targets}:{})});
  const fits=(data:Record<string,unknown>)=>estimateTokens(JSON.stringify(frame(data)))<=budget;
  const edgeIds=(ids:string[])=>sorted([...new Set(ids.flatMap(id=>tables.edges.has(id)?[id]:tables.related(id).map(e=>e.edgeId)))]);
  const paginator=graphPaginator(index,pages,pointerId,budget,fits,data=>estimateTokens(JSON.stringify(frame(data))));
  const put=paginator.put;
  if(directoryTool){
    if(recursive){
      const wrap=(tree:Record<string,unknown>)=>{
        const scope=String(tree.refId),parentId=index.rows.get(scope)?.parentId;
        return {kind:'directory_tree',scope,...(parentId?{parentId}:{}),tree,
          listReadWith:{tool:'graph_read_directory',arguments:{...(scope===index.rootId?{}:{refId:scope}),mode:'children'}}};
      };
      const result=directoryTree(index,target,tree=>fits(wrap(tree)),(id,ids,rows)=>treeListBranch(id,ids,rows,budget,
        items=>({kind:'directory_children',scope:id,directoryVersion:subgraphVersion(index,id,'directory'),listOnly:true,totalChildren:ids.length,items}),fits));
      directoryBranches.push(...result.branches);
      pages.push(wrap(result.tree));seen.push(...result.refs);complete.push(...result.shown);boundaries.push(...result.omitted);
    }else{
      const ids=childDirectories(index,target);resourceLimit(ids.length<=GRAPH_READ_LIMITS.objects,'objects');
      put(ids.map(id=>directoryCard(index,id)),call.name,target,[],{directoryVersion:subgraphVersion(index,target,'directory'),listOnly:true});
      seen.push(target,...ids);complete.push(target);
    }
  }else if(subgraph){
    const groups=targets.map(id=>({id,nodes:sorted(index.rows.get(id)!.children.filter(r=>index.rows.get(r)!.kind==='node'))}));
    const allNodes=groups.flatMap(g=>g.nodes);checkGraphReadSource(index,[...targets,...allNodes],edgeIds(allNodes));
    const groupPages:Record<string,unknown>[][]=[];
    for(const {id,nodes} of groups){
      const start=pages.length,row=index.rows.get(id)!;
      const items=[...(row.content?[tables.node(id,false)]:[]),...nodes.map(r=>tables.node(r,false))];
      const name=row.segments.at(-1)?.name??'';
      put(items,call.name,id,edgeIds(nodes),{subgraph:{refId:id,...(name.length<=256?{name}:{nameReadWith:fieldReadWith(index,id,'name')}),directDataVersion:subgraphVersion(index,id,'direct')}});
      groupPages.push(pages.slice(start));
    }
    // Stable round-robin page delivery, retaining each branch's correct origin.
    const original=new Map(pages.map((p,i)=>[p,i+1])),ordered:Record<string,unknown>[]=[];
    for(let offset=0;groupPages.some(g=>offset<g.length);offset++)for(const group of groupPages)if(group[offset])ordered.push(group[offset]);
    const positions=new Map(ordered.map((p,i)=>[original.get(p)!,i+1]));pages.splice(0,pages.length,...ordered);
    for(const branch of paginator.branches)for(const page of branch.pages){const origin=(page.query as {origin?:{page:number}})?.origin;if(origin)origin.page=positions.get(origin.page)!;}
  }else if(call.name==='graph_read_object_field'){
    requireValue(GRAPH_FIELDS.includes(args.field as GraphField),'field必须为name、path或design','INVALID_ARGUMENT');
    const field=args.field as GraphField,value=graphField(index,target,field);checkGraphReadSource(index,[target],[]);
    // Project structural JSON before slicing: aliases must not alter frozen offsets,
    // and user-authored name/pros/cons strings must never be rewritten.
    if(value.encoding==='json'&&projectField)value.content=JSON.stringify(projectField(JSON.parse(value.content)));
    let offset=0;
    const part=(end:number)=>({refId:target,field,objectVersion:tables.source(target)?.version,encoding:value.encoding,version:value.version,content:value.content.slice(offset,end),start:offset,end,contentLength:value.content.length});
    while(offset<value.content.length){const end=fittingTextEnd(value.content,offset,budget,end=>fits(part(end)));if(end<=offset)return readCapacityReceipt(call,args,availableTokens,undefined,{limits,usePageBudget:true});
      pages.push(part(end));offset=end;resourceLimit(pages.length<=GRAPH_READ_LIMITS.pages,'pages');}
    if(!pages.length)pages.push(part(0));
  }else if(call.name==='graph_read_node_content'||call.name==='graph_read_directory_content'){
    const nodeContent=call.name==='graph_read_node_content',row=index.rows.get(target);
    requireValue(row?.readable&&row.kind!=='root'&&(nodeContent?row.kind==='node':row.kind!=='node'),nodeContent?'需要当前画布节点':'需要当前画布内的子图或图文档','OUT_OF_SCOPE');
    checkGraphReadSource(index,[target],[]);
    const design=nodeContent?index.graph.nodes[target]?.design:undefined;
    requireValue(args.field===undefined||nodeContent&&design?.type==='combination'&&['pros','cons'].includes(String(args.field)),'只有组合可单独读取优缺点；方案的评价请读取正文');
    const field=args.field as 'pros'|'cons'|undefined;
    const content=field?design?.[field]??'':index.rows.get(target)!.content;let offset=Number(args.start??0);const rangeEnd=Number(args.end??content.length);
    const location=tables.path(target);
    const metadata={refId:target,...(field?{field}:{}),...(!nodeContent?{kind:'directory'}:{}),...(nodeContent?{
      ...(JSON.stringify(location).length<=512?{path:location}:{pathReadWith:fieldReadWith(index,target,'path')}),relations:tables.relations(target)}:{}),
      ...(design&&!field?{design:{type:design.type},designReadWith:fieldReadWith(index,target,'design')}:{})};
    while(offset<rangeEnd){
      const part=(end:number)=>({...metadata,content:content.slice(offset,end),start:offset,end,contentLength:content.length});
      const end=fittingTextEnd(content.slice(0,rangeEnd),offset,budget,end=>fits(part(end)));
      if(end<=offset)return readCapacityReceipt(call,args,availableTokens,undefined,{limits,usePageBudget:true});
      pages.push(part(end));offset=end;resourceLimit(pages.length<=GRAPH_READ_LIMITS.pages,'pages');}
    if(!pages.length)pages.push({...metadata,content:'',start:offset,end:offset,contentLength:content.length});
  }else if(call.name==='graph_read_node_edges'){
    const nodes=refs.map(refId=>({refId,kind:'node',relations:{totalEdges:tables.related(refId).length,version:tables.relationVersion(refId)}}));
    const ids=edgeIds(refs);
    checkGraphReadSource(index,refs,ids);
    pages.push(...paginator.edgePages(ids,refs.length===1?refs[0]:index.rootId,{kind:'all_incident_edges',requestedRefs:refs,totalEdges:ids.length},nodes));
  }else if(countOnly){
    // Completing a count is not reading any matching object or relation. Keep
    // both the payload and frozen selection explicit, with no content sources.
    pages.push({kind:'graph_search',scope:index.rootId,countOnly:true,items:[],edges:[]});
  }else {const related=edgeIds(call.name==='graph_neighbors'?seeds:refs);checkGraphReadSource(index,refs,related);put(refs.filter(id=>index.rows.has(id)).map(id=>unit(index,id)),call.name,index.rootId,related);}
  if(!pages.length)pages.push({items:[]});
  if(paginator.failed||[...pages,...paginator.branches.flatMap(b=>b.pages),...directoryBranches.flatMap(b=>b.pages)].some(page=>!fits(page)))return readCapacityReceipt(call,args,availableTokens,undefined,{limits,usePageBudget:true});
  const first=pages[0];
  const oversized=pages.some(p=>hasOversized(p));
  const deferred=paginator.branches.length>0||pages.some(p=>(p.items as Record<string,unknown>[]??[]).some(n=>(n.relations as {coverage?:{extent:string}}|undefined)?.coverage?.extent==='partial'));
  const reasons:CoverageReason[]=[...(oversized?['oversized_object' as const]:[]),...(boundaries.length?['directory_boundary' as const]:[]),...(searchLimited?['search_limit' as const]:[]),...(deferred?['relations_deferred' as const]:[])];
  const coverage=readCoverage(readKind(call.name),reasons);
  const full=!recursive&&pages.length===1&&coverage.extent==='full';
  const pageSources=pages.map(page=>graphPageSources(index,page));
  const result={status:boundaries.length||first.status==='blocked'?'partial':'ok',pointerId,page:1,totalPages:pages.length,hasMorePages:pages.length>1,isLastPage:pages.length===1,
    coverage:pageCoverage(coverage,pages.length,first.status==='blocked'),freshness:'current',stale:false,data:first,sources:pageSources[0],...(!recursive&&pages.length>1?{nextCursor:{pointerId,page:2}}:{}),...(selection?{selection}:{}),
    ...(subgraph?{requestedRefs:targets}:{})};
  const requiredTokens=estimateTokens(JSON.stringify(result));
  if(requiredTokens>availableTokens)return readCapacityReceipt(call,args,availableTokens,requiredTokens,{limits});
  const pageObservations=pageSources.map((sources,i)=>{
    const rows=[pages[i],...((pages[i].items??[]) as Record<string,unknown>[]),...((pages[i].endpoints??[]) as Record<string,unknown>[])];
    const metadataRef=rows.filter(r=>(r===pages[i]||r.relations)&&typeof r.refId==='string'&&index.rows.has(r.refId)).map(r=>r.refId as string);
    const pageScope=typeof pages[i].scope==='string'?pages[i].scope as string:undefined;
    const directoryRefs=directoryTool?(recursive?seen:[target,...((pages[i].items??[]) as Record<string,unknown>[]).map(v=>String(v.refId))]):[];
    const scopes=subgraph&&pageScope?[pageScope]:[];
    const o=observe(state,task,index,[...new Set([...directoryRefs,...metadataRef,...sources.map(s=>s.id)])],recursive?complete:full&&directory?[target]:[],directoryTool,call.name==='graph_search'&&typeof args.query==='string'?args.query:undefined,searchScope as 'all'|'node_names',graphQuery);
    if(!directoryTool){
      // Relation cards, blocked objects and endpoints are identities, not body reads.
      const bodies=new Set(sources.map(s=>s.id));
      o.objects=Object.fromEntries(Object.entries(o.objects??{}).filter(([ref])=>bodies.has(ref)));
      o.contentLengths=Object.fromEntries(Object.entries(o.contentLengths??{}).filter(([ref])=>bodies.has(ref)));
      const paths=new Set(rows.flatMap(row=>Array.isArray(row.path)?row.path.flatMap(p=>p&&typeof p.refId==='string'?[p.refId]:[]):[]));
      o.paths=Object.fromEntries(Object.entries(o.paths).filter(([ref])=>paths.has(ref)));
    }
    if(subgraph&&pageScope){o.directories[pageScope]=directoryStamp(state,index,pageScope);o.directoryMembers![pageScope]=membershipStamp(index,pageScope)!;o.paths={};}
    o.sources=sources;o.readHashes={...captureGraphReadHashes(index.graph,sources,scopes,index.canvasId),
      ...captureSubgraphHashes(index,directoryRefs,'directory'),
      ...relationCardHashes(index.canvasId,pages[i]),
      ...captureRelationHashes(index,call.name==='graph_read_node_edges'?refs:call.name==='graph_neighbors'?seeds:[]),...(graphQuery?{[graphQueryKey(index.canvasId,graphQuery)]:graphQueryVersion(index,graphQuery)}:{})};
    if(subgraph){
      for(const key of Object.keys(o.readHashes))if(subgraphDependency(key)?.part==='path')delete o.readHashes[key];
      Object.assign(o.readHashes,captureSubgraphHashes(index,sources.filter(s=>s.kind==='node').map(s=>s.id),'owner'),captureSubgraphHashes(index,scopes,'content'));
    }
    if(call.name==='graph_read_object_field'){
      Object.assign(o.readHashes,captureSubgraphHashes(index,[target],args.field as GraphField));
      o.objects={};o.paths={};o.contentLengths={};o.directories={};
    }else{
      // A complete field in a fresh object also resolves an earlier field-only read.
      if(!directoryTool)Object.assign(o.readHashes,captureSubgraphHashes(index,rows.filter(r=>typeof r.refId==='string'&&typeof r.name==='string').map(r=>String(r.refId)),'name'));
      if(!isBodyRead(call.name))Object.assign(o.readHashes,captureSubgraphHashes(index,rows.filter(r=>typeof r.refId==='string'&&r.design!==undefined&&task.readHashes?.[subgraphKey(index.canvasId,r.refId,'design')]).map(r=>String(r.refId)),'design'));
    }
    stampCanvasObservation(index,o,pages[i]);o.canvasPage={pointerId,page:i+1,totalPages:pages.length};if(i===0)o.callId=call.id;return o;
  });
  const observation=pageObservations[0];
  const snapshotObservation=observe(state,task,index,[...new Set([...refs,...seen,...(directory?targets:isBodyRead(call.name)||call.name==='graph_read_object_field'?[target]:[]),...pageSources.flatMap(s=>s.map(r=>r.id))])],directoryTool?complete:subgraph?targets:[],directoryTool,call.name==='graph_search'&&typeof args.query==='string'?args.query:undefined,searchScope as 'all'|'node_names',graphQuery);
  for(const field of ['objects','paths','directoryMembers','contentLengths'] as const)
    snapshotObservation[field]=Object.assign({},...pageObservations.map(o=>o[field]));
  if(subgraph)snapshotObservation.paths={};
  snapshotObservation.sources=pageSources.flat();
  snapshotObservation.readHashes=Object.assign({},...pageObservations.map(o=>o.readHashes));
  // Aggregate versions describe the frozen query. Write dependencies remain the
  // actual delivered objects, memberships and relation sets, not every sibling.
  if(subgraph)Object.assign(snapshotObservation.readHashes!,captureSubgraphHashes(index,targets,'direct'));
  if(directoryBranches.length)Object.assign(snapshotObservation.readHashes!,captureSubgraphHashes(index,directoryBranches.flatMap(b=>[b.parentId,...b.childIds]),'directory'));
  observation.callId=call.id;
  const snapshot:FrozenRead={id:pointerId,taskId:task.id,callId:call.id,canvasId:task.canvasId,pages,queryKey,pageBudget:budget,
    canvasOrigin:{version:1,tool:call.name,arguments:structuredClone(args)},
    ...(directoryTool?{directoryReplay:directoryReplayRequest(task.canvasId,target,recursive?'recursive':'children',budget)}:{}),
    pageGraphUsage:pages.map(page=>graphReadUsage(index,call.name,page,call.id)),
    ...(selection?{searchSelection:selection}:{}),
    readFormatVersion:READ_FORMAT_VERSION,coverage,pageSources,pageObservations,snapshotObservation,observation,
    graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,pageReadHashes:pageObservations.map(observation=>observation.readHashes!),
    createdAt:new Date().toISOString(),expiresAt:Date.now()+GRAPH_READ_LIMITS.ttlMs,sources:pageSources.flat(),kind:call.name};
  const additions:FrozenRead[]=[snapshot];
  for(const branch of directoryBranches){
    const allRefs=[branch.parentId,...branch.childIds];
    const branchObservation=observe(state,task,index,allRefs,[branch.parentId],true);branchObservation.sources=[];
    const observations=branch.pages.map(page=>{
      const ids=(page.items as Record<string,unknown>[]??[]).flatMap(row=>typeof row.refId==='string'?[row.refId]:[]);
      const o=observe(state,task,index,[branch.parentId,...ids],[],true);o.sources=[];return o;
    });
    additions.push({id:branch.id,taskId:task.id,callId:call.id,canvasId:task.canvasId,kind:'graph_read_directory_children',pageBudget:budget,
      canvasOrigin:{version:1,tool:'graph_read_directory',arguments:{refId:branch.parentId,mode:'children',budget}},
      directoryReplay:directoryReplayRequest(task.canvasId,branch.parentId,'children',budget),
      readFormatVersion:READ_FORMAT_VERSION,coverage:readCoverage('directory'),pages:branch.pages,pageSources:branch.pages.map(()=>[]),pageObservations:observations,
      graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,pageReadHashes:observations.map(o=>o.readHashes!),
      snapshotObservation:branchObservation,observation:observations[0],sources:[],createdAt:snapshot.createdAt,expiresAt:snapshot.expiresAt});
  }
  for(const branch of paginator.branches){
    const sources=branch.pages.map(page=>graphPageSources(index,page));
    const observations=sources.map((source,i)=>{const o=observe(state,task,index,source.map(s=>s.id));o.sources=source;
      Object.assign(o.readHashes!,captureRelationHashes(index,branch.relationRefs));stampCanvasObservation(index,o,branch.pages[i]);return o;});
    // This cursor freezes every overflow page. Membership and edge bodies have
    // separate versions; a body change on another page must still mark the
    // frozen snapshot historical without pretending that page was delivered.
    const branchObservation={...snapshotObservation,id:'observation:'+randomUUID(),sources:sources.flat(),
      refs:[...new Set([...snapshotObservation.refs,...sources.flat().map(s=>s.id)])],
      objects:Object.assign({},snapshotObservation.objects,...observations.map(o=>o.objects)),
      contentLengths:Object.assign({},snapshotObservation.contentLengths,...observations.map(o=>o.contentLengths)),
      readHashes:Object.assign({},snapshotObservation.readHashes,...observations.map(o=>o.readHashes))};
    delete branchObservation.callId;
    additions.push({id:branch.id,taskId:task.id,callId:call.id,canvasId:task.canvasId,kind:'graph_read_page_edges',pageBudget:budget,
      canvasOrigin:{version:1,tool:'graph_read_node_edges',arguments:{requests:branch.relationRefs.map(refId=>({refId})),budget}},
      pageGraphUsage:branch.pages.map(page=>graphReadUsage(index,'graph_read_node_edges',page,call.id)),
      readFormatVersion:READ_FORMAT_VERSION,coverage:readCoverage('node_edges'),pages:branch.pages,pageSources:sources,pageObservations:observations,
      graphReadDependenciesVersion:GRAPH_READ_DEPENDENCIES_VERSION,pageReadHashes:observations.map(o=>o.readHashes!),
      snapshotObservation:branchObservation,observation:observations[0],sources:sources.flat(),createdAt:snapshot.createdAt,expiresAt:snapshot.expiresAt});
  }
  const retained=(workspace.frozenReads??[]).filter(r=>r.expiresAt>Date.now()&&r.readFormatVersion===READ_FORMAT_VERSION);
  checkFrozenStorage(retained,additions);
  workspace.frozenReads=[...retained,...additions];
  (workspace.observations??=[]).push(observation);
  call.resultSources=observation.sources;
  rememberReadPage(call,snapshot.id,1,frozenGraphReadHashes(snapshot,1));
  attachFrozenDirectoryEvidence(call,snapshot,1);
  rememberCanvasRead(call,snapshot,1);
  rememberGraphReadHashes(task,frozenGraphReadHashes(snapshot,1));
  return result;
}

function hasOversized(value:unknown):boolean {
  if(Array.isArray(value))return value.some(hasOversized);
  return !!value&&typeof value==='object'&&((value as {code?:string}).code==='OBJECT_TOO_LARGE'||Object.values(value).some(hasOversized));
}
