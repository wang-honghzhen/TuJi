import type { GranularityIndex, GranularityProjection } from './canvasGranularity';

export interface EndpointPaths { source: string; target: string; fullTarget: string }

/** Resolve against actual owners, even when a folded ancestor represents the end on screen. */
export function neighborhoodPaths(index: GranularityIndex, scene: GranularityProjection, nameOf: (id: string) => string) {
  const paths = new Map<string, string[]>(), labels = new Map<string, EndpointPaths>();
  function ancestry(id: string): string[] {
    let path = paths.get(id);
    if (!path) {
      const parent = index.parents.get(id);
      path = parent ? [...ancestry(parent), id] : [id];
      paths.set(id, path);
    }
    return path;
  }
  function add(id: string, source?: string, target?: string) {
    if (!source || !target || source === target) return;
    const a = ancestry(source), b = ancestry(target);
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    const display = (parts: string[]) => parts.map(part => nameOf(part) || '未命名').join(' / ');
    const fullTarget = display(b);
    labels.set(id, { source: display(a), fullTarget, target: shared && shared < b.length ? '… / ' + display(b.slice(shared)) : fullTarget });
  }
  const owner = (id: string) => index.groupIds.has(id) ? id : index.parents.get(id);
  for (const edge of scene.edges) add(edge.edgeId, owner(edge.sourceNodeId), owner(edge.targetNodeId));
  for (const relation of scene.relations) {
    const pair = index.relations.get(relation.id)!;
    add(relation.id, pair.sourceSubgraphId, pair.targetSubgraphId);
  }
  return labels;
}
