import type { AppSnapshot, Workspace, ProgressSelection } from './domain';
import type { ContextStage, Coverage } from './contextState';
export type { OrderedTaskSelection } from './domain';

export interface SettledTaskRange {
  taskId: string; sourceSessionId: string;
  records: Array<Omit<Coverage, 'taskId'> & { representation: 'body' | 'receipt' | 'summary'; summaryId?: string; stepId?: string; step?: number }>;
}

/** Archive access, prompt residency and the last assembled UI projection are separate facts. */
export interface SessionContextState {
  version: 3;
  taskOrder: string[];
  residentTaskIds: string[];
  excludedTaskIds: string[];
  historicalSummaryCounts: Record<string, number>;
  countedSummaryRounds?: Record<string, string[]>;
  receiptedNoticeIds?: string[];
  /** Historical storage name; refreshed with every committed prompt assembly. */
  settled?: { revision: number; taskIds: string[]; at: string; taskRanges?: SettledTaskRange[] };
}

export function accessibleSessionTaskIds(state: AppSnapshot, sessionId: string): string[] {
  const workspace = state.workspaces.find(w => w.sessionId === sessionId);
  if (!workspace) return [];
  return [...new Set([
    ...workspace.snapshotIds.flatMap(id => state.snapshots.find(s => s.id === id && !s.revoked)?.sourceTaskIds ?? []),
    ...state.tasks.filter(t => t.workspaceId === workspace.id).map(t => t.id),
  ])];
}

export function ensureSessionContext(state: AppSnapshot, workspace: Workspace): SessionContextState {
  if (!workspace.sessionContext) {
    const taskOrder = accessibleSessionTaskIds(state, workspace.sessionId);
    workspace.sessionContext = { version: 3, taskOrder, residentTaskIds: [...taskOrder], excludedTaskIds: [], historicalSummaryCounts: {} };
  }
  return workspace.sessionContext;
}

export function residentSessionTaskIds(state: AppSnapshot, sessionId: string, currentTaskId?: string): string[] {
  const workspace = state.workspaces.find(w => w.sessionId === sessionId);
  if (!workspace) return [];
  const allowed = new Set(accessibleSessionTaskIds(state, sessionId));
  const context = workspace.sessionContext;
  const resident = (context?.residentTaskIds ?? [...allowed]).filter(id => allowed.has(id) && !context?.excludedTaskIds.includes(id));
  if (currentTaskId && allowed.has(currentTaskId) && !resident.includes(currentTaskId)) resident.push(currentTaskId);
  return resident;
}

export function registerSessionTask(state: AppSnapshot, sessionId: string, taskId: string): void {
  const workspace = state.workspaces.find(w => w.sessionId === sessionId);
  if (!workspace) throw new Error('会话不存在');
  const context = ensureSessionContext(state, workspace);
  if (!context.taskOrder.includes(taskId)) context.taskOrder.push(taskId);
  if (!context.residentTaskIds.includes(taskId)) context.residentTaskIds.push(taskId);
  context.excludedTaskIds = context.excludedTaskIds.filter(id => id !== taskId);
}

/** Publish exact prompt ranges at creation, request submission and terminal assembly.
 * Draft capacity probes do not publish until the chosen assembly is committed. */
