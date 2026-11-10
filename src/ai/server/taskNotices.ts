import { createHash, randomUUID } from 'node:crypto';
import type { AppSnapshot, Note, SourceRef, Task, Workspace } from '../domain';
import type { ContextStage, PromptEntry } from '../contextState';
import { notebookWorkspace } from '../notebook';
import { requireValue } from './errors';

/** Once submitted, an edit notice is immutable task history. */
export interface TaskNotice {
  id: string;
  workspaceId: string;
  taskId?: string;
  kind: 'note_edit' | 'requirements_edit';
  createdAt: string;
  sequence: number;
  content: string;
  version: string;
  sourceRefs: SourceRef[];
  delivered?: boolean;
}

interface PendingTaskNotice {
  id: string;
  key: string;
  kind: TaskNotice['kind'];
  createdAt: string;
  notebookId?: string;
  baseline?: string;
  data: Record<string, unknown>;
  sourceRefs: SourceRef[];
}
export interface PendingTaskNotices { revision: number; changes: PendingTaskNotice[] }
export interface TaskNoticeBatch { revision: number; notebookId?: string; bindingRevision: number; notices: TaskNotice[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const noteValue = (note: Note | undefined) => note ? { content: note.text, type: note.type, sourceRefs: note.sourceRefs } : null;
const newPending = (key: string, kind: TaskNotice['kind'], data: Record<string, unknown>): PendingTaskNotice =>
  ({ id: `notice:${randomUUID()}`, key, kind, createdAt: new Date().toISOString(), data, sourceRefs: [] });

/** User edits reach every bound session. AI writes reach its peers; an existing local batch still follows the final value. */
export function queueNotebookNotices(state: AppSnapshot, notebook: Workspace, kind: 'work' | 'pinned', before: Note[], aiSessionId?: string): void {
  const after = kind === 'work' ? notebook.workNotes : notebook.pinnedNotes;
  const changes = kind === 'work'
    ? [...new Set([...before, ...after].map(note => note.id))].map(id => {
      const old = before.find(note => note.id === id), note = after.find(note => note.id === id);
      return { key: JSON.stringify(['note', notebook.id, id]), before: hash(noteValue(old)), after: hash(noteValue(note)),
        data: note ? { notebookId: notebook.id, noteId: id, version: note.version, content: note.text, type: note.type, sourceRefs: note.sourceRefs, replaces: id }
          : { notebookId: notebook.id, noteId: id, deleted: true }, sources: note?.sourceRefs ?? [] };
    })
    : [{ key: JSON.stringify(['requirements', notebook.id]), before: hash(before.map(noteValue)), after: hash(after.map(noteValue)),
      data: { notebookId: notebook.id, requirements: structuredClone(after), replaces: 'previous_user_requirements' }, sources: [] }];
  for (const session of state.sessions) {
    if (session.lifecycle === 'deleted' || notebookWorkspace(state, session)?.id !== notebook.id) continue;
    const workspace = state.workspaces.find(value => value.id === session.workspaceId)!;
    for (const item of changes) {
      const existing = workspace.pendingTaskNotices?.changes.find(value => value.key === item.key);
      if (!existing && (item.before === item.after || session.id === aiSessionId)) continue;
      const pending = workspace.pendingTaskNotices ??= { revision: 0, changes: [] };
      const change = existing ?? { ...newPending(item.key, kind === 'work' ? 'note_edit' : 'requirements_edit', item.data), notebookId: notebook.id, baseline: item.before };
      if (change.baseline === item.after) pending.changes = pending.changes.filter(value => value !== change);
      else {
        change.data = structuredClone(item.data); change.sourceRefs = structuredClone(item.sources);
        if (!existing) pending.changes.push(change);
      }
      pending.revision++;
    }
  }
}

/** Preparing/previewing never drains the queue or assigns it to a task. */
export function prepareTaskNoticeBatch(state: AppSnapshot, task: Task): TaskNoticeBatch {
  const workspace = state.workspaces.find(value => value.id === task.workspaceId)!;
  const notebook = notebookWorkspace(state, state.sessions.find(session => session.id === task.sessionId));
  const pending = workspace.pendingTaskNotices;
  return { revision: pending?.revision ?? 0, notebookId:notebook?.id,
    bindingRevision:state.sessions.find(session=>session.id===task.sessionId)?.temporaryContext?.revision??0,
    notices: (pending?.changes ?? [])
    .filter(change => !change.notebookId || change.notebookId === notebook?.id)
    .map((change, index) => {
      const content = JSON.stringify({ user_edit: { kind: change.kind, data: change.data } });
      return { id: change.id, workspaceId: workspace.id, taskId: task.id, kind: change.kind, createdAt: change.createdAt,
        sequence: state.lastSeq + index + 1, content, version: hash(content), sourceRefs: structuredClone(change.sourceRefs), delivered: true };
    }) };
}
export function taskNoticeBatchCurrent(state: AppSnapshot, task: Task, stage: ContextStage): boolean {
  const batch=stage.taskNoticeBatch,session=state.sessions.find(value=>value.id===task.sessionId);
  return !batch || batch.revision === (state.workspaces.find(w => w.id === task.workspaceId)?.pendingTaskNotices?.revision ?? 0)
    &&batch.notebookId===notebookWorkspace(state,session)?.id&&batch.bindingRevision===(session?.temporaryContext?.revision??0);
}
export function taskNoticeEntry(notice: TaskNotice): PromptEntry {
  const data = JSON.parse(notice.content).user_edit.data;
  return { id: `record:${notice.id}:${notice.version}`, taskId: notice.taskId, noticeId: notice.id, category: 'progress', lifecycle: 'durable', representation: 'body',
    coverage: [{ taskId: notice.taskId!, recordId: notice.id, version: notice.version, start: 0, end: notice.content.length }],
    ...(notice.kind === 'note_edit' ? { contextUpdate: { kind: 'note' as const, notebookId: data.notebookId, refId: data.noteId, version: data.version ?? 0, deleted: !!data.deleted } } : {}),
    messages: [{ role: 'user', content: JSON.stringify({ task_progress: { recordId: notice.id, content: notice.content } }) }] };
}
/** Only the transaction immediately submitting the execution-model request can seal a batch. */
export function commitTaskNoticeBatch(state: AppSnapshot, task: Task, stage: ContextStage): void {
  const batch = stage.taskNoticeBatch; if (!batch) return;
  requireValue(taskNoticeBatchCurrent(state, task, stage), '待发送改动已变化，请重新拼装提示词', 'STALE_CONTEXT_PLAN');
  const workspace = state.workspaces.find(value => value.id === task.workspaceId)!;
  for (const notice of batch.notices) {
    requireValue(!workspace.taskNotices?.some(value => value.id === notice.id), '改动通知已经发送，请重新拼装提示词', 'STALE_CONTEXT_PLAN');
    (workspace.taskNotices ??= []).push({ ...structuredClone(notice), sequence: ++state.lastSeq });
  }
  if (workspace.pendingTaskNotices) { workspace.pendingTaskNotices.changes = []; workspace.pendingTaskNotices.revision++; }
  delete stage.taskNoticeBatch;
}

/** Upgrade only records that never reached an execution request; submitted history is never rewritten. */
export function migratePendingTaskNotices(state:AppSnapshot):void {
  const sent=new Set(state.contextManifests.filter(manifest=>manifest.stepId).flatMap(manifest=>manifest.items.flatMap(item=>item.derivedFrom)));
  for(const snapshot of state.snapshots)for(const notice of snapshot.taskNotices??[])sent.add(notice.id);
  for(const workspace of state.workspaces){
    for(const entry of workspace.contextStage?.entries??[])for(const span of entry.coverage)sent.add(span.recordId);
    const legacy=(workspace.taskNotices??[]).filter(notice=>!notice.delivered&&!sent.has(notice.id)
      &&(!notice.taskId||state.tasks.find(task=>task.id===notice.taskId)?.status!=='completed'));
    for(const notice of workspace.taskNotices??[])if(!legacy.includes(notice))notice.delivered=true;
    if(!legacy.length)continue;
    const session=state.sessions.find(value=>value.id===workspace.sessionId),notebook=notebookWorkspace(state,session);
    const grouped=new Map<string,TaskNotice[]>();
    for(const notice of legacy.sort((a,b)=>a.sequence-b.sequence)){
      const data=JSON.parse(notice.content).user_edit.data;
      const key=notice.kind==='requirements_edit'?'requirements':`note:${data.noteId}`;
      grouped.set(key,[...grouped.get(key)??[],notice]);
    }
    if(notebook)for(const [group,notices] of grouped){
      const first=notices[0],data=JSON.parse(first.content).user_edit.data;
      const pending=workspace.pendingTaskNotices??={revision:0,changes:[]};
      let key:string,baseline:string,after:string,payload:Record<string,unknown>,sources:SourceRef[]=[];
      if(group==='requirements'){
        let known:Note[]|undefined;
        for(const entry of workspace.contextStage?.entries??[])for(const message of entry.messages)try{
          const value=JSON.parse(message.content);if(Array.isArray(value.user_requirements))known=value.user_requirements;
        }catch{/* Unstructured messages do not prove previous requirements. */}
        key=JSON.stringify(['requirements',notebook.id]);
        baseline=known?hash(known.map(noteValue)):data.version===1?hash([]):`unknown:${first.id}`;
        after=hash(notebook.pinnedNotes.map(noteValue));payload={notebookId:notebook.id,requirements:structuredClone(notebook.pinnedNotes),replaces:'previous_user_requirements'};
      }else{
        const note=notebook.workNotes.find(value=>value.id===data.noteId);
        const knownVersion=workspace.contextStage?.noteVersions[data.noteId];
        const old=(notebook.noteVersions??[]).find(value=>value.id===data.noteId&&value.version===(knownVersion??(data.version>1?data.version-1:undefined)))
          ??(notebook.noteVersions??[]).find(value=>value.id===data.noteId);
        key=JSON.stringify(['note',notebook.id,data.noteId]);
        baseline=data.version===1?hash(null):old?hash(noteValue(old)):`unknown:${first.id}`;
        after=hash(noteValue(note));sources=note?.sourceRefs??[];
        payload=note?{notebookId:notebook.id,noteId:note.id,version:note.version,content:note.text,type:note.type,sourceRefs:sources,replaces:note.id}
          :{notebookId:notebook.id,noteId:data.noteId,deleted:true};
      }
      pending.changes=pending.changes.filter(change=>change.key!==key);
      if(baseline!==after)pending.changes.push({...newPending(key,first.kind,payload),id:first.id,createdAt:first.createdAt,notebookId:notebook.id,baseline,sourceRefs:structuredClone(sources)});
      pending.revision++;
    }
    const ids=new Set(legacy.map(notice=>notice.id));workspace.taskNotices=workspace.taskNotices?.filter(notice=>!ids.has(notice.id));
  }
}

/** Note updates carry authored material, even though they share the edit journal. */
export const canReceiptTaskNotice = (notice: TaskNotice): boolean => notice.kind !== 'note_edit';
export function contextNoteNoticeIds(state: AppSnapshot, workspaceId: string): Set<string> {
  const workspace = state.workspaces.find(w => w.id === workspaceId);
  return new Set([...workspace?.taskNotices ?? [], ...state.snapshots
    .filter(s => workspace?.snapshotIds.includes(s.id) && !s.revoked).flatMap(s => s.taskNotices ?? [])]
    .filter(n => !canReceiptTaskNotice(n)).map(n => n.id));
}

export function claimTaskNotices(state: AppSnapshot, workspaceId: string, taskId: string): void {
  const workspace = state.workspaces.find(w => w.id === workspaceId);
  for (const notice of workspace?.taskNotices ?? []) if (!notice.taskId) notice.taskId = taskId;
}

export function taskNoticeReceipt(notice: TaskNotice) {
  return { user_edit: { recordId: notice.id, kind: notice.kind, occurredAt: notice.createdAt, bodyOmitted: true,
    readWith: { tool: 'context_restore_records', arguments: { recordIds: [notice.id] } } } };
}
