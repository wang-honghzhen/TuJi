import type { GraphState } from '@/v3/types';
import type { SoundSettings } from '@/shared/soundSettings';
import type { PersonalizationSettings } from '@/shared/canvasBackgrounds';
import type { ContextStage, SummarySnapshot, Observation, FrozenRead, ExpansionUse, ProgressEvent } from './contextState';

// Ordinary sessions inherit the canvas mode; temporary sessions have a separate entry.
export type SessionMode = 'explore' | 'design' | 'temporary';
export type TemporaryMode = 'minimal' | 'branch' | 'custom';
export type TaskStatus = 'queued' | 'running' | 'waiting_resource' | 'waiting_user' | 'waiting_retry'
  | 'waiting_reconcile' | 'waiting_presentation' | 'paused' | 'completed';
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed'];
export interface SourceRef { kind: 'message' | 'artifact' | 'node' | 'document' | 'edge' | 'note' | 'snapshot'; id: string; version: number | string; start?: number; end?: number; page?: number;
  /** Historical citations keep their version; current facts require review when their source changes. */
  tracking?: 'current' | 'historical'; unavailableReason?: 'history_reset' }
export interface Session { id: string; canvasId: string; workspaceId: string; mode: SessionMode; title: string;
  titleSource?: 'manual' | 'pending' | 'message';
  temporaryContext?: { sourceSessionId?: string; revision: number; mode?: TemporaryMode; lockedAt?: string;
    lastActiveAt?: string; expiresAt?: string };
  /** Single-source descendants share allocation, never task ownership or access rights. */
  referenceFamilyId?: string;
  lifecycle: 'active' | 'archived' | 'deleted'; createdAt: string }
export const SESSION_TITLE_LIMIT = 32;
export function messageSessionTitle(message: string): string {
  const letters = Array.from(message.trim().replace(/\s+/g, ' '));
  return letters.length <= SESSION_TITLE_LIMIT ? letters.join('') : letters.slice(0, SESSION_TITLE_LIMIT - 1).join('') + '…';
}
export type NoteLifecycle = 'multi_task' | 'current_task';
export interface Note { id: string; text: string; version: number; type: 'goal' | 'constraint' | 'finding' | 'result' | 'question' | 'next' | 'pinned'; sourceRefs: SourceRef[]; updatedAt: string;
  createdAt?: string; originTaskId?: string; author?: 'user' | 'ai'; clientRequestId?: string;
  lifecycle?: NoteLifecycle; taskId?: string; }
/** Personal plain-text pages, independent of AI session memory. */
export interface UserNotePage { id: string; text: string; version: number; createdAt: string; updatedAt: string }
/** User navigation metadata, shared by live and inherited views of the same turn. */
export interface ChatTurnBookmark { id: string; createdAt: string }
/** AI reading presentation only. It grants no access and never changes canvas.collapsed. */
export interface AgentCanvasView { version: 1; initialBudget: number; knownRefs: string[]; hiddenRefs: string[]; collapsedRefs: string[]; detailRefs: string[];
  pulls?: Record<string, { step: number; presentedAt?: number }>;
  halfCollapsedRefs?: string[]; pendingRefs?: string[]; bodyVersions?: Record<string, string> }
export interface AgentGraphReferences { version: 1; aliases: Record<string, string>;
  /** Display bindings before an explicit local-copy replacement; originals stay immutable. */
  history?: Array<{ at: string; throughSequence: number; aliases: Record<string, string> }>;
  /** n/d/e/r address canvas objects; f attachments, w work notes, s summaries and frozen pages,
   *  m messages, t tool calls, c attachment chunks, p mounted summary pages,
   *  g change sets, o canvas operations. */
  next: { n: number; d: number; e: number; r: number; f: number; w: number; s: number; m: number; t: number; c: number; p: number; g: number; o: number; h: number; k: number } }
