import { acknowledgeCompleteNodeReads } from './nodeReadEvidence';
import type { AppSnapshot, ContextManifest, ModelStep } from '../domain';
import { isReceipted, originResultId } from './readVisibility';
import { isDataRead } from './toolContextKinds';

/** A completed response confirms the exact submitted projection, including inherited bodies. */
export function acknowledgeReadDelivery(state:AppSnapshot,manifest:ContextManifest,step:ModelStep):void {
  if(step.status!=='completed'||step.completedSequence===undefined)return;
  const ids=new Set(manifest.readBodyResultIds??[]);
  for(const call of [...state.toolCalls,...state.snapshots.flatMap(s=>s.toolCalls??[])])
    if(isDataRead(call.name)&&call.result!==undefined&&['completed','rejected'].includes(call.status)
      &&(ids.has(call.id)||ids.has(originResultId(call)))&&!isReceipted(state,call)){
      call.presentedAt??=step.ordinal;
      call.firstDelivery??={manifestId:manifest.id,stepId:step.id,sequence:step.completedSequence};
    }
  const deliveredTask=state.tasks.find(t=>t.id===step.taskId);if(deliveredTask)acknowledgeCompleteNodeReads(state,manifest,deliveredTask);
  const sent=new Map(manifest.stageDraft?.entries.filter(e=>e.lifecycle==='temporary').map(e=>[e.id,e])??[]);
  const task=state.tasks.find(t=>t.id===step.taskId),stage=state.workspaces.find(w=>w.id===task?.workspaceId)?.contextStage;
  for(const entry of stage?.entries??[])if(sent.get(entry.id)?.contentSignature===entry.contentSignature&&sent.has(entry.id)){
    if(!entry.firstDeliveredStepId){entry.firstDeliveredStepId=step.id;entry.firstDeliveredSequence=step.completedSequence;}
    else if(entry.firstDeliveredStepId===step.id)entry.firstDeliveredSequence??=step.completedSequence;
  }
  const delivered=manifest.stageDraft?.directoryAreas,current=stage?.directoryAreas;
  if(delivered&&current){
    const shown=new Set(delivered.cache.renderGroups.flatMap(group=>group.memberEntryIds));
    const pending=current.cache.entries.filter(entry=>entry.pendingFirstDelivery&&shown.has(entry.id)
      &&delivered.cache.entries.some(sent=>sent.id===entry.id&&JSON.stringify(sent.replay)===JSON.stringify(entry.replay)))
      .sort((a,b)=>(a.pendingEnteredOrder??Number.MAX_SAFE_INTEGER)-(b.pendingEnteredOrder??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id));
    for(const entry of pending){
      entry.firstEnteredOrder=current.cache.nextEnteredOrder++;
      entry.pendingFirstDelivery=false;delete entry.pendingEnteredOrder;
    }
  }
}
