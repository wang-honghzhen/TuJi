import type { GraphState } from '@/v3/types';
import type { AppSnapshot } from '../domain';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { graphEntityLookup } from './graph';
import { bindSubgraphVersions } from './subgraphVersions';
import { requireValue } from './errors';

/** Only graph-derived work is shared. Stage visibility and coverage must be
 * recomputed after appending replacements or changing retained entries. */
export interface GraphReadContext {
  graph: GraphState;
  index(canvasId: string): CanvasIndex;
  entity(ref: string): unknown;
  version(key: string, compute: () => string | undefined): string | undefined;
}

/** Fresh for each synchronous candidate build. Do not carry across awaits, graph
 * edits, even when graphRevision is unchanged. */
export function graphReadContext(state: Pick<AppSnapshot, 'graph' | 'directoryVersions'>): GraphReadContext {
  requireValue(state.graph, '画布尚未加载', 'NOT_READY');
  const graph = state.graph, indices = new Map<string, CanvasIndex>();
  const versions = new Map<string, string | undefined>();
  const entity = graphEntityLookup(graph);
  bindSubgraphVersions(graph, state.directoryVersions);
  return { graph, entity,
    index(canvasId) {
      let index = indices.get(canvasId);
      if (!index) { index = canvasIndex(graph, canvasId, canvasMemberIds(graph, canvasId), entity); indices.set(canvasId, index); }
      return index;
    },
    version(key, compute) {
      if (!versions.has(key)) versions.set(key, compute());
      return versions.get(key);
    },
  };
}
