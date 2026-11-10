import { attachmentTaskCatalog } from './attachmentReads';
import { createHash, randomUUID } from 'node:crypto';
import type { AppSnapshot, MemorySnapshot, SourceRef, Task, ToolCallRecord } from '../domain';
import type { FrozenRead } from '../contextState';
import { inheritedReadScope } from './inheritedReadScope';
import { visibleCallArguments, visibleCallResult, isReceipted, isWriteReceipted } from './readVisibility';
import { canReceiptTaskNotice, taskNoticeReceipt } from './taskNotices';
import { requireValue } from './errors';
import { resultPages } from './resultPaging';
import { directReadBudgets, readCapacityReceipt, frozenPageCapacityReceipt } from './directReadBudget';
import { readCoverage, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { rememberReadPage } from './readVisibility';
import { rememberPageOrigin } from './readPageEvidence';
import { GRAPH_READ_LIMITS, checkFrozenStorage, resourceLimit } from './graphReadLimits';
import { sourceChanges } from './sourceFreshness';
import { assertGraphReadHashes, rememberGraphReadHashes } from './graphReadDependencies';
import { estimateTokens } from '../tokens';
import { isDataRead } from './toolContextKinds';
import { allEvidence } from './historyRepresentations';
import { canvasKey } from './canvasReadEvidence';

type Row = Record<string, unknown>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (value: string) => { try { return JSON.parse(value) as unknown; } catch { return value; } };
export const TASK_ARCHIVE_TOOLS = new Set(['context_read_task', 'context_read_steps', 'context_restore_records']);
export interface TaskArchiveRecord {
  id: string; taskId: string; sourceSessionId: string; step?: number; stepId?: string;
  order: number; createdAt: string; version: string; kind: 'message' | 'tool_call' | 'progress' | 'notice' | 'note' | 'review';
  original: unknown; projected: unknown; sources: SourceRef[]; call?: ToolCallRecord;
}

/** Permission comes from local ownership or selected, unrevoked snapshot records, never prompt residency. */
export function taskArchiveRecords(input: AppSnapshot, task: Task): TaskArchiveRecord[] {
  const state = inheritedReadScope(input, task), workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const localTasks = new Map(state.tasks.filter(t => t.workspaceId === workspace.id).map(t => [t.id, t]));
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  const records = new Map<string, TaskArchiveRecord>();
  const stepOrdinal = (taskId: string, stepId: string | undefined, memory?: MemorySnapshot):number|undefined => {
    if(!stepId)return;
    return memory?.conversationOrder?.find(r=>r.taskId===taskId&&r.stepId===stepId&&r.stepOrdinal!==undefined)?.stepOrdinal
      ??memory?.completedStepGroups?.find(s=>s.taskId===taskId&&s.id===stepId)?.ordinal
      ??state.steps.find(s=>s.taskId===taskId&&s.id===stepId&&s.purpose==='agent')?.ordinal;
  };
  const add = (r: Omit<TaskArchiveRecord, 'version'> & { version?: string }) => {
    if (!records.has(r.id)) records.set(r.id, { ...r, version: r.version ?? digest(r.original) });
  };
  const load = (memory?: MemorySnapshot) => {
    const local = !memory;
    const sourceSession = (taskId: string) => state.tasks.find(t => t.id === taskId)?.sessionId ?? memory!.sourceSessionId;
    const allowed = (taskId: string) => local ? localTasks.has(taskId) : memory!.sourceTaskIds.includes(taskId);
    for (const m of local ? state.messages : memory!.messages) {
      if (!allowed(m.taskId) || m.status === 'streaming' || m.presentationCallId) continue;
      const order = m.sequence ?? Date.parse(m.createdAt);
      const original = { role: m.role, content: m.text, selectedRefs: m.targetRefs, sources: m.sourceRefs, attachments: m.attachments,
        selectedProgress: m.selectedProgress };
      const rootId=state.tasks.find(t=>t.id===m.taskId)?.rootUserMessageId??memory?.sourceTaskStates?.find(t=>t.id===m.taskId)?.rootUserMessageId;
      add({ id: m.id, taskId: m.taskId, sourceSessionId: sourceSession(m.taskId),
        step: m.id===rootId?0:stepOrdinal(m.taskId, m.stepId, memory), stepId: m.stepId,
        order, createdAt: m.createdAt, kind: 'message', original, projected: original,
        sources: [{ kind: 'message', id: m.id, version: m.version }] });
    }
    for (const c of local ? state.toolCalls : memory!.toolCalls ?? []) {
      if (!allowed(c.taskId) || c.result === undefined || !['completed', 'rejected'].includes(c.status)) continue;
      const order = c.sequence ?? Date.parse(c.createdAt), original = { function: c.name, arguments: parse(c.arguments), result: parse(c.result), operationId: c.operationId };
      const receipt = isReceipted(state, c) || isWriteReceipted(state, c);
      add({ id: c.id, taskId: c.taskId, sourceSessionId: sourceSession(c.taskId), step: stepOrdinal(c.taskId, c.stepId, memory), stepId: c.stepId,
        order, createdAt: c.createdAt, kind: 'tool_call', original,
        projected: { ...original, arguments: parse(visibleCallArguments(state, c)), result: parse(visibleCallResult(state, c)!),
          ...(receipt ? { bodyOmitted: true, readWith: { tool: 'context_restore_records', arguments: { recordIds: [c.id] } } } : {}) },
        sources: c.resultSources ?? [], call: c });
    }
    for (const p of local ? workspace.progressEvents ?? [] : memory!.progressEvents ?? []) if (allowed(p.taskId)) {
      const original = { progress: p.text, version: p.version };
      const producer=(local?state.toolCalls:memory!.toolCalls??[]).find(c=>c.taskId===p.taskId&&c.name==='workspace_update_handoff'&&p.id===`progress:${c.operationId}`);
      add({ id: p.id, taskId: p.taskId, sourceSessionId: sourceSession(p.taskId), step: stepOrdinal(p.taskId, producer?.stepId, memory),stepId:producer?.stepId,
        order: p.sequence, createdAt: p.createdAt, kind: 'progress', original, projected: original, sources: p.sourceRefs });
    }
    const notices = local ? workspace.taskNotices ?? [] : (memory as MemorySnapshot & { taskNotices?: typeof workspace.taskNotices })?.taskNotices ?? [];
    for (const n of notices) if (n.taskId && allowed(n.taskId)) {
      const receipted = canReceiptTaskNotice(n) && workspace.sessionContext?.receiptedNoticeIds?.includes(n.id);
      add({ id: n.id, taskId: n.taskId, sourceSessionId: sourceSession(n.taskId),
        order: n.sequence, createdAt: n.createdAt, kind: 'notice', original: parse(n.content), projected: receipted ? taskNoticeReceipt(n) : parse(n.content),
        version: n.version, sources: n.sourceRefs });
    }
  };
  load(); memories.forEach(load);
  const authorizedTasks = new Set([...localTasks.keys(), ...memories.flatMap(m => m.sourceTaskIds)]);
  // The prompt and the archive share immutable record versions, even when their
  // display formats differ. Never derive a version from a receipt projection.
  for (const evidence of allEvidence(state, task)) {
    const existing = records.get(evidence.id);
    if (existing) { existing.version = evidence.version; continue; }
    if (!authorizedTasks.has(evidence.taskId)) continue;
    const original = parse(evidence.text), kind = (original as Row)?.historical_note ? 'note' : 'review';
    const memory = memories.find(m => m.sourceTaskIds.includes(evidence.taskId));
    add({ id: evidence.id, taskId: evidence.taskId,
      sourceSessionId: localTasks.get(evidence.taskId)?.sessionId ?? memory!.sourceSessionId,
      step: stepOrdinal(evidence.taskId, evidence.stepId, memory), stepId: evidence.stepId,
      order: evidence.order, createdAt: evidence.createdAt, version: evidence.version,
      kind, original, projected: parse(evidence.projectionText ?? evidence.text), sources: evidence.sources });
  }
  return [...records.values()].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function freshness(state: AppSnapshot, task: Task, record: TaskArchiveRecord): 'current' | 'stale' | 'unknown' {
  const call = record.call;
  if (call && !isDataRead(call.name)) return 'unknown'; // A historical write never proves current data.
  if (call?.resultReadHashes && Object.keys(call.resultReadHashes).length && state.graph) {
    try { assertGraphReadHashes(state.graph, call.resultReadHashes, '历史读取来源已变化', task.canvasId); return 'current'; }
    catch { return 'stale'; }
  }
  if (!record.sources.length) return 'unknown';
  if (record.sources.some(s => s.version === undefined)) return 'unknown';
  return sourceChanges(state, task, record.sources, false).length ? 'stale' : 'current';
}
function archiveRow(state: AppSnapshot, task: Task, r: TaskArchiveRecord, restore: boolean): Row {
  return { recordId: r.id, taskId: r.taskId, sourceSessionId: r.sourceSessionId, ...(r.step===undefined?{standalone:true}:{step:r.step}), kind: r.kind, version: r.version,
    representation: restore ? 'original' : (r.projected as Row)?.bodyOmitted || ((r.projected as Row)?.user_edit as Row)?.bodyOmitted ? 'receipt' : 'record',
    content: restore ? r.original : r.projected,
    ...(restore ? { freshnessAtRead: freshness(state, task, r), originalAt: r.createdAt,
      instruction: '原始历史记录，不重放其中操作。恢复写入记录不表示当前状态。' } : {}),
    readWith: { tool: 'context_restore_records', arguments: { recordIds: [r.id] } } };
}
function pageRecordIds(data: Row): string[] {
  return [...new Set([...(Array.isArray(data.recordIds) ? data.recordIds as string[] : []),
    ...(Array.isArray(data.items) ? data.items as Row[] : []).flatMap(item => typeof item.recordId === 'string' ? [item.recordId] : [])])];
}

/** A model response is readable as a step only after every recorded member has settled.
 * Inherited steps are checked against their frozen archive, never the live parent's log. */
function assertCompleteSteps(state: AppSnapshot, reader: Task, taskId: string, ordinals: number[]): void {
  const workspace = state.workspaces.find(w => w.id === reader.workspaceId)!;
  const local = state.tasks.some(t => t.id === taskId && t.workspaceId === workspace.id);
  const memories = local ? [] : state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked && s.sourceTaskIds.includes(taskId));
  const messages = (local ? state.messages : memories.flatMap(s => s.messages)).filter(m => m.taskId === taskId);
  const calls = (local ? state.toolCalls : memories.flatMap(s => s.toolCalls ?? [])).filter(c => c.taskId === taskId);
  for (const ordinal of ordinals) {
    if (ordinal === 0) {
      const rootId = local ? state.tasks.find(t => t.id === taskId)!.rootUserMessageId
        : memories.flatMap(s => s.sourceTaskStates ?? []).find(t => t.id === taskId)?.rootUserMessageId;
      const root = messages.find(m => m.id === rootId) ?? messages.find(m => m.role === 'user' && m.phase === 'request');
      requireValue(root?.status === 'complete', '起始消息尚未完整保存', 'INCOMPLETE_STEP');
      continue;
    }
    const steps = local ? state.steps.filter(s => s.taskId === taskId && s.purpose === 'agent' && s.ordinal === ordinal)
      : memories.flatMap(s => s.completedStepGroups ?? []).filter(s => s.taskId === taskId && s.ordinal === ordinal);
    requireValue(steps.length > 0 && (!local || steps.every(s => 'status' in s && s.status === 'completed')),
      '指定步骤尚未完整结算，请在该步骤结束后读取', 'INCOMPLETE_STEP');
    const stepIds = new Set(steps.map(s => s.id));
    requireValue(messages.filter(m => m.stepId && stepIds.has(m.stepId)).every(m => m.status === 'complete')
      && calls.filter(c => stepIds.has(c.stepId)).every(c => ['completed', 'rejected'].includes(c.status) && c.result !== undefined),
      '指定步骤的回复或调用尚未完整结算，请在整组调用结束后读取', 'INCOMPLETE_STEP');
  }
}

/** Fragment identities are host metadata. Their JSON text remains lossless and opaque. */
function identifyFragments(pages: Row[], rows: Row[], restored: boolean): void {
  for (const page of pages) {
    if (page.resultFragment) Object.assign(page, { kind: 'task_archive', restored, recordIds: rows.map(r => r.recordId) });
    for (const item of Array.isArray(page.items) ? page.items as Row[] : []) {
      const fragment = item.resultFragment as { path?: unknown[] } | undefined;
      if (fragment?.path?.[0] === 'items' && typeof fragment.path[1] === 'number') {
        const original = rows[fragment.path[1]];
        Object.assign(item, { recordId: original.recordId, version: original.version, representation: restored ? 'original_fragment' : 'record_fragment' });
      }
    }
  }
}

/** Called by the ordinary context dispatcher; frozen pages retain a record-level authorization fence. */
export function directTaskArchiveRead(state: AppSnapshot, task: Task, call: ToolCallRecord, args: Row): Row {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const available = taskArchiveRecords(state, task), byId = new Map(available.map(r => [r.id, r]));
  let read: FrozenRead, page = 1;
  if (call.name === 'context_read_pages') {
    const found = workspace.frozenReads?.find(r => r.id === args.pointerId && r.kind === 'task_archive');
    requireValue(found && found.expiresAt > Date.now(), '任务档案分页已过期，请重新读取记录', 'CURSOR_EXPIRED');
    read = found;
    requireValue(Object.entries(read.targetVersions ?? {}).every(([id, v]) => byId.get(id)?.version === v), '任务档案来源已撤销或改变', 'OUT_OF_SCOPE');
    page = Number(args.page); requireValue(Number.isSafeInteger(page) && page >= 1 && page <= read.pages.length, '页码无效', 'INVALID_ARGUMENT');
  } else {
    let selected: TaskArchiveRecord[];
    if (call.name === 'context_restore_records') {
      requireValue(Array.isArray(args.recordIds) && args.recordIds.length > 0 && args.recordIds.length <= 100, '需要1至100条记录代指', 'INVALID_ARGUMENT');
      const ids = [...new Set(args.recordIds as string[])];
      requireValue(ids.every(id => byId.has(id)), '记录不存在或不在本会话授权档案范围', 'OUT_OF_SCOPE');
      selected = ids.map(id => byId.get(id)!);
    } else {
      requireValue(typeof args.taskId === 'string', '需要任务代指', 'INVALID_ARGUMENT');
      selected = available.filter(r => r.taskId === args.taskId);
      requireValue(selected.length > 0, '任务不在本会话授权档案范围', 'OUT_OF_SCOPE');
      if (call.name === 'context_read_steps') {
        requireValue(Array.isArray(args.steps) && args.steps.length > 0 && args.steps.length <= 100
          && args.steps.every(n => Number.isSafeInteger(n) && n >= 0), 'steps需要0起的步骤编号列表', 'INVALID_ARGUMENT');
        requireValue(args.steps.every(n => selected.some(r => r.step === n)), '请求步骤不存在或未携带', 'OUT_OF_SCOPE');
        assertCompleteSteps(state, task, args.taskId, args.steps as number[]);
        selected = selected.filter(r => r.step!==undefined&&(args.steps as number[]).includes(r.step));
      }
    }
    const restore = call.name === 'context_restore_records', limits = directReadBudgets(state, task, call, args.budget);
    const budget = limits.availableTokens;
    if (budget < 512) return readCapacityReceipt(call, args, budget, 512, { limits, minimumOnly: true });
    const pointerId = `read:${randomUUID()}`, coverage = readCoverage('history');
    resourceLimit(selected.length <= GRAPH_READ_LIMITS.objects, 'objects');
    const rows = selected.map(r => archiveRow(state, task, r, restore));
    resourceLimit(Buffer.byteLength(JSON.stringify(rows)) <= GRAPH_READ_LIMITS.sourceBytes, 'sourceBytes');
    const currentFreshness = (data: Row) => restore ? pageRecordIds(data).map(recordId => ({ recordId, freshness: 'unknown' })) : [];
    const frame = (data: Row) => ({ status: 'ok', pointerId, page: 99999999, totalPages: 99999999, hasMorePages: true, isLastPage: false,
      data, recordFreshness: currentFreshness(data), coverage: pageCoverage(coverage, 2), nextCursor: { pointerId, page: 99999999 } });
    let pageBudget = Math.min(limits.pageBudget, budget - 256), pages: Row[] = [];
    while (pageBudget >= 128) {
      pages = resultPages({ kind: 'task_archive', restored: restore, items: rows }, pageBudget);
      identifyFragments(pages, rows, restore);
      if(call.name==='context_read_task')pages[0]={...pages[0],attachments:attachmentTaskCatalog(state,task,String(args.taskId),Math.min(768,Math.floor(budget/4)))};
      if (pages.every(p => estimateTokens(JSON.stringify(frame(p))) <= budget)) break;
      pageBudget = Math.floor(pageBudget * .75);
    }
    if (pageBudget < 128) return readCapacityReceipt(call, args, budget, undefined, { limits });
    read = { id: pointerId, taskId: task.id, callId: call.id, canvasId: task.canvasId, kind: 'task_archive', pages,
      pageBudget: budget, readFormatVersion: READ_FORMAT_VERSION, coverage, pageSources: pages.map(() => []), sources: [],
      targetVersions: Object.fromEntries(selected.map(r => [r.id, r.version])),
      observation: { id: `observation:${randomUUID()}`, taskId: task.id, canvasId: task.canvasId, refs: [], sources: [], directories: {}, paths: {}, completeDirectories: [] },
      createdAt: new Date().toISOString(), expiresAt: Date.now() + GRAPH_READ_LIMITS.ttlMs };
    checkFrozenStorage(workspace.frozenReads ?? [], [read]);
    (workspace.frozenReads ??= []).push(read);
  }
  const data = structuredClone(read.pages[page - 1]);
  // Freshness belongs to the delivery envelope; the frozen payload stays byte-identical.
  const restoredIds = data.restored === true ? pageRecordIds(data) : [];
  const recordFreshness = Object.fromEntries(restoredIds.map(id => [id, freshness(state, task, byId.get(id)!)]));
  const result: Row = { status: 'ok', pointerId: read.id, page, totalPages: read.pages.length, hasMorePages: page < read.pages.length,
    isLastPage: page === read.pages.length, data, ...(Object.keys(recordFreshness).length ? {
      recordFreshness: Object.entries(recordFreshness).map(([recordId, current]) => ({ recordId, freshness: current })) } : {}), coverage: pageCoverage(read.coverage!, read.pages.length),
    ...(page < read.pages.length ? { nextCursor: { pointerId: read.id, page: page + 1 } } : {}) };
  const limits = directReadBudgets(state, task, call, args.budget ?? read.pageBudget), needed = estimateTokens(JSON.stringify(result));
  if (needed > limits.maximumTokens) return frozenPageCapacityReceipt(call, args, limits.availableTokens, needed, limits.maximumTokens);
  if (needed > limits.availableTokens) return readCapacityReceipt(call, args, limits.availableTokens, needed, { limits });
  const deliveredSources: SourceRef[] = [];
  for (const recordId of restoredIds) {
    const record = byId.get(recordId)!;
    if (record.call && isDataRead(record.call.name)) {
      const pages = read.pages.flatMap((data, index) => pageRecordIds(data).includes(recordId) ? [index + 1] : []);
      if (pages.length === 1) deliveredSources.push(...record.sources);
      const observations = [...new Map([...(record.call.canvasOrigins ?? []).map(o => o.observation),
        ...state.workspaces.flatMap(w => w.observations ?? []).filter(o => o.callId === record.call!.id)]
        .filter(o => !o.archiveProof || o.archiveProof.pages.length === 1).map(o => [o.id, o])).values()];
      for (const original of observations) {
        const restored = { ...structuredClone(original), id: `observation:${randomUUID()}`, callId: call.id, taskId: task.id,
          historical: recordFreshness[recordId] !== 'current',
          archiveProof: { pointerId: read.id, recordId, version: record.version, pages } };
        (workspace.observations ??= []).push(restored);
        if (restored.readHashes && pages.length === 1) rememberGraphReadHashes(task, restored.readHashes, restored.historical);
        const origin = record.call.canvasOrigins?.find(o => o.observation.id === original.id)
          ?? record.call.canvasOrigins?.find(o => o.pointerId === original.canvasPage?.pointerId && o.page === original.canvasPage.page);
        if (origin) (call.canvasOrigins ??= []).push({ pointerId: read.id, page,
          request: structuredClone(origin.request), observation: structuredClone(restored), payloadHash: canvasKey(data) });
      }
    }
  }
  call.resultSources = [...new Map(deliveredSources.map(s => [JSON.stringify(s), s])).values()];
  rememberReadPage(call, read.id, page); rememberPageOrigin(call, read, page);
  return result;
}
