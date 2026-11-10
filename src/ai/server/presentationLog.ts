import type { AppSnapshot, PresentationEvent, PresentationPart, Task } from '../domain';
import { presentationSpans } from '../presentation';
import { successfulPartBreak } from '../modelVisibility';

/** A part owns ordered source references, captured in the source transaction. */
export function capturePresentation(before: AppSnapshot, state: AppSnapshot) {
  state.presentationParts ??= [];
  const parts = state.presentationParts, changed = new Set<string>(), affected = new Set<string>();
  const tasksById=new Map(state.tasks.map(t=>[t.id,t])), messagesById=new Map(state.messages.map(m=>[m.id,m])), callsById=new Map(state.toolCalls.map(c=>[c.id,c]));
  const partsById=new Map(parts.map(p=>[p.id,p])), partsByTask=new Map<string,PresentationPart[]>(), tails=new Map<string,PresentationPart>();
  const positions=new Map<string,{part:PresentationPart;index:number}>();
  const recordedSpans=new Map<string,PresentationEvent[]>();
  for(const part of parts){const values=partsByTask.get(part.taskId)??[];values.push(part);partsByTask.set(part.taskId,values);
    if(part.seq>0&&part.seq>(tails.get(part.taskId)?.seq??0))tails.set(part.taskId,part);
    part.events?.forEach((event,index)=>{positions.set(event.id,{part,index});
      if(event.kind==='text'&&event.messageId){const spans=recordedSpans.get(event.messageId)??[];spans.push(event);recordedSpans.set(event.messageId,spans);}});}
  const previousTasks=new Map(before.tasks.map(t=>[t.id,t]));
  for(const task of state.tasks)if(task.status!==previousTasks.get(task.id)?.status)affected.add(task.id);
  const append = (task: Task, seq: number): PresentationPart => {
    const part: PresentationPart = { id: task.id + ':part:' + seq, taskId: task.id, seq, revision: task.instructionRevision,
      graphRevision: state.graphRevision, targets: [...(task.presentationFocus ?? [])], kind: seq === 0 ? 'input' : 'text',
      events: [], views:[], version: 1, sealed: true, stable: seq === 0, dwellMs: 2000 };
    parts.push(part);partsById.set(part.id,part);const values=partsByTask.get(task.id)??[];values.push(part);partsByTask.set(task.id,values);if(seq>0)tails.set(task.id,part);changed.add(task.id); return part;
  };
  const latest = (task: Task) => tails.get(task.id);
  const groupKey = (taskId:string,stepId:string,breakCallId?:string) => JSON.stringify([taskId,stepId,breakCallId??null]);
  const groups = new Map(parts.filter(p=>p.stepId&&p.seq>0).map(p=>[groupKey(p.taskId,p.stepId!,p.breakCallId),p]));
  const boundaries = new Map<string,string>(), breakBeforeCall = new Map<string,string|undefined>();
  for(const call of state.toolCalls){
    const key=groupKey(call.taskId,call.stepId);
    breakBeforeCall.set(call.id,boundaries.get(key));
    if(successfulPartBreak(call))boundaries.set(key,call.id);
  }
  // A boundary is materialized only when content arrives: leading, repeated and trailing br
  // calls cannot create empty public parts. Results keep their source call's original owner.
  const work = (task: Task,stepId?:string,breakCallId?:string,tools=false):PresentationPart => {
    if(!stepId)return latest(task)??append(task,1);
    const key=groupKey(task.id,stepId,breakCallId),existing=groups.get(key);
    if(existing)return existing;
    const tail=latest(task);
    const continueTools=tools&&tail?.sealed&&tail.revision===task.instructionRevision
      &&['tools','focus'].includes(tail.events?.at(-1)?.kind??'');
    const part=!breakCallId&&tail&&(continueTools||!tail.stepId&&tail.events?.every(e=>e.kind==='user'))?tail:append(task,(tail?.seq??0)+1);
    part.stepId=stepId;
    if(breakCallId)part.breakCallId=breakCallId;
    groups.set(key,part);return part;
  };
  const put = (part: PresentationPart, event: PresentationEvent, sealed = true) => {
    const position=positions.get(event.id),index=position?.part===part?position.index:-1;
    if (index >= 0 && JSON.stringify(part.events![index]) === JSON.stringify(event) && part.sealed === sealed) return;
    const previous=part.views?.at(-1),previousTargets=previous?.eventId?part.events!.find(e=>e.id===previous.eventId)?.targets:undefined;
    if (index >= 0) part.events![index] = event; else {part.events!.push(event);positions.set(event.id,{part,index:part.events!.length-1});}
    part.version = (part.version ?? 0) + 1; part.sealed = sealed; part.stable = false;
    part.revision = tasksById.get(part.taskId)!.instructionRevision;
    part.graphRevision = event.graphRevision; part.targets = [...event.targets]; part.stepId = event.stepId ?? part.stepId;
    if(!previous||previous.graphRevision!==event.graphRevision||JSON.stringify(previousTargets)!==JSON.stringify(event.targets))
      (part.views??=[]).push({version:part.version,graphRevision:event.graphRevision,eventId:event.id});
    if (event.kind === 'text' && !part.messageId) { part.messageId = event.messageId; part.start = event.start; part.end = event.end; }
    if (event.kind === 'text' && part.messageId === event.messageId) part.end = event.end;
    const length = part.events!.reduce((n, e) => n + Math.max(0, (e.end ?? 0) - (e.start ?? 0)), 0);
    part.dwellMs = Math.min(6000, Math.max(2000, 500 + length * 45)); changed.add(part.taskId);
  };
  const oldMessages = new Map(before.messages.map(m => [m.id, m]));
  for (const task of state.tasks) {
    const root = messagesById.get(task.rootUserMessageId);
    if (root && !partsById.has(task.id+':part:0')) {
      const part = append(task, 0); root.partSeq = 0;
      put(part, { id: root.id, kind: 'user', messageId: root.id, start: 0, end: root.text.length,
        graphRevision: state.graphRevision, targets: [...root.targetRefs] }); part.stable = true;
    }
  }
  for (const message of state.messages) {
    const prior = oldMessages.get(message.id);
    if (prior?.text === message.text && prior.status === message.status || message.phase === 'request' || message.role === 'system') continue;
    const task = tasksById.get(message.taskId); if (!task) continue;
    if (message.role === 'user') {
      const part = partsById.get(task.id+':part:'+message.partSeq) ?? work(task);
      message.partSeq = part.seq;
      put(part, { id: message.id, kind: 'user', messageId: message.id, start: 0, end: message.text.length,
        graphRevision: state.graphRevision, targets: [...(task.presentationFocus??[])] }); continue;
    }
    const call = message.presentationCallId ? callsById.get(message.presentationCallId) : undefined;
    if (call && (call.name === 'ui_focus' || message.targetRefs.length)) task.presentationFocus = [...message.targetRefs];
    if (!message.text.trim()) continue;
    // Paragraph whitespace belongs to the text. Only execution boundaries and br create parts.
    const frozen=recordedSpans.get(message.id)?.sort((a,b)=>(a.start??0)-(b.start??0));
    const spans=frozen&&frozen.length>1?frozen.map((event,n)=>({start:event.start??0,end:frozen[n+1]?.start??message.text.length,
      sealed:n<frozen.length-1||message.status!=='streaming'})):presentationSpans(message.text,message.status!=='streaming');
    for (const span of spans) {
      const eventId = message.id + ':' + span.start;
      let part = positions.get(eventId)?.part;
      if (!part) {
        const tail=latest(task);
        part=message.stepId?work(task,message.stepId,call?breakBeforeCall.get(call.id):undefined)
          :tail?.events?.every(e=>e.kind==='user')?tail:append(task,(tail?.seq??0)+1);
      }
      message.partSeq=part.seq;
      if(call)call.partSeq=part.seq;
      put(part, { id: eventId, kind: 'text', messageId: message.id, ...(call ? { callId: call.id } : {}), stepId: message.stepId,
        start: span.start, end: span.end, graphRevision: state.graphRevision, targets: [...(task.presentationFocus ?? [])] }, span.sealed);
    }
  }
  const oldCalls = new Map(before.toolCalls.map(c => [c.id, c]));
  for (const call of state.toolCalls) {
    const task = tasksById.get(call.taskId); if (!task) continue;
    if(oldCalls.get(call.id)?.presentedAt!==call.presentedAt)affected.add(task.id);
    if (['ui_present', 'task_finish'].includes(call.name) || successfulPartBreak(call)) continue;
    if (call.status === 'prepared' && !call.startedAt) continue;
    let part = partsById.get(task.id+':part:'+call.partSeq);
    if (!part) { part = work(task,call.stepId,breakBeforeCall.get(call.id),true); call.partSeq = part.seq; }
    if (oldCalls.get(call.id)?.status === call.status && oldCalls.get(call.id)?.startedAt === call.startedAt && positions.has(call.id)) continue;
    if (call.name === 'ui_focus') {
      const visible = state.messages.find(m => m.presentationCallId === call.id);
      if (visible) task.presentationFocus = [...visible.targetRefs];
    }
    put(part, { id: call.id, kind: call.name === 'ui_focus' ? 'focus' : 'tools', callId: call.id, stepId: call.stepId,
      graphRevision: state.graphRevision, targets: [...(task.presentationFocus ?? [])], calls: [structuredClone(call)] },call.status!=='prepared');
  }
  for (const task of state.tasks) {
    if(!changed.has(task.id)&&!affected.has(task.id))continue;
    const tail = latest(task);
    for (const part of (partsByTask.get(task.id)??[]).filter(p=>p.seq>0)) {
      part.stable = part.sealed && (part !== tail || task.status === 'completed') && (part.events ?? []).every(e => {
        if (e.messageId && messagesById.get(e.messageId)?.status !== 'complete') return false;
        const call = e.callId ? callsById.get(e.callId) : undefined;
        return !call || ['completed', 'rejected'].includes(call.status) && (task.status === 'completed' || call.presentedAt !== undefined);
      });
    }
    if (changed.has(task.id) && task.presentation) {
      delete task.presentation.visiblePart; delete task.presentation.ack;
      if(task.status==='completed'&&tail?.stepId)task.presentation.round={stepId:tail.stepId,revision:task.instructionRevision,lastSeq:tail.seq};
    }
  }
}
