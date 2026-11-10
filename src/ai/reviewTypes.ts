import type { GraphPatch } from './domain';

export type ReviewAction = 'approve' | 'revert';
export type ReviewState = 'pending' | 'approved' | 'reverted';
export type ReviewSource = 'user' | 'window' | 'dependency';
export interface ReviewGroup {
  id: string; canvasId: string; taskId: string; changeSetIds: string[];
  sequence: number; revision: number; state: ReviewState; source?: ReviewSource; decidedAt?: string;
}
export interface ReviewDecision {
  id: string; canvasId: string; revision: number; action: ReviewAction; createdAt: string;
  groupIds: string[]; refs: string[]; affectedCanvasIds: string[];
  changes: Array<{ changeSetId: string; taskId: string; unitIds: string[]; source: ReviewSource }>;
}
export interface ReviewDelta {
  collection: GraphPatch['collection']; id: string; path: string[];
  before?: unknown; after?: unknown; member?: string; beforeIndex?: number; layout?: boolean;
}
export interface ReviewGhost { id: string; canvasId?: string; kind: 'node' | 'region' | 'edge'; name: string;
  x: number; y: number; width: number; height: number; targetX?: number; targetY?: number }
export interface ReviewUnit {
  id: string; kind: 'create' | 'update' | 'delete' | 'move'; label: string;
  refs: string[]; parentId?: string; requires: string[]; provides: string[]; removes: string[];
  deltas: ReviewDelta[]; dependencies: string[]; ghosts: ReviewGhost[];
  state: 'pending' | 'approved' | 'reverted'; source?: 'user' | 'window' | 'dependency';
  decidedAt?: string; blockers?: string[];
}
export interface ChangeReview {
  canvasId: string; revision: number; callId?: string; sequence?: number; units: ReviewUnit[];
  policy?: 'group'; groupId?: string; decisionIds?: string[];
}
export interface CanvasReviewState { taskIds: string[]; revision: number; groups?: ReviewGroup[]; decisions?: ReviewDecision[] }
export interface ReviewPreview {
  planToken: string; canvasId: string; action: ReviewAction; selectedIds: string[]; unitIds: string[];
  linked: Array<{ id: string; label: string; reason: string }>;
  conflicts: Array<{ unitId: string; message: string }>;
  affectedCanvasIds: string[]; graphRevision: number;
  selectedGroupIds?: string[]; groupIds?: string[]; changeSetIds?: string[]; affectedRefs?: string[];
}
export interface ReviewResult { ok: true; requestId: string; action: ReviewAction; unitIds: string[];
  graphRevision: number; repeated?: boolean }
