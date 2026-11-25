import type { AppSnapshot, ToolCallRecord } from '../domain';
import type { FrozenRead, Observation } from '../contextState';
import { hasDirectNodes, type CanvasIndex } from './canvasView';
import { digest, membershipStamp } from './directGraph';
import { graphTables } from './graphReadTables';
import { bodyRangeQuery, dependencyEndpoints, graphQueryKey, graphQueryVersion, nodeDependencies } from './graphQueries';
import { subgraphDependency, subgraphKey, subgraphVersion } from './subgraphVersions';
import { translateGraphPayload } from './graphReferences';
import { rememberPageOrigin } from './readPageEvidence';

export type Row=Record<string,unknown>;
export interface CanvasReadRequest { version:1; tool:string; arguments:Row }
export function canvasRefreshRequest(request:CanvasReadRequest):CanvasReadRequest {
  const result=structuredClone(request),args=result.arguments;
  delete args.expectedVersion;delete args.expectedRelationVersion;delete args.current;
  if(request.tool==='graph_read_node_content'&&args.start!==undefined)args.current=true;
  if(Array.isArray(args.requests))for(const part of args.requests)if(row(part))delete part.expectedRelationVersion;
  return result;
}
export interface CanvasFact { refId:string; field:string; version:string; start?:number;end?:number;total?:number;pointerId?:string;sliceVersion?:string }
export interface CanvasReadDelivery { pointerId:string;page:number;request:CanvasReadRequest;observation:Observation;payloadHash:string }
export const canvasReadTools=new Set(['graph_read','graph_read_subgraph','graph_read_node_content','graph_read_directory_content',
  'graph_read_dependencies','graph_read_subgraph_edges','graph_read_between_subgraphs','graph_read_object_field','graph_neighbors','graph_read_node_edges','graph_search','graph_search_node_content','graph_read_design_references','graph_read_directory']);
export const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function canonical(v:unknown):unknown {return Array.isArray(v)?v.map(canonical):row(v)?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;}
export const canvasKey=(v:unknown)=>digest(canonical(v));
export const canvasEvidenceFence=(state:AppSnapshot)=>canvasKey([state.graphRevision,state.graph,state.provider]);
const zeroLayer = { layer: 0, offset: 0 };
export function canvasField(index:CanvasIndex,refId:string,field:string):unknown {
  const tables=graphTables(index),item=index.rows.get(refId),edge=tables.edges.get(refId);
  if(field==='existence')return !!(item||edge);
  if(!item&&!edge)return undefined;
  if(field==='spatial')return item?.readable && item.kind !== 'node' ? item.spatial ?? zeroLayer : undefined;
  if(field==='hasDirectNodes')return item && item.kind !== 'node' ? hasDirectNodes(index,refId) : undefined;
  if(field==='members')return item?.children.slice().sort().map(id=>({refId:id,kind:index.rows.get(id)?.kind}));
  if(field==='node_members'||field==='directory_members')return item?.children.filter(id=>(index.rows.get(id)?.kind==='node')===(field==='node_members')).sort();
  if(field==='owner')return item?.parentId??null;
  if(field==='content')return item?.content??edge?.edgeContent;
  if(field==='name')return item?.segments.at(-1)?.name;
  if(field==='path')return item?tables.path(refId):undefined;
  if(field==='design')return index.graph.nodes[refId]?.design??null;
  if(field==='designType')return index.graph.nodes[refId]?.design?.type??null;
  if(field==='pros'||field==='cons')return index.graph.nodes[refId]?.design?.[field]??'';
  if(field==='edge')return edge?tables.edge(refId):undefined;
  if(field==='dependencyEdge')return dependencyEndpoints(index,refId);
  if((field.startsWith('dependencies_')||field.startsWith('dependencyCount_'))&&item?.kind==='node'&&item.readable){
    const direction=field.split('_')[1];
    if(!['outgoing','incoming','both'].includes(direction))return;
    const rows=nodeDependencies(index,refId,direction);
    return field.startsWith('dependencyCount_')?rows.length:rows;
  }
  return undefined;
}
export const factKey=(f:CanvasFact)=>canvasKey([f.refId,f.field]);
/** Only whole text fields actually visible to this request authorize replacement.
 * A stale sibling in the same observation does not erase an unchanged field. */