export interface Workspace { id: string; sessionId: string; workNotes: Note[]; pinnedNotes: Note[]; snapshotIds: string[]; artifactIds: string[]; canvasView?: AgentCanvasView;
  sessionContext?: import('./sessionContext').SessionContextState;
  taskNotices?: import('./server/taskNotices').TaskNotice[];
  pendingTaskNotices?: import('./server/taskNotices').PendingTaskNotices;
  reviewDelivery?: Record<string, { delivered: boolean; covered: boolean; revision: number }>;
  promptFork?: import('./server/promptFork').PromptFork;
  inheritanceStatus?: {sourceSessionId:string;eligible:boolean;reused:boolean;fingerprint?:string;reason?:string};
  readRetention?: import('./contextState').RetentionState;
  minimalWebReads?: Array<{id:string;pages:Record<string,unknown>[];createdAt:string}>;
  noticeMaintenanceAttempt?: { signature: string; status: 'evaluating' | 'handled' | 'failed' | 'unsafe'; reasons?:string[];availableTokens?:number;resourceBytes?:number };
  refactorEvaluation?: { taskId: string; metrics?: import('./contextState').RefactorMetrics; error?: string };
  contextStage?: ContextStage; summaries?: SummarySnapshot[];
  observations?: Observation[]; frozenReads?: FrozenRead[]; expansionUses?: ExpansionUse[]; progressEvents?: ProgressEvent[];
  deliverySequence?: number;
  /** Idempotency ledger for completed AI note mutations, independent of context projection. */
  noteWriteReceipts?: Record<string, { noteId: string; version: number; storage: 'original' }>;
  noteVersions?: Note[];
  memoryAttempt?: { hash: string; reason: string; calls: number; at: string } }
export interface InheritanceEdge { id: string; canvasId: string; parentSessionId: string; childSessionId: string; snapshotIds: string[]; createdAt: string; structuralOnly?: boolean }
export interface MemorySnapshot { id: string; sourceSessionId: string; sourceTaskIds: string[]; cutoffSeq: number; messages: ChatMessage[];
  taskNotices?: import('./server/taskNotices').TaskNotice[];
  sourceTitle?: string;
  sourceReferenceAliases?: Record<string,string>;
  completedStepGroups?: Array<{ id: string; taskId: string; order: number; ordinal?: number }>;
  summaries?: SummarySnapshot[]; progressEvents?: ProgressEvent[];
  /** Host-only chronology including omitted records; prevents selected fragments becoming falsely adjacent. */
  conversationOrder?: Array<{ id: string; taskId: string; createdAt: string; sequence?: number; stepId?: string;
    stepOrdinal?: number; type: 'reply' | 'function' | 'note'; user?: boolean }>;
  presentationParts?: PresentationPart[];
  operations: ChangeSet[]; notes: Note[]; sourceRefs: SourceRef[]; contentHash: string; createdAt: string; revoked?: boolean;
  sourceTaskStates?: Array<{ id: string; status: TaskStatus; instructionRevision: number; rootUserMessageId?: string }>;
  provenancePaths?: Array<{ source: SourceRef; viaSessionId: string; viaSnapshotIds: string[] }>;
  toolCalls?: ToolCallRecord[]; artifacts?: Artifact[] }
export interface InputBinding { targetIds: string[]; artifactIds: string[]; artifactVersions: Record<string, number> }
export interface Task { nodeReadEvidence?: Record<string,import('./server/nodeReadEvidence').NodeReadEvidence>; id: string; sessionId: string; workspaceId: string; canvasId: string; rootUserMessageId: string;
  reviewFirstCommitSeq?: number; reviewWindowClosed?: boolean; notebookBinding?: { id: string; revision: number };
  pauseRequested?: boolean; pauseReturnStatus?: TaskStatus; waitingSince?: number; idleDurationMs?: number;
  presentation?: { owner: string; mode: 'follow'|'review'|'background'; epoch: number; cursor: number;
    round?: { stepId:string; revision:number; lastSeq:number }; ack?: {stepId:string;epoch:number;lastSeq:number};
    visiblePart?: {seq:number;since:number;epoch:number}; playbackPaused?: boolean };
  presentationFocus?: string[];
  clientRequestId: string; instructionRevision: number; appliedInstructionRevision: number; status: TaskStatus; createdAt: string; updatedAt: string;
  finishedAt?: string; finishedSequence?: number;
  inputBindings: InputBinding; modelSelection?: ModelSelection; maxSteps: number; maxTokens: number; usedTokens: number; stepCount: number;
  readHashes?: Record<string, string>; maxDurationMs?: number; startedAt?: string;
  /** Versions sent in the response being executed, advanced only by its own committed writes. */
  responseReadHashes?: { stepId: string; hashes: Record<string, string>; observations?: Observation[] };
  handoff?: { text: string; version: number }; memoryCalls?: number;
  canvasCapacity?: { fenceStepId?: string; organizing?: boolean; lastTokens?: number; noProgress?: number;
    grantedStep?: number; instructionRevision?: number };
  contextCapacity?: { fenceStepId?: string; organizing?: boolean; lastTokens?: number; noProgress?: number;
    grantedStep?: number; instructionRevision?: number; blockedPlan?: string };
  retryCount?: number; noProgressCount?:number;
  modelRetryHint?: { code: 'tool_arguments'; instructionRevision: number };
  activeRunId?: string; fencingToken: number; relatedTaskId?: string;
  waitReason?: string; error?: string; outcome?: 'success' | 'partial' | 'declined'; interaction?: Interaction;
  checkpoint?: { stepId?: string; operationIds: string[]; protocol: ProtocolMessage[]; instructionRevision: number; lastSeq: number } }
