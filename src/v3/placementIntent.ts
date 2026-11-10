import { inheritRegionGeometry, normalizeRegionLayout } from './regionLayout';
import type { GraphState, Placement } from './types';

/** Called by the host, after final collision resolution; time is never accepted from tool arguments. */
export function recordPlacementIntent(state: GraphState, canvasId: string, parentId: string, id: string,
  actor: 'user' | 'ai', timestamp: number): GraphState {
  const doc = state.documents[parentId], canvas = state.canvases.find(c => c.canvasId === canvasId);
  const previous = doc?.placements[id] ?? canvas?.placements[id]; if (!previous || !canvas) return state;
  const position: Placement = actor === 'user' ? { ...previous, source: 'manual', lastManualAt: timestamp,
    manualAnchor: { x: previous.x, y: previous.y } } : { ...previous, source: 'auto' };
  const next: GraphState = doc ? { ...state, documents: { ...state.documents, [parentId]: { ...doc, placements: { ...doc.placements, [id]: position } } } } :
    { ...state, canvases: state.canvases.map(c => c === canvas ? { ...c, placements: { ...c.placements, [id]: position } } : c) };
  return actor === 'ai' && previous.source === 'manual' ? normalizeRegionLayout(next, state) : inheritRegionGeometry(state, next);
}