export function submittedTextFieldBindings(index:CanvasIndex,observations:Observation[]):Record<string,string>{
  const fields=new Map<string,CanvasFact[]>(),bindings:Record<string,string>={};
  for(const o of observations){
    if(o.evidenceUnknown||o.historical||o.canvasId!==index.canvasId)continue;
    for(const fact of o.canvasFacts??[]){
      if(fact.field!=='name'&&fact.field!=='content')continue;
      const scope=subgraphVersion(index,fact.refId,'editScope');
      if(!scope||o.textScopes?.[fact.refId]&&o.textScopes[fact.refId]!==scope)continue;
      const key=subgraphKey(index.canvasId,fact.refId,fact.field==='name'?'name':'body');
      const list=fields.get(key)??[];list.push({...fact,pointerId:fact.pointerId??o.canvasPage?.pointerId});fields.set(key,list);
    }
  }
  for(const [key,facts] of fields){
    const {refId,field}=facts[0],version=canvasKey(canvasField(index,refId,field));
    if(canvasFactCovered({refId,field,version},facts.filter(f=>f.version===version))){
      bindings[key]=version;
      bindings[subgraphKey(index.canvasId,refId,'editScope')]=subgraphVersion(index,refId,'editScope')!;
    }
  }
  return bindings;
}
/** Subsequent edits to hidden text of the same length do not change a delivered slice. */
export function stampBodyRanges(index:CanvasIndex,o:Observation) {
  for(const fact of o.canvasFacts??[]){
    if(fact.start===undefined||fact.end===undefined||!['content','pros','cons'].includes(fact.field))continue;
    const query=bodyRangeQuery(fact.refId,fact.field,fact.start,fact.end,index.rows.get(fact.refId)?.kind!=='node');
    fact.sliceVersion=graphQueryVersion(index,query);
    (o.readHashes??={})[graphQueryKey(index.canvasId,query)]=fact.sliceVersion;
  }
}
export function currentCanvasFact(index:CanvasIndex,fact:CanvasFact):boolean {
  const value=canvasField(index,fact.refId,fact.field);
  if(fact.sliceVersion&&fact.start!==undefined&&fact.end!==undefined)
    return typeof value==='string'&&canvasKey([value.length,value.slice(fact.start,fact.end)])===fact.sliceVersion;
  return canvasKey(value)===fact.version;
}
/** Capture why a composite stamp had its value. A delivered field can then
 * resolve just that component, without certifying any unseen sibling body. */
export function stampCanvasVersionDependencies(index:CanvasIndex,o:Observation){
  const fact=(refId:string,field:string):CanvasFact=>({refId,field,version:canvasKey(canvasField(index,refId,field))});
  const members=(refId:string,directories:boolean,names=false)=>{
    const ids=index.rows.get(refId)?.children.filter(id=>(index.rows.get(id)?.kind!=='node')===directories)??[];
    return [fact(refId,directories?'directory_members':'node_members'),...(names?ids.map(id=>fact(id,'name')):[])];
  };
  const parts=(refId:string,part:string):CanvasFact[]=>{
    if(part==='body')return [fact(refId,'content')];
    if(part==='directory')return [fact(refId,'name'),fact(refId,'owner'),fact(refId,'hasDirectNodes'),fact(refId,'spatial'),...members(refId,true,true)];
    if(part==='members')return members(refId,false);
    if(part==='content')return [fact(refId,'name'),fact(refId,'content')];
    if(part==='direct')return [fact(refId,'name'),fact(refId,'content'),...members(refId,true),...members(refId,false),
      ...(index.rows.get(refId)?.children.filter(id=>index.rows.get(id)?.kind==='node')??[]).flatMap(id=>['name','content','design'].map(field=>fact(id,field)))];
    return [fact(refId,part)];
  };
  o.canvasVersionDependencies=Object.fromEntries([
    ...Object.keys(o.readHashes??{}).flatMap(key=>{const d=subgraphDependency(key);return d?[[key,parts(d.refId,d.part)]]:[];}),
    ...Object.entries(o.directoryMembers??{}).map(([id,stamp])=>[`directoryMembers:${id}`,members(id,!!o.structureOnly,!stamp.startsWith('members:2:'))]),
    ...Object.keys(o.paths).map(id=>[`paths:${id}`,[fact(id,'path')]]),
    // Modern observations use explicit members/read hashes above. The legacy
    // fallback alone subscribes to entire directory bundles; duplicating it per node/page
    // would accidentally capture every sibling and grow snapshots quadratically.
    ...(!o.objects?Object.keys(o.directories).map(id=>[`directories:${id}`,parts(id,o.structureOnly?'directory':'direct')]):[]),
  ]);
}

