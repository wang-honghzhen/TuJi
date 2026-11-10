import { graphReadContext, type GraphReadContext } from './graphReadContext';
import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { ContextStage, Observation } from '../contextState';
import { digest, graphIndex, membershipStamp, objectStamp, observationChange } from './directGraph';
import { graphTables } from './graphReadTables';
import { relationDependencyKey } from './graphRelationDependencies';
import { subgraphKey, equivalentSubgraphVersion, type SubgraphPart } from './subgraphVersions';
import { acknowledgedObservations, visibleWriteCalls } from './writeAcknowledgements';
import { currentDirectoryObservation } from './directoryObservations';
import { renderNoticeFacts } from './contextUpdates';
import { allRetainedCalls, originResultId, visibleCallResult } from './readVisibility';
import { canvasField, canvasKey, canvasFactCovered, factKey, canvasReadTools, canvasResultHasBody, canvasDeliveryValid, canvasObservationDelivery, visibleCanvasCallIds, deliveredCanvasFacts, type CanvasFact } from './canvasReadEvidence';
import { graphQueryKey, graphQueryVersion } from './graphQueries';
import { decodeGraphReference } from './graphReferences';
import { mayHaveCanvasPage } from './readPageEvidence';
import { visibleTaskPages } from './readDeliveryEvidence';

type Change = Record<string, unknown>;
const changeKey = (change: Change, observation:Observation) => digest([observation.canvasId,change.kind,change.refId,change.queryKey,change.query,change.scope,change.part,
  change.kind==='unknown'?observation.callId??observation.id:undefined]);
function completeVisibleQuery(observations:Observation[]){
  const pages=new Map<string,Set<number>>();for(const o of observations)if(o.canvasPage){const set=pages.get(o.canvasPage.pointerId)??new Set();set.add(o.canvasPage.page);pages.set(o.canvasPage.pointerId,set);}
  return observations.some(o=>o.canvasPage&&pages.get(o.canvasPage.pointerId)?.size===o.canvasPage.totalPages);
}

/** A mixed result can retain an independent leaf after its canvas page becomes a receipt. */
function observationCall(call:ToolCallRecord,observation:Observation,state?:AppSnapshot):ToolCallRecord|undefined {
  const result=state?visibleCallResult(state,call):call.result;
  if(observation.archiveProof)return {...call,result};
  const origin=call.canvasOrigins?.find(o=>o.observation.id===observation.id);
  const expected=origin??observation.canvasPage;
  if(!expected)return {...call,result};
  try{
    const find=(value:unknown):Record<string,unknown>|undefined=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      const row=value as Record<string,unknown>;
      if(row.pointerId===expected.pointerId&&row.page===expected.page&&['ok','partial'].includes(String(row.status))&&row.data!==undefined)return row;
      if(Array.isArray(row.results))for(const child of row.results){const found=find(child);if(found)return found;}
      return;
    };
    const shown=find(JSON.parse(result??'null'));if(!shown)return;
    return {...call,result:JSON.stringify(shown),canvasOrigins:call.canvasOrigins?.filter(o=>o.pointerId===expected.pointerId&&o.page===expected.page)};
  }catch{return;}
}

