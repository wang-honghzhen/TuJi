import type { AppSnapshot, ContextManifest, SourceRef, Task, ToolCallRecord } from '../domain';
import { visibleNoteEvidence } from './noteFreshness';
import { requireValue } from './errors';
import { withoutToolVersions } from './toolVersionProtocol';
import { hash } from './repository';
import { translateGraphPayload } from './graphReferences';

/** Persisted on the submitted manifest, never added to messages or tools. */
export interface ToolVersionBindings {
  protocol:1;
  handoff:number|null;
  notes:Record<string,number>;
  reads:Record<string,string>;
  sources:SourceRef[];
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validVersion=(v:unknown):v is string|number=>typeof v==='string'&&!!v||typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const kinds=new Set(['message','artifact','node','document','edge','note','snapshot']);
export const toolReadKey=(name:string,args:Record<string,unknown>)=>JSON.stringify([name,args.refId,args.field??null,args.start??null,args.end??null]);

/** Read only host-owned structured envelopes. Never parse user prose, note text,
 * summary text or model-authored argument strings as a version declaration. */
export function captureToolVersions(state:AppSnapshot,task:Task,manifest:ContextManifest,decode:(id:string)=>string=v=>v):ToolVersionBindings{
  const versions:ToolVersionBindings={protocol:1,handoff:task.handoff?null:0,notes:{},reads:{},sources:[]};
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const progressSpans=new Map<string,Array<{start:number;end:number}>>();
  const bodyReadKeys=new Map<string,Set<string>>();
  const sourceKeys=new Set<string>(),recordIds=new Set(manifest.items.flatMap(i=>i.derivedFrom));
  const addSource=(raw:unknown)=>{
    if(!object(raw)||!kinds.has(String(raw.kind))||typeof raw.id!=='string'||!validVersion(raw.version))return;
    const source={kind:raw.kind,id:decode(raw.id),version:raw.version,
      ...(Number.isSafeInteger(raw.start)&&Number.isSafeInteger(raw.end)?{start:raw.start,end:raw.end}:{}),
      ...(Number.isSafeInteger(raw.page)?{page:raw.page}:{}),
      ...(raw.tracking==='current'||raw.tracking==='historical'?{tracking:raw.tracking}:{})} as SourceRef;
    const key=JSON.stringify(source);if(!sourceKeys.has(key)){sourceKeys.add(key);versions.sources.push(source);}
  };
  const rememberRead=(name:string,args:Record<string,unknown>)=>{
    const version=args.expectedVersion??args.expectedRelationVersion;
    if(typeof args.refId==='string'&&typeof version==='string'){
      const id=decode(args.refId),key=toolReadKey(name,{...args,refId:id});versions.reads[key]=version;
      if(name==='graph_read_node_content'&&args.field===undefined){
        const keys=bodyReadKeys.get(id)??new Set<string>();keys.add(key);bodyReadKeys.set(id,keys);
      }
    }
  };
  const visit=(value:unknown,readSources=new Map<string,string>()):void=>{
    if(Array.isArray(value)){value.forEach(item=>visit(item,readSources));return;}
    if(!object(value))return;
    if(Array.isArray(value.sources))value.sources.forEach(addSource);
    if(Array.isArray(value.sourceRefs))value.sourceRefs.forEach(addSource);
    if(['ok','partial'].includes(String(value.status))&&object(value.data)&&Array.isArray(value.sources)){
      readSources=new Map();
      for(const source of value.sources)if(object(source)&&['node','document'].includes(String(source.kind))&&typeof source.id==='string'&&typeof source.version==='string'){
        const id=decode(source.id);readSources.set(id,source.version);
        for(const key of bodyReadKeys.get(id)??[])versions.reads[key]=source.version;
      }
    }
    if(typeof value.refId==='string'){
      const id=decode(value.refId),version=readSources.get(id);
      // Complete replacement fields supersede an older truncated-field entry.
      // Hash the delivered value, never an unobserved live database field.
      if(version)for(const field of ['name','path','design']){
        const key=toolReadKey('graph_read_object_field',{refId:id,field});
        if(versions.reads[key]&&value[field]!==undefined&&!value[`${field}ReadWith`])
          versions.reads[key]=hash([version,field,translateGraphPayload(value[field],decode)]);
      }
    }
    if(typeof value.tool==='string'&&object(value.arguments))rememberRead(value.tool,value.arguments);
    if(typeof value.refId==='string'&&object(value.relations)&&typeof value.relations.version==='string')
      rememberRead('graph_read_node_edges',{refId:value.refId,expectedRelationVersion:value.relations.version});
    // The nested source rows are provenance, not instructions to the model.
    if(typeof value.artifactId==='string'&&validVersion(value.version))addSource({kind:'artifact',id:value.artifactId,version:value.version,start:value.start,end:value.end});
    // A conflict receipt offers a new read target, not evidence that its body
    // was read. Bind that recovery entry without advancing write dependencies.
    if(value.status==='error'&&value.code==='VERSION_CONFLICT'&&object(value.details)&&Array.isArray(value.details.conflicts))
      for(const conflict of value.details.conflicts)if(object(conflict)&&typeof conflict.refId==='string'){
        const version=conflict.currentRelationVersion??(conflict.dependency==='incident_edges'?conflict.currentVersion:undefined);
        if(typeof version==='string')rememberRead('graph_read_node_edges',{refId:conflict.refId,expectedRelationVersion:version});
      }
    // Recover a large checkpoint by its immutable host record and exact spans.
    // Literal text is compared, never interpreted as a version declaration.
    if(typeof value.recordId==='string'&&typeof value.content==='string'&&typeof value.start==='number'&&typeof value.end==='number'){
      const id=decode(value.recordId),progress=workspace.progressEvents?.find(p=>p.id===id&&p.taskId===task.id);
      if(progress&&JSON.stringify({progress:progress.text,version:progress.version}).slice(value.start,value.end)===value.content){
        const spans=progressSpans.get(id)??[];spans.push({start:value.start,end:value.end});progressSpans.set(id,spans);
      }
    }
    const note=object(value.work_note)?value.work_note:undefined;
    if(note&&typeof note.noteId==='string'&&typeof note.version==='number'){
      const id=decode(note.noteId);versions.notes[id]=Math.max(versions.notes[id]??0,note.version);
      addSource({kind:'note',id,version:note.version});
    }
    if(object(value.active_progress)&&decode(String(value.active_progress.taskId))===task.id&&Number.isSafeInteger(value.active_progress.version))
      versions.handoff=Number(value.active_progress.version);
    const taskProgress = object(value.task_progress) ? value.task_progress : value;
    if (typeof taskProgress.recordId === 'string' && taskProgress.content !== undefined && !taskProgress.bodyOmitted) {
      const progress = workspace.progressEvents?.find(p => p.id === decode(String(taskProgress.recordId)) && p.taskId === task.id);
      const content = typeof taskProgress.content === 'string' ? taskProgress.content : JSON.stringify(taskProgress.content);
      if (progress && content === JSON.stringify({ progress: progress.text, version: progress.version }))
        versions.handoff = Math.max(versions.handoff ?? 0, progress.version);
    }
    for(const [key,item] of Object.entries(value))if(!['arguments','text','content','summary','newContent','newSummary'].includes(key))visit(item,readSources);
  };
  const stage=manifest.stageDraft;
  if(stage){
    for(const entry of stage.entries){
      entry.coverage.forEach(c=>recordIds.add(c.recordId));
      if(entry.category==='current_request')continue;
      for(const message of entry.messages)if(message.role!=='assistant'&&message.role!=='system'){
        try{visit(JSON.parse(message.content));}catch{/* Literal content is not a binding. */}
      }
    }
    for(const [id,evidence] of visibleNoteEvidence(state,task,stage))if(evidence.complete.size)
      versions.notes[id]=Math.max(...evidence.complete);
  }else{
    for(const item of manifest.items){
      item.sourceRefs.forEach(addSource);
      if(['rules','application','mode','tools','current_request'].includes(item.category))continue;
      try{
        const value=JSON.parse(item.text);
        if(item.category==='current_trajectory'&&value?.handoff===task.handoff?.text)versions.handoff=task.handoff?.version??0;
        visit(value);
      }catch{/* Original prose cannot grant a binding. */}
      if(item.section==='work_notes')for(const source of item.sourceRefs)if(source.kind==='note'&&typeof source.version==='number')
        versions.notes[source.id]=Math.max(versions.notes[source.id]??0,source.version);
    }
  }
  for(const [id,spans] of progressSpans){
    const progress=workspace.progressEvents!.find(p=>p.id===id)!;let end=0;
    for(const span of spans.sort((a,b)=>a.start-b.start)){if(span.start>end)break;end=Math.max(end,span.end);}
    if(end===JSON.stringify({progress:progress.text,version:progress.version}).length)
      versions.handoff=Math.max(versions.handoff??0,progress.version);
  }
  const memories=state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked);
  const visibleCalls=new Set([...manifest.readBodyResultIds??[],...recordIds]);
  const calls=[...state.toolCalls,...memories.flatMap(m=>m.toolCalls??[])].filter(c=>visibleCalls.has(c.id)&&c.status==='completed')
    .sort((a,b)=>(a.sequence??0)-(b.sequence??0));
  for(const call of calls)(call.resultSources??[]).forEach(addSource);
  for(const message of [...state.messages,...memories.flatMap(m=>m.messages)])if(recordIds.has(message.id)||message.id===task.rootUserMessageId)
    addSource({kind:'message',id:message.id,version:message.version});
  // These are complete versions actually displayed in the current input. They
  // outrank older retained provenance, never a newer background database row.
  for(const source of [...manifest.canvasSources??[],...manifest.currentSources??[]]){
    const key=JSON.stringify(source);if(sourceKeys.has(key))versions.sources=versions.sources.filter(s=>JSON.stringify(s)!==key);
    sourceKeys.delete(key);addSource(source);
  }
  for(const [id,version] of Object.entries(versions.notes))addSource({kind:'note',id,version});
  return versions;
}

