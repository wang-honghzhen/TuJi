import { createHash } from 'node:crypto';
import { getCanvasPaths } from '@/v3/paths';
import { getHierarchyIndex } from '@/v3/hierarchyIndex';
import { presentationPlacement } from '@/v3/presentationLayout';
import type { GraphState, Placement } from '@/v3/types';

const positionStamp = (position?: Placement) => position ? [position.x, position.y, position.source,
  position.lastManualAt ?? null, position.manualAnchor ? [position.manualAnchor.x, position.manualAnchor.y] : null] : null;

export function visibleDragDistance(before: GraphState, after: GraphState, canvasId: string, parentId: string, id: string): number | undefined {
  const local = (state: GraphState) => {
    const canvas = state.canvases.find(item => item.canvasId === canvasId);
    const base = (state.documents[parentId]?.placements ?? canvas?.placements)?.[id];
    return canvas && base && presentationPlacement(canvas, id, parentId, base);
  };
  const start = local(before), end = local(after);
  return start && end ? Math.hypot(end.x - start.x, end.y - start.y) : undefined;
}

/** The user's drop is relative to this ancestry, not to the whole graph
 * revision. Unrelated text/edge edits can safely coexist; a new drag, ownership
 * change, fold, or even an invalidated view offset must fence an older drop. */
export function manualMoveBasis(graph: GraphState, canvasId: string, id: string): string | undefined {
  const canvas = graph.canvases.find(item => item.canvasId === canvasId);
  if (!canvas || id === canvasId || (!graph.nodes[id] && !graph.documents[id] && !canvas.directories[id])) return undefined;
  const rows = getCanvasPaths(graph, canvas), byId = new Map(rows.map(row => [row.id, row]));
  const target = byId.get(id); if (!target) return undefined;
  const hierarchy = getHierarchyIndex(graph);
  const ownership = (ref: string): string[] => {
    const chain: string[] = [], seen = new Set<string>();
    let owner = hierarchy.nodeParents.get(ref) ?? hierarchy.documentParents.get(ref);
    while (owner && !seen.has(owner)) {
      seen.add(owner); chain.push(owner); owner = hierarchy.documentParents.get(owner);
    }
    return chain;
  };
  const ancestry = target.segments.map(segment => {
    const ref = segment.id, parentId = byId.get(ref)?.parentId;
    const position = parentId ? (graph.documents[parentId]?.placements ?? canvas.placements)[ref] : undefined;
    const view = canvas.presentationPlacements?.[ref];
    return [ref, parentId ?? null, segment.kind, ownership(ref), positionStamp(position),
      view ? [view.parentId, view.baseX, view.baseY, view.x, view.y] : null, Boolean(canvas.collapsed[ref])];
  });
  return createHash('sha256').update(JSON.stringify([canvasId, id, ancestry])).digest('hex');
}

/** Moving a container moves the active editor inside it. Protect canonical
 * ancestors and all shared mounts as well as the explicitly occupied objects.
 * Keeping unrelated active refs in the set is harmless and avoids losing a
 * shared ancestor merely because its active descendant is hidden here. */
export function activePlacementProtection(graph: GraphState, canvasId: string, refs: Iterable<string>): Set<string> {
  const protectedIds = new Set(refs), queue = [...protectedIds];
  if (!queue.length) return protectedIds;
  const hierarchy = getHierarchyIndex(graph), local = hierarchy.canvasParents.get(canvasId);
  const add = (id?: string) => { if (id && !protectedIds.has(id)) { protectedIds.add(id); queue.push(id); } };
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    add(hierarchy.nodeParents.get(id)); add(hierarchy.documentParents.get(id)); add(local?.get(id));
    for (const parents of hierarchy.canvasParents.values()) if (parents !== local) add(parents.get(id));
  }
  return protectedIds;
}
