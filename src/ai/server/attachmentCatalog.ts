import { isDeepStrictEqual } from 'node:util';
import type { AppSnapshot, Artifact, SourceRef, Task } from '../domain';
import type { AttachmentCatalogEntry, AttachmentProtection } from '../attachments';
import { attachmentLimits } from '../attachments';
import { messageAttachments, sourceVisible, inputCapacity } from '../memory';
import { residentSessionTaskIds } from '../sessionContext';
import { estimateTokens } from '../tokens';
import { requestTokens } from './providers';
import { toolDefinitions } from './tools';
import { isMinimalSession } from '../temporaryModes';
import { requireValue } from './errors';
import { allRetainedCalls, isReceipted, originResultId } from './readVisibility';
import type { ContextStage } from '../contextState';

export const attachmentKey = (row: { artifactId: string; version: number | string }) => `${row.artifactId}:${row.version}`;
/** File authorization is independent of prompt residency; inherited sources remain frozen. */
export function authorizedAttachments(state: AppSnapshot, task: Task, taskIds?: Iterable<string>) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const imagesOnly = isMinimalSession(state.sessions.find(s => s.id === task.sessionId));
  const localTasks = new Set(state.tasks.filter(t => t.workspaceId === workspace.id).map(t => t.id));
  localTasks.add(task.id); // Initial/child-session previews use a host-created task before insertion.
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  const allowed = new Set([...localTasks, ...memories.flatMap(m => m.sourceTaskIds)]);
  const requested = taskIds ? new Set(taskIds) : allowed;
  requireValue([...requested].every(id => allowed.has(id)), '任务不在本会话授权附件范围', 'OUT_OF_SCOPE');
  const found = new Map<string, { entry: AttachmentCatalogEntry; artifact?: Artifact; ref: SourceRef }>();
  const add = (ref: SourceRef, taskId: string, messageId: string | undefined, files: Artifact[]) => {
    if (ref.kind !== 'artifact') return;
    const key = `${ref.id}:${ref.version}`, owner = { taskId, ...(messageId ? { messageId } : {}) };
    const old = found.get(key);
    if (old) { if (!old.entry.owners.some(o => o.taskId === taskId && o.messageId === messageId)) old.entry.owners.push(owner); return; }
    const artifact = files.find(a => a.id === ref.id && a.version === ref.version && a.status !== 'deleted');
    if (imagesOnly && !artifact?.mimeType.startsWith('image/')) return;
    const visual = artifact?.visualState === 'available' || artifact?.mimeType === 'application/pdf' || artifact?.mimeType.startsWith('image/');
    found.set(key, { ref, artifact, entry: { artifactId: ref.id, version: ref.version,
      name: artifact?.name, mimeType: artifact?.mimeType, size: artifact?.size, pages: artifact?.pages, ocrPages:artifact?.ocrPages,
      chunks: artifact?.chunks.length, status: artifact?.status ?? 'unavailable', error: artifact?.error?.slice(0, 300),
      visualState: artifact?.visualState, owners: [owner],
      readWith: { tool: imagesOnly ? 'workspace_view_artifact' : 'workspace_read_artifact', arguments: { artifactId: ref.id, version: ref.version } },
      ...(visual ? { viewWith: { tool: 'workspace_view_artifact' as const, arguments: { artifactId: ref.id, version: ref.version } } } : {}) } });
  };
  for (const m of state.messages.filter(m => localTasks.has(m.taskId) && requested.has(m.taskId) && m.workspaceId === workspace.id))
    if (sourceVisible(state, task, m.sourceRefs)) for (const ref of messageAttachments(m, state)) add(ref, m.taskId, m.id, state.artifacts.filter(a => a.workspaceId === workspace.id));
  for (const memory of memories) for (const m of memory.messages)
    if (requested.has(m.taskId) && memory.sourceTaskIds.includes(m.taskId) && !localTasks.has(m.taskId) && sourceVisible(state, task, m.sourceRefs))
      for (const ref of messageAttachments(m)) add(ref, m.taskId, m.id, memory.artifacts ?? []);
  // Compatibility for pre-message-binding tasks, never a grant to the live parent of a snapshot.
  for (const t of state.tasks.filter(t => localTasks.has(t.id) && requested.has(t.id))) {
    if (state.messages.find(m=>m.id===t.rootUserMessageId)?.attachments !== undefined) continue;
    for (const id of t.inputBindings.artifactIds) add({ kind: 'artifact', id, version: t.inputBindings.artifactVersions[id] }, t.id, undefined,
      state.artifacts.filter(a => a.workspaceId === workspace.id));
  }
  return [...found.values()];
}
export const residentAttachmentTasks = (state: AppSnapshot, task: Task) => residentSessionTaskIds(state, task.sessionId, task.id);
export function resolveAttachment(state: AppSnapshot, task: Task, id: unknown, version?: unknown) {
  requireValue(typeof id === 'string', '需要附件代指', 'INVALID_ARGUMENT');
  const candidates = authorizedAttachments(state, task).filter(a => a.ref.id === id && (version === undefined || a.ref.version === version));
  requireValue(candidates.length === 1 && candidates[0].artifact, '附件版本不可用或不在授权范围，请从任务附件清单选择版本', 'OUT_OF_SCOPE');
  return candidates[0].artifact!;
}
export function activeAttachmentProtections(state: AppSnapshot, task: Task, onlyReceipted = false) {
  if (task.status === 'completed') return [];
  return allRetainedCalls(state).filter(c => c.taskId === task.id && c.attachmentProtection?.ownerTaskId === task.id
    && c.status !== 'rejected' && (!onlyReceipted || isReceipted(state, c)));
}
export function mergeCatalogEntries(entries: AttachmentCatalogEntry[]): AttachmentCatalogEntry[] {
  const result = new Map<string, AttachmentCatalogEntry>();
  for (const value of entries) {
    const key = attachmentKey(value), old = result.get(key);
    if (!old) result.set(key, structuredClone(value));
    else old.owners = [...new Map([...old.owners, ...value.owners].map(o => [JSON.stringify(o), o])).values()];
  }
  return [...result.values()];
}
export function protectedAttachmentEntries(state: AppSnapshot, task: Task, onlyReceipted = true) {
  const authorized = new Map(authorizedAttachments(state, task).filter(r => r.artifact).map(r => [attachmentKey(r.entry),r.entry]));
  const rows=mergeCatalogEntries(activeAttachmentProtections(state, task, onlyReceipted).flatMap(c => c.attachmentProtection!.entries));
  if(isMinimalSession(state.sessions.find(s=>s.id===task.sessionId)))
    return rows.flatMap(row=>{const current=authorized.get(attachmentKey(row));return current?[{...current,owners:row.owners}]:[];});
  return rows.map(row => authorized.has(attachmentKey(row)) ? row : { ...row, status: 'unavailable' as const, error: '附件已删除或授权已撤销' });
}
/** Admission reserves irreducible context; ordinary history may be evicted to honor an accepted pin. */
export function assertProtectionCapacity(state: AppSnapshot, task: Task, protection: AttachmentProtection) {
  const rows = mergeCatalogEntries([...protectedAttachmentEntries(state, task, false), ...protection.entries]);
  const stage = state.workspaces.find(w => w.id === task.workspaceId)?.contextStage;
  const mandatory = stage?.entries.filter(e => !['history', 'references', 'progress'].includes(e.category)) ?? [];
  let tools=toolDefinitions({write:true,graph:true});
  if(stage?.lastRequest?.serialized)try{tools=JSON.parse(stage.lastRequest.serialized).tools??tools;}catch{/* Use the conservative complete registry. */}
  const required = requestTokens({...state.provider,...task.modelSelection},{messages:mandatory.flatMap(e=>e.wireMessages??e.messages),tools}) + 512;
  const limit = attachmentLimits(state), reserve = Math.min(limit.maxReadTokens, inputCapacity(state) * .17);
  requireValue(required + estimateTokens(JSON.stringify(rows)) + reserve <= inputCapacity(state),
    '受保护清单与必要上下文超过模型输入容量；已有保护保持，请缩小清单读取范围或提高容量后重试', 'ATTACHMENT_PROTECTION_CAPACITY');
}
/** Receipt and replacement region must be installed by the same transaction. */
export function validateAttachmentRelocations(state: AppSnapshot, task: Task, stage: ContextStage) {
  if (task.status === 'completed') return;
  const receipts = new Set(stage.retentionDraft?.receiptIds ?? []);
  const body = stage.entries.filter(e => e.id.startsWith('attachment-catalog:')).flatMap(e => {
    try { return JSON.parse(e.messages[0].content).attachmentCatalog.items as AttachmentCatalogEntry[]; } catch { return []; }
  });
  const rows = new Map(body.map(row=>[attachmentKey(row),row]));
  const expected = new Map(protectedAttachmentEntries(state,task,false).map(row=>[attachmentKey(row),row]));
  const complete = (row: AttachmentCatalogEntry) => {
    const actual=rows.get(attachmentKey(row)), wanted=expected.get(attachmentKey(row));
    if(!actual||!wanted)return false;
    const {owners:actualOwners,...actualBody}=actual, {owners:wantedOwners,...wantedBody}=wanted;
    return isDeepStrictEqual(actualBody,JSON.parse(JSON.stringify(wantedBody)))&&wantedOwners.every(owner=>actualOwners.some(o=>isDeepStrictEqual(o,owner)));
  };
  for (const call of activeAttachmentProtections(state, task)) if (receipts.has(originResultId(call)) || isReceipted(state, call))
    requireValue(stage.attachmentProtectionCalls?.includes(originResultId(call))
      && call.attachmentProtection!.entries.every(complete),
    '受保护附件清单尚未完整迁入附件区域，未提交回执化', 'PROTECTED_ATTACHMENT');
}