export function visibleObservations(stage: ContextStage, observations: Observation[], task: Task, calls: ToolCallRecord[] = [],state?:AppSnapshot): Observation[] {
  const archivePages = new Map<string, Set<number>>();
  if (state && [...observations, ...stage.baselineObservations ?? [], ...calls.flatMap(c => c.canvasOrigins?.map(o => o.observation) ?? [])]
    .some(o => o.archiveProof)) for (const page of visibleTaskPages(state, task, stage).pages) {
    if (page.kind !== 'task_archive' || page.representation !== 'body') continue;
    const pages = archivePages.get(page.pointerId) ?? new Set<number>(); pages.add(page.page); archivePages.set(page.pointerId, pages);
  }
  const ids=visibleCanvasCallIds(stage),visible=calls.filter(c=>ids.has(c.id)||ids.has(originResultId(c)));
  const stored=[...observations,...stage.baselineObservations??[]];
  for(const c of visible)if(!stored.some(o=>o.callId===c.id||o.callId===originResultId(c)))
    for(const origin of c.canvasOrigins??[])stored.push({...structuredClone(origin.observation),callId:c.id,taskId:task.id});
  const writes=visibleWriteCalls(stage,calls),writeIds=new Set(writes.map(c=>c.id));
  const byId=new Map(visible.flatMap(c=>[[originResultId(c),c],[c.id,c]]));
  const raw=new Map(stored.map(o=>[o.id,o]));
  return acknowledgedObservations([...raw.values()],writes).map(o=>{
    const original=o.callId&&byId.get(o.callId),c=original&&observationCall(original,o,state);
    if(original&&!c)return;
    const decode=(id:string)=>state?decodeGraphReference(state,task.canvasId,task.sessionId,id):id;
    if(c&&(canvasReadTools.has(c.name)||c.canvasOrigins?.length)&&!canvasDeliveryValid(c,decode))o={...o,evidenceUnknown:true};
    // Replay exact write digests before repairing legacy read ranges. Even an
    // unrelated write may advance a composite observation; it does not make a
    // partial old delivery complete. Full writes supply their own current facts.
    const projected=c&&raw.has(o.id)&&!o.evidenceUnknown&&(canvasReadTools.has(c.name)||c.canvasOrigins?.length||o.canvasFacts?.length)?canvasObservationDelivery(o,c,decode):o;
    if (o.archiveProof && !o.archiveProof.pages.every(page => archivePages.get(o.archiveProof!.pointerId)?.has(page)))
      return { ...projected, evidenceUnknown: true };
    return projected;
  }).filter((o):o is Observation=>!!o).filter(o => (o.taskId === task.id||!!o.callId&&(ids.has(o.callId)||writeIds.has(o.callId)))
    && currentDirectoryObservation(stage,o)
    && (!o.entryId || stage.entries.some(e => e.id === o.entryId))
    && (!o.callId || stage.entries.some(e => e.id === `material:${o.callId}` || e.readCallIds?.includes(o.callId!)
      || (e.category === 'current_protocol'||writeIds.has(o.callId!)) && !e.receiptCallIds?.includes(o.callId!) && e.coverage.some(c => c.recordId === o.callId))));
}

/** A newer fragment resolves only the portion actually delivered, never the entire old read. */
function covered(state: AppSnapshot, old: Observation, change: Change, observations: Observation[], context?: GraphReadContext): boolean {
  if (!state.graph) return false;
  observations=observations.filter(o=>!o.evidenceUnknown);
  const ref = String(change.refId ?? ''), index = graphIndex(state, old.canvasId, context);
  if(change.deleted)return canvasField(index,ref,'existence')===false&&observations.some(o=>o.canvasFacts?.some(f=>f.refId===ref&&f.field==='existence'&&f.version===canvasKey(false)));
  const delivered=()=>deliveredCanvasFacts(index,observations);
  if(change.fact){const fact=change.fact as CanvasFact,current=canvasKey(canvasField(index,fact.refId,fact.field));
    return canvasFactCovered(fact,delivered().filter(f=>factKey(f)===factKey(fact)&&f.version===current));}
  if(change.kind==='unknown')return false;
  const dependencyKey=change.kind==='directory'?'directoryMembers:'+ref:change.kind==='path'?'paths:'+ref
    :change.kind==='directory_data'||change.kind==='direct_data'?subgraphKey(old.canvasId,ref,change.part as SubgraphPart)
    :change.kind===undefined?'directories:'+ref:undefined;
  const dependencies=dependencyKey?old.canvasVersionDependencies?.[dependencyKey]:undefined;
  if(dependencies?.length){const facts=delivered();
    if(dependencies.every(f=>{const current=canvasKey(canvasField(index,f.refId,f.field));
      return f.version===current||canvasFactCovered(f,facts.filter(n=>factKey(n)===factKey(f)&&n.version===current));}))return true;
  }
  if(change.kind==='directory_data'||change.kind==='direct_data')return observations.some(o=>equivalentSubgraphVersion(o.readHashes?.[subgraphKey(old.canvasId,ref,change.part as SubgraphPart)],change.currentVersion as string|undefined));
  if (change.kind === 'content') {
    const latest = observations.filter(o => o.objects?.[ref] === objectStamp(index, ref));
    const required = old.sources.filter(s => s.id === ref);
    if (!required.length) return latest.length > 0;
    const delivered = latest.flatMap(o => o.sources.filter(s => s.id === ref));
    if (delivered.some(s => s.start === undefined)) return true;
    const length = index.rows.get(ref)?.content.length ?? graphTables(index).edges.get(ref)?.edgeContent.length ?? 0;
    return required.every(source => {
      let end = source.start ?? 0;
      const entire = source.start === undefined || source.start === 0 && source.end === old.contentLengths?.[ref];
      for (const span of delivered.slice().sort((a,b) => (a.start ?? 0) - (b.start ?? 0))) {
        if ((span.start ?? 0) > end) break;
        end = Math.max(end, span.end ?? 0);
      }
      return delivered.length > 0 && end >= (entire ? length : source.end ?? length);
    });
  }
  if (change.kind === 'relations') return observations.some(o => o.readHashes?.[relationDependencyKey(old.canvasId, ref)] === change.currentVersion);
  if (change.kind === 'directory') return observations.some(o => o.completeDirectories.includes(ref)&&!!o.structureOnly === !!old.structureOnly
    && o.directoryMembers?.[ref] === membershipStamp(index, ref, old.structureOnly));
  if (change.kind === 'path') return observations.some(o => o.paths[ref] === digest(change.currentPath));
  if (change.kind === 'query') return completeVisibleQuery(old.graphQuery
    ?observations.filter(o=>o.graphQuery&&canvasKey(o.graphQuery)===canvasKey(old.graphQuery)&&o.readHashes?.[graphQueryKey(index.canvasId,old.graphQuery!)]===graphQueryVersion(index,old.graphQuery!))
    :observations.filter(o=>!o.graphQuery&&o.query===old.query&&o.queryScope===old.queryScope&&o.querySignature===change.currentVersion));
  return false;
}

