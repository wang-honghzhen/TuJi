import type { AppSnapshot, SourcePrecondition, Task } from '../domain';
import type { ContextStage, Observation } from '../contextState';
import { allEvidence, summaryArchive, type Evidence } from './historyRepresentations';
import { allRetainedCalls, originResultId, visibleCallResult } from './readVisibility';
import { submittedSourceChanges } from './sourceFreshness';
import { canvasKey, row, canvasReadTools, canvasDeliveryValid } from './canvasReadEvidence';
import { partContents } from './summaryRegionContent';
import { canvasNoticeLabels, unresolvedCanvasChanges } from './contextFreshness';
import { decodeGraphReference } from './graphReferences';
import { archivedDocumentReads } from './currentReadSources';
import { submittedSourceResolution } from './submittedSourceResolution';
import { visibleNoteEvidence } from './noteFreshness';
import { canvasAvailability, verifiedUnavailableReadRefs } from './unavailableCanvasReads';
import { selectSummaryFields, summaryFieldBindings, summaryFieldCheck, summaryFieldVersion } from './summaryFieldEvidence';
import { graphReadContext, type GraphReadContext } from './graphReadContext';

/** A settled legacy refusal can establish that this call returned no body. It
 * never establishes why another source is unavailable or what its current value is. */
function rejectedWithoutCanvasBody(call: AppSnapshot['toolCalls'][number]) {
  if (call.status !== 'rejected' || !canvasReadTools.has(call.name) || call.canvasOrigins?.length || call.resultSources?.length) return false;
  try {
    const result: unknown = JSON.parse(call.result ?? '');
    return row(result) && result.status === 'error' && typeof result.code === 'string' && row(result.details)
      && result.details.executed === false && !Object.hasOwn(result, 'data') && !Object.hasOwn(result, 'results');
  } catch { return false; }
}

