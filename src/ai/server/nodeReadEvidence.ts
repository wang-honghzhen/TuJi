import type { AppSnapshot, ContextManifest, Task, SourceRef } from '../domain';
import type { GraphState } from '@/v3/types';
import { hash } from './repository';
import { requireValue } from './errors';
import { decodeGraphReference, translateGraphPayload } from './graphReferences';
import { canvasMemberResults } from './canvasRefresh';
import { fullyObservedNodeIds } from './canvasReadEvidence';
import { graphIndex } from './directGraph';
import { visibleObservations } from './contextFreshness';

type Field = 'name' | 'content' | 'design';
export interface NodeReadEvidence {version:string;fields:Partial<Record<Field,{length:number;ranges:Array<[number,number]>}>>}
export interface NodeReadAdvance {refId:string;beforeVersion:string;after:NodeReadEvidence}
export function completeNodeEvidence(node:GraphState['nodes'][string]):NodeReadEvidence {
  const fields:NodeReadEvidence['fields']={};
  for(const field of ['name','content','design'] as const){const value=field==='design'?JSON.stringify(node.design??null):node[field];fields[field]={length:value.length,ranges:[[0,value.length]]};}
  return {version:hash(node),fields};
}
export function hasCompleteNodeRead(task:Task,node:GraphState['nodes'][string]):boolean {
  const evidence=task.nodeReadEvidence?.[node.nodeId];if(!evidence||evidence.version!==hash(node))return false;
  return (node.design?['name','content','design']:['name','content']).every(field=>{
    const value=evidence.fields[field as Field];return value&&value.ranges.length===1&&value.ranges[0][0]===0&&value.ranges[0][1]===value.length;
  });
}
export function assertCompleteNodeRead(task:Task,graph:GraphState,refId:string):void {
  requireValue(graph.nodes[refId]&&hasCompleteNodeRead(task,graph.nodes[refId]),'局部修改前须完整读取当前版本节点的名称、正文及设计字段，卡片、摘要或部分页不足','READ_REQUIRED',
    {executed:false,failedRefs:[refId],readWith:{tool:'graph_read',arguments:{refs:[refId]}}});
}
export function prepareNodeReadAdvances(task:Task,before:GraphState,after:GraphState,refs:string[]):NodeReadAdvance[]{
  return refs.flatMap(refId=>before.nodes[refId]&&after.nodes[refId]&&hasCompleteNodeRead(task,before.nodes[refId])
    ?[{refId,beforeVersion:hash(before.nodes[refId]),after:completeNodeEvidence(after.nodes[refId])}]:[]);
}
/** Called only for payloads in an input with a completed execution response. */
export function recordNodeReadData(task:Task,graph:GraphState,data:unknown,sources:SourceRef[]=[]):void {
  const versions=new Map(sources.filter(s=>s.kind==='node').map(s=>[s.id,String(s.version)]));
  const put=(refId:string,version:string,field:Field,start:number,end:number,length:number)=>{
    if(!graph.nodes[refId]||hash(graph.nodes[refId])!==version||![start,end,length].every(Number.isSafeInteger)||start<0||end<start||end>length)return;
    const all=task.nodeReadEvidence??={},old=all[refId];
    const evidence=old?.version===version?old:(all[refId]={version,fields:{}});
    const prior=evidence.fields[field];if(prior&&prior.length!==length)return;
    const ranges=[...(prior?.ranges??[]),[start,end] as [number,number]].sort((a,b)=>a[0]-b[0]);
    const merged:Array<[number,number]>=[];for(const r of ranges){const last=merged.at(-1);if(last&&last[1]>=r[0])last[1]=Math.max(last[1],r[1]);else merged.push([...r]);}
    evidence.fields[field]={length,ranges:merged};
  };
  const visit=(value:unknown)=>{
    if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>,refId=typeof row.refId==='string'?row.refId:undefined;
    const version=refId?(versions.get(refId)??(typeof row.objectVersion==='string'?row.objectVersion:typeof row.version==='string'?row.version:typeof (row.readWith as any)?.arguments?.expectedVersion==='string'?(row.readWith as any).arguments.expectedVersion:undefined)):undefined;
    if(refId&&version&&graph.nodes[refId]){
      if(typeof row.name==='string')put(refId,version,'name',0,row.name.length,row.name.length);
      if(typeof row.content==='string'&&(!row.field||['name','content','design'].includes(String(row.field)))&&row.bodyState!=='not_loaded'){
        const field=(row.field??'content') as Field,start=typeof row.start==='number'?row.start:0,end=typeof row.end==='number'?row.end:row.content.length;
        const length=typeof row.contentLength==='number'?row.contentLength:row.content.length;
        if(end-start===row.content.length)put(refId,version,field,start,end,length);
      }
      if(row.design&&typeof row.design==='object'&&!row.designReadWith){const length=JSON.stringify(row.design).length;put(refId,version,'design',0,length,length);}
    }
    for(const [key,child] of Object.entries(row))if(!['readWith','nameReadWith','pathReadWith','designReadWith','nextAction'].includes(key))visit(child);
  };visit(data);
}
export function acknowledgeCompleteNodeReads(state:AppSnapshot,manifest:ContextManifest,task:Task):void {
  if(!state.graph)return;
  if(manifest.stageDraft){
    const observations=visibleObservations(manifest.stageDraft,state.workspaces.find(w=>w.id===task.workspaceId)?.observations??[],task,state.toolCalls,state);
    for(const ref of fullyObservedNodeIds(graphIndex(state,task.canvasId),observations))(task.nodeReadEvidence??={})[ref]=completeNodeEvidence(state.graph.nodes[ref]);
  }
  for(const member of manifest.stageDraft?.canvasRefresh?.members??[]){
    const entry=manifest.stageDraft!.entries.find(e=>e.id===`canvas-refresh:${member.id}`);
    if(entry&&(entry.wireMessages??entry.messages).every(shown=>manifest.messages.some(m=>m.role===shown.role&&m.content===shown.content)))
      for(const result of canvasMemberResults(member))recordNodeReadData(task,state.graph,result.data,member.observations.flatMap(o=>o.sources));
  }
  const ids=new Set(manifest.readBodyResultIds??[]);
  for(const call of state.toolCalls){
    if(call.taskId!==task.id)continue;
    if(ids.has(call.id)&&call.status==='completed'&&call.result){
      try{const result=translateGraphPayload(JSON.parse(call.result),ref=>decodeGraphReference(state,task.canvasId,task.sessionId,ref)) as Record<string,any>;if(!result.stale&&result.freshness!=='unknown'&&['ok','partial'].includes(result.status))recordNodeReadData(task,state.graph,result.data,result.sources??[]);}catch{/* A receipt is not readable data. */}
    }
    if(call.nodeReadAdvances&&manifest.messages.some(m=>m.role==='tool'&&m.toolCallId===call.providerCallId&&(()=>{try{return JSON.parse(m.content).status==='committed';}catch{return false;}})())){
      for(const advance of call.nodeReadAdvances)if(task.nodeReadEvidence?.[advance.refId]?.version===advance.beforeVersion&&state.graph.nodes[advance.refId]&&hash(state.graph.nodes[advance.refId])===advance.after.version)
        task.nodeReadEvidence[advance.refId]=structuredClone(advance.after);
    }
  }
}