/** Changes are computed from this candidate's actual bodies and successful visible writes. */
export function canvasObservationChanges(state:AppSnapshot,observation:Observation,context?:GraphReadContext):Change[]{
  // Unverified delivery cannot establish which old fields the model received.
  // Its stored stamps may explain a source transition, but cannot prove a
  // current prompt conflict. Other independently verified reads still apply.
  if(observation.evidenceUnknown)return [{kind:'unknown',refId:observation.canvasId}];
  const changes:Change[]=observationChange(state,observation,context).changes;
  if(!observation.provenEmpty&&!Object.keys(observation.objects??{}).length&&!Object.keys(observation.directories).length
    &&!Object.keys(observation.readHashes??{}).length&&!observation.query&&!observation.graphQuery&&!observation.canvasFacts?.length)
    changes.push({kind:'unknown',refId:observation.canvasId});
  if(!state.graph?.canvases.some(c=>c.canvasId===observation.canvasId))return changes;
  const index=graphIndex(state,observation.canvasId,context);
  for(const fact of observation.canvasFacts??[]){const value=canvasField(index,fact.refId,fact.field);
    if(canvasKey(value)!==fact.version)changes.push({kind:fact.field==='path'?'path':observation.structureOnly?'directory_data':'direct_data',part:`field:${fact.field}`,refId:fact.refId,
      fact,...(value===undefined?{deleted:true}:{currentVersion:canvasKey(value)})});}
  return changes;
}
export function pendingCanvasChanges(state:AppSnapshot,task:Task,stage:ContextStage,context:GraphReadContext|undefined=state.graph?graphReadContext(state):undefined) {
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const calls=allRetainedCalls(state),observations=visibleObservations(stage,workspace.observations??[],task,calls,state);
  const pending=new Map<string,{change:Change;observation:Observation;observations:Observation[]}>();
  const visible=visibleCanvasCallIds(stage);
  for(const c of calls)if((visible.has(c.id)||visible.has(originResultId(c)))&&canvasResultHasBody(c)
    &&(canvasReadTools.has(c.name)||c.name==='context_read_pages'&&mayHaveCanvasPage(state,c))
    &&!observations.some(o=>o.callId===c.id||o.callId===originResultId(c)))
    observations.push({id:`unknown:${c.id}`,taskId:task.id,canvasId:task.canvasId,callId:c.id,refs:[],directories:{},paths:{},completeDirectories:[],sources:[],evidenceUnknown:true});
  for(const observation of observations){
    for(const change of canvasObservationChanges(state,observation,context))
    if(!covered(state,observation,change,observations,context)){
      const key=changeKey(change,observation),prior=pending.get(key);
      pending.set(key,{change,observation,observations:[...(prior?.observations??[]),observation]});
    }
  }
  return pending;
}

