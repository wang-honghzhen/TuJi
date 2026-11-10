import type { ProtocolMessage, SourceRef } from './domain';

export const AUTO_CONTEXT = Object.freeze({ recentGroups: 5, recentShare: .12,
  directoryShare: .05, directoryCacheShare: .02, trigger: .80, target: .65,
  attachmentTreeShare: .05, attachmentCacheShare: .02, taskHighShare: 24 / 104, taskLowShare: .1875,
  noticeShare: .02, noticeMaxTokens: 2048, noticeTargetShare: .5,
  directoryCacheEntries: 128, directoryCacheMetadataBytes: 1024 * 1024,
  attachmentCacheEntries: 128, attachmentCacheMetadataBytes: 1024 * 1024,
  maxCalls: 4, maxDurationMs: 120000, pageTokens: 1200, readTokens: 4000 });
export interface ReadPageRef { pointerId: string; page: number }
export interface ReadDelivery { manifestId: string; stepId: string; sequence: number }
export interface RetentionState { version: number; revision: number;
  writeReceipts?: Record<string, { receipt: string; taskId: string; stepId: string; revision: number; decisionIds: string[] }>;
  receipts: Record<string, { receipt: string; taskId: string; stepId: string; pointerId?: string; page?: number; pages?: ReadPageRef[] }>;
  }
export interface RetentionDraft { fence: string; receiptIds: string[]; removedTemporaryIds: string[];
  writeReceiptIds?: string[];
  noticeRefill?:boolean;canvasRecentReceiptIds?:string[];
  maintenanceIntent?: 'notice' | 'capacity' | 'ordinary';
  canvasReceiptIds?:string[]; canvasRefreshedIds?:string[];
  canvasProofs?:Record<string,string>;canvasPageProofs?:Record<string,string>;
  canvasRefreshProofs?:Record<string,string>;
  canvasReceiptFallbacks?:Record<string,string>;
  capacityMaintenance?: boolean; completedGroups: number;
  noticeMaintenance?: boolean; summaryRegionMaintenance?: boolean; relaxedReceiptIds?: string[]; relocatedReceiptIds?: string[] }
export interface DirectoryRegion { data: unknown; tokens: number; observation: Observation; drafts: FrozenRead[];
  canvasId: string; budget: number }
export interface Coverage { recordId: string; taskId: string; version: string; start: number; end: number }
export interface SummaryObjectBinding {key:string;kind:'node'|'document'|'edge'|'read';id:string;version?:string|number}
export interface SummarySnapshot { id: string; version: string; semanticType: 'task' | 'artifact';
  stepIds?: string[]; inputUnitIds?: string[]; summaryRoundId?: string;
  intermediateUserMessages?: Array<{ id:string; version:number; text:string; order:number }>;
  retentionPolicyVersion?: number;
  text: string; coverage: Coverage[]; children: string[]; createdAt: string; sourceRefs: SourceRef[];
  objectBindings?:SummaryObjectBinding[];
  /** Program-derived provenance, independent of optional markers in model prose. */
  sourceBindings?:SummaryObjectBinding[];
  artifactId?: string; artifactVersion?: number }
export interface PromptEntry { id: string; messages: ProtocolMessage[]; coverage: Coverage[]; category: string;
  noticeId?: string;
  /** Full small replacement delivered in the stable prefix; reclaimed on a rebuild. */
  contextUpdate?: { kind: 'note'; refId: string; version: string | number; notebookId?: string; deleted?: boolean };
  lifecycle?: 'durable' | 'temporary' | 'region'; firstDeliveredStepId?: string; firstDeliveredSequence?: number; originResultIds?: string[];
  sourceIdentity?: string; contentSignature?: string;
  representation?: 'body' | 'receipt' | 'summary';
  /** Calls whose actual bodies are present; coverage alone does not prove delivery. */
  readCallIds?: string[];
  receiptCallIds?: string[];
  /** Public, fully projected messages. Drafts become frozen only at request submission. */
  wireMessages?: ProtocolMessage[]; taskId?: string; stepId?: string }
export type PrefixResetReason = 'initial' | 'format_upgrade' | 'source_changed' | 'history_changed'
  | 'route_changed' | 'tools_changed' | 'compaction' | 'refactor' | 'runtime_recovery' | 'unexpected_mutation' | 'summary_region_budget';
