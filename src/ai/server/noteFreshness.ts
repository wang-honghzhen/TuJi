import type { AppSnapshot, Task, SourceRef } from '../domain';
import type { ContextStage, PromptEntry } from '../contextState';
import { notebookWorkspace, notePayload, sameNoteContent } from '../notebook';
import { visibleWriteCalls } from './writeAcknowledgements';
import { sourceChanges } from './sourceFreshness';
import { versionNoticeLine } from './contextUpdates';
import { allRetainedCalls, isReceipted, originResultId } from './readVisibility';
import { pageOrigin, returnedReadPages } from './readPageEvidence';

/** Identity survives partial reads; completeness is a separate, prompt-local fact. */
export function visibleNoteEvidence(state:AppSnapshot,task:Task,stage:ContextStage){
  const notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
  const evidence=new Map<string,{versions:Set<number>;complete:Set<number>;callIds:Set<string>}>();
  const add=(id:string,version:number,complete=false,callId?:string)=>{
    if(!id||!Number.isSafeInteger(version))return;
    const value=evidence.get(id)??{versions:new Set<number>(),complete:new Set<number>(),callIds:new Set<string>()};
    value.versions.add(version);if(complete)value.complete.add(version);if(callId)value.callIds.add(callId);evidence.set(id,value);
  };
  if(!notebook)return evidence;
  const deletions=new Set<string>();
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const notices=new Map([...workspace.taskNotices??[],...state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked).flatMap(s=>s.taskNotices??[])].map(n=>[n.id,n]));
  for(const entry of stage.entries){
    if(entry.contextUpdate?.kind==='note'&&entry.contextUpdate.notebookId===notebook.id){
      if(entry.contextUpdate.deleted)deletions.add(entry.contextUpdate.refId);
      else {deletions.delete(entry.contextUpdate.refId);add(entry.contextUpdate.refId,Number(entry.contextUpdate.version),true);}
    }
    if(entry.representation!=='summary'&&entry.representation!=='receipt')for(const span of entry.coverage){
      const notice=notices.get(span.recordId);
      if(notice?.kind!=='note_edit'||span.version!==notice.version||span.start!==0||span.end!==notice.content.length)continue;
      const data=JSON.parse(notice.content).user_edit.data;
      if(data.notebookId!==notebook.id)continue;
      if(data.deleted)deletions.add(data.noteId);
      else {deletions.delete(data.noteId);add(data.noteId,data.version,true);}
    }
    if(entry.category==='work_notes')for(const message of entry.messages)try{
      const note=JSON.parse(message.content).work_note;if(note)add(note.noteId,note.version,true);
    }catch{/* Only structured notebook bodies prove a full version. */}
  }
  const calls=allRetainedCalls(state),visible=new Set(stage.entries.flatMap(e=>e.readCallIds??[]));
  for(const call of visibleWriteCalls(stage,calls)){
    const ack=call.noteWriteAcknowledgement;if(ack?.notebookId===notebook.id)add(ack.noteId,ack.version,true,call.id);
  }
  const groups=new Map<string,{id:string;version:number;total:number;pages:Set<number>}>();
  for(const call of calls){
    if(isReceipted(state,call)||!visible.has(call.id)&&!visible.has(originResultId(call)))continue;
    for(const page of returnedReadPages(call)){
      const origin=pageOrigin(state,call,page);if(origin?.kind!=='note')continue;
      if(origin.noteBinding&&origin.noteBinding.notebookId!==notebook.id)continue;
      const items=Array.isArray(page.data?.items)?page.data.items:[];
      const bindings=origin.noteBinding?[origin.noteBinding]:items.filter((v:any)=>typeof v?.noteId==='string'&&Number.isSafeInteger(v.version));
      for(const binding of bindings){
        add(binding.noteId,binding.version,false,call.id);
        const key=JSON.stringify([page.pointerId,binding.noteId,binding.version,origin.totalPages]);
        const group=groups.get(key)??{id:binding.noteId,version:binding.version,total:origin.totalPages,pages:new Set<number>()};
        group.pages.add(page.page);groups.set(key,group);
      }
    }
  }
  for(const group of groups.values())if(Number.isSafeInteger(group.total)&&group.total>0
    &&group.pages.size===group.total&&[...group.pages].every(p=>p>=1&&p<=group.total))add(group.id,group.version,true);
  // Saving and undoing an edit advances the revision, but does not change the material the model saw.
  for(const note of notebook.workNotes){
    const known=evidence.get(note.id);if(!known||known.complete.has(note.version))continue;
    if((notebook.noteVersions??[]).some(old=>old.id===note.id&&known.complete.has(old.version)&&sameNoteContent(old,note)))
      add(note.id,note.version,true);
  }
  for(const id of deletions)evidence.delete(id);
  return evidence;
}

