import { modeOf } from '@/v3/design';
import { TEMPORARY_LIMIT, hasUnfinishedTask, touchTemporary } from '../temporaryModes';
import type { TemporaryMode } from '../domain';
import { installPromptFork } from './promptFork';
import { sessionGraphReferences } from './graphReferences';
import { ensureSessionContext, residentSessionTaskIds, type OrderedTaskSelection } from '../sessionContext';
import { assembleCreatedSession, type SessionCreationAssembler } from './sessionCreationAssembler';
import { copySelectedSummaries, snapshotEvidence } from './historyRepresentations';
import type { AppSnapshot, Artifact, ChangeSet, ChatMessage, MemorySnapshot, Note, ToolCallRecord,
  Session, SessionMode, SourceRef, Task, Workspace } from '../domain';
import { SESSION_TITLE_LIMIT, TERMINAL_TASK_STATUSES } from '../domain';
import { getCanvasPaths } from '@/v3/paths';
import { requireValue, text } from './errors';
import { Repository, hash, id, now } from './repository';
import { messageAttachments, withNoteProvenance, sectionBudgets } from '../memory';
import { estimateTokens } from '../tokens';
import { historyTurns, isCompletedHistoryTask } from '../history';
import { writableNotebook, assertNotebookCapacity, editNotebookContent, deleteNotebookEntry } from './notebooks';
import { notebookWorkspace } from '../notebook';
import { queueNotebookNotices } from './taskNotices';

function initializeInheritance(state: AppSnapshot, session: Session, selection: OrderedTaskSelection[]): void {
  const workspace = state.workspaces.find(w => w.id === session.workspaceId)!;
  const context = ensureSessionContext(state, workspace);
  context.taskOrder = selection.map(t => t.taskId);
  context.residentTaskIds = [...context.taskOrder];
  context.excludedTaskIds = [];
  for (const selected of selection) {
    const source = state.workspaces.find(w => w.sessionId === selected.sessionId)?.sessionContext;
    context.historicalSummaryCounts[selected.taskId] = source?.historicalSummaryCounts[selected.taskId] ?? 0;
    (context.countedSummaryRounds ??= {})[selected.taskId] = [...source?.countedSummaryRounds?.[selected.taskId] ?? []];
    context.receiptedNoticeIds = [...new Set([...context.receiptedNoticeIds ?? [], ...source?.receiptedNoticeIds ?? []])];
  }
  const sources = [...new Set(selection.map(t => t.sessionId))];
  if (session.mode !== 'temporary' && sources.length === 1) {
    const source = state.workspaces.find(w => w.sessionId === sources[0])!;
    workspace.workNotes = copy(source.workNotes); workspace.pinnedNotes = copy(source.pinnedNotes);
  }
}

export interface ProvenancePath { source: SourceRef; viaSessionId: string; viaSnapshotIds: string[] }
export interface FrozenTaskState { id: string; status: Task['status']; instructionRevision: number; rootUserMessageId?:string }
export interface SnapshotMaterial extends MemorySnapshot {
  sourceTaskStates: FrozenTaskState[];
  provenancePaths: ProvenancePath[];
}
interface InheritanceMaterial {
  orderedTasks: OrderedTaskSelection[];
  messages: ChatMessage[];
  operations: ChangeSet[];
  notes: Note[];
  artifacts: Artifact[]; toolCalls: ToolCallRecord[];
  sourceRefs: SourceRef[];
  sourceTaskStates: FrozenTaskState[];
  provenancePaths: ProvenancePath[];
  parents: SnapshotMaterial[];
  contentHash: string;
  possibleConflicts: Array<{ sourceId: string; reason: string }>;
}
export interface InheritanceOutcome {
  residentTaskIds: string[];
  excludedTaskIds: string[];
  historicalSummaryCounts: Record<string, number>;
  contentFingerprint: string;
  assemblyFingerprint: string;
  promptReuse: { eligible: boolean; reused: boolean; fingerprint?: string; reason?: string };
}
export interface InheritancePreview extends InheritanceMaterial, InheritanceOutcome {}
export interface CreateSessionResult extends Session { inheritance: InheritanceOutcome }
export interface CreateSessionInput { canvasId: string; mode?: SessionMode; title?: string; orderedTasks?: OrderedTaskSelection[]; expectedPreviewHash?: string; sourceSessionId?: string; temporaryMode?: TemporaryMode; expectedForkFingerprint?: string }
export interface UpdateSessionInput { sessionId: string; title?: string; lifecycle?: Session['lifecycle'] }
export interface SaveNoteInput { sessionId: string; kind: 'pinned' | 'work'; text: string; sourceRefs?: SourceRef[];
  noteId?: string; expectedVersion?: number; type?: Note['type']; lifecycle?: Note['lifecycle']; taskId?: string; clientRequestId?: string }

/** Fixed requirements are live user instructions, including while a response is in flight. */
function invalidateRequirementResponses(state: AppSnapshot, workspace: Workspace): void {
  const readers = new Set(state.sessions.filter(s => notebookWorkspace(state, s)?.id === workspace.id).map(s => s.workspaceId));
  for (const task of state.tasks.filter(t => readers.has(t.workspaceId) && !TERMINAL_TASK_STATUSES.includes(t.status))) {
    task.instructionRevision++; task.updatedAt = now();
  }
}

