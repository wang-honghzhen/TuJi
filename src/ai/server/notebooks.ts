import type { AppSnapshot, Note, SourceRef, Task, Workspace } from '../domain';
import { queueNotebookNotices } from './taskNotices';
import { notebookUsage, notebookWorkspace } from '../notebook';
import { requireValue } from './errors';
import { hash, id, now } from './repository';
export function writableNotebook(state: AppSnapshot, sessionId: string): Workspace {
  const session = state.sessions.find(s => s.id === sessionId && s.lifecycle === 'active');
  requireValue(session, '会话不存在或不可写', 'NOT_FOUND');
  const workspace = notebookWorkspace(state, session);
  requireValue(workspace && state.sessions.some(s => s.id === workspace.sessionId && s.lifecycle === 'active'),
    '当前没有可写的来源会话笔记，请先选择会话记录', 'NO_NOTEBOOK');
  return workspace;
}
export function assertNotebookCapacity(state: AppSnapshot, workspace: Workspace) {
  const usage = notebookUsage(state, workspace);
  requireValue(usage.used <= usage.limit, `AI 笔记超过 ${usage.limit} token 上限，请编辑或删除笔记`, 'WORK_NOTES_LIMIT');
}
/** Delivery provenance must survive deleting the temporary log and its selection snapshots. */
export function preserveDeliverySources(state: AppSnapshot, task: Task, notebook: Workspace, sources: SourceRef[]): SourceRef[] {
  const temporary = state.workspaces.find(w => w.id === task.workspaceId)!;
  const visiting = new Set<string>();
  const preserve = (ref: SourceRef): SourceRef => {
    const key = hash([notebook.id, ref]), archiveId = 'note:delivery-source:' + key;
    if (notebook.noteVersions?.some(n => n.id === archiveId)) return { kind: 'note', id: archiveId, version: 1 };
    const message = ref.kind === 'message' ? state.messages.find(m => m.workspaceId === temporary.id && m.id === ref.id && m.version === ref.version) : undefined;
    const snapshot = ref.kind === 'snapshot' ? state.snapshots.find(s => temporary.snapshotIds.includes(s.id) && s.id === ref.id && s.contentHash === ref.version) : undefined;
    const note = ref.kind === 'note' ? state.workspaces.flatMap(w => [...w.workNotes, ...(w.noteVersions ?? [])])
      .find(n => n.id === ref.id && n.version === ref.version && n.lifecycle === 'current_task') : undefined;
    if (!message && !snapshot && !note) return ref;
    requireValue(!visiting.has(key), '交付来源存在循环依赖', 'INVALID_SOURCE'); visiting.add(key);
    const original = message ?? note;
    const dependencies = [...(original?.sourceRefs ?? snapshot?.sourceRefs ?? []), ...(message?.attachments ?? [])].map(preserve);
    const archive: Note = { id: archiveId, version: 1, type: 'finding', lifecycle: 'multi_task', sourceRefs: dependencies,
      text: message ? JSON.stringify({ role: message.role, text: message.text, attachments: message.attachments })
        : note?.text ?? JSON.stringify({ messages: snapshot!.messages, notes: snapshot!.notes, operations: snapshot!.operations }),
      createdAt: message?.createdAt ?? note?.createdAt ?? snapshot?.createdAt ?? now(), updatedAt: now(),
      originTaskId: message?.taskId ?? note?.originTaskId ?? task.id, author: message?.role === 'user' ? 'user' : 'ai' };
    (notebook.noteVersions ??= []).push(archive); visiting.delete(key);
    return { kind: 'note', id: archiveId, version: 1 };
  };
  return sources.map(preserve);
}
export function retainDeliveryArtifacts(state: AppSnapshot, task: Task, notebook: Workspace, sources: SourceRef[]) {
  const visited = new Set<string>();
  const visit = (source: SourceRef) => {
    const key = JSON.stringify(source); if (visited.has(key)) return; visited.add(key);
    if (source.kind === 'artifact') {
      const artifact = state.artifacts.find(a => a.id === source.id && a.workspaceId === task.workspaceId);
      if (artifact) { artifact.workspaceId = notebook.id; if (!notebook.artifactIds.includes(artifact.id)) notebook.artifactIds.push(artifact.id); }
    }
    if (source.kind === 'note') notebook.noteVersions?.find(n => n.id === source.id && n.version === source.version)?.sourceRefs.forEach(visit);
  };
  sources.forEach(visit);
}
/** Tool failures become receipts inside the outer transaction, so note mutations need their own rollback. */
export function mutateNotebook<T>(state: AppSnapshot, sessionId: string, action: (workspace: Workspace) => T): T {
  const workspace = writableNotebook(state, sessionId), before = structuredClone(workspace);
  try { return action(workspace); }
  catch (error) {
    for (const key of Object.keys(workspace)) delete (workspace as unknown as Record<string, unknown>)[key];
    Object.assign(workspace, before); throw error;
  }
}