/** Only complete, current fields imply their nested projections. */
export function deliveredCanvasFacts(index:CanvasIndex,observations:Observation[]):CanvasFact[]{
  observations=observations.filter(o=>!o.evidenceUnknown&&o.canvasId===index.canvasId);
  const facts=observations
    .flatMap(o=>(o.canvasFacts??[]).map(f=>({...f,pointerId:f.pointerId??o.canvasPage?.pointerId})));
  const pages=new Map<string,Set<number>>();
  for(const o of observations)if(o.canvasPage){const set=pages.get(o.canvasPage.pointerId)??new Set<number>();set.add(o.canvasPage.page);pages.set(o.canvasPage.pointerId,set);}
  for(const o of observations){
    const query=o.graphQuery,page=o.canvasPage;
    if(query?.tool!=='graph_search'||query.arguments.scope!=='children'||page?.page!==1||pages.get(page.pointerId)?.size!==page.totalPages)continue;
    const refId=String(query.arguments.refId??index.rootId),directory=index.rows.get(refId);
    if(!directory?.readable||directory.kind==='node'||directory.children.some(id=>!index.rows.get(id)?.readable))continue;
    if(o.readHashes?.[graphQueryKey(index.canvasId,query)]===graphQueryVersion(index,query))
      facts.push({refId,field:'members',version:canvasKey(canvasField(index,refId,'members')),pointerId:undefined});
  }
  for(const o of observations)for(const [refId,stamp] of Object.entries(o.directoryMembers??{})){
    const complete=o.completeDirectories.includes(refId)||o.canvasPage&&pages.get(o.canvasPage.pointerId)?.size===o.canvasPage.totalPages;
    if(complete&&stamp===membershipStamp(index,refId,!!o.structureOnly,stamp)){
      const field=o.structureOnly?'directory_members':'node_members';
      facts.push({refId,field,version:canvasKey(canvasField(index,refId,field)),pointerId:undefined});
    }
  }
  // A complete directory list plus a complete direct-node list resolves an old
  // combined membership notice. Neither list alone certifies the other half.
  for(const refId of new Set(facts.map(f=>f.refId)))if(['node_members','directory_members'].every(field=>
    facts.some(f=>f.refId===refId&&f.field===field&&f.start===undefined&&f.version===canvasKey(canvasField(index,refId,field)))))
    facts.push({refId,field:'members',version:canvasKey(canvasField(index,refId,'members')),pointerId:undefined});
  for(const refId of new Set(facts.map(f=>f.refId)))for(const field of ['design','members']){
    const version=canvasKey(canvasField(index,refId,field)),current=facts.filter(f=>f.refId===refId&&f.field===field&&f.version===version);
    if(!canvasFactCovered({refId,field,version},current))continue;
    for(const part of field==='design'?['pros','cons']:['node_members','directory_members'])
      facts.push({refId,field:part,version:canvasKey(canvasField(index,refId,part)),pointerId:undefined});
  }
  return facts;
}
export function stampDisplayedCanvasFields(index:CanvasIndex,observation:Observation,data:unknown){
  const facts=new Map<string,CanvasFact>();
  const paths=new Map<string,Array<{refId:string;name:string}>>();
  const add=(id:string,field:string,range?:Row)=>{
    const value=canvasField(index,id,field);if(value===undefined)return;
    const f:CanvasFact={refId:id,field,version:canvasKey(value)};
    if(range&&Number.isInteger(range.start)&&Number.isInteger(range.end)&&Number.isInteger(range.contentLength))
      Object.assign(f,{start:Number(range.start),end:Number(range.end),total:Number(range.contentLength)});
    facts.set(canvasKey(f),f);
  };
  const visit=(v:unknown)=>{
    if(Array.isArray(v)){v.forEach(visit);return;}if(!row(v))return;
    if(observation.structureOnly && typeof v.hasDirectNodes==='boolean'){
      const directory=v.listOnly===true?v.scope:v.refId;
      if(typeof directory==='string'){
        if(v.hasDirectNodes===canvasField(index,directory,'hasDirectNodes'))add(directory,'hasDirectNodes');
        const item=index.rows.get(directory), shown=v.spatial ?? zeroLayer, current=item?.spatial ?? zeroLayer;
        if(item?.readable && row(shown) && shown.layer===current.layer && shown.offset===current.offset)add(directory,'spatial');
      }
    }
    if(typeof v.edgeId==='string'&&typeof v.content==='string'){add(v.edgeId,'edge',v);add(v.edgeId,'existence');}
    if(typeof v.refId==='string'){
      const id=v.refId;
      if(typeof v.designType==='string')add(id,'designType');
      if(typeof v.name==='string'||typeof v.content==='string'){
        add(id,'existence');
        if(index.rows.get(id)?.kind==='node')add(id,'members');
      }
      if(typeof v.field==='string'&&typeof v.content==='string'){
        add(id,v.field,v);
        // The object-field reader can translate IDs before slicing its JSON.
        // Only a complete delivery gives us the old human-readable path.
        if(v.field==='path'&&v.start===0&&v.end===v.contentLength&&v.content.length===v.end)
          paths.set(id,graphTables(index).path(id));
      }
      else {
        if(typeof v.content==='string')add(id,'content',v);
        if(typeof v.name==='string')add(id,'name');
        if(Array.isArray(v.path)){
          const path=graphTables(index).path(id);
          if(canvasKey(path)===canvasKey(v.path)){add(id,'path');paths.set(id,path);}
        }
        // A design type tag is not the complete design field.
        if(v.design!==undefined&&canvasKey(v.design)===canvasKey(canvasField(index,id,'design')))add(id,'design');
      }
    }
    for(const [k,child] of Object.entries(v))if(!['readWith','nameReadWith','pathReadWith','designReadWith','arguments','nextCursor'].includes(k))visit(child);
  };visit(data);observation.canvasFacts=[...facts.values()];
  const scopes:Record<string,string>={};
  for(const f of facts.values())if((f.field==='name'||f.field==='content')&&!scopes[f.refId]){
    const scope=subgraphVersion(index,f.refId,'editScope');if(scope)scopes[f.refId]=scope;
  }
  if(Object.keys(scopes).length)observation.textScopes=scopes;
  if(paths.size)observation.observedPaths=Object.fromEntries(paths);
  else delete observation.observedPaths;
}
export function stampCanvasObservation(index:CanvasIndex,observation:Observation,data:unknown){
  stampDisplayedCanvasFields(index,observation,data);
  if(observation.graphQuery?.tool==='graph_read_dependencies' && row(data) && Array.isArray(data.items)){
    const facts=observation.canvasFacts??=[];
    for(const item of data.items)if(row(item) && typeof item.edgeId==='string')
      facts.push({refId:item.edgeId,field:'dependencyEdge',version:canvasKey([item.sourceNodeId,item.targetNodeId])});
    if(typeof data.refId==='string'&&Number.isSafeInteger(data.totalEdges))
      facts.push({refId:data.refId,field:'dependencyCount_'+String(data.direction),version:canvasKey(data.totalEdges)});
    if(observation.canvasPage?.totalPages===1 && typeof data.refId==='string')
      facts.push({refId:data.refId,field:'dependencies_'+String(data.direction),version:canvasKey(data.items)});
  }
  stampCanvasVersionDependencies(index,observation);
}
export function rememberCanvasRead(call:ToolCallRecord,read:FrozenRead,page:number){
  rememberPageOrigin(call,read,page);
  if(!read.canvasOrigin)return;
  const observation=structuredClone(read.pageObservations?.[page-1]??read.observation);observation.callId=call.id;
  if(!read.pageObservations?.[page-1])observation.evidenceUnknown=true;
  const delivery:CanvasReadDelivery={pointerId:read.id,page,request:structuredClone(read.canvasOrigin),observation,payloadHash:canvasKey(read.pages[page-1])};
  call.canvasOrigins=[...new Map([...(call.canvasOrigins??[]),delivery].map(d=>[`${d.pointerId}:${d.page}`,d])).values()];
}
export function visibleCanvasCallIds(stage:import('../contextState').ContextStage){return new Set(stage.entries.flatMap(e=>e.readCallIds??[]));}
export function canvasResultHasBody(call:ToolCallRecord){try{const r=JSON.parse(call.result??'null');return row(r)&&['ok','partial'].includes(String(r.status))&&r.data!==undefined;}catch{return call.status==='completed'&&!!call.result;}}
/** The captured range must describe the bytes that actually remained in the native result. */
export function canvasDeliveryValid(call:ToolCallRecord,decode:(id:string)=>string=id=>id):boolean {
  try{const result=translateGraphPayload(JSON.parse(call.result??'null'),decode);
    if(!row(result)||!['ok','partial'].includes(String(result.status))||result.data===undefined||result.freshness==='unknown')return false;
    return (call.canvasOrigins??[]).every(origin=>origin.pointerId===result.pointerId&&origin.page===result.page&&origin.payloadHash===canvasKey(result.data));
  }catch{return false;}
}
/** Repair legacy edge spans from the verified delivered payload, never from live
 * graph contents. The saved observation and receipt remain immutable. */
