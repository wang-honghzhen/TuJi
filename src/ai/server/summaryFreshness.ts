import type { AppSnapshot, SourceRef, Task } from '../domain';
import type { ContextStage, Observation } from '../contextState';
import { summaryArchive } from './historyRepresentations';
import { allRetainedCalls, originResultId, visibleCallResult } from './readVisibility';
import { sourceChanges } from './sourceFreshness';
import { canvasKey, row, fullyObservedNodeIds, canvasReadTools, canvasDeliveryValid } from './canvasReadEvidence';
import { partContents } from './summaryRegionContent';
import { graphIndex } from './directGraph';
import { canvasNoticeLabels, unresolvedCanvasChanges } from './contextFreshness';
import { decodeGraphReference } from './graphReferences';

/** Summary dependencies remain checks, never proof of having read object bodies. */
export function summarySourceEvidence(state:AppSnapshot,task:Task,stage:ContextStage,observations:Observation[]=[],encode:(id:string)=>string=id=>id){
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
  const index=state.graph?graphIndex(state,task.canvasId):undefined;
  const fullyReadNodes=new Set(index?fullyObservedNodeIds(index,observations):[]);
  const sources:SourceRef[]=[],facts:Array<{key:string;state:unknown;callIds:string[];kind:string;labels:string[];detail:string}>=[];
  const dependencyObservations:Observation[]=[];
  const calls=allRetainedCalls(state);
  for(const summary of archive.filter(s=>shown.has(s.id))){
    const summarizedCalls=calls.filter(c=>summary.coverage.some(span=>span.recordId===c.id||span.recordId===originResultId(c)));
    for(const call of summarizedCalls){
      if(!canvasReadTools.has(call.name)&&!call.canvasOrigins?.length)continue;
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
      refs.push({kind:binding.kind as SourceRef['kind'],id:binding.id,version:binding.version});
    for(const source of refs){
      // A complete fresh delivery of the cited range supersedes the stale summary
      // dependency. A summary/card or partial unrelated field cannot do this.
      const reread=source.kind==='node'&&fullyReadNodes.has(source.id);
      if(reread)continue;
      sources.push(source);
      const changes=sourceChanges(state,task,[source]);
      if(changes.length)facts.push({key:`summary-source:${canvasKey([summary.id,source])}`,state:changes,callIds:[],kind:'摘要依据变动',
        labels:[`${encode(summary.id)}←${encode(source.id)}${changes.some(c=>c.state==='unavailable')?'·不可用':''}`],
        detail:source.kind==='note'?'context_read_children核对笔记':source.kind==='artifact'?'workspace_read_artifact核对资料':
          ['node','document','edge'].includes(source.kind)?'graph_read核对来源':'context_read_children核对来源'});
    }
  }
  const pending=unresolvedCanvasChanges(state,dependencyObservations,observations);
  for(const [key,value] of pending){
    const labels=canvasNoticeLabels(state,task,value.change,value.observation,encode);
    facts.push({key:`summary-read:${key}`,state:value.change,callIds:[],...labels,
      kind:value.change.kind==='unknown'?'摘要依据无法确认':'摘要依据变动',detail:labels.detail??'重读对应范围'});
  }
  return {sources:[...new Map(sources.map(s=>[canvasKey(s),s])).values()],facts,observations:dependencyObservations,pending};
}