/** Caller owns the repository transaction, including tool receipt and capacity rejection. */
export function writeAiNote(state: AppSnapshot, task: Task, input: {
  noteId?: string; expectedVersion?: number; text: string; type: Note['type'];
  lifecycle: Note['lifecycle']; sourceRefs: Note['sourceRefs']; receiptId: string;
}) {
  const session = state.sessions.find(s => s.id === task.sessionId)!;
  const live = writableNotebook(state, session.id);
  if (session.mode === 'temporary') requireValue(task.notebookBinding?.id === live.id
    && task.notebookBinding.revision === session.temporaryContext?.revision, '来源选择已变化，本次笔记未保存', 'SOURCE_CHANGED');
  const previousReceipt = live.noteWriteReceipts?.[input.receiptId];
  if (previousReceipt) return {status:'ok', ...previousReceipt, replayed:true};
  requireValue(input.lifecycle !== 'current_task', '当前任务用到的笔记请通过workspace_update_handoff追加到任务进度', 'NOTE_LIFECYCLE');
  const workspace = structuredClone(live);
  const previous = input.noteId ? workspace.workNotes.find(n => n.id === input.noteId) : undefined;
  if(input.noteId) requireValue(previous && previous.version === input.expectedVersion, '工作笔记版本已变化', 'VERSION_CONFLICT',
    {noteId:input.noteId,currentVersion:previous?.version??null,executed:false,nextAction:'review_latest_note_before_retry'});
  const sourceRefs = session.mode === 'temporary' ? preserveDeliverySources(state,task,workspace,input.sourceRefs) : input.sourceRefs;
  const note:Note = {id:previous?.id ?? id('note:'),text:input.text,type:previous?.type ?? input.type,
    version:(previous?.version ?? 0)+1,sourceRefs,createdAt:previous?.createdAt ?? now(),updatedAt:now(),
    originTaskId:previous?.originTaskId ?? task.id,author:previous?.author ?? 'ai',lifecycle:'multi_task',
    ...(previous?.clientRequestId ? { clientRequestId: previous.clientRequestId } : {})};
  if(previous){(workspace.noteVersions??=[]).push(structuredClone(previous));workspace.workNotes[workspace.workNotes.indexOf(previous)] = note;}
  else workspace.workNotes.push(note);
  const usage = notebookUsage(state,workspace);
  requireValue(usage.used <= usage.limit, `笔记未保存：当前 ${notebookUsage(state,live).used}，上限 ${usage.limit}，候选 ${usage.used} token`, 'WORK_NOTES_LIMIT');
  const receipt = {noteId:note.id,version:note.version,storage:'original' as const};
  (workspace.noteWriteReceipts??={})[input.receiptId] = receipt;
  if(session.mode === 'temporary') retainDeliveryArtifacts(state,task,workspace,sourceRefs);
  const beforeNotes = live.workNotes;
  Object.assign(live,workspace);
  queueNotebookNotices(state,live,'work',beforeNotes,session.id);
  return {status:'ok',...receipt,lifecycle:'multi_task'};
}

export function editNotebookContent(state: AppSnapshot, workspace: Workspace, input: {
  id: string; text: string; expectedVersion: number;
}) {
  requireValue(input.text.trim(), '内容不能为空');
  const note = workspace.workNotes.find(value => value.id === input.id);
  requireValue(note && note.version === input.expectedVersion, '笔记版本已变化', 'VERSION_CONFLICT');
  const candidate = structuredClone(workspace), replacement = {...note,text:input.text,version:note.version+1,updatedAt:now()};
  candidate.workNotes[candidate.workNotes.findIndex(value => value.id === note.id)] = replacement;
  assertNotebookCapacity(state,candidate);
  (workspace.noteVersions ??= []).push(structuredClone(note)); Object.assign(note,replacement);
}

export function deleteNotebookEntry(_state: AppSnapshot, workspace: Workspace, key: string, expectedVersion: number) {
  const note = workspace.workNotes.find(value => value.id === key);
  requireValue(note, '笔记不存在', 'NOT_FOUND');
  requireValue(note.version === expectedVersion, '笔记版本已变化', 'VERSION_CONFLICT');
  (workspace.noteVersions ??= []).push(structuredClone(note));
  workspace.workNotes = workspace.workNotes.filter(value => value.id !== key);
}
