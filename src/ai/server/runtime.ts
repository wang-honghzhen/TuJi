import { renderArtifactImages, imageAssetData } from './artifactImages';
import { resolveAttachment, authorizedAttachments } from './attachmentCatalog';
import { ATTACHMENT_TOOLS, attachmentRead } from './attachmentReads';
import { attachmentLimits, attachmentBatchError, attachmentVision } from '../attachments';
import { canvasDirectory } from '@/v3/canvas';
import { graphTargetName } from '../toolDescriptions';
import type { RelationshipLayoutResult } from '@/v3/relationshipLayout';
import type { GraphState } from '@/v3/types';
import { allReviewChanges,reviewEntries,reviewUnitRefs } from '../changeReview';
import type { ContextBuildOptions } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import type { AgentGraphReferences,AppSnapshot,ChangeSet,ChatMessage,ContextManifest,Interaction,ProtocolMessage,SendInput,Session,Task,ToolCallRecord } from '../domain';
import { DEEPSEEK_MODELS,messageSessionTitle,TERMINAL_TASK_STATUSES } from '../domain';
import { historyTurns,residentHistoryTurns } from '../history';
import { effectiveArtifacts,HANDOFF_LIMIT,inputCapacity,selectedMessages,withNoteProvenance } from '../memory';
import { notebookWorkspace } from '../notebook';
import type { ReviewAction,ReviewPreview,ReviewResult,ReviewUnit } from '../reviewTypes';
import { selectedProgressPayload, normalizeProgressSelection,registerSessionTask,settleSessionContext } from '../sessionContext';
import { defaultTaskBudget,exhaustedTaskBudget,RUN_BUDGET_REASONS,taskBudgetPauseReason,type TaskBudgetReason } from '../taskBudget';
import { isMinimalSession,touchTemporary } from '../temporaryModes';
import { estimateTokens } from '../tokens';
import { webAccessEnabled } from '../webAccess';
import { AI_STRUCTURE_BOUNDARY_MESSAGE } from './aiStructurePolicy';
import { prepareAutomaticContext,prepareInitialContext } from './automaticCompaction';
import { buildAutomaticContext } from './automaticContext';
import { canvasIndex } from './canvasView';
import { captureReviewUnits,decideReview,planReview,protectReviewWrites,registerReview,reviewAffectedWorkspaces,settleReviewLayout } from './changeReview';
import { canvasObservationChanges } from './contextFreshness';
import { compactConversationHistory } from './conversationHistory';
import { directContextRead } from './directContextReads';
import { directGraphRead,graphIndex,membershipStamp,observationChange,observe } from './directGraph';
import { graphWriteUsage } from './directoryEvidence';
import { retainedDirectoryObservations } from './directoryObservations';
import { directReadBudgets,readCapacityReceipt } from './directReadBudget';
import { DomainError,requireValue,strings,text } from './errors';
import { planFrozenReads } from './frozenReadCommit';
import { applyPatches,assertAiCommandRefs,assertAiObjectRefs,canvasOf,checkAiEffects,entity,graphDiff,memberIds,patchCanUndo,patchValue,planMutation,readableIds,resourcesFor,semanticHashes } from './graph';
import { assertDesignQuery } from './graphQueries';
import { graphQueryRead } from './graphQueryRead';
import { acknowledgeDeletedGraphReads,advanceResponseReadHashes,assertGraphReadHashes,rememberGraphReadHashes,scopedGraphReadHashes,type GraphReadHashes } from './graphReadDependencies';
import { canvasGraphReferences,emptyGraphReferences,graphReferenceCodec,rebindCanvasReferences,seedAddressableReferences,seedPayloadReferences,sessionGraphReferences,translateGraphPayload } from './graphReferences';
import { summaryArchive } from './historyRepresentations';
import { InputTokenEstimator,inputTokenSample,observedInputUpperBound,type InputTokenSample } from './inputTokenEstimator';
import { planRelationshipLayout } from './layoutService';
import { minimalPreview,runMinimalChat } from './minimalChat';
import { assertCompleteNodeRead,prepareNodeReadAdvances } from './nodeReadEvidence';
import { deleteNotebookEntry,mutateNotebook,writableNotebook,writeAiNote } from './notebooks';
import { buildPartIndex } from './partIndex';
import { prefixMetrics,promptRouteSignature,wirePrefixSnapshot,type WirePrefixSnapshot } from './promptPrefix';
import { callModel,ProviderError,type ModelResponse } from './providers';
import { acknowledgeReadDelivery } from './readDelivery';
import { markPresented } from './readPresentation';
import { hash,id,now,Repository,storableManifest } from './repository';
import { commitRetention,synchronizeRetentionStage } from './retentionCommit';
import { reconcileSessionRoots } from './sessions';
import { sourceChanges } from './sourceFreshness';
import { bindSubgraphVersions } from './subgraphVersions';
import { claimTaskNotices, commitTaskNoticeBatch, migratePendingTaskNotices, queueNotebookNotices } from './taskNotices';
import { isDataRead } from './toolContextKinds';
import { toolDefinitions,validateToolArguments,validateToolCallArguments } from './tools';
import { withoutToolVersions } from './toolVersionProtocol';
import { bindToolVersions,captureToolVersions } from './toolVersions';
import { migrateRetiredCanvasNotices } from './retiredCanvasNotices';
import { freezeWebRead,WEB_MIN_READ_TOKENS } from './webReads';
import { callWeb,isWebTool,webRequest } from './webTools';
import { graphWriteAcknowledgement } from './writeAcknowledgements';