export type ThinkingEffort = 'none' | 'low' | 'high' | 'max';
export interface ModelSelection { model: string; thinkingEffort: ThinkingEffort }
export interface ProtocolMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  images?: import('./attachments').ImageAssetRef[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolCallId?: string; responseItems?: unknown[]; reasoningContent?: string; stepId?: string }
export interface ChatMessage { id: string; workspaceId: string; taskId: string; role: 'user' | 'assistant' | 'system'; text: string;
  targetNames?: Record<string,string>;
  progressSelection?: ProgressSelection[];
  selectedProgress?: import('./sessionContext').SelectedProgressTask[];
  partSeq?: number;
  viewedPart?: { taskMessageId: string; part: number; targets: string[]; graphRevision: number; recordIds?: string[] };
  viewedPartUnavailable?: boolean;
  presentationCallId?: string;
  version: number; status: 'streaming' | 'complete' | 'incomplete'; phase: 'request' | 'amendment' | 'progress' | 'final' | 'status';
  createdAt: string; sequence?: number; relatedOperationIds: string[]; targetRefs: string[]; sourceRefs: SourceRef[]; instructionRevision?: number;
  attachments?: SourceRef[]; stepId?: string }
export interface ModelStep { transport?: { requestBytes: number; imageTransportBytes: number; estimatedImageTokens: number }; id: string; taskId: string; runId: string; ordinal: number; purpose: 'agent' | 'context_compaction';
  completedSequence?: number;
  status: 'prepared' | 'streaming' | 'completed' | 'aborted' | 'failed'; inputInstructionRevision: number; contextManifestId: string;
  provider: string; model: string; createdAt: string; providerResponseId?: string; error?: string }
export interface ToolCallRecord { id: string; providerCallId: string; taskId: string; stepId: string; operationId: string; name: string; arguments: string;
  attachmentProtection?: import('./attachments').AttachmentProtection;
  resultImages?: import('./attachments').ImageAssetRef[];
  attachmentRead?: { artifactIds: string[]; versions: Record<string, number | string>; representation: 'index' | 'text' | 'image'; ranges?: unknown };
  readPageOrigins?:import('./server/readPageEvidence').ReadPageOrigin[];
  canvasOrigins?:import('./server/canvasReadEvidence').CanvasReadDelivery[];
  directoryReplay?: import('./server/directoryEvidence').DirectoryReplayRequest;
  graphUsage?: import('./server/directoryEvidence').GraphUsageEvidence[];
  originResultId?: string; readOriginIds?: string[]; frozenSourceCallId?: string; resultRepresentation?: 'body' | 'receipt';
  readPageRefs?: import('./contextState').ReadPageRef[]; resultReadHashes?: Record<string, string>;
  firstDelivery?: import('./contextState').ReadDelivery;
  summaryOrigins?: Array<{pointerId:string;roots:string[];versions:Record<string,string>;parentId?:string}>;
  partSeq?: number;
  argumentVersion?: 2;
  status: 'prepared' | 'waiting' | 'completed' | 'rejected'; result?: string; createdAt: string; startedAt?: string; sequence?: number; userResolved?: boolean;
  nodeReadAdvances?: import('./server/nodeReadEvidence').NodeReadAdvance[];
  presentedAt?: number; resultSources?: SourceRef[];
  graphWriteAcknowledgement?: import('./contextState').GraphWriteAcknowledgement;
  noteWriteAcknowledgement?: { notebookId: string; noteId: string; version: number } }
export interface WorkspaceEvent { id: string; seq: number; globalSeq: number; workspaceId: string; taskId?: string; stepId?: string;
  type: string; payload: Record<string, unknown>; createdAt: string }
export interface GraphPatch { collection: 'nodes' | 'documents' | 'canvases' | 'edges'; id: string; before: unknown; after: unknown }
export interface PresentationEvent { id:string; kind:'text'|'user'|'tools'|'focus'; messageId?:string; callId?:string; stepId?:string;
  start?:number; end?:number; graphRevision:number; targets:string[]; calls?:ToolCallRecord[] }