const sourceKey = (source: SourceRef) => JSON.stringify([source.kind, source.id, source.version, source.start ?? null, source.end ?? null, source.page ?? null, source.tracking ?? null]);
const uniqueSources = (sources: SourceRef[]) => [...new Map(sources.map(source => [sourceKey(source), {
  kind: source.kind, id: source.id, version: source.version, ...(source.tracking ? { tracking: source.tracking } : {}),
  ...(source.start === undefined ? {} : { start: source.start, end: source.end }),
  ...(source.page === undefined ? {} : { page: source.page }),
}])).values()];
const copy = <T>(value: T): T => structuredClone(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function sessionOf(state: AppSnapshot, sessionId: string, includeDeleted = false): Session {
  const session = state.sessions.find(value => value.id === sessionId);
  requireValue(session && (includeDeleted || session.lifecycle !== 'deleted'), '会话不存在或已删除', 'NOT_FOUND');
  return session;
}
function workspaceOf(state: AppSnapshot, session: Session): Workspace {
  const workspace = state.workspaces.find(value => value.id === session.workspaceId && value.sessionId === session.id);
  requireValue(workspace, '会话工作区不存在', 'NOT_FOUND'); return workspace;
}
function canvasExists(state: AppSnapshot, canvasId: string) {
  requireValue(state.graph?.canvases.some(canvas => canvas.canvasId === canvasId), '画布不存在', 'NOT_FOUND');
}
function inheritedOf(state: AppSnapshot, workspace: Workspace): SnapshotMaterial[] {
  return workspace.snapshotIds.map(snapshotId => state.snapshots.find(snapshot => snapshot.id === snapshotId))
    .filter((snapshot): snapshot is SnapshotMaterial => Boolean(snapshot && !snapshot.revoked));
}

function buildPreview(state: AppSnapshot, canvasId: string, orderedTasks: OrderedTaskSelection[]): InheritanceMaterial {
  canvasExists(state, canvasId);
  requireValue(Array.isArray(orderedTasks) && orderedTasks.length <= 10000, '任务选择无效');
  requireValue(orderedTasks.every(t => t && typeof t.sessionId === 'string' && typeof t.taskId === 'string'), '任务选择无效');
  requireValue(new Set(orderedTasks.map(t => t.taskId)).size === orderedTasks.length, '同一任务不能重复继承', 'DUPLICATE_SELECTION');
  const sources = [...new Set(orderedTasks.map(t => t.sessionId))];
  requireValue(sources.length <= 64, '来源会话过多');
  const parents: SnapshotMaterial[] = [];
  for (const sourceId of sources) {
    const parent = sessionOf(state, sourceId);
    requireValue(parent.canvasId === canvasId, '父子会话必须属于同一画布', 'CROSS_CANVAS_INHERITANCE');
    requireValue(parent.mode !== 'temporary', '临时会话不能产生子会话', 'TEMPORARY_PARENT');
    const workspace = workspaceOf(state, parent), memories = inheritedOf(state, workspace);
    const sourceTaskIds = orderedTasks.filter(t => t.sessionId === sourceId).map(t => t.taskId);
    const turns = historyTurns(state, sourceId);
    for (const taskId of sourceTaskIds) requireValue(isCompletedHistoryTask(state, sourceId, taskId) && turns.some(t => t.taskId === taskId),
      '只能继承当前来源可访问的已完成任务', 'INCOMPLETE_TASK');
    const messages = sourceTaskIds.flatMap(taskId => copy(turns.find(t => t.taskId === taskId)!.messages.filter(m => m.status === 'complete')));
    const ids = new Set(sourceTaskIds), messageIds = new Set(messages.map(m => m.id));
    const localIds = new Set(state.tasks.filter(t => t.workspaceId === workspace.id).map(t => t.id));
    const toolCalls = [...new Map([...state.toolCalls.filter(c => localIds.has(c.taskId)), ...memories.flatMap(m => m.toolCalls ?? [])]
      .filter(c => ids.has(c.taskId) && ['completed', 'rejected'].includes(c.status)).map(c => [c.id, copy(c)])).values()];
    const operations = [...new Map(sourceTaskIds.flatMap(taskId => turns.find(t => t.taskId === taskId)!.operations).map(c => [c.id, copy(c)])).values()];
    const attachmentRefs = uniqueSources(messages.flatMap(m => messageAttachments(m, state)));
    const artifacts = attachmentRefs.map(ref => {
      const artifact = [...state.artifacts, ...memories.flatMap(m => m.artifacts ?? [])].find(a => a.id === ref.id && a.version === ref.version && a.status !== 'deleted');
      requireValue(artifact, '所选任务的附件版本不可用', 'MISSING_DEPENDENCY'); return copy(artifact);
    });
    const progressEvents = [...new Map([...(workspace.progressEvents ?? []), ...memories.flatMap(m => m.progressEvents ?? [])]
      .filter(p => ids.has(p.taskId)).map(p => [p.id, copy(p)])).values()];
    const taskNotices = [...new Map([...(workspace.taskNotices ?? []), ...memories.flatMap(m => m.taskNotices ?? [])].filter(n => n.taskId && ids.has(n.taskId)).map(n => [n.id, copy(n)])).values()];
    const summaries = copySelectedSummaries([...(workspace.summaries ?? []), ...memories.flatMap(m => m.summaries ?? [])],
      snapshotEvidence(messages, toolCalls, progressEvents, [], sourceTaskIds.at(-1) ?? '', state,taskNotices), artifacts);
    const boundIds = new Set([...messageIds, ...toolCalls.flatMap(c => [c.id, c.operationId, c.stepId]),
      ...progressEvents.map(p => p.id),...taskNotices.map(n=>n.id), ...summaries.map(s => s.id), ...artifacts.flatMap(a => [a.id, ...a.chunks.map(c => c.id)])]);
    const completedStepGroups=[...new Map([
      ...state.steps.filter(s=>localIds.has(s.taskId)&&ids.has(s.taskId)&&s.purpose==='agent'&&s.status==='completed')
        .map(s=>({id:s.id,taskId:s.taskId,ordinal:s.ordinal,order:s.completedSequence??messages.find(m=>m.stepId===s.id)?.sequence
          ??toolCalls.find(c=>c.stepId===s.id)?.sequence??Date.parse(s.createdAt)})),
      ...memories.flatMap(m=>m.completedStepGroups??[]).filter(s=>ids.has(s.taskId)),
    ].filter(g=>toolCalls.some(c=>c.stepId===g.id)||messages.some(m=>m.stepId===g.id)).map(g=>[g.id,copy(g)])).values()];
    const presentationParts = [...new Map([...state.presentationParts ?? [], ...memories.flatMap(m => m.presentationParts ?? [])]
      .filter(p => ids.has(p.taskId)).map(p => [p.id, copy(p)])).values()];
    const sourceRefs = uniqueSources(messages.flatMap(m => [{kind:'message' as const,id:m.id,version:m.version}, ...m.sourceRefs]));
    const sourceTaskStates = sourceTaskIds.map(taskId => ({ id:taskId, status:'completed' as const,
      instructionRevision:Math.max(1,...messages.filter(m => m.taskId === taskId).map(m => m.instructionRevision ?? 1)),
      rootUserMessageId:state.tasks.find(t=>t.id===taskId)?.rootUserMessageId??memories.flatMap(m=>m.sourceTaskStates??[]).find(t=>t.id===taskId)?.rootUserMessageId }));
    const material = { sourceSessionId: parent.id, sourceTitle: parent.title, sourceTaskIds, messages, operations, notes: [], toolCalls, taskNotices,
      artifacts, summaries, progressEvents, completedStepGroups, presentationParts, sourceTaskStates, sourceRefs,
      sourceReferenceAliases: Object.fromEntries(Object.entries(sessionGraphReferences(state,parent.id)?.aliases ?? {}).filter(([,raw]) => boundIds.has(raw))),
      provenancePaths: sourceRefs.map(source => ({ source, viaSessionId:parent.id, viaSnapshotIds:[] })),
      cutoffSeq: state.events.filter(e => e.workspaceId === workspace.id).reduce((n,e) => Math.max(n,e.seq),0) };
    parents.push({ id:'', createdAt:'', ...material, contentHash:hash(material) });
  }
  const messages = orderedTasks.flatMap(t => parents.find(p => p.sourceSessionId === t.sessionId)!.messages.filter(m => m.taskId === t.taskId));
  const artifacts = [...new Map(parents.flatMap(p => p.artifacts ?? []).map(a => [`${a.id}:${a.version}`,a])).values()];
  return { orderedTasks: copy(orderedTasks), messages, notes:[], artifacts, operations:parents.flatMap(p => p.operations), toolCalls:parents.flatMap(p => p.toolCalls ?? []),
    sourceRefs:uniqueSources(parents.flatMap(p => p.sourceRefs)), sourceTaskStates:parents.flatMap(p => p.sourceTaskStates),
    provenancePaths:parents.flatMap(p => p.provenancePaths), parents, possibleConflicts:[],
    contentHash:hash([orderedTasks, parents.map(p => p.contentHash), sources.map(id => {
      const w = state.workspaces.find(w => w.sessionId === id)!; return [id,w.contextStage,w.pinnedNotes,w.workNotes,w.sessionContext];
    })]) };
}



function covers(existing: SourceRef, source: SourceRef): boolean {
  return existing.kind === source.kind && existing.id === source.id && existing.version === source.version
    && (source.page === undefined ? existing.page === undefined : source.page === existing.page)
    && (source.start === undefined ? existing.start === undefined : (existing.start !== undefined && source.start >= existing.start && source.end! <= existing.end!));
}

function validateNoteSources(state: AppSnapshot, session: Session, sources: SourceRef[]): SourceRef[] {
  requireValue(Array.isArray(sources) && sources.length <= 500, '笔记来源列表无效');
  const workspace = workspaceOf(state, session), memories = inheritedOf(state, workspace);
  const inheritedSources = memories.flatMap(memory => memory.sourceRefs);
  const graph = state.graph;
  const graphRefs = new Set<string>();
  if (graph && graph.canvases.some(canvas => canvas.canvasId === session.canvasId)) {
    const canvas = graph.canvases.find(value => value.canvasId === session.canvasId)!;
    getCanvasPaths(graph, canvas).forEach(row => graphRefs.add(row.id));
    graph.edges.filter(edge => !edge.removed && (graphRefs.has(edge.sourceNodeId) || graphRefs.has(edge.targetNodeId))).forEach(edge => graphRefs.add(edge.edgeId));
  }
  for (const source of sources) {
    requireValue(source && ['message', 'artifact', 'node', 'document', 'edge', 'note', 'snapshot'].includes(source.kind)
      && typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 1000
      && (positiveInteger(source.version) || (typeof source.version === 'string' && source.version.length > 0 && source.version.length <= 1000)), '笔记来源的类型、ID 或版本无效');
    requireValue((source.start === undefined && source.end === undefined)
      || (Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) && source.start! >= 0 && source.end! > source.start!), '来源片段范围无效');
    requireValue(source.page === undefined || positiveInteger(source.page), '来源页码无效');
    requireValue(source.page === undefined || source.kind === 'artifact', '页码只能用于附件来源');
    requireValue(source.tracking === undefined || ['current','historical'].includes(source.tracking), '来源跟踪方式无效');
    if (inheritedSources.some(existing => covers(existing, source))) continue;
    if (source.kind === 'message') {
      const message = [...state.messages.filter(message => message.workspaceId === workspace.id), ...memories.flatMap(memory => memory.messages)]
        .find(message => message.id === source.id && message.version === source.version);
      requireValue(message, '消息来源不属于当前工作区或版本不存在', 'OUT_OF_SCOPE');
      if (source.end !== undefined) requireValue(source.end <= message.text.length, '消息来源片段范围不存在', 'VERSION_CONFLICT');
    } else if (source.kind === 'note') {
      const note = [...workspace.workNotes, ...workspace.pinnedNotes, ...memories.flatMap(memory => memory.notes)].find(note => note.id === source.id && note.version === source.version);
      requireValue(note, '笔记来源不属于当前工作区或版本不存在', 'OUT_OF_SCOPE');
      if (source.end !== undefined) requireValue(source.end <= note.text.length, '笔记来源片段范围不存在', 'VERSION_CONFLICT');
    } else if (source.kind === 'snapshot') {
      requireValue(memories.some(memory => memory.id === source.id && memory.contentHash === source.version), '快照来源不属于当前工作区或版本不存在', 'OUT_OF_SCOPE');
    } else if (source.kind === 'artifact') {
      const attached = new Set([...workspace.artifactIds, ...state.tasks.filter(task => task.workspaceId === workspace.id).flatMap(task => task.inputBindings.artifactIds)]);
      const artifact = [...state.artifacts.filter(value => value.workspaceId === workspace.id), ...memories.flatMap(memory => memory.artifacts ?? [])].find(value => value.id === source.id && value.version === source.version && value.status !== 'deleted');
      for (const memory of memories) for (const file of memory.artifacts ?? []) attached.add(file.id);
      requireValue(artifact && attached.has(source.id), '附件来源未附加到当前工作区或版本不存在', 'OUT_OF_SCOPE');
      if (source.start !== undefined) requireValue(artifact.chunks.some(chunk => source.start! >= chunk.start && source.end! <= chunk.end && (source.page === undefined || source.page === chunk.page)), '附件片段未解析或范围不存在', 'VERSION_CONFLICT');
      if (source.page !== undefined) requireValue(artifact.chunks.some(chunk => chunk.page === source.page), '附件页未成功解析', 'VERSION_CONFLICT');
    } else {
      requireValue(graph && graphRefs.has(source.id), '图内容来源不在当前画布范围', 'OUT_OF_SCOPE');
      const value = source.kind === 'node' ? graph.nodes[source.id] : source.kind === 'document' ? graph.documents[source.id] : graph.edges.find(edge => edge.edgeId === source.id && !edge.removed);
      requireValue(value && hash(value) === source.version, '图内容来源版本不存在或已经改变', 'VERSION_CONFLICT');
      if (source.end !== undefined) {
        const content = source.kind === 'node' ? graph.nodes[source.id].content : source.kind === 'document' ? graph.documents[source.id].metadata.description ?? '' : graph.edges.find(edge => edge.edgeId === source.id)!.edgeContent;
        requireValue(source.end <= content.length, '图内容来源片段范围不存在', 'VERSION_CONFLICT');
      }
    }
  }
  return uniqueSources(sources);
}