export function settleSessionContext(state: AppSnapshot, sessionId: string, projection?: ContextStage): void {
  const workspace = state.workspaces.find(w => w.sessionId === sessionId);
  if (!workspace) return;
  const context = ensureSessionContext(state, workspace);
  const taskIds = residentSessionTaskIds(state, sessionId), stage = projection ?? workspace.contextStage ?? workspace.promptFork?.stage;
  const snapshotIds = new Set(workspace.snapshotIds);
  const memories = state.snapshots.filter(s => snapshotIds.has(s.id) && !s.revoked);
  const localTasks = new Set(state.tasks.filter(t => t.workspaceId === workspace.id).map(t => t.id));
  const records = new Map([...memories.flatMap(s => [...s.messages, ...s.toolCalls ?? []]),
    ...state.messages.filter(r => localTasks.has(r.taskId)), ...state.toolCalls.filter(r => localTasks.has(r.taskId))].map(r => [r.id, r]));
  const summaries = new Map<string, { id: string }>();
  for (const summary of [...workspace.summaries ?? [], ...memories.flatMap(s => s.summaries ?? [])]) {
    const key = `summary:${summary.id}:${summary.version}`;
    if (!summaries.has(key)) summaries.set(key, summary);
  }
  const localSteps = new Map(state.steps.map(step => [step.id, step]));
  const inheritedSteps = new Map<string, Map<string, number>>(), sourceSessions = new Map<string, string>();
  for (const memory of memories) {
    for (const taskId of memory.sourceTaskIds) if (!sourceSessions.has(taskId)) sourceSessions.set(taskId, memory.sourceSessionId);
    for (const step of memory.completedStepGroups ?? []) {
      const steps = inheritedSteps.get(step.taskId) ?? new Map<string, number>();
      if (!steps.has(step.id) && step.ordinal !== undefined) steps.set(step.id, step.ordinal);
      inheritedSteps.set(step.taskId, steps);
    }
  }
  for (const memory of memories) for (const record of memory.conversationOrder ?? []) if (record.stepId && record.stepOrdinal !== undefined) {
    const steps = inheritedSteps.get(record.taskId) ?? new Map<string, number>();
    if (!steps.has(record.stepId)) steps.set(record.stepId, record.stepOrdinal);
    inheritedSteps.set(record.taskId, steps);
  }
  const ledger = workspace.readRetention ?? state.contextRetention;
  const receipted = new Set([...Object.keys(ledger?.receipts ?? {}), ...Object.keys(ledger?.writeReceipts ?? {}),
    ...stage?.retentionDraft?.receiptIds ?? [], ...stage?.retentionDraft?.writeReceiptIds ?? [], ...stage?.receiptedNoticeIds ?? []]);
  const taskRanges: SettledTaskRange[] = taskIds.map(taskId => ({ taskId,
    sourceSessionId: localTasks.has(taskId) ? sessionId : sourceSessions.get(taskId) ?? sessionId,
    records: [] }));
  const byTask = new Map(taskRanges.map(r => [r.taskId, r])), seen = new Set<string>();
  for (const entry of stage?.entries ?? []) {
    const summary = entry.representation === 'summary' ? summaries.get(entry.id) : undefined;
    for (const coverage of entry.coverage) {
      const range = byTask.get(coverage.taskId); if (!range) continue;
      const record = records.get(coverage.recordId), stepId = record?.stepId;
      const localStep = stepId ? localSteps.get(stepId) : undefined;
      const step = stepId ? localTasks.has(coverage.taskId)
        ? localStep?.taskId === coverage.taskId ? localStep.ordinal : undefined
        : inheritedSteps.get(coverage.taskId)?.get(stepId) : undefined;
      const representation = entry.representation === 'summary' ? 'summary'
        : receipted.has(coverage.recordId) || entry.receiptCallIds?.includes(coverage.recordId) ? 'receipt'
        : entry.coverage.length === 1 && entry.representation === 'receipt' ? 'receipt' : 'body';
      const { taskId: _taskId, ...span } = coverage;
      const value = { ...span, representation, ...(summary ? { summaryId: summary.id } : {}), ...(stepId ? { stepId, step } : {}) } as SettledTaskRange['records'][number];
      const key = JSON.stringify([coverage.taskId, value]); if (seen.has(key)) continue;
      seen.add(key); range.records.push(value);
    }
  }
  context.settled = { revision: (context.settled?.revision ?? 0) + 1, taskIds, at: new Date().toISOString(), taskRanges };
}

export interface SessionProgressRecord {
  id: string; taskId: string; stepId?: string; complete: boolean; order:number;
  kind: 'message' | 'tool_call' | 'progress' | 'note' | 'notice'; content: unknown;
}
export interface SelectedProgressTask {
  taskId: string;
  records: Array<{ recordId: string; kind: SessionProgressRecord['kind']; stepId?: string; content: unknown }>;
}