/** Summary dependencies remain checks, never proof of having read object bodies. */
export function summarySourceEvidence(state:AppSnapshot,task:Task,stage:ContextStage,observations:Observation[]=[],encode:(id:string)=>string=id=>id,
  availability=canvasAvailability(state,task,stage),context?:GraphReadContext){
  const archive=summaryArchive(state,task),shown=new Set<string>();
  for(const summary of archive)if(stage.entries.some(e=>e.id===`summary:${summary.id}:${summary.version}`&&e.representation==='summary'))shown.add(summary.id);
  const visit=(value:unknown)=>{
    if(Array.isArray(value)){value.forEach(visit);return;}if(!row(value))return;
    if(typeof value.summaryId==='string'&&typeof value.content==='string'&&archive.some(s=>s.id===value.summaryId))shown.add(value.summaryId);
    // Never parse authored content or argument strings as an evidence envelope.
    for(const [key,child] of Object.entries(value))if(!['content','text','arguments'].includes(key))visit(child);
  };
  for(const member of stage.summaryRegions?.members??[])for(const part of member.parts){
    const contents=partContents(part);contents.cards.forEach(visit);
    // A split summary body still carries all of that immutable summary's dependencies.
    if(contents.fragments.length)for(const id of part.rootIds??[part.rootId])if(archive.some(s=>s.id===id))shown.add(id);
  }
  const visible=new Set(stage.entries.flatMap(e=>e.readCallIds??[]));
  for(const call of allRetainedCalls(state))if(visible.has(call.id)||visible.has(originResultId(call))){
    if(!['context_read_children','context_read_summary_tree','context_read_pages'].includes(call.name))continue;
    try{visit(JSON.parse(visibleCallResult(state,call)??'null'));}catch{/* An invalid envelope cannot certify a summary body. */}
  }
  let noteEvidence: ReturnType<typeof visibleNoteEvidence> | undefined;
  const resolution=submittedSourceResolution(state,task,observations,()=>noteEvidence??=visibleNoteEvidence(state,task,stage));
  let records: Map<string,Evidence> | undefined;
  const sources:SourcePrecondition[]=[],facts:Array<{key:string;state:unknown;callIds:string[];kind:string;labels:string[];detail:string}>=[];
  const dependencyObservations:Observation[]=[];
  const calls=allRetainedCalls(state);
  if(shown.size && state.graph)context??=graphReadContext(state);
  const fieldCatalogs=new Map<string,ReturnType<typeof summaryFieldBindings>>();
  for(const summary of archive.filter(s=>shown.has(s.id))){
    const firstObservation=dependencyObservations.length;
    const summarizedCalls=calls.filter(c=>summary.coverage.some(span=>span.recordId===c.id||span.recordId===originResultId(c)));
    const narrowedRecords=new Map<string,Set<string>>();
    for(const call of summarizedCalls){
      if(!canvasReadTools.has(call.name)&&!call.canvasOrigins?.length)continue;
      if(verifiedUnavailableReadRefs(call,task.canvasId).length||rejectedWithoutCanvasBody(call))continue;
      const selected=summary.fieldDependencies?.filter(b=>b.fieldRead?.recordId===call.id)??[];
      const omitted=summary.omittedFieldSources?.filter(b=>b.recordId===call.id).map(b=>b.key)??[];
      if(selected.length || omitted.length){
        records??=new Map(allEvidence(state,task).map(record=>[record.id,record]));
        const record=records.get(call.id);
        const complete=record && summary.coverage.some(c=>c.recordId===call.id && c.taskId===call.taskId
          && c.version===record.version && c.start===0 && c.end===record.text.length);
        if(complete&&!fieldCatalogs.has(call.id))fieldCatalogs.set(call.id,summaryFieldBindings(state,task,call));
        const catalog=complete?fieldCatalogs.get(call.id)??[]:[];
        const selection=selectSummaryFields(call,catalog,selected,summary.objectBindings??[],omitted);
        if(selection){
          narrowedRecords.set(call.id,selection.otherIds);
          const index=state.graph?.canvases.some(c=>c.canvasId===task.canvasId)?context?.index(task.canvasId):undefined;
          for(const binding of selection.checks.values()){
            const {observation,source}=summaryFieldCheck(task,binding,call);
            dependencyObservations.push(observation);
            const version=index&&summaryFieldVersion(index,source.id,source.summaryField!.field,source.summaryField);
            if(version!==undefined && version!==source.version && !unresolvedCanvasChanges(state,[observation],observations,context).size){
              source.summaryField!.version=version;source.version=version;
            }
            sources.push(source);
          }
          continue;
        }
      }
      const stored=call.canvasOrigins?.map(origin=>origin.observation)??[];
      if(stored.length)for(const original of stored)dependencyObservations.push({...structuredClone(original),
        id:`summary-dependency:${summary.id}:${original.id}`,taskId:task.id,entryId:undefined,
        ...(!canvasDeliveryValid(call,id=>decodeGraphReference(state,task.canvasId,task.sessionId,id))?{evidenceUnknown:true}:{})});
      else dependencyObservations.push({id:`summary-unknown:${summary.id}:${call.id}`,callId:call.id,taskId:task.id,canvasId:task.canvasId,
        refs:[],directories:{},paths:{},completeDirectories:[],sources:[],evidenceUnknown:true});
    }
    const refs=[...summary.sourceRefs];
    for(const binding of summary.sourceBindings??[])if(['node','document','edge'].includes(binding.kind)&&binding.version!==undefined
      &&!refs.some(s=>s.kind===binding.kind&&s.id===binding.id&&s.version===binding.version))
      refs.push({kind:binding.kind as SourcePrecondition['kind'],id:binding.id,version:binding.version});
    let documentOrigins: ReturnType<typeof archivedDocumentReads> | undefined;
    for(const source of refs){
      if(narrowedRecords.size && ['node','edge','document'].includes(source.kind)){
        // Independent citations, even to the same object version, remain whole.
        const contributions=summary.coverage.filter(span=>records?.get(span.recordId)?.sources.some(s=>s.kind===source.kind && s.id===source.id && s.version===source.version));
        if(contributions.length && contributions.every(c=>narrowedRecords.has(c.recordId) && !narrowedRecords.get(c.recordId)!.has(source.id)))continue;
      }
      const closure:SourcePrecondition[]=resolution.freeze([source]);
      if(source.kind==='document' && closure.length){
        records??=new Map(allEvidence(state,task).map(record=>[record.id,record]));
        if(!documentOrigins){
          const delivered=new Set(summarizedCalls.filter(c=>c.status==='completed'&&(c.firstDelivery||c.presentedAt!==undefined))
            .flatMap(c=>[c.id,originResultId(c)]));
          documentOrigins=archivedDocumentReads(summary.coverage,records,dependencyObservations.slice(firstObservation)
            .filter(o=>o.callId&&delivered.has(o.callId)));
        }
        const root=closure[0];
        closure[0]=resolution.graphReads()?.document(root,documentOrigins(source))??root;
      }
      sources.push(...closure);
      const changes=submittedSourceChanges(state,task,closure).filter(change=>!availability.settleSource(change));
      for(const change of changes){
        const target=change.source;
        const chain=[summary.id,source.id,...(target.id===source.id?[]:[target.id])].map(encode).join('←');
        facts.push({key:`summary-source:${canvasKey([summary.id,source,target])}`,state:change,callIds:[],kind:'摘要依据变动',
          labels:[chain+(change.state==='unavailable'?'·不可用':'')],
          detail:target.kind==='note'?'context_read_children核对笔记':target.kind==='artifact'?'workspace_read_artifact核对资料':
            target.kind==='document'?'graph_read_subgraph/graph_read_directory核对范围':
            ['node','edge'].includes(target.kind)?'graph_read核对来源':'context_read_children核对来源'});
      }
    }
  }
  const pending=unresolvedCanvasChanges(state,dependencyObservations,observations,context,availability);
  for(const [key,value] of pending){
    const labels=canvasNoticeLabels(state,task,value.change,value.observation,encode,context);
    facts.push({key:`summary-read:${key}`,state:value.change,callIds:[],...labels,
      kind:value.change.kind==='unknown'?'摘要依据无法确认':'摘要依据变动',detail:labels.detail??'重读对应范围'});
  }
  return {sources:[...new Map(sources.map(s=>[canvasKey(s),s])).values()],facts};
}