export interface ContextBuildOptions { mode?: 'append' | 'refactor' | 'compact'; phase?: 'active' | 'task_end';
  /** Task eviction is a candidate projection until the request is committed. */
  residentTaskIds?: string[];
  preferOriginals?: boolean;
  /** Refill caused by the final notice check, even during a capacity maintenance round. */
  noticeRefill?:boolean;
  maintenanceIntent?: 'notice' | 'capacity' | 'ordinary';
  canvasMaintenance?: import('./server/canvasRefresh').CanvasMaintenance;
  /** One private replay cache for all builds in a maintenance round. Never persisted. */
  directoryMaintenance?: import('./server/directoryCacheState').DirectoryMaintenance;
  summaryMaintenance?: import('./server/summaryRegions').SummaryMaintenance;
  noticeReceiptIds?: string[];
  receiptIds?: string[] }
export interface RefactorMetrics { trigger: 'task_end' | 'capacity' | 'version_notices'; adopted: boolean; reason: string;
  before: number; after: number; ratio: number; receiptCalls: number; removedTasks: number; removedArtifacts: number; summaryCalls: number }
export interface Observation { id: string; callId?: string; taskId: string; canvasId: string; directories: Record<string, string>;
  /** Restored evidence is usable only while every exact archive fragment is visible together. */
  archiveProof?: { pointerId: string; recordId: string; version: string; pages: number[] };
  canvasFacts?: import('./server/canvasReadEvidence').CanvasFact[];
  /** Semantic components of aggregate stamps. These are dependencies, not delivered bodies. */
  canvasVersionDependencies?: Record<string,import('./server/canvasReadEvidence').CanvasFact[]>;
  canvasPage?: {pointerId:string;page:number;totalPages:number};
  fileTransitions?:Array<{key:string;before?:string;after?:string}>;
  fileVersions?: Record<string,string>;
  evidenceUnknown?: boolean;
  provenEmpty?:boolean;
  /** System directory views are visible only while their owning region is displayed. */
  directoryView?: true;
  /** Incremental bodies belong to a specific prompt entry, not all future context generations. */
  entryId?: string;
  /** Exact displayed objects and queried memberships. */
  objects?: Record<string, string>; directoryMembers?: Record<string, string>; historical?: boolean;
  contentLengths?: Record<string, number>;
  /** Membership at delivery, also usable after a node/edge moves or is deleted. */
  objectParents?: Record<string, string[]>;
  graphQuery?: import('./server/graphQueries').GraphQuery;
  paths: Record<string, string>; structureOnly?: boolean; query?: string; queryScope?: 'all' | 'node_names'; querySignature?: string;
  refs: string[]; completeDirectories: string[]; notified?: string; sources: SourceRef[];
  readHashes?: Record<string, string>; graphReadDependenciesVersion?: number }
/** Private evidence attached to a successful write, never a replacement for frozen read bodies. */
export interface GraphWriteAcknowledgement {
  fileTransitions?:Array<{key:string;before?:string;after?:string}>;
  commandCallIds?: string[];
  advances: Array<{ observationId: string; expected: string; observation: Observation }>;
  observations: Observation[];
}
export interface FrozenRead { id: string; taskId: string; callId: string; canvasId: string; pages: Record<string, unknown>[];
  attachmentRead?: { taskIds?: string[]; protect?: boolean; representation: 'index' | 'text' | 'image'; versions: Record<string, number | string> };
  canvasView?:true;
  canvasOrigin?:import('./server/canvasReadEvidence').CanvasReadRequest;
  summaryView?: true;
  summaryOrigin?: { roots: string[]; versions: Record<string,string>; pure: boolean; parentId?:string };
  noteBinding?: { notebookId: string; noteId: string; version: number };
  /** Current system directory pagination, independent of model tool result lifetimes. */
  directoryView?: true;
  directoryReplay?: import('./server/directoryEvidence').DirectoryReplayRequest;
  pageGraphUsage?: import('./server/directoryEvidence').GraphUsageEvidence[][];
  originResultIds?: string[];
  pageBudget?: number;
  queryKey?:string;
  searchSelection?: { scope?: 'node_names'; totalMatches: number; selectedMatches: number; countOnly?: boolean; countComplete?: boolean };
  readFormatVersion?:number; coverage?:import('./server/readCoverage').ReadCoverage;
  historyViewVersion?: number;
  /** Navigation only, created with new history snapshots; never delivered source coverage. */
  recordDirectory?: { totalRecords:number; listedRecords:number; complete:boolean; instruction:string;
    records:Array<{recordId:string;taskId:string;version:string;ranges:Array<[number,number]>;pageRanges:Array<[number,number]>;
      readWith:{tool:'context_read_children';arguments:{summaryId:string}}}> };
  pageSources?: SourceRef[][]; pageObservations?: Observation[]; snapshotObservation?: Observation;
  graphReadDependenciesVersion?: number; pageReadHashes?: Record<string, string>[];
  pageCoverage?: Coverage[][]; targetVersions?: Record<string,string>;
  observation: Observation; createdAt: string; expiresAt: number; sources: SourceRef[]; kind: string }