export interface PresentationPart { id:string; taskId:string; seq:number; stepId?:string; revision:number;
  /** The successful br call opening this part; absent for the step's default part. */
  breakCallId?:string;
  events?: PresentationEvent[]; version?:number; stable?:boolean; partial?:boolean;
  views?:Array<{version:number;graphRevision:number;eventId?:string;unavailable?:boolean}>;
  callId?: string;
  graphRevision:number; messageId?:string; start?:number; end?:number; text?:string;
  kind:'input'|'text'|'tools'|'focus'; sealed:boolean; targets:string[]; calls?:ToolCallRecord[]; dwellMs:number }
export interface ChangeSet { id: string; operationId: string; workspaceId: string; taskId: string; stepId: string;
  reviewArchive?: { sessionId?:string; title?:string; request?:string; createdAt:string };
  review?: import('./reviewTypes').ChangeReview;
  status: 'proposed' | 'committed' | 'rejected' | 'superseded' | 'reverted'; commands: Record<string, unknown>[];
  patches: GraphPatch[]; expectedHashes: Record<string, string>; affectedRefs: string[]; affectedCanvasIds: string[]; temporaryRefs?: Record<string,string>;
  createdAt: string; committedAt?: string; instructionRevision: number; digest: string; error?: string; layoutGraphRevision?: number }
export interface Interaction { id: string; version: number; kind: 'question' | 'structure' | 'budget'; question: string;
  options: string[]; changeSetId?: string; payload?: Record<string, unknown> }
export interface ArtifactChunk { searchOnly?: boolean; id: string; ordinal: number; page?: number; start: number; end: number; text: string; hash: string }
export interface Artifact { id: string; workspaceId: string; name: string; mimeType: string; version: number; createdAt: string;
  visualState?: 'available' | 'unavailable'; width?: number; height?: number; firstFrameOnly?: boolean; chunkCount?: number;
  status: 'ready' | 'partial' | 'failed' | 'deleted'; size: number; hash: string; chunks: ArtifactChunk[]; pages?: number;
  failedPages?: number[]; ocrPages?: number[]; error?: string }
export type ContextSection = 'rules' | 'conversation' | 'canvas' | 'references' | 'work_notes';
export interface ContextItem { id: string; category: string; section?: ContextSection; sourceRefs: SourceRef[]; text: string; representation: 'original' | 'extract';
  sourceFragment?: { recordId:string; start:number; end:number; totalLength:number };
  historyTaskId?: string;
  budgetBucket: 'fixed' | 'data' | 'history'; tokens: number; derivedFrom: string[] }
export interface ContextManifest { id: string; taskId: string; stepId?: string; createdAt: string; items: ContextItem[];
  /** Host-only preconditions captured from this exact input, durable across restart. */
  toolVersions?: import('./server/toolVersions').ToolVersionBindings;
  /** Full read bodies actually included in this request, not summary coverage. */
  readBodyResultIds?: string[];
  /** New pages in the actual candidate projection; confirmed only by a completed execution step. */
  readPageDeliveries?: import('./server/readDeliveryEvidence').PageDeliveryEvidence[];
  stageDraft?: ContextStage; contextMetrics?: { generation: number; commonPrefixCharacters: number; cachedInputTokens?: number; cacheStatus: 'known' | 'unknown';
    stableMessageCount?: number; stableWireItemCount?: number; prefixPreserved?: boolean;
    /** Zero-based provider item index; Responses may expand one message into multiple items. */
    firstChangedMessageIndex?: number; firstChangedToolIndex?: number;
    rebuildReason?: import('./contextState').PrefixResetReason; prefixBreakReason?: import('./contextState').PrefixResetReason;
    temporaryTailChanged?: boolean; toolsUnchanged?: boolean;
    rawRequestTokens?: number; inputEstimateMethod?: 'local' | 'usage-prefix' | 'usage-subset' | 'usage-inflated';
    matchedInputTokens?: number; reportedInputTokens?: number; inputCalibrationAccepted?: boolean;
    versionNotices?: {tokens:number;threshold:number;target:number;maintenance?:import('./server/noticeMaintenance').NoticeState['maintenance']};
    canvasRefresh?: import('./server/canvasRefresh').CanvasRefreshState['diagnostics'] & {members:number};
    summaryRegions?: {tokens:number;referenceTokens:number;budget:number;members:number;builds:number;elapsedMs:number;migrated:number;evicted:number;resourceFailure?:string;resourceEvictions?:number};
    maintenance?: {candidateBuilds:number;elapsedMs:number};
    refactor?: import('./contextState').RefactorMetrics };
  rawHistoryTokens: number; selectedHistoryTokens: number; fixedTokens: number; dataTokens: number; requestTokens: number;
  contextWindow: number; outputReserve: number; safetyReserve: number; historyBudget: number; referencePercent: number;
  compressed: boolean; omitted: string[]; hash: string; messages: ProtocolMessage[]; error?: string; sourcePolicyHash?: string; canvasViewHash?: string;
  /** Only this local-estimate error may be cleared by a measured wire estimate. */
  capacityEstimateError?: boolean;
  /** Host-only bindings for graph citations; never added to model messages. */
  canvasSources?: SourceRef[];
  canvasReadHashes?: Record<string,string>;
  canvasChecks?: Observation[];
  currentSources?: SourceRef[];
  /** Host-only versions actually advertised in this model input. */
  summaryVersions?: Record<string,string>; summaryViewHash?: string;
  memory?: { inputCapacity: number; apiInputCapacity?: number; contextPresetTokens?: import('./contextCapacity').ContextPresetTokens; occupancy: number; attachmentSummaryRequired: boolean;
    sectionTokens: Record<string, number>; sectionBudgets: Record<string, number>; lastReason?: string;
    canvas?: { tokens: number; budget: number; hardLimit: number; organizing: boolean; pendingCount: number };
    targetOccupancy?: number } }
