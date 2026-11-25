import type { Observation, SummaryObjectBinding } from '../contextState';
import type { AppSnapshot, SourcePrecondition, Task, ToolCallRecord } from '../domain';
import { canvasDeliveryValid, canvasField, canvasKey, canvasObservationDelivery, row, type CanvasFact } from './canvasReadEvidence';
import type { CanvasIndex } from './canvasView';
import { decodeGraphReference, translateGraphPayload } from './graphReferences';
import { relationCardHashes, relationDependency, relationDependencyKey, relationVersion } from './graphRelationDependencies';
import { verifiedDeliveryPage } from './readDeliveryEvidence';
import { returnedReadPages } from './readPageEvidence';

/** Derive a marker from the delivered page, with no lookup of today's graph contents. */
export function summaryFieldBindings(state:AppSnapshot,task:Task,call:ToolCallRecord):SummaryObjectBinding[] {
  if (call.status !== 'completed' || call.presentedAt === undefined || call.canvasOrigins?.length !== 1) return [];
  const origin = call.canvasOrigins[0];
  const decode = (id:string) => decodeGraphReference(state, task.canvasId, task.sessionId, id);
  if (origin.observation.canvasId !== task.canvasId || !canvasDeliveryValid(call, decode)) return [];
  const result = returnedReadPages(call)[0];
  if (!result || !verifiedDeliveryPage(state,call,result)) return [];
  const observed = canvasObservationDelivery(origin.observation,call,decode);
  if (observed.evidenceUnknown) return [];
  const data=translateGraphPayload(result.data,decode);
  if(!row(data))return [];
  const kinds=new Map<string,SummaryObjectBinding['kind']>();
  for(const item of Array.isArray(data.items)?data.items:[])if(row(item)&&typeof item.refId==='string'){
    if(item.kind==='node')kinds.set(item.refId,'node');
    if(item.kind==='document'||item.kind==='subgraph'||item.kind==='root')kinds.set(item.refId,'document');
  }
  for(const source of observed.sources)if(source.kind==='node'||source.kind==='document'||source.kind==='edge')kinds.set(source.id,source.kind);
  const bindings:SummaryObjectBinding[] = [];
  function add(kind:SummaryObjectBinding['kind'], fact:CanvasFact) {
    const {refId:id,field,version,start,end,total,sliceVersion} = fact;
    const fieldRead = {recordId:call.id,pointerId:origin.pointerId,page:origin.page,field,...(start===undefined?{}:{start,end,total}),...(sliceVersion?{sliceVersion}:{})};
    const key = canvasKey([kind,id,version,fieldRead]).slice(0,16);
    bindings.push({key,kind,id,version,fieldRead});
  }
  for (const fact of observed.canvasFacts ?? []) {
    if(origin.request.tool==='graph_read_directory' && fact.field==='spatial'){add('document',fact);continue;}
    if(origin.request.tool==='graph_read_dependencies' && fact.field==='dependencyEdge'){add('edge',fact);continue;}
    if(origin.request.tool==='graph_read_dependencies' && (fact.field.startsWith('dependencies_')||fact.field.startsWith('dependencyCount_'))){add('node',fact);continue;}
    if(fact.field==='members' && origin.request.tool==='graph_search' && origin.request.arguments.scope==='children'
      && fact.refId===(origin.request.arguments.refId??task.canvasId) && result.totalPages===1) {
      add('document',fact);continue;
    }
    if (!['content','name','path','design','pros','cons','edge'].includes(fact.field)) continue;
    const kind=kinds.get(fact.refId);
    if(kind)add(kind,fact);
  }
  for (const [key,version] of Object.entries(relationCardHashes(task.canvasId,data))) {
    const relation = relationDependency(key);
    if (relation && observed.readHashes?.[key]===version) add('node',{refId:relation.refId,field:'relations',version});
  }
  for (const id of Object.keys(observed.directoryMembers??{})) {
    // A single partial page never establishes that all immediate members were shown.
    if (!observed.completeDirectories.includes(id) && result.totalPages !== 1) continue;
    const field = observed.structureOnly?'directory_members':'node_members';
    const fact = observed.canvasVersionDependencies?.['directoryMembers:'+id]?.find(f=>f.field===field && f.refId===id);
    if (fact) add('document',fact);
  }
  return bindings;
}