/** Organization edges carry no memory; repair the current session graph only. */
export function reconcileSessionRoots(repo: Repository): void {
  for (const canvas of repo.state.graph?.canvases ?? []) {
    const sessions = repo.state.sessions.filter(session => session.mode !== 'temporary' && session.canvasId === canvas.canvasId && session.lifecycle !== 'deleted');
    if (!sessions.length) continue;
    const ids = new Set(sessions.map(session => session.id));
    const children = new Set(repo.state.inheritanceEdges.filter(edge => ids.has(edge.parentSessionId) && ids.has(edge.childSessionId)).map(edge => edge.childSessionId));
    const roots = sessions.filter(session => !children.has(session.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    let root = roots.find(session => session.mode === modeOf(canvas));
    if (!root) {
      root = { id: id('session:'), canvasId: canvas.canvasId, workspaceId: id('workspace:'), mode: modeOf(canvas), title: `新建会话${repo.state.sessions.filter(s => s.canvasId === canvas.canvasId).length + 1}（发送第一条消息后改名）`, titleSource: 'pending', lifecycle: 'active', createdAt: now() };
      repo.state.sessions.push(root);
      repo.state.workspaces.push({ id: root.workspaceId, sessionId: root.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] });
      repo.event(root.workspaceId, 'session.root_repaired', { sessionId: root.id, canvasId: canvas.canvasId });
    }
    for (const formerRoot of roots) if (formerRoot.id !== root.id) {
      repo.state.inheritanceEdges.push({ id: id('inheritance:'), canvasId: canvas.canvasId, parentSessionId: root.id, childSessionId: formerRoot.id, snapshotIds: [], createdAt: now(), structuralOnly: true });
      repo.event(formerRoot.workspaceId, 'session.root_organized', { rootSessionId: root.id, memoryInherited: false });
    }
  }
}

/** Fresh destination identities do not change the fingerprint of the visible content. */
function inheritanceOutcome(state: AppSnapshot, session: Session, dependencyFingerprint: string): InheritanceOutcome {
  const workspace = workspaceOf(state, session), context = ensureSessionContext(state, workspace);
  const stage = workspace.contextStage ?? workspace.promptFork?.stage;
  const canonicalIds = [[session.id, '$created-session'], [session.workspaceId, '$created-workspace'],
    ...workspace.snapshotIds.map((id, index) => [id, `$created-snapshot-${index}`])];
  let content = JSON.stringify({ entries: stage?.entries.map(entry => ({ category: entry.category,
    taskId: entry.taskId, coverage: entry.coverage, representation: entry.representation,
    messages: entry.wireMessages ?? entry.messages })),
    workNotes: notebookWorkspace(state, session)?.workNotes ?? [], pinnedNotes: notebookWorkspace(state, session)?.pinnedNotes ?? [] });
  for (const [id, marker] of canonicalIds) content = content.replaceAll(id, marker);
  const contentFingerprint = hash(content);
  const residentTaskIds = [...context.residentTaskIds], excludedTaskIds = [...context.excludedTaskIds];
  const historicalSummaryCounts = { ...context.historicalSummaryCounts };
  const promptReuse = { eligible: !!workspace.promptFork, reused: workspace.promptFork?.reused === true,
    ...(workspace.promptFork ? { fingerprint: workspace.promptFork.fingerprint } : {}),
    ...(workspace.inheritanceStatus?.reason ? { reason: workspace.inheritanceStatus.reason } : {}) };
  return { residentTaskIds, excludedTaskIds, historicalSummaryCounts, contentFingerprint, promptReuse,
    assemblyFingerprint: hash([dependencyFingerprint, residentTaskIds, excludedTaskIds, historicalSummaryCounts, contentFingerprint, promptReuse]) };
}

/** User session and note commands. Every mutation and its event share a repository commit. */
export class SessionService {
  constructor(private readonly repo: Repository, public creationAssembler?: SessionCreationAssembler) {}

  ensure(canvasId: string): Session {
    return this.repo.transaction(state => {
      canvasExists(state, canvasId); reconcileSessionRoots(this.repo);
      const existing = state.sessions.filter(session => session.mode !== 'temporary' && session.canvasId === canvasId && session.lifecycle !== 'deleted');
      const root = existing.find(session => !state.inheritanceEdges.some(edge => edge.childSessionId === session.id && existing.some(parent => parent.id === edge.parentSessionId)));
      return root ? copy(root) : this.create({ canvasId });
    });
  }

  private assembleNewSession(state: AppSnapshot, payload: CreateSessionInput): { session: Session; preview: InheritancePreview } {
    requireValue(payload && typeof payload === 'object', '会话创建参数无效');
    requireValue(!('parents' in payload)&&!('messageIds' in payload),'记忆选择协议已更新，请刷新界面','SELECTION_PROTOCOL_CHANGED');
    const canvas = state.graph?.canvases.find(c => c.canvasId === payload.canvasId);
    requireValue(canvas, '画布不存在', 'NOT_FOUND');
    const mode = payload.mode ?? modeOf(canvas);
    requireValue(mode === 'temporary' || mode === modeOf(canvas), '普通会话必须沿用所属画布的模式', 'UNSUPPORTED_MODE');
    const canvasId = text(payload.canvasId, '画布 ID', 1000);
    const title = text(payload.title ?? '', '会话标题', 1000).trim();
    requireValue(Array.from(title).length <= SESSION_TITLE_LIMIT, `会话名称最多 ${SESSION_TITLE_LIMIT} 个字符`);
    let orderedTasks = payload.orderedTasks ?? [];
    let temporaryMode: TemporaryMode | undefined;
    if (mode === 'temporary') {
      requireValue(state.sessions.filter(s=>s.canvasId===canvasId&&s.mode==='temporary'&&s.lifecycle==='active').length<TEMPORARY_LIMIT,'每个画布最多保留三个临时会话，请先关闭一个。','TEMPORARY_LIMIT');
      requireValue(new Set(orderedTasks.map(t => t.sessionId)).size <= 1, '临时会话只能选择一个来源会话', 'SINGLE_SOURCE_REQUIRED');
      const sourceId=payload.sourceSessionId??orderedTasks[0]?.sessionId;
      const source=sourceId?sessionOf(state,sourceId):undefined;
      requireValue(!source||source.canvasId===canvasId&&source.mode!=='temporary','请选择当前画布的普通会话','INVALID_SOURCE');
      temporaryMode=payload.temporaryMode??(payload.orderedTasks?.length?'custom':source&&!hasUnfinishedTask(state,source.id)?'branch':'minimal');
      requireValue(['minimal','branch','custom'].includes(temporaryMode),'临时模式无效');
      if(temporaryMode==='minimal')orderedTasks=[];
      else {
        requireValue(source,'请先进入一个普通会话','SOURCE_REQUIRED');
        requireValue(orderedTasks.every(t=>t.sessionId===source.id),'临时会话只能选择当前来源任务','SINGLE_SOURCE_REQUIRED');
        if(temporaryMode==='branch'){
          requireValue(!hasUnfinishedTask(state,source.id),'来源会话的任务尚未结束，暂不能创建分支','SOURCE_BUSY');
          orderedTasks=residentSessionTaskIds(state,source.id).map(taskId=>({sessionId:source.id,taskId}));
        }

      }
    }
    const preview = buildPreview(state, canvasId, orderedTasks);
    // Capture all assembly inputs before reserving new identities or installing projections.
    const dependencyFingerprint = hash([preview.contentHash, mode, temporaryMode, payload.sourceSessionId,
      state.provider, state.graph, state.directoryVersions, state.canvasGraphReferences, state.sessionReferences,
      state.changes, state.reviewChanges,
      temporaryMode && temporaryMode !== 'minimal' ? state.workspaces.find(w => w.sessionId === payload.sourceSessionId) : undefined]);
    const session: Session = { id: id('session:'), canvasId, workspaceId: id('workspace:'), mode,
      title: title || `新建会话${state.sessions.filter(s => s.canvasId === canvasId).length + 1}（发送第一条消息后改名）`, titleSource: title ? 'manual' : 'pending',
      lifecycle: 'active', createdAt: now(),
      ...(mode === 'temporary' ? { temporaryContext: { revision: 1, mode:temporaryMode, sourceSessionId: temporaryMode!=='minimal' ? payload.sourceSessionId??orderedTasks[0]?.sessionId : undefined } } : {}) };
    touchTemporary(session);
    const workspace: Workspace = { id: session.workspaceId, sessionId: session.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] };
    workspace.readRetention={version:1,revision:0,receipts:{}};
    const source = preview.parents.length===1 ? state.sessions.find(s => s.id === preview.parents[0].sourceSessionId) : undefined;
    if(source){source.referenceFamilyId??=source.id;session.referenceFamilyId=source.referenceFamilyId;sessionGraphReferences(state,source.id,true);}
    if (source) workspace.canvasView = copy(state.workspaces.find(w => w.id === source.workspaceId)?.canvasView);
    for (const material of preview.parents) {
      const snapshot = { ...copy(material), id: id('snapshot:'), createdAt: now() };
      state.snapshots.push(snapshot); workspace.snapshotIds.push(snapshot.id);
      if (session.mode !== 'temporary') state.inheritanceEdges.push({ id: id('inheritance:'), canvasId, parentSessionId: material.sourceSessionId, childSessionId: session.id,
        snapshotIds: [snapshot.id], createdAt: now() });
    }
    if (!preview.parents.length && session.mode !== 'temporary') {
      const existing = state.sessions.filter(candidate => candidate.canvasId === canvasId && candidate.lifecycle !== 'deleted');
      const children = new Set(state.inheritanceEdges.filter(edge => edge.canvasId === canvasId && existing.some(candidate => candidate.id === edge.parentSessionId)).map(edge => edge.childSessionId));
      const root = existing.find(candidate => candidate.mode === modeOf(canvas) && !children.has(candidate.id));
      if (root) state.inheritanceEdges.push({ id: id('inheritance:'), canvasId, parentSessionId: root.id, childSessionId: session.id, snapshotIds: [], createdAt: now(), structuralOnly: true });
    }
    state.sessions.push(session); state.workspaces.push(workspace);
    initializeInheritance(state, session, orderedTasks);
    if(source&&preview.parents[0]){
      installPromptFork(state,workspace,source,preview.parents[0],temporaryMode==='branch');
    }
    assembleCreatedSession(state, session, this.creationAssembler);
    const outcome = inheritanceOutcome(state, session, dependencyFingerprint);
    return { session, preview: { ...preview, ...outcome, contentHash: outcome.assemblyFingerprint } };
  }

  create(payload: CreateSessionInput): CreateSessionResult {
    return this.repo.transaction(state => {
      reconcileSessionRoots(this.repo);
      const { session, preview } = this.assembleNewSession(state, payload);
      if (payload.expectedPreviewHash !== undefined) requireValue(payload.expectedPreviewHash === preview.contentHash,
        '继承预览之后来源、容量或装配结果发生变化，请重新预览', 'VERSION_CONFLICT');
      if (payload.expectedForkFingerprint !== undefined) requireValue(preview.promptReuse.fingerprint === payload.expectedForkFingerprint,
        '来源提示词已更新，请重新预览', 'VERSION_CONFLICT');
      const workspace = workspaceOf(state, session);
      this.repo.event(workspace.id, 'session.created', { sessionId: session.id, mode: session.mode, snapshotIds: [...workspace.snapshotIds] });
      const { residentTaskIds, excludedTaskIds, historicalSummaryCounts, contentFingerprint, assemblyFingerprint, promptReuse } = preview;
      return { ...copy(session), inheritance: copy({ residentTaskIds, excludedTaskIds, historicalSummaryCounts, contentFingerprint, assemblyFingerprint, promptReuse }) };
    });
  }

  configureTemporary(payload: {sessionId:string;mode:TemporaryMode;sourceSessionId?:string;currentSessionId?:string;orderedTasks?:OrderedTaskSelection[];expectedRevision:number}) {
    requireValue(payload&&typeof payload==='object'&&!('parents' in payload)&&!('messageIds' in payload),'记忆选择协议已更新，请刷新界面','SELECTION_PROTOCOL_CHANGED');
    return this.repo.transaction(state=>{
      const session=sessionOf(state,payload.sessionId),workspace=workspaceOf(state,session);
      requireValue(session.mode==='temporary','仅临时会话可配置模式');
      requireValue(!session.temporaryContext?.lockedAt&&!state.tasks.some(t=>t.sessionId===session.id),'发送第一条消息后不能更换模式或记忆','MODE_LOCKED');
      requireValue(payload.expectedRevision===(session.temporaryContext?.revision??1),'模式设置已更新，请重新打开','VERSION_CONFLICT');
      requireValue(['minimal','branch','custom'].includes(payload.mode),'临时模式无效');
      const source=payload.mode==='minimal'?undefined:state.sessions.find(s=>s.id===payload.sourceSessionId&&s.id===payload.currentSessionId&&s.mode!=='temporary'&&s.lifecycle==='active'&&s.canvasId===session.canvasId);
      requireValue(payload.mode==='minimal'||source,'请先进入来源主会话','SOURCE_NOT_CURRENT');
      if(payload.mode==='branch')requireValue(!hasUnfinishedTask(state,source!.id),'来源会话任务尚未结束，暂不能创建分支','SOURCE_BUSY');
      const orderedTasks=payload.mode==='branch'?residentSessionTaskIds(state,source!.id).map(taskId=>({sessionId:source!.id,taskId})):payload.orderedTasks??[];
      requireValue(orderedTasks.every(t=>t.sessionId===source?.id),'临时会话只能选择当前来源任务','SINGLE_SOURCE_REQUIRED');
      const preview=buildPreview(state,session.canvasId,orderedTasks);
      const oldIds=new Set(workspace.snapshotIds);state.snapshots=state.snapshots.filter(s=>!oldIds.has(s.id));
      const artifacts=[...workspace.artifactIds];
      for(const key of Object.keys(workspace))if(!['id','sessionId'].includes(key))delete (workspace as unknown as Record<string,unknown>)[key];
      Object.assign(workspace,{workNotes:[],pinnedNotes:[],snapshotIds:[],artifactIds:artifacts});
      for(const material of preview.parents){const snapshot={...copy(material),id:id('snapshot:'),createdAt:now()};state.snapshots.push(snapshot);workspace.snapshotIds.push(snapshot.id);}
      session.temporaryContext={mode:payload.mode,sourceSessionId:source?.id,revision:payload.expectedRevision+1};touchTemporary(session);
      session.referenceFamilyId=source?(source.referenceFamilyId??=source.id):undefined;
      initializeInheritance(state,session,orderedTasks);
      if(source&&preview.parents[0])installPromptFork(state,workspace,source,preview.parents[0],payload.mode==='branch');
      assembleCreatedSession(state,session,this.creationAssembler);
      this.repo.event(workspace.id,'temporary.mode_changed',{mode:payload.mode,revision:session.temporaryContext.revision});return copy(session);
    });
  }


  closeTemporary(sessionId: string) {
    this.repo.transaction(state => {
      const session = sessionOf(state, sessionId);
      requireValue(session.mode === 'temporary', '只能通过此入口关闭临时会话');
      const workspace = workspaceOf(state, session), tasks = new Set(state.tasks.filter(t => t.sessionId === sessionId).map(t => t.id));
      const snapshots = new Set(workspace.snapshotIds);
      const previousCleanup = this.repo.db.prepare("SELECT body FROM metadata WHERE key='temporary_artifact_cleanup'").get();
      const cleanup = [...new Set([...(previousCleanup ? JSON.parse(String(previousCleanup.body)) as string[] : []),
        ...state.artifacts.filter(a => a.workspaceId === workspace.id).map(a => a.hash)])];
      this.repo.db.prepare("INSERT INTO metadata(key,body) VALUES('temporary_artifact_cleanup',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(cleanup));
      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      state.workspaces = state.workspaces.filter(w => w.id !== workspace.id);
      state.snapshots = state.snapshots.filter(s => !snapshots.has(s.id));
      state.inheritanceEdges = state.inheritanceEdges.filter(e => e.childSessionId !== sessionId && e.parentSessionId !== sessionId);
      state.tasks = state.tasks.filter(t => !tasks.has(t.id));
      state.chatTurnBookmarks = state.chatTurnBookmarks?.filter(mark => !tasks.has(mark.id));
      state.messages = state.messages.filter(m => m.workspaceId !== workspace.id);
      state.steps = state.steps.filter(s => !tasks.has(s.taskId));
      state.toolCalls = state.toolCalls.filter(c => !tasks.has(c.taskId));
      state.changes = state.changes.filter(c => c.workspaceId !== workspace.id || c.status==='committed'||c.status==='reverted');
      state.contextManifests = state.contextManifests.filter(m => !tasks.has(m.taskId));
      state.presentationParts = state.presentationParts?.filter(p => !tasks.has(p.taskId));
      state.artifacts = state.artifacts.filter(a => a.workspaceId !== workspace.id);
      state.events = state.events.filter(e => e.workspaceId !== workspace.id);
      if (state.sessionReferences&&!state.sessions.some(s=>s.referenceFamilyId===sessionId)) delete state.sessionReferences[sessionId];
      this.repo.event('system', 'temporary.closed', { sessionId });
    });
    return { ok: true };
  }

  bookmarkTurn(payload: { sessionId: string; taskId: string; starred: boolean }) {
    return this.repo.transaction(state => {
      const session = sessionOf(state, text(payload.sessionId, '会话 ID', 1000));
      const taskId = text(payload.taskId, '任务 ID', 1000);
      requireValue(typeof payload.starred === 'boolean', '标注状态必须为布尔值');
      requireValue(state.tasks.some(task => task.id === taskId && task.sessionId === session.id)
        || historyTurns(state, session.id).some(turn => turn.taskId === taskId), '当前会话中不存在这一轮对话', 'NOT_FOUND');
      const marks = state.chatTurnBookmarks ??= [];
      if (payload.starred && !marks.some(mark => mark.id === taskId)) marks.push({ id: taskId, createdAt: now() });
      if (!payload.starred) state.chatTurnBookmarks = marks.filter(mark => mark.id !== taskId);
      this.repo.event(session.workspaceId, 'chat.turn_bookmarked', { taskId, starred: payload.starred });
      return { taskId, starred: payload.starred };
    });
  }

  update(payload: UpdateSessionInput): Session {
    requireValue(payload && typeof payload === 'object', '会话更新参数无效');
    requireValue(!('mode' in payload) && !('orderedTasks' in payload) && !('parents' in payload) && !('contextPolicy' in payload) && !('canvasId' in payload) && !('workspaceId' in payload), '会话模式、上下文和继承关系不能通过此入口修改', 'IMMUTABLE_SESSION');
    return this.repo.transaction(state => {
      const session = sessionOf(state, text(payload.sessionId, '会话 ID', 1000));
      if (payload.title !== undefined) { const title = text(payload.title, '会话标题', 1000).trim(); requireValue(title && Array.from(title).length <= SESSION_TITLE_LIMIT, `会话名称须为 1–${SESSION_TITLE_LIMIT} 个字符`); session.title = title; session.titleSource = 'manual'; }
      if (payload.lifecycle !== undefined) {
        requireValue(['active', 'archived', 'deleted'].includes(payload.lifecycle), '会话状态无效');
        if (payload.lifecycle !== 'active') requireValue(!state.tasks.some(task => task.sessionId === session.id && task.status !== 'completed'), '请先完成当前任务，再归档或删除会话', 'SESSION_BUSY');
        session.lifecycle = payload.lifecycle;
        reconcileSessionRoots(this.repo);
      }

      this.repo.event(session.workspaceId, 'session.updated', { sessionId: session.id, lifecycle: session.lifecycle });
      return copy(session);
    });
  }

  replaceRequirements(payload: { sessionId: string; text: string; expectedVersion: string }) {
    const value = text(payload.text, '固定要求');
    return this.repo.transaction(state => {
      const session = sessionOf(state, text(payload.sessionId, '会话 ID', 1000));
      requireValue(session.lifecycle === 'active' && session.mode !== 'temporary', '当前会话的固定要求不可编辑');
      const workspace = workspaceOf(state, session), notes = [...workspace.pinnedNotes];
      requireValue(payload.expectedVersion === JSON.stringify(notes.map(note => [note.id, note.version])),
        '固定要求已在其他窗口修改，请保留当前文字并重新打开笔记', 'VERSION_CONFLICT');
      // One transaction keeps the continuous editor atomic, including capacity rejection.
      if (notes[0] && value.trim()) notes[0].sourceRefs = [...new Map(notes.flatMap(note => note.sourceRefs).map(source => [JSON.stringify(source), source])).values()];
      for (const note of value.trim() ? notes.slice(1) : notes)
        this.noteDelete({ sessionId: session.id, kind: 'pinned', noteId: note.id, expectedVersion: note.version });
      if (value.trim()) this.noteSave({ sessionId: session.id, kind: 'pinned', text: value,
        ...(notes[0] ? { noteId: notes[0].id, expectedVersion: notes[0].version } : {}), sourceRefs: [] });
      return { text: workspace.pinnedNotes.map(note => note.text).join('\n'),
        version: JSON.stringify(workspace.pinnedNotes.map(note => [note.id, note.version])) };
    });
  }

  noteSave(payload: SaveNoteInput): Note {
    requireValue(payload && (payload.kind === 'pinned' || payload.kind === 'work'), '笔记类型无效');
    const value = text(payload.text, '笔记正文').trim(); requireValue(value, '笔记正文不能为空');
    return this.repo.transaction(state => {
      const session = sessionOf(state, text(payload.sessionId, '会话 ID', 1000));
      requireValue(session.lifecycle === 'active', '归档会话的笔记为只读，请先恢复会话', 'SESSION_ARCHIVED');
      const workspace = payload.kind === 'work' ? writableNotebook(state, session.id) : workspaceOf(state, session);
      requireValue(session.mode !== 'temporary' || payload.kind === 'work', '临时会话不维护独立固定笔记');
      const notes = payload.kind === 'pinned' ? workspace.pinnedNotes : workspace.workNotes;
      const beforeNotes = structuredClone(notes);
      const requestId = payload.clientRequestId === undefined ? undefined : text(payload.clientRequestId, '笔记草稿 ID', 100);
      if (requestId && !payload.noteId) {
        const replay = notes.find(note => note.clientRequestId === requestId);
        if (replay) return copy(replay);
      }
      const existing = payload.noteId === undefined ? undefined : notes.find(note => note.id === payload.noteId);
      if (payload.noteId !== undefined) requireValue(existing, '笔记不存在或不属于当前工作区与笔记区', 'NOT_FOUND');
      requireValue(!existing || !(payload.sourceRefs ?? []).some(source => source.kind === 'note' && source.id === existing.id), '笔记不能把自己的旧版本作为来源', 'INVALID_SOURCE');
      const sources = withNoteProvenance(state, validateNoteSources(state, session, payload.sourceRefs ?? []));
      if (existing) requireValue(positiveInteger(payload.expectedVersion) && payload.expectedVersion === existing.version, '笔记已被修改，请刷新后重试', 'VERSION_CONFLICT');
      else requireValue(payload.expectedVersion === undefined, '新笔记不能指定旧版本', 'VERSION_CONFLICT');
      if (existing && payload.kind === 'work') {
        editNotebookContent(state, workspace, { id: existing.id, text: value,
          expectedVersion: existing.version });
        queueNotebookNotices(state,workspace,payload.kind,beforeNotes);
        this.repo.event(workspace.id, 'workspace.note_saved', { noteId: existing.id, kind: payload.kind, version: existing.version });
        return copy(existing);
      }
      const type = payload.kind === 'pinned' ? 'pinned' : payload.type ?? existing?.type ?? 'finding';
      requireValue(payload.kind === 'pinned' || ['goal', 'constraint', 'finding', 'result', 'question', 'next'].includes(type), '工作笔记类别无效');
      const note: Note = { id: existing?.id ?? id('note:'), text: value, version: (existing?.version ?? 0) + 1,
        type: existing?.type ?? type, sourceRefs: existing?.sourceRefs ?? sources, updatedAt: now(),
        createdAt: existing?.createdAt ?? existing?.updatedAt ?? now(), originTaskId: existing?.originTaskId, author: existing?.author ?? 'user',
        ...(existing?.clientRequestId || requestId ? { clientRequestId: existing?.clientRequestId ?? requestId } : {}) };
      if (payload.kind === 'pinned') requireValue(estimateTokens([...notes.filter(note => note.id !== existing?.id).map(note => note.text), value].join('\n')) <= sectionBudgets(state).fixed_requirements,
        `固定要求总量超过 ${sectionBudgets(state).fixed_requirements} token 上限`, 'FIXED_REQUIREMENTS_LIMIT');
      else {
        note.lifecycle = existing?.lifecycle ?? payload.lifecycle ?? 'multi_task';
        requireValue(note.lifecycle==='multi_task', '当前任务用到的笔记请追加到任务进度', 'NOTE_LIFECYCLE');

      }
      if(existing&&payload.kind==='work')(workspace.noteVersions??=[]).push(copy(existing));
      if (existing) notes[notes.indexOf(existing)] = note; else notes.push(note);
      if (payload.kind === 'work') assertNotebookCapacity(state, workspace);
      else invalidateRequirementResponses(state, workspace);
      queueNotebookNotices(state,workspace,payload.kind,beforeNotes);
      this.repo.event(workspace.id, 'workspace.note_saved', { noteId: note.id, kind: payload.kind, version: note.version });
      return copy(note);
    });
  }

  noteDelete(payload: { sessionId: string; kind: 'pinned' | 'work'; noteId: string; expectedVersion: number }): void {
    requireValue(payload && (payload.kind === 'pinned' || payload.kind === 'work'), '笔记类型无效');
    this.repo.transaction(state => {
      const session = sessionOf(state, text(payload.sessionId, '会话 ID', 1000));
      requireValue(session.lifecycle === 'active', '归档会话的笔记为只读，请先恢复会话', 'SESSION_ARCHIVED');
      const workspace = payload.kind === 'work' ? writableNotebook(state, session.id) : workspaceOf(state, session);
      if (payload.kind === 'work') {
        const beforeNotes = structuredClone(workspace.workNotes);
        deleteNotebookEntry(state, workspace, payload.noteId, payload.expectedVersion);
        queueNotebookNotices(state,workspace,payload.kind,beforeNotes);
      this.repo.event(workspace.id, 'workspace.note_deleted', { noteId: payload.noteId, kind: payload.kind }); return;
      }
      const notes = workspace.pinnedNotes;
      const beforeNotes = structuredClone(notes);
      const index = notes.findIndex(note => note.id === payload.noteId); requireValue(index >= 0, '笔记不存在或不属于当前笔记区', 'NOT_FOUND');
      requireValue(payload.expectedVersion === notes[index].version, '笔记已被修改，请刷新后重试', 'VERSION_CONFLICT');
      notes.splice(index, 1); invalidateRequirementResponses(state, workspace);
      queueNotebookNotices(state,workspace,payload.kind,beforeNotes);
      this.repo.event(workspace.id, 'workspace.note_deleted', { noteId: payload.noteId, kind: payload.kind });
    });
  }

  noteEdit(payload: { sessionId: string; id: string; text: string; expectedVersion: number }) {
    return this.repo.transaction(state => {
      const workspace = writableNotebook(state, payload.sessionId);
      const beforeNotes = structuredClone(workspace.workNotes);
      editNotebookContent(state, workspace, payload);
      queueNotebookNotices(state,workspace,'work',beforeNotes);
      this.repo.event(workspace.id, 'workspace.note_saved', { noteId: payload.id });
      return { ok: true };
    });
  }

  inheritancePreview(payload: CreateSessionInput & { orderedTasks: OrderedTaskSelection[] }): InheritancePreview {
    requireValue(payload && typeof payload === 'object', '继承预览参数无效');
    // The production assembler runs against a detached state. Preview cannot commit
    // reads, consume historical rounds, allocate durable aliases, or alter residency.
    return copy(this.assembleNewSession(copy(this.repo.state), payload).preview);
  }

}