export interface ExpansionPart { targets: string[]; targetVersions: Record<string,string>; coverage: Coverage[];
  historyViewVersion?: number;
  messages: ProtocolMessage[]; sources: SourceRef[] }
export interface ExpansionUse { presented?: boolean; callId: string; order: number; targets: string[]; coverage: Coverage[];
  messages: ProtocolMessage[]; sources: SourceRef[]; parts?: ExpansionPart[] }
export interface ProgressEvent { id: string; taskId: string; version: number; text: string; sequence: number;
  createdAt: string; sourceRefs: SourceRef[] }
export interface ContextStage { version: 1; generation: number; taskId: string; entries: PromptEntry[]; eventIds: string[];
  attachmentProtectionCalls?: string[];
  receiptedNoticeIds?: string[];
  taskNoticeBatch?: import('./server/taskNotices').TaskNoticeBatch;
  reviewFence?: string; reviewNoticeIds?: string[]; coveredReviewIds?: string[];
  pendingNoticeAttempt?:{fence:string;signature:string;availableTokens?:number;resourceBytes?:number;reasons:string[]};
  canvasRefresh?:import('./server/canvasRefresh').CanvasRefreshState;
  canvasEvidenceFence?:string;
  retentionRevision?: number; retentionDraft?: RetentionDraft; directoryRegion?: DirectoryRegion;
  directoryAreas?: import('./server/directoryCacheState').DirectoryAreas;
  summaryRegions?: import('./server/summaryRegions').SummaryRegions;
  versionNotices?: import('./server/noticeMaintenance').NoticeState;
  removedTemporaryIds?: string[];
  residentTaskIds?: string[]; afterTaskId?: string;
  /** Uncommitted system directory snapshots, installed only with the request. */
  frozenReadDrafts?: FrozenRead[];
  refactorMetrics?: RefactorMetrics;
  projectionVersion?: number; routeSignature?: string; toolsSignature?: string; modeSignature?: string;
  rebuildReason?: PrefixResetReason; invalidatedReason?: PrefixResetReason; recoveryRequired?: boolean;
  protectedCoverage: Coverage[]; residentRoots: string[]; noteVersions: Record<string, number>; pinnedHash: string;
  requirementsRevision?: number; freshnessRevision?: number;
  /** Suppresses re-injecting reclaimed updates, never suppresses freshness notices. */
  canvasUpdateVersions?: Record<string, string>;
  notebookId?: string; sourceRevision: string; policyRevision: string; sentIds: string[]; lastCompactionStep: number;
  lastRequest?: { hash: string; tokens: number; commonPrefixCharacters: number; serialized: string;
    rawTokens?: number; reportedInputTokens?: number };
  /** A completed attempt must gain new compressible evidence or enough growth before retrying. */
  compactionAttempt?: { capacity: number; pendingSignature: string; retryAtTokens: number };
  baselineObservations?: Observation[];
  metrics?: { before: number; after: number; calls: number; elapsedMs: number; reason: string; fixedTokens?:number;targetTokens?:number;
    triggerTokens?:number;readingReserve?:number;targetReached?:boolean;lowerBound?:boolean;limitedMergeBenefit?:boolean;
    rawBefore?:number;rawAfter?:number;observedAfter?:number;observedHeadroomTokens?:number } }