const recovery=(name:string,id?:string)=>name==='workspace_update_handoff'
  ?{nextAction:'review_latest_progress_before_retry',instruction:'核对最新任务笔记与后续实际结果后，重试追加仍需记录的内容，无需重写此前笔记。追加失败不撤销此前核验；版本由系统维护，无需填写。'}
  :name.startsWith('workspace_')?{nextAction:'read_latest_note_before_retry',...(id
    ?{readWith:{tool:'context_read_children',arguments:{summaryId:id}}}:{})}
  :{nextAction:'reread_current_object',...(id?{readWith:{tool:'graph_read',arguments:{refs:[id]}}}:{})};

/** Return a private execution copy. The recorded model arguments stay version-free. */
export function bindToolVersions(state:AppSnapshot,task:Task,call:ToolCallRecord,input:Record<string,unknown>):Record<string,unknown>{
  const manifest=state.contextManifests.find(m=>m.taskId===task.id&&m.stepId===call.stepId);
  const captured=manifest?.toolVersions;
  // Older queued calls retain their original explicit preconditions. They must
  // never be silently rebound to whatever is latest when the process restarts.
  if(!captured)return input;
  const args=withoutToolVersions(call.name,input);
  if(['workspace_read_artifact','workspace_view_artifact','workspace_search_artifacts'].includes(call.name)&&typeof args.artifactId==='string'){
    const known=captured.sources.filter(s=>s.kind==='artifact'&&s.id===args.artifactId).at(-1);
    requireValue(known,'附件缺少本次可见的版本入口，请先读取任务附件清单','VERSION_BINDING_REQUIRED');
    args.version=known.version;
  }
  const bindNumber=(value:number|undefined|null,key:string,id?:string)=>{
    requireValue(typeof value==='number','本次请求未包含可用的写入依据，请先核对最新记录。','VERSION_BINDING_REQUIRED',
      {executed:false,...recovery(call.name,id)});args[key]=value;
  };
  if(call.name==='workspace_update_handoff')bindNumber(captured.handoff,'expectedVersion');
  if(call.name==='workspace_update_work_notes'){
    if(typeof args.noteId==='string')bindNumber(captured.notes[args.noteId],'expectedVersion',args.noteId);
  }
  if(['graph_read_node_content','graph_read_directory_content','graph_read_object_field'].includes(call.name)){
    const exact=captured.reads[toolReadKey(call.name,args)];
    let version:string|undefined=exact;
    if(!version&&call.name==='graph_read_node_content'&&(args.start!==undefined||args.end!==undefined)){
      version=captured.reads[toolReadKey(call.name,{refId:args.refId})];
      version??=captured.sources.filter(s=>s.kind==='node'&&s.id===args.refId).at(-1)?.version as string|undefined;
      requireValue(typeof version==='string','该正文范围缺少已知来源，请先读取对象取得当前范围入口。','VERSION_BINDING_REQUIRED',
        {executed:false,...recovery(call.name,String(args.refId))});
    }
    if(version)args.expectedVersion=version;
  }
  if(call.name==='graph_read_node_edges'){
    const bind=(row:Record<string,unknown>)=>{
      const version=captured.reads[toolReadKey(call.name,row)];return {...row,...(version?{expectedRelationVersion:version}:{})};
    };
    if(Array.isArray(args.requests))args.requests=args.requests.map(row=>bind(row as Record<string,unknown>));
    else Object.assign(args,bind(args));
  }
  if(Array.isArray(args.sourceRefs))args.sourceRefs=args.sourceRefs.map(raw=>{
    const ref=raw as SourceRef;
    const candidates=captured.sources.filter(s=>s.kind===ref.kind&&s.id===ref.id
      &&(ref.page===undefined||s.page===undefined||ref.page===s.page)
      &&(s.start===undefined||ref.start!==undefined&&ref.end!==undefined&&ref.start>=s.start&&ref.end<=s.end!));
    requireValue(candidates.length,'来源没有出现在本次可用证据中，请先读取来源再引用。','SOURCE_VERSION_UNAVAILABLE',{executed:false,sourceId:ref.id});
    requireValue(ref.tracking!=='historical'||new Set(candidates.map(s=>s.version)).size===1,
      '同一对象存在多个历史版本，请改用对应历史记录或快照引用。','SOURCE_VERSION_AMBIGUOUS',{executed:false,sourceId:ref.id});
    return {...ref,version:candidates.at(-1)!.version};
  });
  return args;
}