export function summaryFieldVersion(index:CanvasIndex,id:string,field:string,range?:{start?:number;end?:number}):string|undefined {
  if (field === 'relations') return relationVersion(index,id);
  if (!index.rows.get(id)?.readable && id!==index.rootId && !index.edges.some(e=>e.edgeId===id)) return;
  const value = canvasField(index,id,field);
  if(range?.start!==undefined && range.end!==undefined)
    return typeof value==='string'?canvasKey([value.length,value.slice(range.start,range.end)]):undefined;
  return value === undefined ? undefined : canvasKey(value);
}

/** A selected marker scopes its own object. Keep explicit batch siblings and ordinary
 * identity citations conservative. A collection marker alone does not cite each member's body. */
export function selectSummaryFields(call:ToolCallRecord,catalog:SummaryObjectBinding[],
  selected:SummaryObjectBinding[],objectBindings:SummaryObjectBinding[],omittedKeys:string[]=[]) {
  const byKey=new Map(catalog.map(b=>[b.key,b]));
  if(!selected.every(b=>byKey.has(b.key) && canvasKey(byKey.get(b.key))===canvasKey(b)) || !omittedKeys.every(key=>byKey.has(key)))return;
  const origin=call.canvasOrigins![0],args=origin.request.arguments;
  const previous=[...selected,...omittedKeys.map(key=>byKey.get(key)!)];
  const selectedIds=new Set(previous.map(b=>b.id));
  const collection=previous.some(b=>b.fieldRead?.field==='members' && b.id===(args.refId??origin.observation.canvasId));
  const explicit=Array.isArray(args.refs)?args.refs:origin.request.tool==='graph_search'&&!collection?origin.observation.refs:[];
  const otherIds=new Set(explicit.filter((id):id is string=>typeof id==='string'&&!selectedIds.has(id)));
  for(const b of objectBindings)if(!b.fieldRead && b.kind!=='read' && origin.observation.refs.includes(b.id))otherIds.add(b.id);
  const knownIds=new Set(catalog.map(b=>b.id));
  if([...otherIds].some(id=>!knownIds.has(id)))return;
  const checks=new Map([...selected,...catalog.filter(b=>otherIds.has(b.id))].map(b=>[b.key,b]));
  return {otherIds,checks};
}

/** Only an actual matching reread can advance this submission guard. Summary evidence
 * is never added to the execution model's body-read or write-authority observations. */
export function summaryFieldCheck(task:Task,binding:SummaryObjectBinding,record:ToolCallRecord) {
  const {field,recordId,pointerId,start,end,total,sliceVersion} = binding.fieldRead!;
  const version = String(binding.version);
  const fact = {refId:binding.id,field,version,pointerId,...(start===undefined?{}:{start,end,total}),...(sliceVersion?{sliceVersion}:{})};
  const observation:Observation = {id:'summary-field:'+binding.key,taskId:task.id,canvasId:task.canvasId,
    callId:recordId,refs:[binding.id],objects:{},paths:{},directories:{},completeDirectories:[],sources:[],
    ...(field==='relations'?{readHashes:{[relationDependencyKey(task.canvasId,binding.id)]:version}}:{canvasFacts:[fact]}),
    ...(field==='path'?{observedPaths:record.canvasOrigins?.[0].observation.observedPaths}:{})};
  const source:SourcePrecondition = {kind:binding.kind as 'node'|'document'|'edge',id:binding.id,version:sliceVersion??version,
    tracking:'current',summaryField:{canvasId:task.canvasId,field,version:sliceVersion??version,...(sliceVersion?{start,end}:{})}};
  return {observation,source};
}