/** A version is known only through a complete displayed note, replacement, or successful write. */
export function acknowledgeVisibleNotes(state:AppSnapshot,task:Task,stage:ContextStage):void {
  stage.noteVersions=Object.fromEntries([...visibleNoteEvidence(state,task,stage)].filter(([,v])=>v.complete.size)
    .map(([id,v])=>[id,Math.max(...v.complete)]));
}

export function appendNoteUpdates(state:AppSnapshot,task:Task,stage:ContextStage,append:(entry:PromptEntry)=>void,
  rebuild:boolean,pendingNoteIds:ReadonlySet<string>=new Set()):void {
  const notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
  if(!notebook)return;
  if(!rebuild){acknowledgeVisibleNotes(state,task,stage);return;}
  for(const note of notebook.workNotes){
    if(pendingNoteIds.has(note.id))continue;
    if(stage.noteVersions[note.id]===note.version)continue;
    append({id:`note:${note.id}:${note.version}`,category:'work_notes',lifecycle:'region',coverage:[],
      messages:[{role:'user',content:JSON.stringify({work_note:notePayload(note)})}]});
    stage.noteVersions[note.id]=note.version;
  }
}

export function noteNoticeFacts(state:AppSnapshot,task:Task,stage:ContextStage){
  const notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
  const facts:Array<{key:string;id:string;kind:string;state:unknown;deleted?:boolean;callIds:string[]}>=[];
  if(!notebook)return facts;
  acknowledgeVisibleNotes(state,task,stage);
  const visible=visibleNoteEvidence(state,task,stage);
  for(const note of notebook.workNotes){
    const known=stage.noteVersions[note.id];
    const versions=[...visible.get(note.id)?.versions??[]].sort((a,b)=>a-b),callIds=[...visible.get(note.id)?.callIds??[]].sort();
    if(known!==note.version)facts.push({key:`note:${note.id}`,id:note.id,kind:'AI笔记版本变动',state:[versions,note.version],callIds});
    const shown=known===note.version?[note]:(notebook.noteVersions??[]).filter(n=>n.id===note.id&&versions.includes(n.version));
    const changes=shown.flatMap(n=>sourceChanges(state,task,n.sourceRefs));
    if(changes.length)facts.push({key:`note-source:${note.id}`,id:note.id,kind:'AI笔记依据变动',state:[versions,changes],callIds});
  }
  for(const [id,value] of visible)if(!notebook.workNotes.some(n=>n.id===id))facts.push({key:`note:${id}`,id,kind:'AI笔记版本变动',
    state:[[...value.versions].sort((a,b)=>a-b),'deleted'],deleted:true,callIds:[...value.callIds].sort()});
  return facts;
}
export function noteVersionNotices(state:AppSnapshot,task:Task,stage:ContextStage,encode:(id:string)=>string){
  const facts=noteNoticeFacts(state,task,stage),notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
  const sources:SourceRef[]=(notebook?.workNotes??[]).filter(n=>stage.noteVersions[n.id]===n.version)
    .map(n=>({kind:'note',id:n.id,version:n.version,tracking:'current'}));
  return {lines:['AI笔记版本变动','AI笔记依据变动'].map(kind=>versionNoticeLine(kind,facts.filter(f=>f.kind===kind)
    .map(f=>`${encode(f.id)}${f.deleted?'（已删除）':''}`))).filter(Boolean),sources};
}
