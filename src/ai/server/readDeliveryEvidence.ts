import { createHash } from 'node:crypto';
import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { ContextStage, FrozenRead } from '../contextState';
import type { ReadPageOrigin } from './readPageEvidence';
import { returnedReadPages } from './readPageEvidence';
import { isDataRead } from './toolContextKinds';
import { originResultId } from './readVisibility';
import { decodeGraphReference, translateGraphPayload } from './graphReferences';

type Row=Record<string,any>;
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse=(v:unknown):any=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return undefined;}};
export interface PageDeliveryEvidence extends ReadPageOrigin { sourcesHash:string; sourceIds:string[]; representation:'body'|'summary'|'index'|'mixed'|'image'; readWith?:{tool:string;arguments:Record<string,unknown>} }
const representation=(kind:string,result:Row,read?:FrozenRead):PageDeliveryEvidence['representation']=>{
  if(read?.attachmentRead?.representation==='image'||kind==='attachment_local'&&result.data?.representation==='image')return 'image';
  if(read?.attachmentRead?.representation==='index'||kind==='attachment_local'&&result.data?.representation==='index')return 'index';
  if(read?.summaryOrigin?.pure||kind==='summary_tree'||kind==='summary_children')return 'summary';
  if(kind==='graph_read_directory'||kind==='graph_search'&&result.selection?.countOnly)return 'index';
  if(result.recordDirectory&&!(result.data?.items??[]).some((i:Row)=>typeof i.content==='string'))return 'index';
  const items=result.data?.items;
  if(Array.isArray(items)&&items.length){
    const summaries=items.filter(i=>object(i)&&typeof i.summaryId==='string'&&typeof i.content==='string');
    if(summaries.length)return summaries.length===items.length?'summary':'mixed';
    if(items.every(i=>object(i)&&i.bodyState==='not_loaded'))return 'index';
  }
  return 'body';
};

/** A shape or a citation alone is not proof of a frozen page's identity. */
export function verifiedDeliveryPage(state:AppSnapshot,call:ToolCallRecord|undefined,result:Row,drafts:FrozenRead[]=[]):PageDeliveryEvidence|undefined {
  const owner=call&&state.tasks.find(t=>t.id===call.taskId);
  if(owner)result=translateGraphPayload(result,id=>decodeGraphReference(state,owner.canvasId,owner.sessionId,id)) as Row;
  if(!['ok','partial'].includes(result.status)||result.executed===false||result.bodyOmitted===true||!object(result.data)
    ||result.data.status==='blocked'||result.coverage?.extent==='none'||typeof result.pointerId!=='string'
    ||!Number.isSafeInteger(result.page)||!Number.isSafeInteger(result.totalPages)||result.page<1||result.page>result.totalPages)return;
  const payloadHash=digest(result.data),sourcesHash=digest(result.sources??[]);
  const saved=call?.readPageOrigins?.find(o=>o.pointerId===result.pointerId&&o.page===result.page);
  const read=[...drafts,...state.workspaces.flatMap(w=>w.frozenReads??[])].find(r=>r.id===result.pointerId);
  if(saved&&(saved.payloadHash!==payloadHash||saved.totalPages!==result.totalPages||saved.sourcesHash!==undefined&&saved.sourcesHash!==sourcesHash))return;
  let kind:string|undefined;
  if(read){
    if(read.pages.length!==result.totalPages||digest(read.pages[result.page-1])!==payloadHash||digest(read.pageSources?.[result.page-1]??[])!==sourcesHash)return;
    if(saved&&saved.kind!==read.kind)return;
    kind=read.kind;
  }else if(saved?.sourcesHash!==undefined)kind=saved.kind;
  else{
    const canvas=call?.canvasOrigins?.find(o=>o.pointerId===result.pointerId&&o.page===result.page);
    if(canvas?.payloadHash===payloadHash&&digest(canvas.observation.sources)===sourcesHash)kind=canvas.request.tool;
  }
  if(!kind)return;
  return {pointerId:result.pointerId,page:result.page,totalPages:result.totalPages,kind,payloadHash,sourcesHash,
    sourceIds:[...new Set((result.sources??[]).filter((s:unknown)=>object(s)&&typeof s.id==='string').map((s:Row)=>s.id))] as string[],
    representation:representation(kind,result,read)};
}