/** Readable task records come from this session's live log or its immutable selected snapshots. */
export function sessionProgressRecords(state: AppSnapshot, sessionId: string): SessionProgressRecord[] {
  const workspace = state.workspaces.find(w => w.sessionId === sessionId);
  if (!workspace) return [];
  const local = new Set(state.tasks.filter(t => t.workspaceId === workspace.id).map(t => t.id));
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  const parse = (value: string) => { try { return JSON.parse(value) as unknown; } catch { return value; } };
  const records: SessionProgressRecord[] = [];
  for (const message of [...state.messages.filter(m => local.has(m.taskId)), ...memories.flatMap(m => m.messages)]) {
    if (message.phase === 'status') continue;
    records.push({id:message.id,taskId:message.taskId,stepId:message.stepId,complete:message.status==='complete',order:message.sequence??Date.parse(message.createdAt),kind:'message',
      content:{role:message.role,text:message.text,version:message.version,createdAt:message.createdAt,targetRefs:message.targetRefs,sourceRefs:message.sourceRefs,attachments:message.attachments,selectedProgress:message.selectedProgress}});
  }
  for (const call of [...state.toolCalls.filter(c => local.has(c.taskId)), ...memories.flatMap(m => m.toolCalls ?? [])])
    records.push({id:call.id,taskId:call.taskId,stepId:call.stepId,complete:['completed','rejected'].includes(call.status)&&call.result!==undefined,order:call.sequence??Date.parse(call.createdAt),kind:'tool_call',
      content:{function:call.name,arguments:parse(call.arguments),result:call.result===undefined?undefined:parse(call.result),operationId:call.operationId}});
  for (const progress of [...workspace.progressEvents ?? [], ...memories.flatMap(m => m.progressEvents ?? [])])
    records.push({id:progress.id,taskId:progress.taskId,complete:true,order:progress.sequence,kind:'progress',content:{progress:progress.text,version:progress.version}});
  for (const notice of [...workspace.taskNotices ?? [], ...memories.flatMap(m => m.taskNotices ?? [])]) if(notice.taskId)
    records.push({id:notice.id,taskId:notice.taskId,complete:true,order:notice.sequence,kind:'notice',content:parse(notice.content)});
  for (const memory of memories) for(const note of memory.notes){
    const taskId=note.taskId??note.originTaskId??memory.sourceTaskIds.at(-1);
    if(taskId&&memory.sourceTaskIds.includes(taskId)) records.push({id:note.id,taskId,complete:true,order:Date.parse(note.updatedAt),kind:'note',content:{note:note.text,version:note.version,type:note.type}});
  }
  const allowed=new Set(accessibleSessionTaskIds(state,sessionId));
  return [...new Map(records.filter(r=>allowed.has(r.taskId)).map(r=>[r.id,r])).values()].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}

/** A selected model record carries its whole settled step; independent records stay whole. */
export function normalizeProgressSelection(state: AppSnapshot, sessionId: string, selections: ProgressSelection[]): ProgressSelection[] {
  if (!state.workspaces.some(w=>w.sessionId===sessionId) || !Array.isArray(selections) || selections.length > 100) throw new Error('任务进度选区无效');
  const allowed = new Set(accessibleSessionTaskIds(state, sessionId)), records=sessionProgressRecords(state,sessionId);
  const groups = new Map<string, { steps: Set<string>; records: Set<string> }>();
  for (const selection of selections) {
    if (!selection || !allowed.has(selection.taskId)) throw new Error('所选任务不在当前会话可访问范围');
    if (![selection.stepIds ?? [], selection.recordIds ?? []].every(ids => Array.isArray(ids) && ids.length <= 1000 && ids.every(id => typeof id === 'string'))) throw new Error('任务步骤或记录选区无效');
    const taskRecords=records.filter(r=>r.taskId===selection.taskId);
    const group = groups.get(selection.taskId) ?? { steps: new Set<string>(), records: new Set<string>() };
    for (const id of selection.recordIds ?? []) {
      const record = taskRecords.find(r => r.id === id && r.complete);
      if (!record) throw new Error('选中的任务记录不存在或尚未完成');
      group.records.add(id); if (record.stepId) group.steps.add(record.stepId);
    }
    for (const id of selection.stepIds ?? []) {
      if (!taskRecords.some(r => r.stepId === id)) throw new Error('选中的任务步骤不存在或尚未完成');
      group.steps.add(id);
    }
    for (const stepId of group.steps) {
      const localTask=state.tasks.find(t=>t.id===selection.taskId&&t.sessionId===sessionId);
      if(localTask&&state.steps.some(s=>s.id===stepId&&s.taskId===localTask.id&&s.status!=='completed')) throw new Error('所选步骤尚未结算，不能截取部分工具组');
      if (taskRecords.some(r=>r.stepId===stepId&&!r.complete)) throw new Error('所选步骤尚未结算，不能截取部分工具组');
      taskRecords.filter(r=>r.stepId===stepId).forEach(r=>group.records.add(r.id));
    }
    if (!group.records.size) throw new Error('请选择要携带的任务记录');
    groups.set(selection.taskId, group);
  }
  return [...groups].map(([taskId, group]) => ({ taskId, stepIds: [...group.steps], recordIds: [...group.records] }));
}

/** Freeze at send time. This payload is data, never a set of calls to execute again. */
export function selectedProgressPayload(state:AppSnapshot,sessionId:string,selections:ProgressSelection[]):SelectedProgressTask[] {
  const normalized=normalizeProgressSelection(state,sessionId,selections),records=sessionProgressRecords(state,sessionId);
  return structuredClone(normalized.map(selection=>({taskId:selection.taskId,records:records.filter(r=>r.taskId===selection.taskId&&selection.recordIds!.includes(r.id))
    .map(record=>({recordId:record.id,kind:record.kind,...(record.stepId?{stepId:record.stepId}:{}),content:record.content}))})));
}