export function canvasNoticeLabels(state:AppSnapshot,task:Task,change:Change,observation:Observation,encode:(id:string)=>string,context?:GraphReadContext){
  if(change.kind==='unknown')return {kind:'版本无法确认',labels:[observation.refs.length?observation.refs.map(encode).join('/'):'画布读取'],detail:'交付证据缺失，不代表资料已变更；仅当前任务需要时按原读取范围补读'};
  if(change.kind==='query'){
    const query=observation.graphQuery??change.readWith;
    const args=observation.graphQuery?.arguments;
    const scopes=args?.sourceRefId&&args.targetRefId?[String(args.sourceRefId),String(args.targetRefId)]:[String(args?.refId??observation.canvasId)];
    const scope=scopes.map(ref=>ref===task.canvasId?'画布根':encode(ref)).join('↔');
    const reference=observation.callId?encode(observation.callId):`Q${digest([observation.canvasId,query??[observation.query,observation.queryScope]]).slice(0,10)}`;
    return {kind:'查询结果版本变动',labels:[`${reference}@${scope}`],detail:change.deleted
      ?`${observation.graphQuery?.tool??'graph_search'}；原查询范围已删除或不可访问；旧结果仅供历史参考，仅当前任务需要时重新定位可访问范围`
      :`${observation.graphQuery?.tool??'graph_search'}；结果集合已变更，新版未完整交付；仅当前任务需要该查询时重跑原查询`};
  }
  const ref=String(change.refId??task.canvasId),index=graphIndex(state,task.canvasId,context),row=index.rows.get(ref),edge=graphTables(index).edges.get(ref);
  const field=String(change.part??(change.fact as CanvasFact|undefined)?.field??(change.kind==='path'?'path':'')).replace(/^field:/,'');
  const names:Record<string,string>={content:'正文',name:'名称',design:'设计字段',pros:'优点',cons:'缺点',edge:'边数据',path:'路径',owner:'归属',members:'直接成员',directory:'直接子图目录',direct:'文件直接内容',existence:'存在状态'};
  const structural=observation.structureOnly||['path','owner','directory','directory_members'].includes(field)||change.kind==='path';
  const kind=structural?'目录版本变动':'详细数据版本变动';
  const label=ref===task.canvasId?'画布根':encode(ref);
  if(change.deleted)return {kind,labels:[label],detail:'已删除或不在当前范围；旧内容仅供历史参考'};
  const scope=names[field]??(change.kind==='directory'?'直接成员':change.kind==='relations'?'关系集合':row?.kind==='node'?'节点数据':edge?'边数据':'子图信息');
  // Directory tools cannot take node references. Bound body/field/relation
  // readers need a fresh object entry before they can read a newer version.
  const tool=change.kind==='relations'?'graph_read_node_edges':edge||row?.kind==='node'&&['existence','members','path','owner'].includes(field)?'graph_read':structural?'graph_read_directory':row?.kind==='node'&&(!field||['content','pros','cons'].includes(field))?'graph_read_node_content':['name','path','design'].includes(field)?'graph_read_object_field':'graph_read_subgraph';
  const root=ref===task.canvasId;
  const readTool=field==='members'&&row?.kind!=='node'
    ?`按需选graph_read_subgraph（直属节点）或graph_read_directory（直属子图）${root?'，均省略refId':''}`
    :root?`${structural||tool==='graph_read_object_field'?'graph_read_directory':'graph_read_subgraph'}（省略refId）`
    :['graph_read_node_content','graph_read_object_field','graph_read_node_edges'].includes(tool)
      ?`先用graph_read刷新该对象入口；仍缺内容时按返回入口补读（${tool}）`:tool;
  return {kind,labels:[label],detail:`${scope}已变更；新版未完整交付；仅当前任务需要此范围时，${readTool}`};
}

/** Each session compares its own visible read evidence with the current canvas. */
export function appendCanvasFreshness(state: AppSnapshot, task: Task, stage: ContextStage,
  encode:(id:string)=>string, context:GraphReadContext|undefined=state.graph?graphReadContext(state):undefined): string[] {
  if (!state.graph?.canvases.some(c => c.canvasId === task.canvasId)) return [];
  return renderNoticeFacts([...pendingCanvasChanges(state,task,stage,context).values()].map(({change,observation})=>
    canvasNoticeLabels(state,task,change,observation,encode,context)));
}