export function confirmedTaskPages(state:AppSnapshot,task:Task):PageDeliveryEvidence[] {
  const pages:PageDeliveryEvidence[]=[];
  for(const call of state.toolCalls){
    if(call.taskId!==task.id||call.status!=='completed'||call.presentedAt===undefined||!isDataRead(call.name))continue;
    for(const result of returnedReadPages(call)){const page=verifiedDeliveryPage(state,call,result);if(page)pages.push(page);}
  }
  // Delta metadata on existing request manifests also covers refreshed canvas views.
  // Only a completed execution response acknowledges it; previews and failed attempts do not.
  const completed=new Set(state.steps.filter(s=>s.taskId===task.id&&s.purpose==='agent'&&s.status==='completed'&&s.completedSequence!==undefined).map(s=>s.contextManifestId));
  for(const manifest of state.contextManifests)if(manifest.taskId===task.id&&completed.has(manifest.id))pages.push(...manifest.readPageDeliveries??[]);
  return pages;
}

/** Inspect trusted application envelopes, never arbitrary user prose or nested business data. */
export function visibleTaskPages(state:AppSnapshot,task:Task,stage:ContextStage):{pages:PageDeliveryEvidence[];unknown:Set<string>} {
  const pages:PageDeliveryEvidence[]=[],unknown=new Set<string>(),calls=state.toolCalls.filter(c=>c.taskId===task.id&&isDataRead(c.name));
  const visit=(value:unknown,call:ToolCallRecord|undefined)=>{
    const row=parse(value);if(!object(row)||row.bodyOmitted===true||row.executed===false||row.data?.status==='blocked'||row.coverage?.extent==='none')return;
    if(typeof row.pointerId==='string'&&Number.isSafeInteger(row.page)&&row.data!==undefined){
      const read=[...stage.frozenReadDrafts??[],...state.workspaces.flatMap(w=>w.frozenReads??[])].find(r=>r.id===row.pointerId);
      if(!call&&read?.taskId!==task.id)return;
      const proof=verifiedDeliveryPage(state,call,row,stage.frozenReadDrafts);
      if(proof)pages.push(proof);else if(['ok','partial'].includes(row.status)&&row.executed!==false)unknown.add(row.pointerId);
    }
    if(Array.isArray(row.results))row.results.forEach(r=>visit(r,call));
  };
  for(const entry of stage.entries){
    for(const message of entry.messages){
      if(message.role==='tool'){
        const call=calls.find(c=>(entry.readCallIds??[]).includes(c.id)&&(c.providerCallId===message.toolCallId||c.id===message.toolCallId));
        if(call)visit(message.content,call);continue;
      }
      const value=parse(message.content);if(!object(value))continue;
      const attachment=value.attachmentText;
      // Inline source text is an actual delivery too; an attachment index or summary is not.
      // Its immutable entry is the snapshot. The entry is authored by attachmentEntries, not user text.
      if(entry.category==='references'&&object(attachment)&&Array.isArray(attachment.chunks)
        &&entry.id===`attachment-body:${attachment.artifactId}:${attachment.version}:${digest({attachmentText:attachment})}`){
        const pointerId=`attachment:${attachment.artifactId}:${attachment.version}`;
        pages.push({pointerId,page:1,totalPages:1,kind:'artifact_inline',payloadHash:digest(attachment),sourcesHash:digest([attachment.artifactId,attachment.version]),
          sourceIds:[attachment.artifactId],representation:'body',readWith:{tool:'workspace_read_artifact',arguments:{artifactId:attachment.artifactId}}});
      }
      const material=value.historical_material;
      if(object(material)){
        const call=calls.find(c=>(entry.readCallIds??[]).includes(c.id)&&(c.id===material.recordId||originResultId(c)===material.recordId));
        if(call)visit(parse(material.content)?.result,call);
      }
      const history=value.historical_read;
      if(object(history)){const call=calls.find(c=>(entry.readCallIds??[]).includes(c.id)&&c.id===history.callId);if(call)visit(history,call);}
      if(entry.category==='canvas'&&object(value.canvas_refresh)){
        const refresh=value.canvas_refresh;visit(refresh.result??{results:refresh.results},undefined);
      }
    }
  }
  return {pages,unknown};
}

export const pageEvidenceKey=(page:ReadPageOrigin)=>JSON.stringify([page.pointerId,page.page,page.totalPages,page.kind,page.payloadHash,page.sourcesHash]);
export function pendingPageDeliveries(confirmed:PageDeliveryEvidence[],visible:PageDeliveryEvidence[]):PageDeliveryEvidence[]{
  const known=new Set(confirmed.map(pageEvidenceKey));
  return [...new Map(visible.filter(p=>!known.has(pageEvidenceKey(p))).map(p=>[pageEvidenceKey(p),p])).values()];
}