export interface ProviderConfig { protocol: 'responses' | 'chat-completions'; baseUrl: string; model: string; contextWindow: number;
  supportsVision?: boolean;
  visionModels?: string[];
  contextPresetTokens?: import('./contextCapacity').ContextPresetTokens;
  maxInputTokens?: number;
  /** Percentage of the usable prompt input budget reserved for AI notes. */
  workNotesPercent?: number;
  maxOutputTokens: number; supportsTools: boolean; webSearchEnabled?: boolean; webSearchProvider?: 'deepseek'; timeoutMs: number; apiFamily?: 'deepseek'; thinkingEffort?: ThinkingEffort }
// API ID and display name are distinct. See https://api-docs.deepseek.com/api/list-models/
export const DEEPSEEK_FLASH_MODEL = 'deepseek-flash';
export const DEEPSEEK_MODELS = [{ id: DEEPSEEK_FLASH_MODEL, name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] as const;
export const DEFAULT_PROVIDER: ProviderConfig = { apiFamily: 'deepseek', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com', model: DEEPSEEK_FLASH_MODEL,
  contextWindow: 500000, contextPresetTokens: 500000, maxOutputTokens: 16384, supportsTools: true, timeoutMs: 300000, thinkingEffort: 'high' };
export interface AppSnapshot { soundSettings?: SoundSettings; schemaVersion: 3; graph: GraphState | null; graphRevision: number; canvasGraphReferences: Record<string, AgentGraphReferences>; sessionReferences?: Record<string, AgentGraphReferences>; sessions: Session[]; workspaces: Workspace[];
  attachmentLimits?: import('./attachments').AttachmentLimits;
  canvasReviewStates?: Record<string, import('./reviewTypes').CanvasReviewState>;
  canvasVersionProtocol?: { version:1; migratedAt?:string; backupPath?:string };
  contextRetention?: import('./contextState').RetentionState;
  directoryVersions?: Record<string, { version: number; signature: string; structure: string;
    directoryVersion?: number; directDataVersion?: number; deleted?: boolean }>;
  personalizationSettings?: PersonalizationSettings;
  userNotePages?: UserNotePage[];
  chatTurnBookmarks?: ChatTurnBookmark[];
  presentationParts?: PresentationPart[];
  inheritanceEdges: InheritanceEdge[]; snapshots: MemorySnapshot[]; tasks: Task[]; messages: ChatMessage[]; steps: ModelStep[];
  changes: ChangeSet[]; reviewChanges?: ChangeSet[]; toolCalls: ToolCallRecord[]; artifacts: Artifact[]; contextManifests: ContextManifest[]; events: WorkspaceEvent[];
  provider: ProviderConfig; credentialConfigured: boolean; setupCompleted: boolean; lastSeq: number }
export interface SendInput { sessionId: string; text: string; clientMessageId: string; intent: 'new' | 'amend';
  progressSelection?: ProgressSelection[];
  presentationOwner?: string;
  viewedPart?: { taskId: string; part: number; version?:number };
  targetTaskId?: string; targetIds: string[]; artifactIds: string[]; modelSelection?: ModelSelection }
export interface ProgressSelection { taskId: string; stepIds?: string[]; recordIds?: string[] }
export interface OrderedTaskSelection { sessionId: string; taskId: string }
export interface ApiError { error: string; code?: string; details?: unknown }
