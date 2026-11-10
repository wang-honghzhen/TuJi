import { create } from 'zustand';
import type { AppSnapshot } from './domain';
import { reviewEntries, expandReviewSelection, reviewUnitRefs } from './changeReview';
import { useAiStore } from './client';
import { getCanvasPaths } from '@/v3/paths';

type ReviewPanelUi = { round: number; lastTaskId?: string; canvasSelectionKey?: string };
export const DEFAULT_REVIEW_PANEL: ReviewPanelUi = { round: 0 };

export const useReviewUi = create<{
  selected: Record<string, string[]>; selectionRefs: Record<string, string[]>; linked: Record<string, string[]>; boxCanvasId?: string;
  working: Record<string, boolean>; work: (canvasId: string, value: boolean) => void;
  panels: Record<string, ReviewPanelUi>; panel: (canvasId: string, patch: Partial<ReviewPanelUi>) => void;
  select: (canvasId: string, ids: string[], refs?: string[]) => void; link: (canvasId: string, ids: string[]) => void; box: (canvasId?: string) => void;
}>((set) => ({ selected: {}, selectionRefs: {}, linked: {}, working: {}, panels: {},
  panel: (canvasId, patch) => set(s => ({ panels: { ...s.panels, [canvasId]: { ...DEFAULT_REVIEW_PANEL, ...s.panels[canvasId], ...patch } } })),
  work: (canvasId, value) => set(s => ({ working: { ...s.working, [canvasId]: value } })),
  select: (canvasId, ids, refs = []) => set(s => ({ selected: { ...s.selected, [canvasId]: useAiStore.getState().snapshot
    ? expandReviewSelection(useAiStore.getState().snapshot!, ids) : [...new Set(ids)] }, selectionRefs: { ...s.selectionRefs, [canvasId]: [...new Set(refs)] } })),
  link: (canvasId, ids) => set(s => ({ linked: { ...s.linked, [canvasId]: ids } })),
  box: boxCanvasId => set({ boxCanvasId }) }));

export function reviewRefsInArea(state: AppSnapshot, canvasId: string, refs: string[]): Set<string> {
  const canvas = state.graph?.canvases.find(c => c.canvasId === canvasId);
  if (!canvas || !state.graph) return new Set(refs);
  const paths = getCanvasPaths(state.graph, canvas), included = new Set(refs);
  for (const row of paths) if (row.segments.some(s => included.has(s.id))) included.add(row.id);
  for (const edge of state.graph.edges) if (included.has(edge.sourceNodeId) && included.has(edge.targetNodeId)) included.add(edge.edgeId);
  return included;
}
export function reviewUnitsAtRefs(state: AppSnapshot, canvasId: string, refs: string[], includeForeign = false): string[] {
  if (!state.graph?.canvases.some(c => c.canvasId === canvasId)) return [];
  const included = reviewRefsInArea(state, canvasId, refs);
  return expandReviewSelection(state, reviewEntries(state).filter(({ change, unit }) => unit.state === 'pending' && (change.review!.canvasId === canvasId || includeForeign && change.affectedCanvasIds.includes(canvasId))
    && (reviewUnitRefs(unit).some(ref => included.has(ref)) || !!unit.parentId && included.has(unit.parentId))).map(e => e.unit.id));
}