export function canvasObservationDelivery(observation:Observation,call:ToolCallRecord,decode:(id:string)=>string=id=>id):Observation {
  const edges=observation.canvasFacts?.filter(f=>f.field==='edge')??[];
  if(!edges.length&&observation.canvasPage)return observation;
  try{
    const result=translateGraphPayload(JSON.parse(call.result??'null'),decode);
    if(!row(result)||!canvasDeliveryValid(call,decode))return {...observation,evidenceUnknown:true};
    const origins=call.canvasOrigins?.filter(o=>o.pointerId===result.pointerId&&o.page===result.page&&o.payloadHash===canvasKey(result.data));
    const origin=origins?.find(o=>o.observation.id===observation.id)??origins?.[0];
    // A restored archive row contains the exact original public result. Its
    // query geometry remains the original pointer/page, not the archive pager.
    if(origin&&row(result.data)&&result.data.kind==='task_archive'&&result.data.restored===true
      &&origins?.some(o=>o.observation.id===observation.id))return observation;
    if(!origin)return edges.length?{...observation,evidenceUnknown:true}:observation;
    if(!Number.isSafeInteger(result.totalPages)||!Number.isSafeInteger(result.page)||Number(result.page)<1||Number(result.page)>Number(result.totalPages))return {...observation,evidenceUnknown:true};
    const fragments=new Map<string,Row[]>();
    const visit=(value:unknown)=>{
      if(Array.isArray(value)){value.forEach(visit);return;}if(!row(value))return;
      if(typeof value.edgeId==='string'&&typeof value.content==='string')fragments.set(value.edgeId,[...fragments.get(value.edgeId)??[],value]);
      for(const [key,child] of Object.entries(value))if(!['readWith','arguments','nextCursor'].includes(key))visit(child);
    };visit(result.data);
    let invalid=false;
    const facts=observation.canvasFacts?.flatMap(fact=>{
      if(fact.field!=='edge')return [fact];
      const shown=fragments.get(fact.refId);if(!shown?.length){invalid=true;return [fact];}
      return shown.map(fragment=>{
        const next={...fact};delete next.start;delete next.end;delete next.total;
        if(['start','end','contentLength'].some(key=>fragment[key]!==undefined)){
          const {start,end,contentLength}=fragment;
          if(![start,end,contentLength].every(Number.isSafeInteger)||Number(start)<0||Number(end)<Number(start)||Number(end)>Number(contentLength)||Number(end)-Number(start)!==String(fragment.content).length){invalid=true;return fact;}
          Object.assign(next,{start,end,total:contentLength});
        }
        return next;
      });
    });
    return {...observation,canvasFacts:facts,canvasPage:{pointerId:origin.pointerId,page:origin.page,totalPages:Number(result.totalPages)},...(invalid?{evidenceUnknown:true}:{})};
  }catch{return {...observation,evidenceUnknown:true};}
}
/** Partial fields only cover their actual delivered span, even if their full-field hash is current. */
export function canvasFactCovered(old:CanvasFact,current:CanvasFact[]):boolean {
  const same=current.filter(f=>factKey(f)===factKey(old));
  if(same.some(f=>f.start===undefined))return true;
  if(!same.length)return false;
  const groups=new Map<string,CanvasFact[]>();
  for(const f of same){const key=canvasKey([f.pointerId,f.version,f.total]);groups.set(key,[...groups.get(key)??[],f]);}
  return [...groups.values()].some(spans=>{
    spans.sort((a,b)=>a.start!-b.start!);
    let whole=0;for(const span of spans){if(span.start!>whole)break;whole=Math.max(whole,span.end!);}
    // A complete newer field supersedes any old slice, even when it became shorter.
    if(spans[0].total!==undefined&&whole>=spans[0].total)return true;
    const entire=old.start===undefined||old.start===0&&old.end===old.total;
    let end=entire?0:old.start!;const target=entire?(spans[0].total??Infinity):old.end!;
    for(const span of spans){if(span.start!>end)break;end=Math.max(end,span.end!);}
    return end>=target;
  });
}

/** Whole-node admission can be composed from actual current fields, including a
 * user field replacement, but never from a file version or an identity card. */
export function fullyObservedNodeIds(index:CanvasIndex,observations:Observation[]):string[]{
  const facts=observations.filter(o=>!o.evidenceUnknown&&o.canvasId===index.canvasId)
    .flatMap(o=>(o.canvasFacts??[]).map(f=>({...f,pointerId:f.pointerId??o.canvasPage?.pointerId})));
  return [...new Set(facts.map(f=>f.refId))].filter(refId=>{
    const node=index.graph.nodes[refId];if(!node||!index.rows.get(refId)?.readable)return false;
    return (node.design?['name','content','design']:['name','content']).every(field=>{
      const version=canvasKey(canvasField(index,refId,field));
      return canvasFactCovered({refId,field,version},facts.filter(f=>f.refId===refId&&f.field===field&&f.version===version));
    });
  });
}
