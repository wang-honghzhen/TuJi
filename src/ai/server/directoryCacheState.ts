import { AUTO_CONTEXT, type DirectoryRegion, type FrozenRead, type Observation } from '../contextState';
import type { DirectoryReplayRequest, GraphUsageEvidence } from './directoryEvidence';
import type { DirectoryNode } from './directoryRead';

export const DIRECTORY_POLICY_VERSION = 1;
export const DIRECTORY_CACHE_LIMITS = Object.freeze({ entries: AUTO_CONTEXT.directoryCacheEntries, metadataBytes: AUTO_CONTEXT.directoryCacheMetadataBytes });
export interface CacheDirectoryEntry {
  id: string; replay: DirectoryReplayRequest; firstEnteredOrder?: number;
  pendingFirstDelivery: boolean; pendingEnteredOrder?: number;
  usageEvidence: GraphUsageEvidence[]; auditOrigins: string[];
}
export interface DirectoryView {
  tree: DirectoryNode; canvasId: string; rootRefId: string;
  currentPath: Array<{refId: string; name: string}>;
  observation: Observation; drafts: FrozenRead[];
}
export interface CacheDirectoryRenderGroup extends DirectoryView { id: string; memberEntryIds: string[] }
export interface DirectoryAreas {
  policyVersion: number; main: DirectoryRegion;
  cache: { entries: CacheDirectoryEntry[]; renderGroups: CacheDirectoryRenderGroup[]; budget: number; nextEnteredOrder: number };
}
/** Ephemeral, shared only within one maintenance cycle; never persisted on the stage. */
export interface DirectoryMaintenance {
  id: string; snapshotKey: string; replayMemo: Map<string, DirectoryView | null>;
  /** Only surviving members' bounded evidence; private to this maintenance cycle. */
  usageEvidenceMemo: Map<string, GraphUsageEvidence[]>;
  mainMemo?: {budget: number; region: DirectoryRegion};
  evictedReplayKeys: Set<string>; cacheTokenLimit?: number;
  diagnostics: { replayCount: number; replayFailures: number; replayMs: number; elapsedMs: number; evictions: number; mainReused: boolean };
}