type ModelCaller = typeof callModel;
type Waiting = { waiting: true };
interface ProposalPlan { before: GraphState; planned: GraphState; commands: Record<string, unknown>[]; temporary: Record<string, string>; graphRevision: number; readHashes: GraphReadHashes; reviewUnits: ReviewUnit[] }
const isTerminal = (task: Task) => TERMINAL_TASK_STATUSES.includes(task.status);
const owner = (state: AppSnapshot, task: Task) => state.workspaces.find(w => w.id === task.workspaceId)!;
const bounded = (value: unknown, fallback: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(max, value) : fallback;
/** Streaming text is committed in batches: one commit costs a full state clone plus an SSE push. */
const DELTA_COMMIT_MS = 60, DELTA_COMMIT_BYTES = 2048;
/** Every unfinished state keeps its task and session identity. */
const BLOCKING_TASK_STATUSES: Task['status'][] = ['queued', 'running', 'waiting_resource', 'waiting_user', 'waiting_retry', 'waiting_reconcile', 'waiting_presentation', 'paused'];
const commandTypes = new Set(['patchNodeContent','createNode', 'createSubgraph', 'move', 'moveCanvasItems', 'reparentContent', 'deleteNode', 'deleteEdge',
  'deleteSubgraph', 'createEdge', 'updateNodeText', 'updateSubgraphText', 'updateDesignNode', 'updateEdge', 'reconnectEdge', 'moveBlock']);

/** Owns generation independently of React and serializes only short local commits. */
export class Runtime {
  private active = new Map<string, { controller: AbortController; resources: string[]; fence: number }>();
  private claims = new Map<string, string>();
  private wirePrefixes=new Map<string,WirePrefixSnapshot>();
  /** Prepared public projection only; never exported, persisted or marked as sent. */
  private inputTokenEstimators=new Map<string,InputTokenEstimator>();
  private inputTokenSamples=new WeakMap<ContextManifest,InputTokenSample>();
  /** Provider-private replay stays outside public prompt snapshots and is indexed by
   * execution identity, not response text (which can repeat across steps/tasks). */
  private privateContinuations=new Map<string,{generation:number;route:string;steps:Map<string,Pick<ModelResponse,'responseItems'|'reasoningContent'>>}>();
  private referencePlans = new WeakMap<ContextManifest, { canvas: AgentGraphReferences; session: AgentGraphReferences }>();
  private manifestReadDependencies = new WeakMap<ContextManifest, GraphReadHashes>();
  private editOccupancies = new Map<string, { field: string; expiresAt: number }>();
  private placementOccupancies = new Map<string, number>();
  private proposalPlans = new Map<string, ProposalPlan>();
  private reviewPreviews = new Map<string, { canvasId: string; selectedIds: string[]; groupIds: string[]; action: ReviewAction; signature: string; expiresAt: number }>();
  private reviewRestarts = new Set<string>();
  private layoutPreviews = new Map<string, { canvasId: string; regionId: string; graphRevision: number; before: GraphState; result: RelationshipLayoutResult; affectedCanvasIds: string[]; expiresAt: number }>();
  private layoutRequests = new Map<string, number>();
  private kicking = false;
  private shuttingDown = false;
  private runs = new Set<Promise<void>>();
  private inputEstimator(sessionId:string) {
    let estimator=this.inputTokenEstimators.get(sessionId);
    if(!estimator){estimator=new InputTokenEstimator();this.inputTokenEstimators.set(sessionId,estimator);}
    return estimator;
  }
  constructor(readonly repo: Repository, readonly modelCaller: ModelCaller = callModel, readonly webCaller: typeof callWeb = callWeb) {
    migrateRetiredCanvasNotices(repo);
    if(repo.state.canvasVersionProtocol?.version!==1)return;
    repo.transaction(state => {
      migratePendingTaskNotices(state);
      // A process restart cannot establish whether an in-flight paid read succeeded.
      // Preserve its identity and let the model decide whether a new request is needed.
      for (const call of state.toolCalls) if (isWebTool(call.name) && call.status === 'prepared' && call.startedAt) {
        call.status = 'rejected'; call.result = JSON.stringify({ status: 'error', code: 'WEB_INTERRUPTED', message: '服务重启中断了联网读取，未保留返回数据；如仍需要，请重新调用。' });
        repo.event(state.tasks.find(t => t.id === call.taskId)?.workspaceId ?? 'system', 'tool.failed', { toolCallId: call.id, name: call.name }, call.taskId, call.stepId);
      }
      for(const workspace of state.workspaces)if(workspace.contextStage)workspace.contextStage.recoveryRequired=true;
      const removed = compactConversationHistory(state);
      // Old pending transfer choices cannot grant the new executor management rights.
      for (const task of state.tasks) if (!isTerminal(task) && task.interaction?.kind === 'structure') {
        this.rejectLegacyStructure(task);
        task.status = 'paused'; task.pauseRequested = true; task.error = AI_STRUCTURE_BOUNDARY_MESSAGE;
        task.fencingToken++; task.updatedAt = now();
        repo.event(task.workspaceId, 'task.paused', { reason: task.error }, task.id);
      }
      if (removed) repo.event('system', 'history.compacted', { removedStreamingEvents: removed });
      for (const task of state.tasks) if (!isTerminal(task) && !['paused','waiting_user'].includes(task.status)) {
        task.fencingToken++;
        task.status = 'paused'; task.pauseRequested = true; task.error = '服务已重启，进度已保存，点击继续恢复。';
        task.updatedAt = now();
        for (const step of state.steps.filter(step => step.taskId === task.id && ['streaming', 'prepared'].includes(step.status))) step.status = 'aborted';
        for (const message of state.messages.filter(message => message.taskId === task.id && message.status === 'streaming')) message.status = 'incomplete';
        repo.event(task.workspaceId, 'task.paused', { reason: task.error }, task.id);
      }
    });
  }
  getTask(taskId: string): Task { const task = this.repo.state.tasks.find(t => t.id === taskId); requireValue(task, '任务不存在', 'NOT_FOUND'); return task; }
  getSession(sessionId: string) { const session = this.repo.state.sessions.find(s => s.id === sessionId); requireValue(session && session.lifecycle === 'active', '会话已归档、删除或不存在', 'NOT_FOUND'); return session; }
  private graph(): GraphState { requireValue(this.repo.state.graph, '画布尚未迁移', 'NOT_READY'); bindSubgraphVersions(this.repo.state.graph,this.repo.state.directoryVersions); return this.repo.state.graph; }
  isSessionBusy(sessionId:string) {return this.repo.state.tasks.some(t=>t.sessionId===sessionId&&(this.active.has(t.id)||['queued','running','waiting_resource','waiting_retry','waiting_reconcile','waiting_presentation'].includes(t.status)));}
  private message(task: Task, role: ChatMessage['role'], value: string, phase: ChatMessage['phase'], targets: string[] = [], operations: string[] = []): ChatMessage {
    const message: ChatMessage = { id: id('msg:'), workspaceId: task.workspaceId, taskId: task.id, role, text: value, phase,
      version: 1, status: 'complete', createdAt: now(), relatedOperationIds: operations, targetRefs: targets, sourceRefs: [], instructionRevision: task.instructionRevision };
    this.repo.state.messages.push(message); message.sequence = this.repo.event(task.workspaceId, 'message.completed', { messageId: message.id, phase }, task.id).globalSeq; return message;
  }
  send(input: SendInput): Task {
    const session = this.getSession(text(input.sessionId, '会话'));
    const body = text(input.text, '消息', 5000000).trim(); requireValue(body || input.artifactIds?.length, '消息不能为空');
    const requestId = text(input.clientMessageId, '消息请求 ID', 200); requireValue(requestId, '缺少消息请求 ID');
    requireValue(['new', 'amend'].includes(input.intent), '发送仅支持新建或补充；未完成任务会继续接收补充。');
    if(input.viewedPart!==undefined)requireValue(input.viewedPart&&typeof input.viewedPart.taskId==='string'&&Number.isSafeInteger(input.viewedPart.part)&&input.viewedPart.part>=0,'提问时段定位无效');
    if (input.modelSelection !== undefined) requireValue(input.modelSelection &&
      [this.repo.state.provider.model, ...(this.repo.state.provider.apiFamily === 'deepseek' ? DEEPSEEK_MODELS.map(model => model.id) : [])].includes(input.modelSelection.model)
      && ['none', 'low', 'high', 'max'].includes(input.modelSelection.thinkingEffort), '模型或思考强度不在可选范围');
    const duplicate = this.repo.state.messages.find(m => m.id === `user:${session.id}:${requestId}`);
    if (duplicate) return this.getTask(duplicate.taskId);
    const graph = this.graph(), members = memberIds(graph, session.canvasId);
    const targets = isMinimalSession(session)?[]:strings(input.targetIds ?? [], '选区').filter(ref => members.has(ref)), attached = strings(input.artifactIds ?? [], '附件');
    const workspace = this.repo.state.workspaces.find(w => w.id === session.workspaceId)!;
    const versions: Record<string, number> = {};
    for (const ref of attached) {
      const artifact = this.repo.state.artifacts.find(a => a.id === ref && a.workspaceId === workspace.id && a.status !== 'deleted');
      requireValue(artifact, '附件不在本工作区或已经删除', 'OUT_OF_SCOPE'); versions[ref] = artifact.version;
    }
    const attachmentError=attachmentBatchError([...new Set(attached)].map(id=>this.repo.state.artifacts.find(a=>a.id===id)!),attachmentLimits(this.repo.state),session);
    requireValue(!attachmentError,attachmentError??'', 'ATTACHMENT_LIMIT');
    let amended = false;
    const result = this.repo.transaction(state => {
      if(session.mode==='temporary'){session.temporaryContext!.lockedAt??=now();touchTemporary(session);}
      const current = state.tasks.find(t => t.sessionId === session.id && !isTerminal(t));
      let task: Task;
      if (current && !isTerminal(current)) {
        task = current; amended = true;
        task.instructionRevision++; task.updatedAt = now();
        this.endIdle(task); task.pauseRequested = false; task.error = undefined; task.retryCount = 0; task.noProgressCount=0;
        if(task.presentation){task.presentation.playbackPaused=false;delete task.presentation.visiblePart;delete task.presentation.ack;}
        for(const pending of state.toolCalls.filter(c=>c.taskId===task.id&&c.status==='waiting'&&c.name==='interaction_ask')){
          pending.status='completed';pending.result=JSON.stringify({status:'answered'});
        }
        if (input.modelSelection && JSON.stringify(input.modelSelection) !== JSON.stringify(task.modelSelection)) {
          task.modelSelection = structuredClone(input.modelSelection);
          for (const message of task.checkpoint?.protocol ?? []) { delete message.responseItems; delete message.reasoningContent; }
        }
        for (const tool of state.toolCalls.filter(c => c.taskId === task.id && c.status === 'prepared')) {
          tool.status = 'rejected'; tool.result = JSON.stringify({ status: 'rejected', reason: '用户补充已接收，旧指令下的未执行调用已作废' });
        }
        task.inputBindings.artifactIds = [...new Set([...task.inputBindings.artifactIds, ...attached])];
        Object.assign(task.inputBindings.artifactVersions, versions);
        if (task.interaction) {
          // A supplement answers whatever the task was waiting for: the pending question or the
          // budget acknowledgement is superseded, and a structure plan is invalidated outright.
          const structural = task.interaction.kind === 'structure';
          this.continueBudget(task);
          task.interaction = undefined;
          if (structural) for (const tool of state.toolCalls.filter(c => c.taskId === task.id && c.status === 'waiting')) {
            tool.status = 'rejected'; tool.result = JSON.stringify({ status: 'rejected', reason: '用户补充改变了提案依据，请重新规划' });
          }
          task.status = 'queued';
          if (task.contextCapacity) task.contextCapacity.blockedPlan = undefined;
        }
        this.repo.event(task.workspaceId, 'task.input_received', { clientMessageId: requestId, instructionRevision: task.instructionRevision }, task.id);
        task.status=this.active.has(task.id)?'running':'queued';
      } else {
        task = { id: id('task:'), sessionId: session.id, workspaceId: workspace.id, canvasId: session.canvasId,
          rootUserMessageId: `user:${session.id}:${requestId}`, clientRequestId: requestId, instructionRevision: 1, appliedInstructionRevision: 0,
          status: 'queued', createdAt: now(), updatedAt: now(), modelSelection: input.modelSelection ? structuredClone(input.modelSelection) : undefined,
          inputBindings: { targetIds: targets, artifactIds: attached, artifactVersions: versions },
          readHashes: {},
          ...defaultTaskBudget(state.provider), usedTokens: 0, stepCount: 0, fencingToken: 0,
          relatedTaskId: input.intent === 'amend' ? input.targetTaskId : undefined };
        state.tasks.push(task); this.repo.event(workspace.id, 'task.created', { taskId: task.id, intent: input.intent }, task.id);
        if (input.intent === 'amend' && input.targetTaskId) this.message(task, 'system', '原任务已结束，本条补充已保存为关联的新任务。', 'status');
      }
      state.messages.push({ id: `user:${session.id}:${requestId}`, workspaceId: workspace.id, taskId: task.id, role: 'user', text: body,
        version: 1, status: 'complete', phase: amended ? 'amendment' : 'request', createdAt: now(), relatedOperationIds: [], targetRefs: targets,
        targetNames:Object.fromEntries(targets.map(ref=>[ref,graphTargetName(state,ref,session.canvasId)])),
        sourceRefs: attached.map(ref => ({ kind: 'artifact' as const, id: ref, version: versions[ref] })), instructionRevision: task.instructionRevision });
      state.messages.at(-1)!.attachments = attached.map(ref => ({ kind: 'artifact' as const, id: ref, version: versions[ref] }));
      registerSessionTask(state, session.id, task.id);
      claimTaskNotices(state, workspace.id, task.id);
      if (input.progressSelection?.length) { const message=state.messages.at(-1)!;message.progressSelection = normalizeProgressSelection(state, session.id, input.progressSelection);message.selectedProgress=selectedProgressPayload(state,session.id,message.progressSelection); }
      if(input.viewedPart){
        const index=buildPartIndex(state,task),part=index.parts.find(p=>p.taskId===input.viewedPart!.taskId&&p.seq===input.viewedPart!.part&&p.sealed);
        const version=input.viewedPart.version??part?.version,view=part?.views?.filter(v=>v.version<=(version??0)).at(-1);
        const event=view?.eventId?part?.events?.find(e=>e.id===view.eventId):undefined;
        if(part&&version!==undefined&&Number.isSafeInteger(version)&&version>0&&version<=(part.version??0)&&!view?.unavailable&&(event||version===part.version)){
          const events=version===part.version?part.events??[]:(part.events??[]).slice(0,(part.events??[]).findIndex(e=>e.id===event?.id)+1);
          const recordIds=[...new Set(events.flatMap(e=>[...(e.callId?[e.callId]:[]),...(e.messageId?[e.messageId]:[])]))];
          state.messages.at(-1)!.viewedPart={taskMessageId:index.anchors.get(part.taskId)!,part:part.seq,targets:[...(event?.targets??part.targets)],graphRevision:view?.graphRevision??part.graphRevision,recordIds};
        }
        else state.messages.at(-1)!.viewedPartUnavailable=true;
      }
      if (session.titleSource === 'pending') {
        session.title = messageSessionTitle(body); session.titleSource = 'message';
        this.repo.event(workspace.id, 'session.auto_named', { sessionId: session.id, title: session.title }, task.id);
      }
      state.messages.find(message => message.id === `user:${session.id}:${requestId}`)!.sequence = this.repo.event(workspace.id, 'message.completed', { messageId: `user:${session.id}:${requestId}` }, task.id).globalSeq;
      if(!amended){
        const root=state.messages.find(m=>m.id===task.rootUserMessageId)!;
        const isolatedTask={...task,inputBindings:{targetIds:task.inputBindings.targetIds,artifactIds:[],artifactVersions:{}}};
        const minimal:AppSnapshot={...state,tasks:[isolatedTask],messages:[{...root,sourceRefs:[],attachments:[]}],
          toolCalls:[],steps:[],changes:[],snapshots:[],inheritanceEdges:[],artifacts:[],contextManifests:[],presentationParts:[],events:[],
          workspaces:[{id:workspace.id,sessionId:session.id,pinnedNotes:workspace.pinnedNotes,workNotes:[],snapshotIds:[],artifactIds:[]}]};
        const admission=this.previewState(minimal,isolatedTask);
        requireValue(admission.requestTokens<=inputCapacity(state),'起始输入和必需提示词无法完整装入模型，请缩短正文或转为附件。','CONTEXT_CAPACITY');
      }
      if (input.presentationOwner) {
        const previous = task.presentation;
        task.presentation = { owner: text(input.presentationOwner, '控制窗口', 200), mode: 'follow',
          epoch: (previous?.epoch ?? 0) + 1,
          cursor: state.presentationParts?.filter(part => part.taskId === task.id).at(-1)?.seq ?? 1 };
      }
      return task;
    });
    if (amended) this.active.get(result.id)?.controller.abort('amendment');
    this.kick(); return result;
  }
  private endIdle(task:Task){if(task.waitingSince!==undefined){
    const elapsed=Date.now()-task.waitingSince;task.idleDurationMs=(task.idleDurationMs??0)+elapsed;
    if(task.startedAt)task.startedAt=new Date(Date.parse(task.startedAt)+elapsed).toISOString();delete task.waitingSince;
  }}
  private parkPause(task:Task):boolean{
    if(!task.pauseRequested)return false;
    this.repo.transaction(()=>{task.pauseReturnStatus=task.interaction?'waiting_user':'queued';task.status='paused';task.waitingSince??=Date.now();
      this.repo.event(task.workspaceId,'task.paused',{},task.id);});return true;
  }
  pause(taskId:string){
    const task=this.getTask(taskId);requireValue(!isTerminal(task),'任务已完成。');
    this.repo.transaction(()=>{
      if(task.presentation)task.presentation.playbackPaused=true;
      if(!isTerminal(task)){
        task.pauseRequested=true;task.waitingSince??=Date.now();
        if(!this.active.has(task.id)){task.pauseReturnStatus=task.status;task.status='paused';}
      }
      this.repo.event(task.workspaceId,'task.pause_requested',{},task.id);
    });return task;
  }
  presentationControl(input:{taskId:string;owner:string;action:'attach'|'takeover'|'follow'|'review'|'background'|'show'|'ack';epoch?:number;seq?:number;stepId?:string;revision?:number}){
    const task=this.getTask(text(input.taskId,'任务')),ownerId=text(input.owner,'控制窗口',200);
    const action=input.action;requireValue(['attach','takeover','follow','review','background','show','ack'].includes(action),'展示操作无效');
    this.repo.transaction(()=>{
      if(!task.presentation){task.presentation={owner:ownerId,mode:'follow',epoch:1,cursor:0};this.repo.event(task.workspaceId,'presentation.attached',{},task.id);}const p=task.presentation;
      if(action==='takeover'){
        requireValue(input.epoch===p.epoch,'展示控制已变更，请重试');
        p.owner=ownerId;p.epoch++;delete p.visiblePart;
        this.repo.event(task.workspaceId,'presentation.control',{action},task.id);return;
      }
      if(p.owner!==ownerId)return;
      if(action==='attach')return;
      if(['follow','review','background'].includes(action)){
        p.mode=action as typeof p.mode;p.epoch++;delete p.visiblePart;
        if(input.seq!==undefined)p.cursor=input.seq;
        if(p.mode!=='follow'&&task.status==='waiting_presentation'&&!task.pauseRequested){this.endIdle(task);task.status='queued';}
      }else if(action==='show'){
        const part=this.repo.state.presentationParts?.find(part=>part.taskId===task.id&&part.seq===input.seq);
        requireValue(part,'展示记录不存在');
        if(input.epoch!==p.epoch)return;p.cursor=part.seq;
        if(part.sealed&&!p.playbackPaused&&!task.pauseRequested)p.visiblePart={seq:part.seq,since:Date.now(),epoch:p.epoch};
      }else{
        const round=p.round,part=this.repo.state.presentationParts?.find(part=>part.taskId===task.id&&part.seq===input.seq);
        if(p.mode!=='follow'||p.playbackPaused||task.pauseRequested||input.epoch!==p.epoch||!round
          ||input.stepId!==round.stepId||input.revision!==round.revision||input.seq!==round.lastSeq||!part?.sealed
          ||p.visiblePart?.seq!==input.seq||p.visiblePart.epoch!==p.epoch||Date.now()-p.visiblePart.since<part.dwellMs)return;
        p.ack={stepId:round.stepId,epoch:p.epoch,lastSeq:round.lastSeq};
        if(task.status==='waiting_presentation'){this.endIdle(task);task.status='queued';}
      }
      this.repo.event(task.workspaceId,'presentation.control',{action},task.id);
    });this.kick();return task.presentation;
  }
  private presentationGate(task:Task):boolean{
    const step=[...this.repo.state.steps].reverse().find(s=>s.taskId===task.id&&s.purpose==='agent'&&s.status==='completed'&&s.inputInstructionRevision===task.instructionRevision);
    if(!step)return false;
    const parts=this.repo.state.presentationParts?.filter(p=>p.taskId===task.id&&p.stepId===step.id)??[];
    const last=parts.at(-1);if(!last)return false;
    let waiting=false;
    this.repo.transaction(()=>{
      const p=task.presentation;if(!p)return;
      p.round={stepId:step.id,revision:task.instructionRevision,lastSeq:last.seq};
      if(p.mode==='follow'&&!(p.ack?.stepId===step.id&&p.ack.epoch===p.epoch&&p.ack.lastSeq===last.seq)){
        task.status='waiting_presentation';task.waitingSince??=Date.now();waiting=true;
        this.repo.event(task.workspaceId,'task.waiting_presentation',{},task.id,step.id);
      }
    });return waiting;
  }
  private parkFailure(task: Task, reason: string) {
    if (isTerminal(task)) return;
    task.status='paused'; task.pauseRequested=true; task.error=reason; task.updatedAt=now(); task.waitingSince??=Date.now();
    for(const message of this.repo.state.messages.filter(m=>m.taskId===task.id&&m.status==='streaming'))message.status='incomplete';
    this.repo.event(task.workspaceId,'task.paused',{reason},task.id);
  }
  resume(taskId: string) {
    requireValue(this.repo.state.canvasVersionProtocol?.version===1,'旧会话需要先执行画布版本迁移。','CONTEXT_MIGRATION_REQUIRED');
    const task=this.getTask(taskId);requireValue(!isTerminal(task),'任务已完成，请发送新消息。');
    this.repo.transaction(()=>{
      this.endIdle(task);delete task.pauseRequested;delete task.pauseReturnStatus;task.error=undefined;task.retryCount=0;task.noProgressCount=0;
      if(task.presentation){task.presentation.playbackPaused=false;delete task.presentation.visiblePart;}
      this.continueBudget(task);
      if(task.interaction?.kind==='budget'){task.interaction=undefined;if(task.contextCapacity)task.contextCapacity.blockedPlan=undefined;}
      task.status=task.interaction?'waiting_user':'queued';
      this.repo.event(task.workspaceId,'task.resumed',{},task.id);
    });this.kick();return task;
  }
  redoTask(taskId: string) {
    const prior = this.getTask(taskId); requireValue(isTerminal(prior), '请先结束当前任务');
    const root = this.repo.state.messages.find(m => m.id === prior.rootUserMessageId)!;
    const result = this.send({ sessionId: prior.sessionId, text: `明确重新执行并先核对当前图与已执行差异。原请求：${root.text}`,
      clientMessageId: id(), intent: 'new', targetIds: prior.inputBindings.targetIds,
      artifactIds: prior.inputBindings.artifactIds.filter(ref => this.repo.state.artifacts.some(a => a.id === ref && a.status !== 'deleted')), modelSelection: prior.modelSelection });
    this.repo.transaction(() => { result.relatedTaskId = prior.id; this.repo.event(result.workspaceId, 'task.linked', { relatedTaskId: prior.id }, result.id); });
    return result;
  }
  private canWrite(task: Task, state = this.repo.state) {
    const session = state.sessions.find(session => session.id === task.sessionId);
    const canvas = state.graph?.canvases.find(canvas => canvas.canvasId === task.canvasId);
    return Boolean(session && canvas && (session.mode === (canvas.mode ?? 'explore') || session.mode==='temporary' && session.temporaryContext?.mode && !isMinimalSession(session)));
  }
  private toolMode(task: Task, state = this.repo.state) {
    const session = state.sessions.find(s => s.id === task.sessionId);
    return { attachments:authorizedAttachments(state,task).length>0, design: state.graph?.canvases.find(canvas => canvas.canvasId === task.canvasId)?.mode === 'design', notes: !!notebookWorkspace(state, session), web:webAccessEnabled(state.provider) };
  }
  stopTemporary(sessionId: string) {
    requireValue(this.getSession(sessionId).mode === 'temporary', '只能停止临时会话');
    this.privateContinuations.delete(sessionId);this.wirePrefixes.delete(sessionId);this.inputTokenEstimators.delete(sessionId);
    this.repo.transaction(state => {
      for (const task of state.tasks.filter(t => t.sessionId === sessionId && !isTerminal(t))) {
        task.fencingToken++; task.instructionRevision++; task.status = 'paused'; task.pauseRequested = true;
        task.error = '临时会话的上下文已更换，继续后使用新的选择。';
        delete task.checkpoint; delete task.handoff; delete task.interaction; task.updatedAt = now();
        for (const step of state.steps.filter(s => s.taskId === task.id && ['streaming', 'prepared'].includes(s.status))) step.status = 'aborted';
        for (const message of state.messages.filter(m => m.taskId === task.id && m.status === 'streaming')) message.status = 'incomplete';
        for (const call of state.toolCalls.filter(c => c.taskId === task.id && ['prepared', 'waiting'].includes(c.status))) {
          call.status = 'rejected'; call.result = JSON.stringify({ status: 'rejected', reason: '临时会话选区已变化，旧调用失效' });
        }
        this.active.get(task.id)?.controller.abort('temporary-context-changed');
      }
    });
  }
  private taskResources(task: Task) { return this.canWrite(task) ? resourcesFor(this.graph(), task.canvasId, memberIds(this.graph(), task.canvasId)) : []; }
  private canClaim(task: Task, resources: string[]) {
    if (resources.some(resource => this.claims.has(resource) && this.claims.get(resource) !== task.id)) return false;
    const earlier = this.repo.state.tasks.slice(0, this.repo.state.tasks.findIndex(t => t.id === task.id))
      .filter(t => ['queued', 'waiting_resource'].includes(t.status) && this.canWrite(t));
    return !earlier.some(other => { try { return this.taskResources(other).some(resource => resources.includes(resource)); } catch { return false; } });
  }
  kick() {
    if(this.repo.state.canvasVersionProtocol?.version!==1)return;
    if (this.kicking || this.shuttingDown) return; this.kicking = true;
    queueMicrotask(() => {
      this.kicking = false;
      if (this.shuttingDown) return;
      for (const task of [...this.repo.state.tasks]) {
        if (!['queued', 'waiting_resource'].includes(task.status) || this.active.has(task.id)) continue;
        const priorTasks = this.repo.state.tasks.slice(0, this.repo.state.tasks.findIndex(t => t.id === task.id));
        if (priorTasks.some(t => t.sessionId === task.sessionId && BLOCKING_TASK_STATUSES.includes(t.status))
          || this.repo.state.tasks.some(t => t.id !== task.id && t.sessionId === task.sessionId && this.active.has(t.id))) continue;
        let claimed: string[] = [];
        try {
          this.getSession(task.sessionId);
          if (!this.repo.state.provider.model || !this.repo.credential) {
            this.repo.transaction(() => this.waitBudget(task, 'configuration', '请先配置模型提供方、模型名称与 API 密钥，再继续任务。', ['配置完成后继续'])); continue;
          }
          const resources = this.taskResources(task); claimed = resources;
          if (!this.canClaim(task, resources)) {
            if (task.status !== 'waiting_resource') this.repo.transaction(() => { task.status = 'waiting_resource'; task.waitReason = '其他 AI 任务正在编辑同一共享范围'; this.repo.event(task.workspaceId, 'edit.queued', { resources }, task.id); });
            continue;
          }
          for (const resource of resources) this.claims.set(resource, task.id);
          const controller = new AbortController();
          this.repo.transaction(() => {
            task.fencingToken++; task.activeRunId = id('run:'); task.status = 'running'; task.waitReason = undefined; task.interaction = undefined;
            task.startedAt ??= now(); task.updatedAt = now();
            this.repo.event(task.workspaceId, 'task.started', { runId: task.activeRunId }, task.id);
            if (resources.length) this.repo.event(task.workspaceId, 'edit.granted', { resources, generation: task.fencingToken }, task.id);
          });
          this.active.set(task.id, { controller, resources, fence: task.fencingToken });
          const run = this.run(task.id).finally(() => {
            const active = this.active.get(task.id); if (active) for (const resource of active.resources) if (this.claims.get(resource) === task.id) this.claims.delete(resource);
            this.active.delete(task.id);
            this.reviewRestarts.delete(task.id);
            if (!this.shuttingDown && this.repo.state.tasks.some(t => t.id === task.id)) this.repo.transaction(() => {const session=this.repo.state.sessions.find(s=>s.id===task.sessionId);if(session)touchTemporary(session);this.repo.event(task.workspaceId, 'edit.released', {}, task.id);});
            this.kick();
          });
          this.runs.add(run); void run.catch(cause => {
            // A run must never die silently: record why, so the session can continue and the user
            // sees a reason instead of a task that stays "running" forever.
            try { this.repo.transaction(() => { const failed = this.getTask(task.id);
              if (!isTerminal(failed)) { failed.updatedAt = now();
                failed.error = cause instanceof Error ? cause.message : '执行失败';
                this.parkFailure(failed, failed.error!); } }); } catch (reason) {
              if (process.env.QIXUE_TRACE) console.error('[trace] run failure could not be recorded', reason);
            }
          }).finally(() => this.runs.delete(run));
        } catch (cause) {
          // Nothing owns those resources when the run never started; leaving them claimed would
          // park every later task on this canvas in `waiting_resource` until a restart.
          for (const resource of claimed) if (this.claims.get(resource) === task.id) this.claims.delete(resource);
          this.repo.transaction(() => this.parkFailure(task,cause instanceof Error?cause.message:'任务启动失败')); 
        }
      }
    });
  }
  private guard(task: Task, revision?: number) {
    const active = this.active.get(task.id);
    requireValue(this.repo.state.tasks.some(t => t.id === task.id && t.fencingToken === task.fencingToken)
      && this.repo.state.sessions.some(s => s.id === task.sessionId && s.lifecycle === 'active'), '会话运行已失效', 'RUN_INVALID');
    requireValue(active && active.fence === task.fencingToken && task.status === 'running', '该运行实例已停止或失效', 'RUN_INVALID');
    if (revision !== undefined) requireValue(task.instructionRevision === revision, '任务要求已更新，需要按最新要求重新规划', 'INSTRUCTION_CHANGED');
    if (this.canWrite(task)) {
      const resources = this.taskResources(task);
      requireValue(resources.every(resource => active.resources.includes(resource) && this.claims.get(resource) === task.id), '共享资源归属或编辑资格已变化', 'RESOURCE_CHANGED');
    }
  }
  private allowedRead(task: Task): Set<string> {
    return readableIds(this.graph(), task);
  }
  private previewReadScope(state: AppSnapshot, task: Task): Set<string> {
    requireValue(state.sessions.some(session => session.id === task.sessionId && session.lifecycle === 'active') && state.graph, '预览任务的会话或图不存在', 'NOT_FOUND');
    return readableIds(state.graph, task);
  }
  private canvasReadingState(task: Task, state: AppSnapshot = this.repo.state) {
    const index = canvasIndex(state.graph!, task.canvasId, this.previewReadScope(state, task));
    const workspace = state.workspaces.find(workspace => workspace.id === task.workspaceId)!;
    const references = structuredClone(canvasGraphReferences(state, task.canvasId) ?? emptyGraphReferences());
    const sessionReferences = structuredClone(sessionGraphReferences(state, task.sessionId) ?? emptyGraphReferences());
    // Give the model a short reference for every id this request can show it, so it never
    // has to copy a long raw id back into a function. Canvas objects stay numbered per canvas;
    // attachments, notes, handles, messages, tool calls and chunks are numbered per session.
    seedAddressableReferences(sessionReferences, [
      ...summaryArchive(state,task).map(s=>({prefix:'s' as const,id:s.id})),
      ...(workspace.frozenReads??[]).map(r=>({prefix:'s' as const,id:r.id})),
      ...effectiveArtifacts(state,task).map(f=>({prefix:'s' as const,id:`attachment:${f.ref.id}:${f.ref.version}`})),
    ]);
    const visibleMessages = selectedMessages(state, task);
    const visibleTasks = new Set([...state.tasks.filter(value => value.sessionId === task.sessionId).map(value => value.id),
      ...visibleMessages.map(message => message.taskId)]);
    const inherited=state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked);
    const visibleCalls=[...state.toolCalls,...inherited.flatMap(s=>s.toolCalls??[])].filter(call=>visibleTasks.has(call.taskId));
    const visibleNotices=[...workspace.taskNotices??[],...inherited.flatMap(s=>s.taskNotices??[])]
      .filter(notice=>notice.taskId&&visibleTasks.has(notice.taskId));
    seedAddressableReferences(sessionReferences, [
      ...effectiveArtifacts(state, task).map(({ ref }) => ({ prefix: 'f' as const, id: ref.id })),
      ...[...(notebookWorkspace(state, state.sessions.find(s => s.id === task.sessionId))?.workNotes ?? []), ...workspace.pinnedNotes,
        ...residentHistoryTurns(state, task.sessionId, task.id).flatMap(turn => turn.notes)]
        .map(note => ({ prefix: 'w' as const, id: note.id })),
      ...visibleMessages.map(message => ({ prefix: 'm' as const, id: message.id })),
      ...visibleCalls.map(call => ({ prefix: 't' as const, id: call.id })),
      ...visibleCalls.map(call => ({ prefix: 'o' as const, id: call.operationId })),
      // Task scopes share the context series; execution groups share the operation series.
      // These display identities do not create a new readable entry or grant tool access.
      ...[...visibleTasks].map(id=>({prefix:'k' as const,id})),
      ...[task.sessionId,...inherited.map(s=>s.sourceSessionId)].map(id=>({prefix:'h' as const,id})),
      ...visibleCalls.map(call=>({prefix:'o' as const,id:call.stepId})),
      ...state.steps.filter(step=>visibleTasks.has(step.taskId)).map(step=>({prefix:'o' as const,id:step.id})),
      ...[...(workspace.progressEvents??[]),...inherited.flatMap(s=>s.progressEvents??[])]
        .filter(p=>visibleTasks.has(p.taskId)).map(p=>({prefix:'s' as const,id:p.id})),
      ...effectiveArtifacts(state, task).flatMap(({ artifact }) => artifact?.chunks ?? []).map(chunk => ({ prefix: 'c' as const, id: chunk.id })),
      // A mounted summary page is addressed by a composed id; give it a number of its own so
      // the raw handle identity never has to travel inside the prompt.
      ...visibleNotices.map(n=>({prefix:'s' as const,id:n.id})),
      ...(workspace.pendingTaskNotices?.changes??[]).map(n=>({prefix:'s' as const,id:n.id})),
      // Change sets and their canvas operations are handed back by graph_apply_changes and ui_present.
      ...state.changes.filter(change => visibleTasks.has(change.taskId))
        .flatMap(change => [{ prefix: 'g' as const, id: change.id }, { prefix: 'o' as const, id: change.operationId }]),
    ]);
    // Share only during this seeding pass; the codec may allocate more identities later.
    const seededReferences = new Set(Object.values(sessionReferences.aliases));
    seedPayloadReferences(sessionReferences,visibleMessages.map(m=>({sources:m.sourceRefs,attachments:m.attachments})),seededReferences);
    seedPayloadReferences(sessionReferences,visibleCalls.map(c=>({sources:c.resultSources})),seededReferences);
    for(const call of visibleCalls)for(const text of [call.arguments,call.result])if(text){
      try{seedPayloadReferences(sessionReferences,JSON.parse(text),seededReferences);}catch{/* Malformed archived payloads grant no new references. */}
    }
    // Notice payloads can refer to retired notes absent from the live notebook.
    // Reserve display identities from selected records without granting read access.
    for(const notice of visibleNotices){
      seedPayloadReferences(sessionReferences,{sources:notice.sourceRefs},seededReferences);
      try{seedPayloadReferences(sessionReferences,JSON.parse(notice.content),seededReferences);}catch{/* Preserve malformed notice text without guessing identities. */}
    }
    const codec = graphReferenceCodec(state.graph!, references, sessionReferences);
    // Allocate stable addresses for this canvas scope independently of which tree
    // nodes fit in this request. Allocation is neither content delivery nor permission.
    for (const ref of index.knownRefs) codec.encode(ref);
    return { index, workspace, codec, references, sessionReferences };
  }
  preview(task: Task, protocol: ProtocolMessage[] | undefined = task.checkpoint?.protocol): ContextManifest {
    return this.previewState(this.repo.state, task, protocol);
  }
  /** Draft evaluation uses a private clone and never populates durable records or
   * the live summary cache. The same projection builds actual model requests. */
  freezeForkContinuation(sessionId:string):void {
    this.privateContinuations.delete(sessionId);
    const fork=this.repo.state.workspaces.find(w=>w.sessionId===sessionId)?.promptFork;
    if(!fork)return;
    const source=this.privateContinuations.get(fork.sourceSessionId);
    if(!source||source.route!==fork.stage.routeSignature||source.generation!==fork.stage.generation)return;
    const steps=new Set(fork.stage.entries.flatMap(e=>e.wireMessages??e.messages).flatMap(m=>m.stepId?[m.stepId]:[]));
    this.privateContinuations.set(sessionId,{generation:source.generation,route:source.route,steps:new Map([...source.steps].filter(([id])=>steps.has(id)).map(([id,value])=>[id,structuredClone(value)]))});
  }
  /** Creation/preview use the identical deterministic engine; never issue a model request. */
  assembleCreatedSession(state: AppSnapshot, session: Session): void {
    const workspace=state.workspaces.find(w=>w.id===session.workspaceId)!;
    const task:Task={id:`creation:${session.id}`,sessionId:session.id,workspaceId:session.workspaceId,canvasId:session.canvasId,
      rootUserMessageId:'',clientRequestId:'creation',instructionRevision:0,appliedInstructionRevision:0,status:'completed',
      createdAt:session.createdAt,updatedAt:session.createdAt,inputBindings:{targetIds:[],artifactIds:[],artifactVersions:{}},
      ...defaultTaskBudget(state.provider),usedTokens:0,stepCount:0,fencingToken:0};
    const hadEstimator=this.inputTokenEstimators.has(session.id);
    let candidate:ContextManifest;
    try {
      if(workspace.promptFork){
        // A source snapshot can be larger than the destination's current input budget.
        // Evaluate the target route and actual wire projection before promising reuse.
        const fork=workspace.promptFork,visible=this.previewState(state,task,undefined,{phase:'task_end'});
        const capacity=inputCapacity(state),reserve=Math.min(AUTO_CONTEXT.readTokens,capacity*AUTO_CONTEXT.recentShare)
          +Math.min(AUTO_CONTEXT.readTokens,capacity*AUTO_CONTEXT.directoryShare);
        if(!visible.error&&!visible.contextMetrics?.rebuildReason&&visible.requestTokens<=capacity*AUTO_CONTEXT.trigger-reserve){
          fork.reused=true;
          if(workspace.inheritanceStatus)workspace.inheritanceStatus.reused=true;
          return;
        }
        const reason=visible.contextMetrics?.rebuildReason?'来源提示词需要重新装配':'来源提示词超过当前容量维护触发线';
        delete workspace.promptFork;
        // Exact forks alone inherit visibility. Reassembly starts from the selected
        // immutable records, so the source's receipt ledger cannot hide their bodies.
        workspace.readRetention={version:1,revision:0,receipts:{}};
        workspace.observations=[];
        const calls=new Set(state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)).flatMap(s=>(s.toolCalls??[]).flatMap(c=>[c.id,c.originResultId??c.id])));
        workspace.frozenReads=(workspace.frozenReads??[]).filter(r=>calls.has(r.callId));
        if(workspace.inheritanceStatus)Object.assign(workspace.inheritanceStatus,{eligible:false,reused:false,reason});
      }
      candidate=prepareInitialContext(state,task,options=>this.previewState(state,task,undefined,options));
    } finally { if(!hadEstimator)this.inputTokenEstimators.delete(session.id); }
    requireValue(!candidate.error,candidate.error??'创建会话容量不足','CONTEXT_CAPACITY');
    if(candidate.stageDraft){
      commitRetention(state,task,candidate.stageDraft);
      workspace.contextStage=candidate.stageDraft;
      const references=this.referencePlans.get(candidate);
      if(references){state.canvasGraphReferences[task.canvasId]=references.canvas;(state.sessionReferences??={})[session.id]=references.session;}
    }
  }
  previewState(state: AppSnapshot, task: Task, _protocol?: ProtocolMessage[], options: ContextBuildOptions|boolean = {}): ContextManifest {
    if(isMinimalSession(state.sessions.find(s=>s.id===task.sessionId)))return minimalPreview(state,task);
    const build=typeof options==='boolean'?{mode:options?'compact' as const:'append' as const}:options;
    const tools = state.provider.supportsTools ? toolDefinitions({ write: this.canWrite(task, state), graph: this.previewReadScope(state, task).size > 0, ...this.toolMode(task, state) }) : [];
    {
      const reading=this.canvasReadingState(task,state);
      const manifest=buildAutomaticContext(state,task,tools,reading.codec.encode,build);
      this.manifestReadDependencies.set(manifest,{...manifest.canvasReadHashes});
      let continuation=this.privateContinuations.get(task.sessionId);
      const fork=owner(state,task).promptFork;
      if(!continuation&&fork&&!manifest.contextMetrics?.rebuildReason){
        const source=this.privateContinuations.get(fork.sourceSessionId);
        if(source&&source.route===fork.stage.routeSignature&&source.generation===fork.stage.generation){
          const stepIds=new Set(fork.stage.entries.flatMap(e=>e.wireMessages??e.messages).flatMap(m=>m.stepId?[m.stepId]:[]));
          continuation={generation:source.generation,route:source.route,steps:new Map([...source.steps].filter(([id])=>stepIds.has(id)).map(([id,value])=>[id,structuredClone(value)]))};
        }
      }
      if(!manifest.contextMetrics?.rebuildReason&&continuation&&continuation.generation===manifest.stageDraft?.generation&&continuation.route===manifest.stageDraft?.routeSignature){
        for(const message of manifest.messages)if(message.role==='assistant'&&message.stepId){
          const prior=continuation.steps.get(message.stepId);
          if(prior){message.responseItems=structuredClone(prior.responseItems);message.reasoningContent=prior.reasoningContent;}
        }
      }
      const sample=inputTokenSample({...state.provider,...task.modelSelection},{messages:manifest.messages as Parameters<ModelCaller>[2]['messages'],tools});
      const estimate=this.inputEstimator(task.sessionId).estimate(sample);
      this.inputTokenSamples.set(manifest,sample);
      manifest.requestTokens=estimate.tokens;
      Object.assign(manifest.contextMetrics!,{rawRequestTokens:estimate.rawTokens,inputEstimateMethod:estimate.method,
        ...(estimate.matchedInputTokens===undefined?{}:{matchedInputTokens:estimate.matchedInputTokens})});
      if(manifest.stageDraft?.lastRequest){manifest.stageDraft.lastRequest.tokens=estimate.tokens;manifest.stageDraft.lastRequest.rawTokens=estimate.rawTokens;}
      if(manifest.memory)manifest.memory.occupancy=estimate.tokens/inputCapacity(state);
      const prefix=wirePrefixSnapshot({...state.provider,...task.modelSelection},{messages:manifest.messages as Parameters<ModelCaller>[2]['messages'],tools},
        manifest.contextMetrics!.stableMessageCount!,manifest.stageDraft!.generation);
      Object.assign(manifest.contextMetrics!,prefixMetrics(prefix,this.wirePrefixes.get(task.sessionId),manifest.contextMetrics?.rebuildReason));
      if(manifest.capacityEstimateError){delete manifest.error;delete manifest.capacityEstimateError;}
      if(manifest.requestTokens>inputCapacity(state)&&!manifest.error){
        manifest.error='传输请求的保守用量（含协议续传）超过可用输入容量，请整理后继续。';manifest.capacityEstimateError=true;
      }
      manifest.toolVersions=captureToolVersions(state,task,manifest,ref=>reading.codec.decode(ref,undefined,false));
      this.referencePlans.set(manifest,{canvas:reading.references,session:reading.sessionReferences});return manifest;
    }
    }
  private wait(task: Task, kind: Interaction['kind'], question: string, options: string[], payload?: Record<string, unknown>, changeSetId?: string) {
    task.status = 'waiting_user'; task.waitReason = question; task.waitingSince ??= Date.now();
    task.interaction = { id: id('interaction:'), version: 1, kind, question, options, payload, changeSetId };
    task.updatedAt = now(); this.repo.event(task.workspaceId, 'task.waiting', { interaction: task.interaction }, task.id);
  }
  private continueBudget(task: Task, overrides: { increaseSteps?: number; increaseTokens?: number } = {}): boolean {
    const reason = taskBudgetPauseReason(task, Boolean(this.repo.credential && this.repo.state.provider.model)) ?? exhaustedTaskBudget(task);
    if (!reason || !(RUN_BUDGET_REASONS as readonly string[]).includes(reason)) return false;
    const grant = defaultTaskBudget(this.repo.state.provider);
    task.maxSteps += bounded(overrides.increaseSteps, grant.maxSteps, 240);
    task.maxTokens += bounded(overrides.increaseTokens, grant.maxTokens, Math.max(3000000, grant.maxTokens));
    task.startedAt = now();
    this.repo.event(task.workspaceId, 'task.budget_extended', { reason, maxSteps: task.maxSteps,
      maxTokens: task.maxTokens, usedTokens: task.usedTokens }, task.id);
    return true;
  }
  private waitBudget(task: Task, reason: TaskBudgetReason, question: string, options: string[] = ['继续'], details: Record<string, unknown> = {}) {
    this.wait(task, 'budget', question, options, { ...details, budgetReason: reason,
      ...(reason === 'context_capacity' ? { capacityError: true } : {}) });
  }
  private rejectLegacyStructure(task: Task) {
    for (const call of this.repo.state.toolCalls.filter(call => call.taskId === task.id && call.status === 'waiting')) {
      call.status = 'rejected'; call.result = JSON.stringify({ status: 'error', code: 'AI_STRUCTURE_BOUNDARY', message: AI_STRUCTURE_BOUNDARY_MESSAGE });
      this.repo.event(task.workspaceId, 'tool.failed', { toolCallId: call.id, name: call.name }, task.id, call.stepId);
    }
    task.interaction = undefined; task.waitReason = undefined;
  }
  reply(payload: { taskId: string; interactionId: string; version: number; answer: string; choices?: Record<string, string>; increaseSteps?: number; increaseTokens?: number }) {
    const task = this.getTask(payload.taskId), interaction = task.interaction;
    requireValue(task.status === 'waiting_user' && interaction && interaction.id === payload.interactionId && interaction.version === payload.version, '这条交互请求已经处理或版本已变更', 'STALE_INTERACTION');
    const answer = text(payload.answer, '回复');
    this.repo.transaction(state => {
      if (interaction.kind === 'structure') {
        this.rejectLegacyStructure(task);
      }
      if (interaction.kind === 'question') {
        for (const call of state.toolCalls.filter(c => c.taskId === task.id && c.status === 'waiting')) { call.status = 'completed'; call.result = JSON.stringify({ status: 'answered' }); }
      }
      this.endIdle(task);
      if (interaction.kind === 'budget') {
        this.continueBudget(task, payload);
        if (interaction.payload?.capacityError) {
          // Explicit acknowledgement cannot make an oversized request fit; the next preview will verify again.
          task.error = undefined;
        }
        if (task.contextCapacity) task.contextCapacity.blockedPlan = undefined;
      }
      const response=this.message(task, 'user', answer, 'amendment');
      response.partSeq=this.repo.state.toolCalls.find(c=>c.taskId===task.id&&c.name==='interaction_ask'&&c.partSeq!==undefined&&c.stepId===task.checkpoint?.stepId)?.partSeq;
      task.instructionRevision++;response.instructionRevision=task.instructionRevision;
      delete task.pauseRequested;if(task.presentation)task.presentation.playbackPaused=false;this.endIdle(task);
      task.interaction = undefined; task.status = 'queued'; task.updatedAt = now(); this.repo.event(task.workspaceId, 'interaction.answered', { interactionId: interaction.id }, task.id);
    }); this.kick(); return task;
  }
  private async appendReadyTools(task: Task): Promise<boolean> {
    const protocol = task.checkpoint?.protocol; if (!protocol) return false;
    const requested = new Set(protocol.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
    const pending = this.repo.state.toolCalls.filter(call => call.taskId === task.id && requested.has(call.providerCallId)
      && !protocol.some(m => m.role === 'tool' && m.toolCallId === call.providerCallId));
    for (let index = 0; index < pending.length; index++) {
      if(this.parkPause(task))return true;
      const call = pending[index];
      if (call.status === 'waiting') return true;
      if (call.status === 'prepared') {
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(this.parkPause(task))return true;
        this.guard(task);
        const result = await this.executeTool(task, call);
        if ('waiting' in result && result.waiting) return true;
      }
      if (call.result !== undefined) this.repo.transaction(() => {
        task.checkpoint!.protocol.push({ role: 'tool', content: call.result!, toolCallId: call.providerCallId });
        this.repo.event(task.workspaceId, 'checkpoint.saved', { toolCallId: call.id }, task.id);
      });
    }
    return false;
  }
  private async run(taskId: string) {

    try {
      if(isMinimalSession(this.getSession(this.getTask(taskId).sessionId))){
        const task=this.getTask(taskId),route=promptRouteSignature({...this.repo.state.provider,...task.modelSelection});
        if(this.privateContinuations.get(task.sessionId)?.route!==route)this.privateContinuations.set(task.sessionId,{route,generation:0,steps:new Map()});
        await runMinimalChat(this.repo,taskId,this.modelCaller,this.webCaller,this.active.get(taskId)!.controller.signal,revision=>this.guard(this.getTask(taskId),revision),this.privateContinuations.get(task.sessionId)!.steps);
        if(isTerminal(this.getTask(taskId)))this.repo.transaction(state=>{
          settleSessionContext(state,task.sessionId);
          this.repo.event(task.workspaceId,'context.prompt_refreshed',{
            sessionId:task.sessionId,revision:owner(state,task).sessionContext?.settled?.revision,phase:'task_end',
          },task.id);
        });
        return;
      }
      while (true) {
        const task = this.getTask(taskId); this.guard(task);
        if(this.parkPause(task))return;
        if (await this.appendReadyTools(task)) return;
        if(isTerminal(task)){
          this.repo.transaction(state=>{
            // Include the sealed final response without submitting a new request, confirming
            // delivery, or committing maintenance just to update the navigation snapshot.
            const completed = this.previewState(state,task,undefined,{phase:'task_end'});
            settleSessionContext(state,task.sessionId,completed.stageDraft);
            this.repo.event(task.workspaceId,'context.prompt_refreshed',{
              sessionId:task.sessionId,revision:owner(state,task).sessionContext?.settled?.revision,phase:'task_end',
            },task.id);
          });
          return;
        }
        if(this.parkPause(task)||this.presentationGate(task))return;
        const recentSteps = this.repo.state.steps.filter(step => step.taskId === task.id && step.purpose === 'agent'
          && step.status === 'completed' && step.inputInstructionRevision === task.instructionRevision).slice(-2);
        const blockedPlan = (stepId: string) => {
          const calls = this.repo.state.toolCalls.filter(call => call.taskId === task.id && call.stepId === stepId);
          return calls.length && calls.every(call => {
            try { const result = JSON.parse(call.result ?? '{}'); return result.status === 'blocked' && ['OBJECT_TOO_LARGE', 'CONTEXT_CAPACITY'].includes(result.code); } catch { return false; }
          }) ? hash(calls.map(call => [call.name, call.arguments])) : undefined;
        };
        const plan = recentSteps.length === 2 ? blockedPlan(recentSteps[0].id) : undefined;
        const repeatedPlan = plan && plan === blockedPlan(recentSteps[1].id) ? plan : undefined;
        // Ask once per identical blocked plan. The user's "继续" then really continues: waiting
        // again on the same fingerprint would re-ask the same question forever.
        if (repeatedPlan && task.contextCapacity?.blockedPlan !== repeatedPlan) {
          this.repo.transaction(() => { task.contextCapacity ??= {}; task.contextCapacity.blockedPlan = repeatedPlan;
            this.waitBudget(task, 'context_capacity', '同一过大对象连续两次无法装入，已停止重复读取；请缩小目标或调整画布预算。', ['调整后继续']); }); return;
        }
        if (task.stepCount + (task.memoryCalls ?? 0) >= task.maxSteps || task.usedTokens >= task.maxTokens || Date.now() - Date.parse(task.startedAt!) > (task.maxDurationMs ?? 1800000)) {
          this.repo.transaction(() => { this.message(task, 'system', '任务达到运行预算，已保存进度；继续前可检查已提交修改并增加预算。', 'status'); this.waitBudget(task, exhaustedTaskBudget(task)!, '任务达到调用、用量或时间预算，是否继续？'); }); return;
        }
        const revision = task.instructionRevision;
        const protocol = structuredClone(task.checkpoint?.protocol??[]);
        if (revision > task.appliedInstructionRevision && protocol.length) {
          for (const message of this.repo.state.messages.filter(m => m.taskId === task.id && m.role === 'user' && (m.instructionRevision ?? 1) > task.appliedInstructionRevision)) {
            if (!protocol.some(m => m.role === 'user' && m.content === message.text)) protocol.push({ role: 'user', content: message.text });
          }
        }
        let manifest:ContextManifest;
        {
          manifest=await prepareAutomaticContext({repo:this.repo,task,caller:this.modelCaller,signal:this.active.get(taskId)!.controller.signal,
            guard:()=>this.guard(task,revision),build:(options={})=>this.previewState(this.repo.state,task,undefined,options)});
        }
        if(manifest.stageDraft&&!synchronizeRetentionStage(this.repo.state,task,manifest.stageDraft))continue;
        if (manifest.error) {
          this.repo.transaction(state => { state.contextManifests.push(storableManifest(manifest)); this.message(task, 'system', manifest.error!, 'status'); this.waitBudget(task, 'context_capacity', manifest.error!, ['调整上下文设置后继续']); }); return;
        }
        if (task.stepCount + (task.memoryCalls ?? 0) >= task.maxSteps) {
          this.repo.transaction(() => this.waitBudget(task, 'calls', '记忆整理已用尽本轮调用预算，请检查上下文或增加任务预算。')); return;
        }
        if (task.usedTokens + manifest.requestTokens + this.repo.state.provider.maxOutputTokens > task.maxTokens) {
          this.repo.transaction(() => this.waitBudget(task, 'tokens', '本次请求将超过剩余任务用量预算，请检查上下文或增加任务预算。', ['继续'], { requiredTokens: manifest.requestTokens + this.repo.state.provider.maxOutputTokens, remainingTokens: task.maxTokens - task.usedTokens })); return;
        }
        const stepId = id('step:'), messageId = id('msg:');
        const tools = this.repo.state.provider.supportsTools ? toolDefinitions({ write: this.canWrite(task), graph: this.allowedRead(task).size > 0, ...this.toolMode(task) }) : [];
        const baseProtocol:ProtocolMessage[] = protocol.length ? protocol : this.repo.state.messages.filter(m => m.taskId === task.id && m.role === 'user').map(m => ({ role: 'user' as const, content: m.text }));
        if(manifest.stageDraft&&manifest.stageDraft.generation!==owner(this.repo.state,task).contextStage?.generation){for(const m of baseProtocol){delete m.responseItems;delete m.reasoningContent;}}
        const submittedPrefix=manifest.stageDraft?wirePrefixSnapshot({...this.repo.state.provider,...task.modelSelection},
          {messages:manifest.messages as Parameters<ModelCaller>[2]['messages'],tools},manifest.contextMetrics!.stableMessageCount!,manifest.stageDraft.generation):undefined;
        if(submittedPrefix)Object.assign(manifest.contextMetrics!,prefixMetrics(submittedPrefix,this.wirePrefixes.get(task.sessionId),manifest.contextMetrics?.rebuildReason));
        const submitted=this.repo.transaction(state => {
          if(manifest.stageDraft&&!synchronizeRetentionStage(state,task,manifest.stageDraft))return false;
          const planned = this.referencePlans.get(manifest)!, existing = canvasGraphReferences(state, task.canvasId);
          if(existing && (!Object.entries(existing.aliases).every(([alias, real]) => planned.canvas.aliases[alias] === real)
            || !Object.keys(existing.next).every(prefix => planned.canvas.next[prefix as keyof typeof planned.canvas.next] >= existing.next[prefix as keyof typeof existing.next])))return false;
          const session = sessionGraphReferences(state, task.sessionId, true)!;
          if(!Object.entries(session.aliases).every(([alias, real]) => planned.session.aliases[alias] === real)
            || !Object.keys(session.next).every(prefix => planned.session.next[prefix as keyof typeof planned.session.next] >= session.next[prefix as keyof typeof session.next]))return false;
          Object.defineProperty(state.canvasGraphReferences, task.canvasId, { value: planned.canvas, enumerable: true, writable: true, configurable: true });
          Object.assign(session, planned.session);
          const maintenance=manifest.stageDraft?.metrics&&manifest.stageDraft.generation!==owner(state,task).contextStage?.generation
            ?{generation:manifest.stageDraft.generation,...manifest.stageDraft.metrics,
              exitedTaskIds:(owner(state,task).sessionContext?.residentTaskIds??[]).filter(id=>!manifest.stageDraft!.residentTaskIds?.includes(id)),
              directory:{entries:manifest.stageDraft.directoryAreas?.cache.entries.length??0,
                evictedIds:(owner(state,task).contextStage?.directoryAreas?.cache.entries??[]).map(e=>e.id)
                  .filter(id=>!manifest.stageDraft!.directoryAreas?.cache.entries.some(e=>e.id===id))},
              attachments:manifest.contextMetrics?.summaryRegions,
              historicalSummaryCounts:{...owner(state,task).sessionContext?.historicalSummaryCounts}}:undefined;
          manifest.stepId = stepId; state.contextManifests.push(storableManifest(manifest)); task.appliedInstructionRevision = revision; task.stepCount++;
          if (task.contextCapacity?.organizing) task.contextCapacity.grantedStep = task.stepCount;
          if(manifest.stageDraft)commitRetention(state,task,manifest.stageDraft);
          state.steps.push({ id: stepId, taskId: task.id, runId: task.activeRunId!, ordinal: task.stepCount, purpose: 'agent', status: 'streaming',
            inputInstructionRevision: revision, contextManifestId: manifest.id, provider: state.provider.protocol, model: task.modelSelection?.model ?? state.provider.model, createdAt: now() });
          state.messages.push({ id: messageId, taskId: task.id, workspaceId: task.workspaceId, role: 'assistant', text: '', version: 1, status: 'streaming',
            phase: 'progress', createdAt: now(), targetRefs: [], relatedOperationIds: [], sourceRefs: [], instructionRevision: revision, stepId });
          
          if(manifest.stageDraft){
            const status=owner(state,task).inheritanceStatus;
            if(status&&task.stepCount===1&&!state.steps.some(s=>s.taskId!==task.id&&state.tasks.some(t=>t.id===s.taskId&&t.sessionId===task.sessionId))){
              status.reused=status.eligible&&!manifest.contextMetrics?.rebuildReason;
              if(status.eligible&&!status.reused)status.reason=manifest.contextMetrics?.rebuildReason??'提示词容量或协议不兼容';
            }
            owner(state,task).frozenReads=planFrozenReads(state,task,manifest.stageDraft).reads;
            delete manifest.stageDraft.frozenReadDrafts;
            const previousGeneration=owner(state,task).contextStage?.generation;
            owner(state,task).contextStage=manifest.stageDraft;
            commitTaskNoticeBatch(state,task,manifest.stageDraft);
            if(previousGeneration!==manifest.stageDraft.generation){
              const fresh=manifest.stageDraft.baselineObservations??[];owner(state,task).observations=(owner(state,task).observations??[]).filter(o=>!o.structureOnly&&!fresh.some(n=>n.callId&&n.callId===o.callId)).concat(fresh);
            }
            owner(state,task).observations=retainedDirectoryObservations(manifest.stageDraft,owner(state,task).observations??[]);
            // Incremental update bodies are observations only after this exact prompt is submitted.
            for(const observation of manifest.stageDraft.baselineObservations??[])
              if(!owner(state,task).observations?.some(o=>o.id===observation.id))(owner(state,task).observations??=[]).push(observation);
            const source=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
            const session=state.sessions.find(s=>s.id===task.sessionId)!;
            if(source)task.notebookBinding={id:source.id,revision:session.temporaryContext?.revision??1};
            // Publish the chosen prompt with this submission, so task exits and range
            // changes reach the navigation immediately, even during a long-running task.
            settleSessionContext(state,task.sessionId,manifest.stageDraft);
          }
          // The graph can change after request construction. Bind exactly what this request contains.
          rememberGraphReadHashes(task,this.manifestReadDependencies.get(manifest)??{});
          task.responseReadHashes={stepId,hashes:{...this.manifestReadDependencies.get(manifest)},observations:structuredClone(manifest.canvasChecks??[])};
          task.checkpoint = { stepId, operationIds: task.checkpoint?.operationIds ?? [], protocol: baseProtocol, instructionRevision: revision, lastSeq: state.lastSeq };
          this.repo.event(task.workspaceId, 'task.input_applied', { instructionRevision: revision }, task.id);
          if(maintenance)this.repo.event(task.workspaceId,'context.maintenance',maintenance,task.id,stepId);
          if(manifest.contextMetrics?.prefixBreakReason==='unexpected_mutation')this.repo.event(task.workspaceId,'context.prefix_changed',{
            reason:'unexpected_mutation',generation:manifest.contextMetrics.generation,firstChangedMessageIndex:manifest.contextMetrics.firstChangedMessageIndex,
          },task.id,stepId);
          state.messages.find(message => message.id === messageId)!.sequence = this.repo.event(task.workspaceId, 'step.started', { stepId }, task.id, stepId).globalSeq;
          return true;
        });
        if(!submitted)continue;
        // Only a committed submission advances the baseline. Previews and failed commits
        // must not change either the wire comparison or provider continuation generation.
        if(submittedPrefix){
          this.wirePrefixes.set(task.sessionId,submittedPrefix);
          const prior=this.privateContinuations.get(task.sessionId);
          if(manifest.contextMetrics?.rebuildReason||prior?.generation!==submittedPrefix.generation||prior.route!==submittedPrefix.route)
            this.privateContinuations.set(task.sessionId,{generation:submittedPrefix.generation,route:submittedPrefix.route,steps:new Map()});
        }
        const active = this.active.get(taskId)!;
        active.controller = new AbortController();
        let result: ModelResponse;
        // A commit deep-clones the whole state, diffs every stored record and pushes a full
        // snapshot to the UI, so streaming text is buffered and committed in batches instead of
        // once per frame. A retry or an aborted call simply drops what is still buffered.
        let buffered = '', lastFlush = Date.now(), flushTimer: ReturnType<typeof setTimeout> | undefined;
        const flushDeltas = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
          if (!buffered) return; const text = buffered; buffered = ''; lastFlush = Date.now();
          // Only onDelta accepts bytes, and fences late arrivals. Already accepted bytes survive stop.
          if (!this.repo.state.tasks.some(t => t.id === taskId && t.fencingToken === active.fence)) return;
          this.repo.transaction(state => { const message = state.messages.find(m => m.id === messageId); if (message) message.text += text;
            state.lastSeq++; }); };
        try {
          const remainingTime = Math.max(1, (task.maxDurationMs ?? 1800000) - (Date.now() - Date.parse(task.startedAt!)));
          result = await this.modelCaller({ ...this.repo.state.provider, ...task.modelSelection, supportsVision:attachmentVision(this.repo.state.provider,task.modelSelection?.model), timeoutMs: Math.min(this.repo.state.provider.timeoutMs, remainingTime) }, this.repo.credential, { messages: manifest.messages as Parameters<ModelCaller>[2]['messages'], tools }, {            signal: active.controller.signal, resolveImage:image=>imageAssetData(this.repo.artifactDirectory!,image),
            onDelta: delta => {
              const current = this.repo.state.tasks.find(t => t.id === taskId); if (!current || current.instructionRevision !== revision || current.fencingToken !== active.fence) return;
              if (!delta) return;
              buffered += delta;
              if (buffered.length >= DELTA_COMMIT_BYTES || Date.now() - lastFlush >= DELTA_COMMIT_MS) flushDeltas();
              // A quiet stream must not leave text invisible: commit it on a timer as well.
              else if (!flushTimer) flushTimer = setTimeout(flushDeltas, DELTA_COMMIT_MS);
            },
          });
          this.guard(this.getTask(taskId), revision);
          flushDeltas();
        } catch (cause) {
          flushDeltas();
          if (!this.repo.state.tasks.some(t => t.id === taskId)) return;
          const current = this.getTask(taskId);
          if (this.reviewRestarts.has(taskId)) {
            this.repo.transaction(() => { current.usedTokens += manifest.requestTokens; this.repo.event(current.workspaceId, 'step.aborted', { reason: '用户回退使旧请求失效' }, current.id, stepId); });
            return;
          }
          if (this.shuttingDown || current.status === 'paused' || isTerminal(current)) return;
          this.repo.transaction(state => {
            // The prompt was already sent, so a failed or retried attempt still spends budget;
            // otherwise `maxTokens` would not bound spending at all.
            current.usedTokens += manifest.requestTokens;
            const step = state.steps.find(s => s.id === stepId)!; step.status = current.instructionRevision !== revision ? 'aborted' : 'failed';
            step.error = cause instanceof Error ? cause.message : '模型调用失败';
            const message = state.messages.find(m => m.id === messageId)!; message.status = 'incomplete';
            this.repo.event(task.workspaceId, `step.${step.status}`, { error: step.error,
              ...(cause instanceof ProviderError ? { providerError: cause.toJSON() } : {}) }, task.id, stepId);
          });
          if (current.instructionRevision !== revision) continue;
          const failedSample=this.inputTokenSamples.get(manifest);
          if(cause instanceof ProviderError&&cause.code==='context_limit'&&failedSample
            &&manifest.contextMetrics?.inputEstimateMethod!=='local'){
            // A rejected calibrated request is charged above. Fall back once to
            // local counting; this route/tool set cannot learn another discount.
            this.inputEstimator(current.sessionId).reject(failedSample);
            this.repo.transaction(()=>this.repo.event(current.workspaceId,'context.input_calibration_rejected',
              {rawTokens:failedSample.rawTokens,estimatedTokens:manifest.requestTokens},current.id,stepId));
            continue;
          }
          if (cause instanceof ProviderError && cause.retryable && (current.retryCount ?? 0) < 3) {
            current.retryCount = (current.retryCount ?? 0) + 1;
            current.modelRetryHint = cause.code === 'tool_arguments' ? { code: 'tool_arguments', instructionRevision: revision } : undefined;
            this.repo.transaction(() => { current.status = 'waiting_retry'; this.repo.event(task.workspaceId, 'task.waiting_retry', { attempt: current.retryCount }, task.id); });
            const delay = Math.max(250 * 2 ** current.retryCount, cause.retryAfterMs ?? 0);
            if (Date.now() + delay - Date.parse(current.startedAt!) > (current.maxDurationMs ?? 1800000)) {
              this.repo.transaction(() => this.waitBudget(current, 'time', '提供方建议的重试时间已超过本任务剩余时间预算。')); return;
            }
            // No graph lock is held during backoff; release the scheduling claim and requeue.
            for (const resource of active.resources) if (this.claims.get(resource) === task.id) this.claims.delete(resource);
            active.resources = []; this.kick();
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); active.controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
            if (this.shuttingDown || this.getTask(taskId).status === 'paused') return;
              this.repo.transaction(() => { current.status = current.pauseRequested?'paused':'queued'; current.updatedAt = now(); }); return;
          }
          throw cause;
        }
        const current = this.getTask(taskId);
        if(current.instructionRevision!==revision){
          this.repo.transaction(state=>{
            const step=state.steps.find(s=>s.id===stepId)!;step.status='aborted';
            const message=state.messages.find(m=>m.id===messageId)!;message.status='incomplete';
            current.usedTokens+=(result.inputTokens??manifest.requestTokens)+(result.outputTokens??estimateTokens(result.text));
            this.repo.event(task.workspaceId,'step.aborted',{reason:'用户补充后旧响应已失效'},task.id,stepId);
          });continue;
        }
        this.guard(current,revision);
        const measuredSample=this.inputTokenSamples.get(manifest);
        const calibrationAccepted=!!measuredSample&&this.inputEstimator(current.sessionId).accepts(measuredSample,result.inputTokens);
        this.repo.transaction(state => {
          const step = state.steps.find(s => s.id === stepId)!; step.status = 'completed';
          acknowledgeDeletedGraphReads(this.graph(),current,state.toolCalls,manifest.messages);
          {
            markPresented(state,current,manifest.messages,[],manifest.readBodyResultIds??[]);
            const stage=owner(state,current).contextStage;if(stage){
              stage.sentIds=[...stage.eventIds];
            }
            const stored=state.contextManifests.find(m=>m.id===manifest.id);
            if(stored?.contextMetrics&&result.cachedInputTokens!==undefined){stored.contextMetrics.cachedInputTokens=result.cachedInputTokens;stored.contextMetrics.cacheStatus='known';}
            if(stored?.contextMetrics){stored.contextMetrics.reportedInputTokens=result.inputTokens;stored.contextMetrics.inputCalibrationAccepted=calibrationAccepted;}
            if(calibrationAccepted&&stage?.lastRequest&&stage.generation===manifest.stageDraft?.generation
              &&stage.lastRequest.hash===manifest.stageDraft.lastRequest?.hash){
              stage.lastRequest.tokens=observedInputUpperBound(result.inputTokens!);
              stage.lastRequest.reportedInputTokens=result.inputTokens;
              if(stage.metrics&&manifest.contextMetrics?.rebuildReason==='compaction'){
                stage.metrics.observedAfter=result.inputTokens;
                stage.metrics.observedHeadroomTokens=Math.max(0,(stage.metrics.triggerTokens??0)-stage.lastRequest.tokens);
              }
            }
          }
          current.retryCount = 0;
          delete current.modelRetryHint;
          step.providerResponseId = result.providerResponseId;
          step.transport = result.transport;
          current.usedTokens += (result.inputTokens ?? manifest.requestTokens) + (result.outputTokens ?? estimateTokens(result.text));
          const message = state.messages.find(m => m.id === messageId)!; message.text = result.text; message.status = 'complete';
          current.checkpoint!.protocol.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls.length ? result.toolCalls : undefined, responseItems: result.responseItems, reasoningContent: result.reasoningContent, stepId });
          for (const call of result.toolCalls) state.toolCalls.push({ id: id('tool:'), providerCallId: call.id, taskId: current.id, stepId,
            operationId: id('op:'), name: call.name, arguments: call.arguments, argumentVersion: 2, status: 'prepared', createdAt: now() });
          step.completedSequence=this.repo.event(task.workspaceId, 'step.completed', { stepId }, task.id, stepId).globalSeq;
          acknowledgeReadDelivery(state,manifest,step);
          this.repo.event(task.workspaceId, 'message.completed', { messageId }, task.id, stepId);
        });
        if(measuredSample&&calibrationAccepted)this.inputEstimator(current.sessionId).observe(measuredSample,result.inputTokens);
        if(submittedPrefix&&promptRouteSignature({...this.repo.state.provider,...current.modelSelection})===submittedPrefix.route){
          const continuation=this.privateContinuations.get(current.sessionId);
          if(continuation?.generation===submittedPrefix.generation&&continuation.route===submittedPrefix.route)
            continuation.steps.set(stepId,structuredClone({responseItems:result.responseItems,reasoningContent:result.reasoningContent}));
        }
        current.noProgressCount = result.toolCalls.length && result.toolCalls.some(c=>!['ui_focus','ui_present','br'].includes(c.name)) ? 0 : (current.noProgressCount??0)+1;
        if(current.noProgressCount>=5)throw new DomainError('连续回复未推进任务，已暂停。完成时请调用 task_finish。','NO_PROGRESS');
        // A text response completes only this model step; task_finish owns task completion.
      }
    } catch (cause) {
      if (!this.repo.state.tasks.some(t => t.id === taskId)) return;
      const task = this.getTask(taskId);
      if (this.reviewRestarts.has(taskId)) return;
      if (this.shuttingDown || task.status === 'paused' || isTerminal(task)) return;
      this.repo.transaction(() => {
        if (cause instanceof DomainError && cause.code === 'RESOURCE_CHANGED') {
          for (const call of this.repo.state.toolCalls.filter(call => call.taskId === task.id && call.status === 'prepared')) {
            call.status = 'rejected'; call.result = JSON.stringify({ status: 'rejected', reason: '画布共享资源已变化，请重新读取后规划' });
          }
          task.readHashes = {}; task.status = 'queued'; task.updatedAt = now();
          this.repo.event(task.workspaceId, 'task.resources_changed', {}, task.id);
        } else if (cause instanceof DomainError && cause.code === 'INSTRUCTION_CHANGED') {
          // A supplement arrived while this step's calls were in flight: the user's message is
          // kept and the same task re-plans against it instead of dying with it.
          for (const call of this.repo.state.toolCalls.filter(call => call.taskId === task.id && ['prepared', 'waiting'].includes(call.status))) {
            call.status = 'rejected'; call.result = JSON.stringify({ status: 'rejected', reason: '用户补充已接收，旧指令下的调用已作废，请按最新要求重新规划' });
          }
          task.interaction = undefined; task.status = 'queued'; task.updatedAt = now();
          this.repo.event(task.workspaceId, 'task.replanned', { instructionRevision: task.instructionRevision }, task.id);
        } else { this.parkFailure(task,cause instanceof Error?cause.message:'执行失败'); }
      });
    }
  }

  // Tool arguments must be complete; all local effects and tool receipts share a transaction.
  private async executeTool(task: Task, call: ToolCallRecord): Promise<Record<string, unknown> | Waiting> {
    if (isWebTool(call.name)) return this.executeWebTool(task, call);
    const rawArgs = JSON.parse(call.arguments) as Record<string, unknown>;
    let result: Record<string, unknown> | Waiting = {};
    // A tool call is one savepoint. Its preconditions are checked before anything runs, so a
    // failure in a later step of the same call cannot leave a half-applied effect behind.
    requireValue(this.repo.state.sessions.some(session => session.id === task.sessionId && session.lifecycle === 'active') && this.repo.state.graph,
      '会话已归档或画布不可用，本次调用未执行', 'NOT_FOUND');
    let preparationError: unknown;
    let preparedImages:import('../attachments').ImageAssetRef[]|undefined;
    if(call.name==='workspace_view_artifact')try{
      this.guard(task);
      const codec=graphReferenceCodec(this.graph(),canvasGraphReferences(this.repo.state,task.canvasId,true)!,sessionGraphReferences(this.repo.state,task.sessionId,true)!);
      const raw=translateGraphPayload(rawArgs,ref=>codec.decode(ref)) as Record<string,unknown>;
      const args=bindToolVersions(this.repo.state,task,call,raw);
      const definition=toolDefinitions({write:false,graph:true}).find(t=>t.name===call.name)!;validateToolCallArguments(call.name,withoutToolVersions(call.name,args),definition.parameters);
      requireValue(attachmentVision(this.repo.state.provider,task.modelSelection?.model),'当前执行模型未配置视觉能力','VISION_UNSUPPORTED');
      requireValue(this.repo.artifactDirectory,'附件目录未配置','IMAGE_UNAVAILABLE');
      preparedImages=await renderArtifactImages(resolveAttachment(this.repo.state,task,args.artifactId,args.version),this.repo.artifactDirectory,attachmentLimits(this.repo.state),{...args,signal:this.active.get(task.id)?.controller.signal});
    }catch(error){preparationError=error;}

    if (call.name === 'graph_propose_changes') {
      try {
        this.guard(task);
        const codec = graphReferenceCodec(this.graph(), canvasGraphReferences(this.repo.state, task.canvasId, true)!, sessionGraphReferences(this.repo.state, task.sessionId, true)!);
        const args = translateGraphPayload(rawArgs, ref => codec.decode(ref)) as Record<string, unknown>;
        const definition = toolDefinitions({ write: this.canWrite(task), graph: true, ...this.toolMode(task) }).find(t => t.name === call.name);
        requireValue(definition, '当前任务不允许写图', 'READ_ONLY');
        validateToolCallArguments(call.name, args, definition.parameters);
        this.proposalPlans.set(call.id, await this.prepareProposal(task, args));
      } catch (error) { preparationError = error; }
    }
    try { this.repo.transaction(state => {
      this.guard(task, state.steps.find(step => step.id === call.stepId)?.inputInstructionRevision);
      if (call.sequence === undefined) {
        call.startedAt = now(); call.sequence = this.repo.event(task.workspaceId, 'tool.started', { toolCallId: call.id, name: call.name }, task.id, call.stepId).globalSeq;
      }
      try {
        if (preparationError) throw preparationError;
        const references = canvasGraphReferences(state, task.canvasId, true)!;
        const sessionReferences = sessionGraphReferences(state, task.sessionId, true)!;
        const codec = graphReferenceCodec(this.graph(), references, sessionReferences);
        const args = translateGraphPayload(rawArgs, ref => codec.decode(ref)) as Record<string, unknown>;
        // Storage keeps real ids, exactly like a result does: the model may have written short
        // references, and every reader of a saved call — the UI, previews, later requests — needs
        // the record identity. The prompt re-encodes them when it renders the call again.
        call.arguments = JSON.stringify(args);
        result = this.tool(task, call, args, preparedImages);
        if ('waiting' in result && result.waiting) { call.status = 'waiting'; return; }
        const updated = graphReferenceCodec(this.graph(), references, sessionReferences);
        result = translateGraphPayload(result, (ref, hint) => {
          // Stored results keep real ids. Attachment, note, handle, message and tool-call ids are
          // addressed by a short reference only in prompts, so they never enter saved receipts.
          if (updated.isAddressable(ref)) return ref;
          const patches = state.changes.filter(change => change.taskId === task.id).flatMap(change => change.patches);
          const patch = patches.find(patch => patch.id === ref);
          const directory = patches.some(patch => patch.collection === 'canvases' && (patch.after as { directories?: Record<string, unknown> } | null)?.directories?.[ref]);
          const derived = patch?.collection === 'nodes' ? 'node' : patch?.collection === 'edges' ? 'edge' : patch?.collection === 'documents' || directory ? 'document' : undefined;
          // Only canvas identities are aliased in stored results; other ids stay raw in
          // storage and are given short references only when the prompt is built.
          const kind = hint && ['node', 'document', 'edge'].includes(hint) ? hint : derived;
          return kind ? updated.encode(ref, kind, true) : ref;
        }) as Record<string, unknown>;
        
        if(isDataRead(call.name)&&result&&typeof result==='object')Object.assign(result,{originResultId:call.id});
        call.originResultId??=call.id;
        call.status = 'completed'; call.result = JSON.stringify(result);
        call.result=JSON.stringify({...result,blockId:call.id});
        this.repo.event(task.workspaceId, 'tool.completed', { toolCallId: call.id, name: call.name }, task.id, call.stepId);
      } catch (cause) {
        if (cause instanceof DomainError && ['RUN_INVALID', 'INSTRUCTION_CHANGED', 'RESOURCE_CHANGED', 'SCOPE_CHANGED'].includes(cause.code)) throw cause;
        call.status = 'rejected'; call.result = JSON.stringify({ status: 'error', code: cause instanceof DomainError ? cause.code : 'TOOL_ERROR', message: cause instanceof Error ? cause.message : '工具执行失败',
          ...(cause instanceof DomainError && cause.details !== undefined ? {details:cause.details} : {}) });
        result = JSON.parse(call.result); this.repo.event(task.workspaceId, 'tool.failed', { toolCallId: call.id, name: call.name }, task.id, call.stepId);
      }
    }); } finally { this.proposalPlans.delete(call.id); } return result;
  }
  /** Network I/O never holds the repository transaction. Every receipt keeps the original call id. */
  private async executeWebTool(task: Task, call: ToolCallRecord): Promise<Record<string, unknown>> {
    if (call.status !== 'prepared') return JSON.parse(call.result ?? '{}');
    const revision = this.repo.state.steps.find(step => step.id === call.stepId)?.inputInstructionRevision ?? task.instructionRevision;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: Record<string, unknown>, rejected = false) => this.repo.transaction(() => {
      call.originResultId = call.id; call.status = rejected ? 'rejected' : 'completed';
      call.result = JSON.stringify({ ...result, originResultId: call.id, blockId: call.id });
      this.repo.event(task.workspaceId, rejected ? 'tool.failed' : 'tool.completed', { toolCallId: call.id, name: call.name }, task.id, call.stepId);
      return result;
    });
    try {
      this.guard(task, revision);
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      const definition = toolDefinitions({ write: false, graph: false, ...this.toolMode(task) }).find(t => t.name === call.name);
      requireValue(definition, '当前设置或模式没有开放联网工具', 'TOOL_NOT_ALLOWED');
      validateToolArguments(args, definition.parameters); webRequest(call.name, args);
      const limits = directReadBudgets(this.repo.state, task, call), budget = Math.min(limits.pageBudget, limits.availableTokens);
      if (budget < WEB_MIN_READ_TOKENS) return finish(readCapacityReceipt(call, args, budget, WEB_MIN_READ_TOKENS, { limits, usePageBudget: true, minimumOnly: true }));
      const remainingTime = (task.maxDurationMs ?? 1800000) - (Date.now() - Date.parse(task.startedAt ?? now()));
      requireValue(remainingTime > 0, '任务已达到运行时间预算', 'WEB_TIMEOUT');
      const controller = new AbortController(), active = this.active.get(task.id)!;
      active.controller = controller;
      const fence = task.fencingToken;
      const invalidate = () => {
        const current = this.repo.state.tasks.find(t => t.id === task.id);
        if (this.shuttingDown || !current || current.status !== 'running' || current.pauseRequested
          || current.fencingToken !== fence || current.instructionRevision !== revision
          || !this.repo.state.sessions.some(s => s.id === task.sessionId && s.lifecycle === 'active')) controller.abort();
      };
      unsubscribe = this.repo.subscribe(invalidate);
      this.repo.transaction(() => {
        this.guard(task, revision);
        call.startedAt = now(); call.sequence ??= this.repo.event(task.workspaceId, 'tool.started', { toolCallId: call.id, name: call.name }, task.id, call.stepId).globalSeq;
      });
      invalidate();
      const data = await this.webCaller(this.repo.state.provider, this.repo.credential, call.name, args,
        { signal: controller.signal, timeoutMs: Math.min(60000, remainingTime), connection: this.repo.webConnection });
      this.guard(task, revision);
      requireValue(!controller.signal.aborted, '联网读取已中断，未保留返回数据', 'WEB_INTERRUPTED');
      return this.repo.transaction(state => {
        this.guard(task, revision);
        requireValue(webAccessEnabled(state.provider), '联网功能已关闭', 'TOOL_NOT_ALLOWED');
        try { return finish(freezeWebRead(state, task, call, data)); }
        catch (error) {
          // Packing validates before storing a snapshot. Keep resource failures local
          // so a rollback cannot detach the executor's task/call references.
          if (!(error instanceof DomainError)) throw error;
          return finish({ status: 'error', code: error.code, message: error.message }, true);
        }
      });
    } catch (cause) {
      // Record only an interruption if the run changed. In particular, never commit late content.
      let invalid: unknown;
      try { this.guard(task, revision); } catch (error) { invalid = error; }
      const error = invalid ? new DomainError('联网读取已中断，未保留返回数据；如仍需要，请重新调用。', 'WEB_INTERRUPTED')
        : cause instanceof DomainError ? cause : new DomainError('联网工具执行失败', 'WEB_TOOL_ERROR');
      const result = { status: 'error', code: error.code, message: error.message };
      if (this.repo.state.toolCalls.some(c => c === call && c.status === 'prepared')) finish(result, true);
      if (invalid) throw invalid;
      return result;
    } finally { unsubscribe?.(); }
  }
  private tool(task: Task, call: ToolCallRecord, args: Record<string, unknown>, images?: import('../attachments').ImageAssetRef[]): Record<string, unknown> | Waiting {
    const graph = this.graph(), readScope = this.allowedRead(task);
    const definition = toolDefinitions({ write: this.canWrite(task), graph: readScope.size > 0, ...this.toolMode(task) }).find(tool => tool.name === call.name);
    requireValue(definition, '当前模式或任务没有开放该工具', 'TOOL_NOT_ALLOWED');
    validateToolCallArguments(call.name, withoutToolVersions(call.name,args), definition.parameters);
    args=bindToolVersions(this.repo.state,task,call,args);
    if(ATTACHMENT_TOOLS.has(call.name))return attachmentRead(this.repo.state,task,call,args,images);
    if (call.name === 'br') return { status: 'ok' };
    {
      if(call.name==='graph_read_design_references'){assertDesignQuery(this.repo.state,task);return graphQueryRead(this.repo.state,task,call,args);}
      if(call.name==='graph_search_node_content'||call.name==='graph_search'&&args.output==='cards')return graphQueryRead(this.repo.state,task,call,args);
      if(['context_view','context_read_children','context_read_summary_tree','context_read_pages','context_read_task','context_read_steps','context_restore_records'].includes(call.name))return directContextRead(this.repo.state,task,call,args);
      if(['graph_read_directory','graph_read_subgraph','graph_read','graph_neighbors','graph_search','graph_read_node_content','graph_read_directory_content','graph_read_node_edges','graph_read_object_field','graph_read_subgraph_edges','graph_read_between_subgraphs'].includes(call.name)){
        if(call.name==='graph_read_object_field'){
          const codec=graphReferenceCodec(graph,canvasGraphReferences(this.repo.state,task.canvasId,true)!,sessionGraphReferences(this.repo.state,task.sessionId,true)!);
          return directGraphRead(this.repo.state,task,call,args,value=>translateGraphPayload(value,codec.encode));
        }
        return directGraphRead(this.repo.state,task,call,args);
      }
    }
    const graphRefs = (value: unknown) => { const refs = strings(value, '对象引用', 200); assertAiObjectRefs(graph, refs); requireValue(refs.every(ref => readScope.has(ref)), '读取超出当前画布范围', 'OUT_OF_SCOPE'); return refs; };
    if (call.name === 'workspace_update_work_notes') {
      const refs = withNoteProvenance(this.repo.state, this.validateSources(task, args.sourceRefs, call.stepId));
      const value = text(args.text, '工作笔记', 12000);
      requireValue(['goal', 'constraint', 'finding', 'result', 'question', 'next'].includes(String(args.type)), '笔记类型无效');
      const result = writeAiNote(this.repo.state, task, { noteId: args.noteId as string | undefined, expectedVersion: args.expectedVersion as number | undefined,
        text: value, type: args.type as 'finding', lifecycle: 'multi_task', sourceRefs: refs, receiptId: call.operationId });
      call.noteWriteAcknowledgement = { notebookId: writableNotebook(this.repo.state, task.sessionId).id, noteId: result.noteId, version: result.version };
      this.repo.event(writableNotebook(this.repo.state, task.sessionId).id, 'notes.updated', result, task.id, call.stepId);
      return result;
    }
    if (call.name === 'workspace_delete_work_notes') {
      const workspace = writableNotebook(this.repo.state, task.sessionId);
      if (this.getSession(task.sessionId).mode === 'temporary') {
        const request = this.repo.state.messages.filter(m => m.taskId === task.id && m.role === 'user').at(-1)?.text ?? '';
        const explicit = request.split(/[。！？!?\n；;，,]/).some(sentence =>
          /删除|删掉|移除|delete|remove/i.test(sentence) && /笔记|摘要|交付|注意事项|这[一几]?条|这些|第.{1,8}条|notes?|summar|deliver/i.test(sentence)
          && !/不要|不许|禁止|别|不删|不能|do\s+not|don't|never|cannot/i.test(sentence));
        requireValue(explicit, '临时会话删除共享笔记须有用户的明确删除要求', 'USER_REQUEST_REQUIRED');
      }
      const beforeNotes = structuredClone(workspace.workNotes);
      mutateNotebook(this.repo.state, task.sessionId, target => deleteNotebookEntry(this.repo.state, target, text(args.id, '笔记 ID'), args.expectedVersion as number));
      queueNotebookNotices(this.repo.state,workspace,'work',beforeNotes,task.sessionId);
      this.repo.event(workspace.id, 'notes.deleted', { id: args.id }, task.id, call.stepId);
      return { status: 'ok', id: args.id };
    }
    if (call.name === 'workspace_update_handoff') {
      const body = text(args.text, '任务笔记', HANDOFF_LIMIT);
      // The submitted input owns this precondition, not the model or live state.
      if(args.expectedVersion!==undefined?args.expectedVersion!==(task.handoff?.version??0):!!task.handoff){
        const progress=owner(this.repo.state,task).progressEvents?.filter(p=>p.taskId===task.id&&p.version===(task.handoff?.version??0)).at(-1);
        throw new DomainError('本次请求后已追加新的任务笔记，或旧请求缺少系统绑定；本次未追加，请核对最新记录。',
          'VERSION_CONFLICT',400,{reason:'version_mismatch',
            currentVersion:task.handoff?.version??0,executed:false,nextAction:'review_latest_progress_before_retry',
            ...(progress?{readWith:{tool:'context_read_children',arguments:{summaryId:progress.id}}}:{}),
            instruction:'已发生的读取、核验及提交不因笔记追加失败而撤销。核对最新任务笔记与后续实际结果后，重试追加仍需记录的内容，无需重写此前笔记；系统自动绑定版本，无需填写。无法重试时仍按实际证据汇报，不能照抄旧笔记。'});
      }
      const sourceRefs=args.sourceRefs?this.validateSources(task,args.sourceRefs,call.stepId):[];
      {
        const usedTokens=estimateTokens(JSON.stringify({taskId:task.id,text:body,sourceRefs,version:(task.handoff?.version??0)+1})),limitTokens=Math.floor(inputCapacity(this.repo.state)*.02);
        requireValue(usedTokens<=limitTokens,'本条任务笔记超过容量预算，请缩短正文','PROGRESS_LIMIT',
          {usedTokens,limitTokens,remainingTokens:Math.max(0,limitTokens-usedTokens),excessTokens:Math.max(0,usedTokens-limitTokens),executed:false,
            nextAction:'shorten_progress_preserving_required_sources'});
      }
      task.handoff = { text: body, version: (task.handoff?.version ?? 0) + 1 };
      (owner(this.repo.state,task).progressEvents??=[]).push({id:`progress:${call.operationId}`,taskId:task.id,text:body,
        version:task.handoff.version,sequence:call.sequence??this.repo.state.lastSeq,createdAt:now(),sourceRefs});
      return { status: 'ok', version: task.handoff.version };
    }
    if (call.name === 'task_finish') {
      const group=this.repo.state.toolCalls.filter(c=>c.taskId===task.id&&c.stepId===call.stepId);
      requireValue(group.at(-1)?.id===call.id && group.filter(c=>c.id!==call.id).every(c=>['completed','rejected'].includes(c.status)), '结束回复必须是调用组最后一项，且前序调用已结算。','TASK_PENDING');
      requireValue(!task.interaction && task.instructionRevision===this.repo.state.steps.find(s=>s.id===call.stepId)?.inputInstructionRevision,'还有未处理的用户补充或问题。','INSTRUCTION_CHANGED');
      if(args.basis!=='historical'){
        const input=this.repo.state.contextManifests.find(m=>m.taskId===task.id&&m.stepId===call.stepId);
        const expected=task.responseReadHashes?.stepId===call.stepId?task.responseReadHashes.hashes:input?.canvasReadHashes??{};
        assertGraphReadHashes(graph,expected,'最终回复依据在生成期间已变化，请核对最新内容后再结束',task.canvasId);
        const observations=task.responseReadHashes?.stepId===call.stepId?task.responseReadHashes.observations:input?.canvasChecks;
        const graphChanges=(observations??[]).flatMap(o=>canvasObservationChanges(this.repo.state,o));
        requireValue(!graphChanges.length,'最终回复所用的目录、路径或查询范围已变化，请核对后再结束','VERSION_CONFLICT',
          {executed:false,changes:graphChanges,nextAction:'review_changed_scope'});
        const sources=structuredClone(input?.currentSources??[]);
        for(const previous of group.filter(c=>c.name==='workspace_update_work_notes'&&c.status==='completed')){
          try{const receipt=JSON.parse(previous.result??'{}');for(const source of sources)if(source.id===receipt.noteId&&typeof receipt.version==='number')source.version=receipt.version;}catch{/* Invalid receipts do not advance evidence. */}
        }
        const changes=sourceChanges(this.repo.state,task,sources,false);
        requireValue(!changes.length,'最终回复依赖的笔记已更新，请核对新内容后再结束','SOURCE_CHANGED',{executed:false,sources:changes,nextAction:'review_latest_sources'});
      }
      const body=text(args.text,'结束回复',50000);
      const operations=this.repo.state.changes.filter(c=>c.taskId===task.id&&c.status==='committed').map(c=>c.operationId);
      const message=this.message(task,'assistant',body,'final',[],operations);message.stepId=call.stepId;message.presentationCallId=call.id;
      task.status='completed';task.outcome=(args.outcome??'success') as Task['outcome'];task.updatedAt=now();task.finishedAt=task.updatedAt;
      task.finishedSequence=this.repo.event(task.workspaceId,'task.completed',{outcome:task.outcome},task.id).globalSeq;
      return {status:'ok',messageId:message.id,outcome:task.outcome};
    }
    if (call.name === 'ui_present' || call.name === 'ui_focus') {
      const targets = args.targetRefs ? graphRefs(args.targetRefs) : [];
      const operationIds = args.relatedOperationIds ? strings(args.relatedOperationIds, '操作引用') : [];
      requireValue(operationIds.every(op => this.repo.state.changes.some(change => change.operationId === op && change.taskId === task.id && change.status === 'committed')), '过程说明引用的操作尚未提交');
      const sourceRefs = args.sourceRefs ? this.validateSources(task, args.sourceRefs, call.stepId) : [];
      const body = call.name === 'ui_present' ? text(args.text, '过程说明', 20000) : '';
      const message = this.message(task, 'assistant', body, 'progress', targets, operationIds);
      message.stepId = call.stepId; message.presentationCallId = call.id;
      message.sourceRefs = sourceRefs;
      this.repo.event(task.workspaceId, 'ui.presentation', { messageId: message.id, targetRefs: targets, focus: call.name === 'ui_focus' }, task.id, call.stepId);
      return { status: 'ok', messageId: message.id, targetRefs: targets };
    }
    if (call.name === 'interaction_ask') {
      this.wait(task, 'question', text(args.question, '问题', 12000), args.options ? strings(args.options, '选项', 12) : []); return { waiting: true };
    }
    if (call.name === 'graph_propose_changes') return this.propose(task, call, args);
    if (call.name === 'graph_apply_changes') {
      const change = this.repo.state.changes.find(c => c.id === args.changeSetId && c.taskId === task.id); requireValue(change, '变更不属于当前任务', 'OUT_OF_SCOPE');
      return this.commitChange(task, change, call);
    }
    throw new DomainError('未实现的工具', 'TOOL_NOT_ALLOWED');
  }
  private validateSources(task: Task, raw: unknown, stepId: string) {
    requireValue(Array.isArray(raw) && raw.length <= 100, '来源引用必须是列表');
    const bindings = this.repo.state.contextManifests.find(manifest => manifest.taskId === task.id && manifest.stepId === stepId)?.canvasSources ?? [];
    const refs = structuredClone(raw) as import('../domain').SourceRef[], readable = this.allowedRead(task);
    for (const ref of refs) if (ref && ref.version === undefined && ['node', 'document', 'edge'].includes(ref.kind)) {
      const binding = bindings.find(source => source.kind === ref.kind && source.id === ref.id);
      requireValue(binding, '来源正文未出现在本次AI画布视图中，请先读取再引用', 'OUT_OF_SCOPE');
      requireValue(binding.start===undefined||(ref.start!==undefined&&ref.end!==undefined&&ref.start>=binding.start&&ref.end<=binding.end!), '仅展示了部分正文，请按实际读取的片段范围引用','OUT_OF_SCOPE');
      ref.version = binding.version;
    }
    const workspace = this.repo.state.workspaces.find(w => w.id === task.workspaceId)!;
    const memories = this.repo.state.snapshots.filter(snapshot => workspace.snapshotIds.includes(snapshot.id)
      && !snapshot.revoked);
    const history = historyTurns(this.repo.state, task.sessionId, task.id);
    const historyMessageKeys = new Set(history.flatMap(turn => turn.messages.map(message => `${message.id}:${message.version}`)));
    const historyNoteKeys = new Set(history.flatMap(turn => turn.notes.map(note => `${note.id}:${note.version}`)));
    const notebook = notebookWorkspace(this.repo.state, this.getSession(task.sessionId));
    const sharedNotes = notebook && notebook.id !== workspace.id ? [...notebook.workNotes, ...(notebook.noteVersions ?? [])] : [];
    const allowedNotes = [...workspace.workNotes, ...workspace.pinnedNotes, ...sharedNotes,
      ...memories.flatMap(memory => memory.notes).filter(note => historyNoteKeys.has(`${note.id}:${note.version}`))];
    const memoryMessages = memories.flatMap(memory => memory.messages);
    const referenceMessages = [...this.repo.state.messages.filter(message => message.workspaceId === task.workspaceId), ...memoryMessages];
    const visibleSources = (sources: import('../domain').SourceRef[], visiting = new Set<string>()): boolean => sources.every(source => {
      const key = `${source.kind}:${source.id}:${source.version}`;
      if (visiting.has(key)) return false;
      const next = new Set(visiting); next.add(key);
      if (source.kind === 'message') {
        const message = referenceMessages.find(message => message.id === source.id && message.version === source.version);
        return Boolean(message && visibleSources(message.sourceRefs, next));
      }
      if (source.kind === 'note') {
        const note = allowedNotes.find(note => note.id === source.id && note.version === source.version);
        if (note && sharedNotes.includes(note)) return true;
        return Boolean(note && visibleSources(note.sourceRefs, next));
      }
      if (source.kind === 'snapshot') {
        const memory = memories.find(memory => memory.id === source.id && memory.contentHash === source.version);
        return Boolean(memory && visibleSources(memory.sourceRefs, next));
      }
      return true;
    });
    // Snapshot-level provenance contains the union of all selected records.
    // Only records within the selected recent history may grant frozen excerpts.
    const inheritedSources = memories.flatMap(memory => [
      ...memory.messages.filter(message => historyMessageKeys.has(`${message.id}:${message.version}`)
        && visibleSources([{ kind: 'message', id: message.id, version: message.version }])).flatMap(message => message.sourceRefs),
      ...memory.notes.filter(note => historyNoteKeys.has(`${note.id}:${note.version}`)
        && visibleSources(note.sourceRefs)).flatMap(note => note.sourceRefs),
    ]);
    for (const ref of refs) {
      requireValue(ref && typeof ref.id === 'string' && ref.id.length > 0 && ['message', 'artifact', 'node', 'document', 'edge', 'note', 'snapshot'].includes(ref.kind)
        && (typeof ref.version === 'string' && ref.version.length > 0 || typeof ref.version === 'number' && Number.isSafeInteger(ref.version) && ref.version > 0), '来源引用无效');
      requireValue(ref.start === undefined && ref.end === undefined || Number.isSafeInteger(ref.start) && Number.isSafeInteger(ref.end) && ref.start! >= 0 && ref.end! > ref.start!, '来源片段范围无效');
      requireValue(ref.page === undefined || ref.kind === 'artifact' && Number.isSafeInteger(ref.page) && ref.page > 0, '来源页码无效');
      requireValue(ref.tracking === undefined || ['current','historical'].includes(ref.tracking), '来源跟踪方式无效');
      // A frozen citation grants only that inherited excerpt, never access to
      // the parent's full attachment or current graph object.
      const inheritedExcerpt = inheritedSources.some(source => source.kind === ref.kind && source.id === ref.id
        && source.version === ref.version && source.page === ref.page && (ref.start === undefined ? source.start === undefined
          : source.start !== undefined && source.end !== undefined && ref.start >= source.start && ref.end! <= source.end));
      if (inheritedExcerpt && ['artifact', 'node', 'document', 'edge'].includes(ref.kind)) continue;
      let content: string | undefined;
      if (ref.kind === 'message') {
        const message = [...this.repo.state.messages.filter(m => m.workspaceId === task.workspaceId),
          ...memories.flatMap(memory => memory.messages).filter(message => historyMessageKeys.has(`${message.id}:${message.version}`))]
          .find(m => m.id === ref.id && m.version === ref.version);
        requireValue(message && visibleSources([ref]), '消息来源不在当前历史中或版本无效', 'OUT_OF_SCOPE'); content = message.text;
      } else if (ref.kind === 'artifact') {
        const artifact = resolveAttachment(this.repo.state, task, ref.id, ref.version);
        if (ref.start !== undefined) requireValue(artifact.chunks.some(chunk => ref.start! >= chunk.start && ref.end! <= chunk.end && (ref.page === undefined || ref.page === chunk.page)), '资料片段未成功解析或范围不存在', 'VERSION_CONFLICT');
        if (ref.page !== undefined) requireValue(artifact.chunks.some(chunk => chunk.page === ref.page)
          || ref.start === undefined && artifact.visualState === 'available' && ref.page <= (artifact.pages ?? 0), '资料来源页不可用', 'VERSION_CONFLICT');
      } else if (ref.kind === 'note') {
        const note = allowedNotes.find(n => n.id === ref.id && n.version === ref.version);
        requireValue(note && (sharedNotes.includes(note) || visibleSources(note.sourceRefs)), '笔记来源版本无效或来源不可用', 'OUT_OF_SCOPE'); content = note.text;
      } else if (ref.kind === 'snapshot') {
        requireValue(memories.some(snapshot => snapshot.id === ref.id && snapshot.contentHash === ref.version
          && snapshot.messages.every(message => historyMessageKeys.has(`${message.id}:${message.version}`))
          && snapshot.notes.every(note => historyNoteKeys.has(`${note.id}:${note.version}`)) && visibleSources(snapshot.sourceRefs)), '快照来源已退出历史范围、版本无效或已经撤销', 'OUT_OF_SCOPE');
        requireValue(ref.start === undefined, '完整快照来源不能伪造文本偏移');
      } else {
        assertAiObjectRefs(this.graph(), [ref.id]);
        const value = entity(this.graph(), ref.id) as Record<string, unknown> | null;
        requireValue(readable.has(ref.id) && value && hash(value) === String(ref.version), '图来源不在允许范围或版本已变化', 'OUT_OF_SCOPE');
        const metadata = value.metadata as Record<string, unknown> | undefined;
        content = String(value.content ?? value.edgeContent ?? metadata?.description ?? value.description ?? '');
      }
      if (content !== undefined && ref.end !== undefined) requireValue(ref.end <= content.length, '来源片段超出原文范围', 'VERSION_CONFLICT');
    }
    return structuredClone(refs);
  }
  private async prepareProposal(task: Task, args: Record<string, unknown>): Promise<ProposalPlan> {
    requireValue(this.canWrite(task), '当前任务不允许写图', 'READ_ONLY');
    requireValue(Array.isArray(args.commands) && args.commands.length > 0 && args.commands.length <= 30, '一批操作须为 1～30 条');
    text(args.reason, '修改原因', 12000);
    const before = this.graph(), graphRevision = this.repo.state.graphRevision, allowed = memberIds(before, task.canvasId); let planned = before;
    const activeSources=owner(this.repo.state,task).progressEvents?.filter(p=>p.taskId===task.id).at(-1)?.sourceRefs??[];
    const readHashes=scopedGraphReadHashes(before,task,args.commands as Record<string,unknown>[],
      args.dependencyRefs===undefined?undefined:strings(args.dependencyRefs,'操作依据',200),
      activeSources.filter(s=>s.tracking!=='historical'&&['node','edge','document'].includes(s.kind)).map(s=>s.id));
    assertGraphReadHashes(before,readHashes,'已读取的图内容已变化或来源不再可用，请查看冲突详情后重新规划',task.canvasId);
    const temporary: Record<string, string> = {}, commands: Record<string, unknown>[] = [];
    const reviewUnits: ReviewUnit[] = [];
    for (const raw of args.commands as Record<string, unknown>[]) {
      requireValue(raw && commandTypes.has(String(raw.type)), 'AI 无此图操作能力', 'USER_ONLY_MANAGEMENT');
      requireValue(raw.resolution === undefined, AI_STRUCTURE_BOUNDARY_MESSAGE, 'AI_STRUCTURE_BOUNDARY');
      const command = structuredClone(raw);
      const resolve = (ref: unknown) => typeof ref === 'string' ? temporary[ref] ?? ref : ref;
      for (const key of ['id', 'parentId', 'nodeId']) if (key in command) command[key] = resolve(command[key]);
      if(before.nodes[String(command.id)]&&(command.type==='patchNodeContent'||command.type==='updateDesignNode'&&(command.designPatch!==undefined||command.designListPatch!==undefined))){
        assertCompleteNodeRead(task,before,String(command.id));
        readHashes[`nodes:${String(command.id)}`]=hash(before.nodes[String(command.id)]);
      }
      if (Array.isArray(command.ids)) command.ids = command.ids.map(resolve);
      for (const designKey of ['design', 'designPatch','designListPatch']) if (command[designKey] && typeof command[designKey] === 'object') {
        const data = command[designKey] as Record<string, unknown>;
        for (const key of ['memberIds', 'subjectIds','addMemberIds','removeMemberIds','addSubjectIds','removeSubjectIds']) if (Array.isArray(data[key])) data[key] = data[key].map(resolve);
      }
      for (const key of ['input', 'patch']) if (command[key] && typeof command[key] === 'object') {
        const fields = command[key] as Record<string, unknown>;
        for (const refKey of ['sourceNodeId', 'targetNodeId']) if (refKey in fields) fields[refKey] = resolve(fields[refKey]);
      }
      assertAiCommandRefs(planned, command);
      const implicitTop = command.parentId === undefined && ['createNode', 'createSubgraph', 'move', 'moveCanvasItems', 'reparentContent', 'moveBlock'].includes(String(command.type));
      const effectiveParent = implicitTop ? canvasOf(planned, task.canvasId).canvasId : undefined;
      const references = ['id', 'parentId', 'nodeId'].flatMap(key => typeof command[key] === 'string' ? [command[key] as string] : []);
      if (Array.isArray(command.ids)) references.push(...command.ids as string[]);
      for (const designKey of ['design', 'designPatch','designListPatch']) if (command[designKey] && typeof command[designKey] === 'object') {
        const data = command[designKey] as Record<string, unknown>;
        for (const key of ['memberIds', 'subjectIds','addMemberIds','removeMemberIds','addSubjectIds','removeSubjectIds']) if (Array.isArray(data[key])) {
          const retained = command.type === 'updateDesignNode' ? planned.nodes[String(command.id)]?.design : undefined;
          const existing = key.toLowerCase().includes('member') ? retained?.memberIds : retained?.subjectIds;
          if(!key.startsWith('remove'))references.push(...(data[key] as string[]).filter(ref => !existing?.includes(ref)));
        }
      }
      for (const key of ['input', 'patch']) {
        const fields = command[key] as Record<string, unknown> | undefined;
        if (fields) for (const refKey of ['sourceNodeId', 'targetNodeId']) if (typeof fields[refKey] === 'string') references.push(fields[refKey] as string);
      }
      requireValue(references.every(ref => allowed.has(ref)), '命令引用了当前画布外的对象', 'OUT_OF_SCOPE');
      if (effectiveParent) requireValue(allowed.has(effectiveParent), '当前画布顶层不可用', 'OUT_OF_SCOPE');
      const tempId = command.tempId; delete command.tempId;
      if (typeof tempId === 'string') requireValue(!Object.hasOwn(canvasGraphReferences(this.repo.state, task.canvasId)?.aliases ?? {}, tempId)
        && !Object.hasOwn(sessionGraphReferences(this.repo.state, task.sessionId)?.aliases ?? {}, tempId)
        && !entity(planned, tempId), '临时引用不能冒用已有短引用或真实对象 ID');
      const resolved = effectiveParent ? { ...command, parentId: effectiveParent } : command;
      const result = planMutation(planned, task.canvasId, resolved, 'ai');
      reviewUnits.push(...captureReviewUnits(planned, result.state, task.canvasId, resolved, result.id));
      planned = result.state;
      if (result.id) { allowed.add(result.id); if (typeof tempId === 'string') { requireValue(!temporary[tempId], '临时引用重复'); temporary[tempId] = result.id; } }
      commands.push(command);
    }
    checkAiEffects(before, planned, task.canvasId, memberIds(before, task.canvasId));
    // A child the plan newly put on the canvas has no user-authored position:
    // the AI writes a path, so the region has to place it on insertion.
    const insertedIds = [...new Set([...memberIds(planned, task.canvasId)].filter(ref => !entity(before, ref)))];
    const movableIds = [...new Set([
      ...insertedIds,
      ...commands.filter(command => ['move', 'moveCanvasItems', 'reparentContent', 'createSubgraph'].includes(String(command.type)))
        .flatMap(command => Array.isArray(command.ids) ? command.ids as string[] : []),
    ])];
    const changedEdgeIds = planned.edges.filter(edge => !before.edges.some(old => old.edgeId === edge.edgeId && hash(old) === hash(edge))).map(edge => edge.edgeId);
    const protectedIds = [...this.editOccupancies].filter(([, value]) => value.expiresAt > Date.now()).map(([ref]) => ref)
      .concat([...this.placementOccupancies].filter(([, time]) => time > Date.now()).map(([ref]) => ref));
    if (movableIds.length || changedEdgeIds.length) planned = (await planRelationshipLayout(planned, { canvasId: task.canvasId,
      mode: 'auto', movableIds, insertedIds, changedEdgeIds, permittedIds: [...allowed], protectedIds, solveTime: Date.now() }, this.active.get(task.id)?.controller.signal)).state;
    this.guard(task);
    requireValue(graphRevision === this.repo.state.graphRevision, '布局期间画布已变化，请重新读取并规划', 'VERSION_CONFLICT');
    settleReviewLayout(reviewUnits, planned);
    return { before, planned, commands, temporary, graphRevision, readHashes, reviewUnits };
  }
  private propose(task: Task, call: ToolCallRecord, _args: Record<string, unknown>): Record<string, unknown> {
    const plan = this.proposalPlans.get(call.id); requireValue(plan, '图规划尚未完成', 'STALE_CHANGE');
    const { before, planned, commands, temporary, graphRevision } = plan;
    requireValue(graphRevision === this.repo.state.graphRevision, '画布已变化，请重新规划', 'VERSION_CONFLICT');
    checkAiEffects(before, planned, task.canvasId, memberIds(this.graph(), task.canvasId));
    const patches = graphDiff(before, planned), beforeHashes = semanticHashes(before), expected = { ...plan.readHashes };
    for (const patch of patches) {
      for (const [key, value] of Object.entries(beforeHashes)) if (key === `${patch.collection}:${patch.id}` || key.startsWith(`${patch.collection}:${patch.id}:`)) {
        // A text change does not depend on pure layout. Layout/structure writes do.
        const old = patch.before as Record<string, unknown> | null, next = patch.after as Record<string, unknown> | null;
        if (key.endsWith(':view') && old && next && hash([old.placements, old.collapsed]) === hash([next.placements, next.collapsed])) continue;
        expected[key] ??= value;
      }
    }
    const placementRefs = patches.flatMap(p => {
      const a = p.before as { placements?: Record<string, unknown> } | null, b = p.after as { placements?: Record<string, unknown> } | null;
      return Object.keys(b?.placements ?? {}).filter(ref => hash(a?.placements?.[ref] ?? null) !== hash(b?.placements?.[ref] ?? null));
    });
    const affectedRefs = [...new Set([...patches.filter(p => p.collection !== 'canvases').map(p => p.id), ...placementRefs])];
    const affectedCanvasIds = before.canvases.filter(canvas => {
      const members = memberIds(before, canvas.canvasId); return affectedRefs.some(ref => members.has(ref)) || canvas.canvasId === task.canvasId;
    }).map(canvas => canvas.canvasId);
    const existing = this.repo.state.changes.find(c => c.operationId === call.operationId);
    if (existing) return { status: 'proposed', applied:false,nextAction:{tool:'graph_apply_changes',arguments:{changeSetId:existing.id}},changeSetId: existing.id, temporaryRefs: existing.temporaryRefs??{}, affectedRefs: existing.affectedRefs };
    const change: ChangeSet = { id: id('change:'), operationId: call.operationId, workspaceId: task.workspaceId, taskId: task.id, stepId: call.stepId,
      review: { canvasId: task.canvasId, revision: 0, units: plan.reviewUnits, policy: 'group' },
      status: 'proposed', commands, patches, expectedHashes: expected, affectedRefs, affectedCanvasIds, temporaryRefs: temporary, createdAt: now(), instructionRevision: task.instructionRevision,
      digest: hash([commands, patches, expected]) };
    if (hash(before.canvases.map(c => c.placements)) !== hash(planned.canvases.map(c => c.placements)) ||
      hash(Object.values(before.documents).map(d => d.placements)) !== hash(Object.values(planned.documents).map(d => d.placements))) change.layoutGraphRevision = graphRevision;
    this.repo.state.changes.push(change); this.repo.event(task.workspaceId, 'changes.proposed', { changeSetId: change.id, affectedRefs, affectedCanvasIds }, task.id, call.stepId);
    return { status: 'proposed', applied:false,nextAction:{tool:'graph_apply_changes',arguments:{changeSetId:change.id}},changeSetId: change.id, operationId: change.operationId, temporaryRefs: temporary, affectedRefs, affectedCanvasIds,
      summary: patches.map(patch => ({ kind: patch.collection, id: patch.id, action: patch.before === null ? 'create' : patch.after === null ? 'delete' : 'update' })) };
  }
  private commitChange(task: Task, change: ChangeSet, call: ToolCallRecord): Record<string, unknown> {
    if (change.status === 'committed') return { status: 'committed', operationId: change.operationId, changeSetId: change.id, affectedRefs: change.affectedRefs, temporaryRefs: change.temporaryRefs??{}, repeated: true };
    requireValue(change.status === 'proposed', '该提案已取消或失效', 'STALE_CHANGE'); this.guard(task, change.instructionRevision);
    const graph = this.graph();
    assertGraphReadHashes(graph,change.expectedHashes,'图内容或读取依赖已变化，请查看冲突详情后重新提出补丁',task.canvasId);
    requireValue(change.layoutGraphRevision === undefined || change.layoutGraphRevision === this.repo.state.graphRevision,
      '布局所依赖的画布已更新，请重新规划', 'VERSION_CONFLICT');
    change.commands.forEach(command => assertAiCommandRefs(graph, command));
    for (const ref of change.affectedRefs) {
      const editing = this.editOccupancies.get(ref); requireValue(!editing || editing.expiresAt <= Date.now(), '用户正在编辑此字段，请等待其保存后重新读取', 'USER_EDITING');
      requireValue((this.placementOccupancies.get(ref) ?? 0) <= Date.now(), '用户正在拖动此对象，请等待其定位后重新规划', 'USER_POSITIONING');
    }
    const next = applyPatches(graph, change.patches); checkAiEffects(graph, next, task.canvasId, memberIds(this.graph(), task.canvasId));
    // Graph + change receipt + checkpoint + events are inside executeTool's one SQLite transaction.
    this.repo.state.graph = next; this.repo.state.graphRevision++; change.status = 'committed'; change.committedAt = now();
    registerReview(this.repo.state, task, change, call);
    call.nodeReadAdvances=prepareNodeReadAdvances(task,graph,next,change.affectedRefs);
    call.graphUsage = graphWriteUsage(graph,next,task.canvasId,change.affectedRefs,call.id);
    call.graphWriteAcknowledgement = graphWriteAcknowledgement(this.repo.state, task, call, change, graph);
    advanceResponseReadHashes(task,graph,next);
    if(task.responseReadHashes?.observations){
      const before={...this.repo.state,graph},index=graphIndex(this.repo.state,task.canvasId);
      task.responseReadHashes.observations=task.responseReadHashes.observations.map(observation=>{
        if(observationChange(before,observation).changes.length)return observation;
        const updated=observe(this.repo.state,task,index,observation.refs,observation.completeDirectories,observation.structureOnly,observation.query,observation.queryScope,observation.graphQuery);
        updated.directoryMembers=Object.fromEntries(Object.keys(observation.directoryMembers??{}).flatMap(ref=>{
          const version=membershipStamp(index,ref,observation.structureOnly);return version?[[ref,version]]:[];
        }));return updated;
      });
    }
    task.readHashes = {}; task.checkpoint!.operationIds = [...new Set([...task.checkpoint!.operationIds, change.operationId])];
    this.repo.event(task.workspaceId, 'changes.committed', { changeSetId: change.id, operationId: change.operationId, affectedRefs: change.affectedRefs, graphRevision: this.repo.state.graphRevision }, task.id, change.stepId);
    return { status: 'committed', operationId: change.operationId, changeSetId: change.id, affectedRefs: change.affectedRefs, temporaryRefs: change.temporaryRefs??{}, affectedCanvasIds: change.affectedCanvasIds };
  }
  mutateGraph(payload: { canvasId: string; command: Record<string, unknown>; expectedGraphRevision?: number; operationId?: string;
    expectedFields?: Array<{ refId: string; field: string; value: string }> }) {
    const operationId = payload.operationId ?? id('user-op:');
    const old = this.repo.state.events.find(event => event.type === 'graph.user_committed' && event.payload.operationId === operationId);
    const requestHash = hash([payload.canvasId, payload.command]);
    if (old) {
      requireValue(old.payload.requestHash === requestHash || old.payload.requestHash === hash([payload.canvasId,payload.command,old.payload.originSessionId??null]), '相同操作 ID 携带了不同参数', 'OPERATION_CONFLICT');
      return { ok: true, id: old.payload.id, graphRevision: this.repo.state.graphRevision, repeated: true };
    }
    const current = this.graph();
    for (const expected of payload.expectedFields ?? []) {
      const value = entity(current, expected.refId) as Record<string, unknown> | null;
      requireValue(value && value[expected.field] === expected.value, '此字段在编辑期间已更新，输入仍保留，请核对后再保存', 'VERSION_CONFLICT');
    }
    requireValue(payload.expectedGraphRevision === undefined || payload.expectedGraphRevision === this.repo.state.graphRevision, '画布已更新，请同步后重新操作', 'VERSION_CONFLICT');
    const revision = this.repo.state.graphRevision;
    const result = planMutation(current, text(payload.canvasId, '画布'), payload.command, 'user');
    const changedEdgeIds = result.state.edges.filter(edge => {
      const old = current.edges.find(e => e.edgeId === edge.edgeId);
      return !old || old.sourceNodeId !== edge.sourceNodeId || old.targetNodeId !== edge.targetNodeId || old.directed !== edge.directed;
    }).map(edge => edge.edgeId);
    if (changedEdgeIds.length && !result.identityMap) return planRelationshipLayout(result.state, { canvasId: payload.canvasId, mode: 'auto', changedEdgeIds, solveTime: Date.now(),
      protectedIds: [...this.editOccupancies].filter(([, v]) => v.expiresAt > Date.now()).map(([ref]) => ref)
        .concat([...this.placementOccupancies].filter(([, time]) => time > Date.now()).map(([ref]) => ref)), permittedIds: [...memberIds(result.state, payload.canvasId)], budgetMs: 12 })
      .then(layout => {
        const old = this.repo.state.events.find(e => e.type === 'graph.user_committed' && e.payload.operationId === operationId);
        if (old) { requireValue(old.payload.requestHash === requestHash, '相同操作 ID 携带了不同参数', 'OPERATION_CONFLICT');
          return { ok: true, id: old.payload.id as string | undefined, graphRevision: this.repo.state.graphRevision, repeated: true }; }
        requireValue(!this.shuttingDown && revision === this.repo.state.graphRevision, '布局期间画布已更新，请同步后重新操作', 'VERSION_CONFLICT');
        const moved = graphDiff(result.state, layout.state).flatMap(p => {
          const a = p.before as { placements?: Record<string, unknown> } | null, b = p.after as { placements?: Record<string, unknown> } | null;
          return Object.keys(b?.placements ?? {}).filter(ref => hash(a?.placements?.[ref] ?? null) !== hash(b?.placements?.[ref] ?? null));
        });
        requireValue(moved.every(ref => (this.editOccupancies.get(ref)?.expiresAt ?? 0) <= Date.now() && (this.placementOccupancies.get(ref) ?? 0) <= Date.now()),
          '用户正在编辑或拖动受影响对象，请重新操作', 'USER_EDITING');
        return this.commitUserMutation(payload, operationId, requestHash, current, { ...result, state: layout.state }, layout.stats.moved > 0);
      });
    return this.commitUserMutation(payload, operationId, requestHash, current, result);
  }
  private commitUserMutation(payload: { canvasId: string; command: Record<string, unknown> }, operationId: string, requestHash: string,
    before: GraphState, result: ReturnType<typeof planMutation>, hasLayout = false) {
    const changeSetId = hasLayout ? id('change:') : undefined;
    const replacedSessions: string[] = [], interruptedTasks: string[] = [];
    this.repo.transaction(state => {
      protectReviewWrites(state, before, result.state);
      state.graph = result.state; state.graphRevision++;
      if (result.identityMap) {
        const preservedReferences = rebindCanvasReferences(state, payload.canvasId, result.identityMap);
        const sessions = state.sessions.filter(session => session.canvasId === payload.canvasId);
        const workspaceIds = new Set(sessions.map(session => session.workspaceId));
        for (const workspace of state.workspaces) if (workspaceIds.has(workspace.id)) {
          delete workspace.canvasView; delete workspace.contextStage; delete workspace.memoryAttempt;
        }
        replacedSessions.push(...sessions.map(session => session.id));
        const members = memberIds(result.state, payload.canvasId);
        for (const task of state.tasks.filter(task => task.canvasId === payload.canvasId && !isTerminal(task))) {
          task.fencingToken++; task.readHashes = {}; delete task.nodeReadEvidence; delete task.responseReadHashes;
          task.inputBindings.targetIds = task.inputBindings.targetIds.map(ref =>
            result.identityMap![ref] && !members.has(ref) ? result.identityMap![ref] : ref);
          delete task.interaction; delete task.waitReason;
          this.parkFailure(task, '图文档已替换为独立目录，短代指已延续；请继续任务以重新读取和核对副本。');
          interruptedTasks.push(task.id);
        }
        const taskIds = new Set(state.tasks.filter(task=>task.canvasId===payload.canvasId).map(task=>task.id));
        for (const change of state.changes) if (taskIds.has(change.taskId) && change.status==='proposed') change.status='superseded';
        for (const call of state.toolCalls) if (taskIds.has(call.taskId) && ['prepared','waiting'].includes(call.status)) {
          call.status='rejected'; call.result=JSON.stringify({ status:'rejected', code:'DOCUMENT_REPLACED', message:'图文档已替换，请重新读取后规划。' });
        }
        this.repo.event('system', 'graph.document_replaced', { canvasId: payload.canvasId, identityMap: result.identityMap, preservedReferences });
      }
      if (changeSetId) {
        const patches = graphDiff(before, result.state);
        const refs = patches.map(p => p.id);
        const affectedCanvasIds = before.canvases.filter(canvas => {
          if (refs.includes(canvas.canvasId)) return true;
          const members = memberIds(before, canvas.canvasId); return refs.some(ref => members.has(ref));
        }).map(canvas => canvas.canvasId);
        state.changes.push({ id: changeSetId, operationId, workspaceId: 'system', taskId: 'user-layout', stepId: operationId, status: 'committed',
          commands: [payload.command], patches, expectedHashes: semanticHashes(before), affectedRefs: refs, affectedCanvasIds,
          createdAt: now(), committedAt: now(), instructionRevision: 0, digest: requestHash });
      }
      reconcileSessionRoots(this.repo);
      if (payload.command.type === 'clearCanvas') for (const task of state.tasks.filter(t => t.canvasId === payload.canvasId && !isTerminal(t))) {
        task.fencingToken++;this.parkFailure(task,'画布已清空，已保存任务进度，请检查后继续。');
        this.active.get(task.id)?.controller.abort('canvas-cleared');
      }
      this.repo.event('system', 'graph.user_committed', { operationId, requestHash, graphRevision: state.graphRevision, id: result.id, canvasId: payload.canvasId,changeSetId });
    });
    for (const sessionId of replacedSessions) this.privateContinuations.delete(sessionId);
    for (const taskId of interruptedTasks) this.active.get(taskId)?.controller.abort('document-replaced');
    return { ok: true, id: result.id, cleanedEdges: result.cleanedEdges, graphRevision: this.repo.state.graphRevision, changeSetId };
  }
  async previewLayout(canvasId: string, regionId: string) {
    const before = this.graph(), canvas = canvasOf(before, canvasId), graphRevision = this.repo.state.graphRevision;
    requireValue(canvasDirectory(canvas, regionId) || before.documents[regionId] && memberIds(before, canvasId).has(regionId), '整理目录不在当前画布', 'OUT_OF_SCOPE');
    const request = (this.layoutRequests.get(canvasId) ?? 0) + 1; this.layoutRequests.set(canvasId, request);
    for (const [key, value] of this.layoutPreviews) if (value.expiresAt <= Date.now() || value.canvasId === canvasId) this.layoutPreviews.delete(key);
    const result = await planRelationshipLayout(before, { canvasId, regionId, mode: 'organize', solveTime: Date.now(),
      permittedIds: [...memberIds(before, canvasId)], protectedIds: [...this.editOccupancies].filter(([, v]) => v.expiresAt > Date.now()).map(([ref]) => ref)
        .concat([...this.placementOccupancies].filter(([, time]) => time > Date.now()).map(([ref]) => ref)) });
    requireValue(!this.shuttingDown && this.layoutRequests.get(canvasId) === request && this.repo.state.graphRevision === graphRevision,
      '整理期间画布已更新，请重新生成预览', 'VERSION_CONFLICT');
    const proposalId = id('layout:');
    const patches = graphDiff(before, result.state), changedRefs = patches.map(patch => patch.id);
    const affectedCanvasIds = before.canvases.filter(canvas => {
      if (changedRefs.includes(canvas.canvasId)) return true;
      const members = memberIds(before, canvas.canvasId); return changedRefs.some(ref => members.has(ref));
    }).map(canvas => canvas.canvasId);
    if (this.layoutPreviews.size >= 8) this.layoutPreviews.delete(this.layoutPreviews.keys().next().value!);
    this.layoutPreviews.set(proposalId, { canvasId, regionId, graphRevision, before, result, affectedCanvasIds, expiresAt: Date.now() + 120000 });
    return { ok: true, proposalId, graphRevision, graph: result.state, stats: result.stats, affectedCanvasIds };
  }
  applyLayout(proposalId: string, operationId: string) {
    const old = this.repo.state.changes.find(c => c.operationId === operationId);
    if (old) { requireValue(old.digest === hash(proposalId), '相同操作 ID 携带了不同参数', 'OPERATION_CONFLICT');
      requireValue(old.status === 'committed', '该布局操作已撤销或失效，请重新生成预览', 'STALE_CHANGE');
      return { ok: true, changeSetId: old.id, graphRevision: this.repo.state.graphRevision, repeated: true }; }
    const preview = this.layoutPreviews.get(proposalId);
    requireValue(preview && preview.expiresAt > Date.now(), '整理预览已过期，请重新生成', 'STALE_CHANGE');
    requireValue(preview.graphRevision === this.repo.state.graphRevision, '预览之后画布已更新，请重新生成', 'VERSION_CONFLICT');
    const patches = graphDiff(preview.before, preview.result.state);
    const movedRefs = patches.flatMap(p => {
      const a = p.before as { placements?: Record<string, unknown> } | null, b = p.after as { placements?: Record<string, unknown> } | null;
      return Object.keys(b?.placements ?? {}).filter(ref => hash(a?.placements?.[ref] ?? null) !== hash(b?.placements?.[ref] ?? null));
    });
    requireValue(movedRefs.every(ref => (this.editOccupancies.get(ref)?.expiresAt ?? 0) <= Date.now() && (this.placementOccupancies.get(ref) ?? 0) <= Date.now()), '用户正在编辑或拖动受影响对象，请重新生成预览', 'USER_EDITING');
    const changeSetId = id('change:');
    this.repo.transaction(state => {
      protectReviewWrites(state, preview.before, preview.result.state);
      state.graph = preview.result.state; state.graphRevision++;
      state.changes.push({ id: changeSetId, operationId, workspaceId: 'system', taskId: 'user-layout', stepId: proposalId, status: 'committed',
        commands: [], patches, expectedHashes: semanticHashes(preview.before), affectedRefs: movedRefs,
        affectedCanvasIds: preview.affectedCanvasIds,
        createdAt: now(), committedAt: now(), instructionRevision: 0, digest: hash(proposalId) });
      this.repo.event('system', 'layout.committed', { proposalId, changeSetId, operationId, canvasId: preview.canvasId, graphRevision: state.graphRevision });
    });
    this.layoutPreviews.delete(proposalId); return { ok: true, changeSetId, graphRevision: this.repo.state.graphRevision };
  }
  cancelLayout(proposalId: string) { this.layoutPreviews.delete(proposalId); return { ok: true }; }
  positioning(refId: string, active: boolean) {
    requireValue(entity(this.graph(), refId), '拖动对象不存在', 'NOT_FOUND');
    if (active) this.placementOccupancies.set(refId, Date.now() + 45000); else this.placementOccupancies.delete(refId);
    return { ok: true };
  }
  previewReview(payload: { canvasId: string; unitIds?: string[]; groupIds?: string[]; action: ReviewAction }): ReviewPreview {
    const canvasId = text(payload.canvasId, '画布'), unitIds = strings(payload.unitIds ?? [], '修改项', 10000), groupIds = strings(payload.groupIds ?? [], '审阅组', 10000);
    const plan = planReview(this.repo.state, canvasId, unitIds, payload.action, groupIds);
    for (const [token, old] of this.reviewPreviews) if (old.expiresAt < Date.now()) this.reviewPreviews.delete(token);
    if (this.reviewPreviews.size >= 128) this.reviewPreviews.delete(this.reviewPreviews.keys().next().value!);
    const planToken = id('review-plan:');
    this.reviewPreviews.set(planToken, { canvasId, selectedIds: unitIds, groupIds, action: payload.action, signature: plan.signature, expiresAt: Date.now() + 120000 });
    return { ...plan.preview, planToken };
  }
  applyReview(payload: { planToken: string; requestId: string }): ReviewResult {
    const planToken = text(payload.planToken, '决策预览'), requestId = text(payload.requestId, '决策请求', 200);
    const old = this.repo.state.events.find(e => e.type === 'changes.reviewed' && e.payload.requestId === requestId);
    if (old) { requireValue(old.payload.planToken === planToken, '相同请求 ID 携带了不同决定', 'OPERATION_CONFLICT');
      return { ...(old.payload.result as unknown as ReviewResult), repeated: true }; }
    const saved = this.reviewPreviews.get(planToken);
    requireValue(saved && saved.expiresAt > Date.now(), '决策预览已过期，请刷新选择', 'STALE_REVIEW');
    const plan = planReview(this.repo.state, saved.canvasId, saved.selectedIds, saved.action, saved.groupIds);
    requireValue(plan.signature === saved.signature, '画布或决定已变化，请刷新联动范围', 'STALE_REVIEW');
    requireValue(!plan.preview.conflicts.length, '存在冲突，请调整选择后重试', 'REVIEW_CONFLICT', { conflicts: plan.preview.conflicts });
    const selectedEntries = reviewEntries(this.repo.state).filter(e => plan.preview.unitIds.includes(e.unit.id));
    const refs = new Set(selectedEntries.flatMap(e => reviewUnitRefs(e.unit)));
    if (saved.action === 'revert') for (const ref of refs) {
      requireValue((this.editOccupancies.get(ref)?.expiresAt ?? 0) <= Date.now() && (this.placementOccupancies.get(ref) ?? 0) <= Date.now(),
        '相关对象正在编辑或拖动，请完成后重新预览', 'USER_EDITING');
    }
    const interrupted: string[] = [];
    const result = this.repo.transaction(state => {
      decideReview(state, plan.preview, plan.graph);
      const affectedWorkspaces = reviewAffectedWorkspaces(state, [...new Set(selectedEntries.map(e => e.change))], selectedEntries.map(e => e.unit));
      for (const workspace of state.workspaces) {
        if (!affectedWorkspaces.has(workspace.id) || saved.action !== 'revert') continue;
        // The successful write remains historical evidence. Preserve frozen prompt
        // entries and completed provider continuation; append the rollback notice
        // on the next request. Fences below still reject in-flight stale writes.
        delete workspace.memoryAttempt;
        for (const task of state.tasks.filter(t => t.workspaceId === workspace.id)) {
          if (saved.action !== 'revert' || isTerminal(task)) continue;
          const executing = this.active.has(task.id);
          task.fencingToken++; task.instructionRevision++; task.readHashes = {};
          delete task.responseReadHashes; delete task.nodeReadEvidence;
          for (const c of state.changes.filter(c => c.taskId === task.id && c.status === 'proposed')) c.status = 'superseded';
          for (const c of state.toolCalls.filter(c => c.taskId === task.id && c.status === 'prepared')) {
            c.status = 'rejected'; c.result = JSON.stringify({ status: 'rejected', code: 'USER_REVIEW', message: '用户已回退部分画布修改，请基于最新画布和决定重新规划' });
          }
          for (const step of state.steps.filter(s => s.taskId === task.id && ['prepared', 'streaming'].includes(s.status))) step.status = 'aborted';
          for (const message of state.messages.filter(m => m.taskId === task.id && m.status === 'streaming')) message.status = 'incomplete';
          if (executing) { interrupted.push(task.id); if (!task.pauseRequested && task.status !== 'paused' && task.status !== 'waiting_user') task.status = 'queued'; }
          this.repo.event(task.workspaceId, 'task.review_changed', { unitIds: plan.preview.unitIds }, task.id);
        }
      }
      const result: ReviewResult = { ok: true, requestId, action: saved.action, unitIds: plan.preview.unitIds, graphRevision: state.graphRevision };
      this.repo.event('system', 'changes.reviewed', { requestId, planToken, result, canvasId: saved.canvasId, affectedCanvasIds: plan.preview.affectedCanvasIds });
      return result;
    });
    for (const taskId of interrupted) { this.reviewRestarts.add(taskId); this.active.get(taskId)?.controller.abort('user-review'); }
    this.reviewPreviews.delete(planToken); this.kick(); return result;
  }
  undo(changeSetId: string) {
    const change = allReviewChanges(this.repo.state).find(c => c.id === changeSetId); requireValue(change && change.status === 'committed', '该批修改不可撤销');
    requireValue(!change.review?.callId, '请在画布决策面板选择仍待决策的修改；已批准内容不能撤销', 'REVIEW_REQUIRED');
    const current = this.graph();
    for (const patch of change.patches) {
      const value = entity(current, patch.id);
      requireValue(patchCanUndo(value, patchValue(patch.collection, patch.before), patchValue(patch.collection, patch.after)), '这批修改的字段已有后续编辑，不能覆盖当前内容；请检查差异后局部调整', 'UNDO_CONFLICT');
    }
    const next = applyPatches(current, change.patches, true);
    for (const edge of next.edges.filter(e => !e.removed)) requireValue(Boolean(entity(next, edge.sourceNodeId)) && Boolean(entity(next, edge.targetNodeId)), '新增内容已有后续关系依赖，不能直接撤销', 'UNDO_CONFLICT');
    for (const patch of change.patches.filter(p => p.collection === 'documents')) {
      const record = next.documents[patch.id];
      if (record) { record.rev = (current.documents[patch.id]?.rev ?? record.rev) + 1; record.metadata.updatedAt = now(); }
    }
    this.repo.transaction(state => { protectReviewWrites(state, current, next); state.graph = next; state.graphRevision++; change.status = 'reverted';
      this.repo.event(change.workspaceId, 'changes.reverted', { changeSetId, operationId: id('undo:') }, change.taskId); });
    return { ok: true, graphRevision: this.repo.state.graphRevision };
  }
  editing(ref: string, field: string, active: boolean, expectedValue?: string) {
    requireValue(['name', 'content', 'edgeContent'].includes(field), '编辑字段无效');
    const value = entity(this.graph(), ref) as Record<string, unknown> | null;
    requireValue(value && field in value, '编辑对象或字段已不存在', 'NOT_FOUND');
    if (active && expectedValue !== undefined) requireValue(value[field] === expectedValue, '此字段刚刚更新，请读取最新内容后再编辑', 'VERSION_CONFLICT');
    if (active) this.editOccupancies.set(ref, { field, expiresAt: Date.now() + 45000 });
    else if (this.editOccupancies.get(ref)?.field === field) this.editOccupancies.delete(ref);
    return { ok: true };
  }
  clearSummaryCache() { this.repo.transaction(state => { for (const workspace of state.workspaces) delete workspace.memoryAttempt; }); }
  hasActiveRuns() { return this.active.size > 0; }
  async dispose() {
    if (this.shuttingDown) { await Promise.allSettled([...this.runs]); return; }
    this.shuttingDown = true;
    this.repo.transaction(state => {
      for (const task of state.tasks.filter(t => this.active.has(t.id))) {
        task.fencingToken++; task.updatedAt = now();
        if(!isTerminal(task))this.parkFailure(task,'本地服务已关闭，进度已保存，重新启动后可继续。');
        for (const step of state.steps.filter(s => s.taskId === task.id && ['prepared', 'streaming'].includes(s.status))) step.status = 'aborted';
        for (const message of state.messages.filter(m => m.taskId === task.id && m.status === 'streaming')) message.status = 'incomplete';
      }
    });
    for (const active of this.active.values()) active.controller.abort('shutdown');
    await Promise.allSettled([...this.runs]);
    this.claims.clear(); this.editOccupancies.clear();this.privateContinuations.clear();this.wirePrefixes.clear();this.inputTokenEstimators.clear();
  }
}

