import type { GraphState } from './types';
import { reconcileRegionGeometry } from './regionLayout';

/** Reconcile whole-graph wire updates once; immutable unmodified records retain their identity. */
export function reconcileGraph(previous: GraphState | null | undefined, incoming: GraphState): GraphState {
  if (!previous) { reconcileRegionGeometry(undefined, incoming); return incoming; }
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const records = <T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> => {
    let unchanged = Object.keys(a).length === Object.keys(b).length;
    const next = Object.fromEntries(Object.entries(b).map(([id, value]) => {
      const equal = same(a[id], value); unchanged &&= equal; return [id, equal ? a[id] : value];
    })); return unchanged ? a : next;
  };
  const array = <T>(a: T[], b: T[], id: (v: T) => string): T[] => {
    const old = new Map(a.map(v => [id(v), v])); const values = b.map(v => same(old.get(id(v)), v) ? old.get(id(v))! : v);
    return a.length === values.length && a.every((v, i) => v === values[i]) ? a : values;
  };
  const next = { ...incoming, nodes: records(previous.nodes, incoming.nodes), documents: records(previous.documents, incoming.documents),
    canvases: array(previous.canvases, incoming.canvases, c => c.canvasId), edges: array(previous.edges, incoming.edges, e => e.edgeId) };
  if (next.nodes === previous.nodes && next.documents === previous.documents && next.canvases === previous.canvases && next.edges === previous.edges &&
    next.layoutVersion === previous.layoutVersion) return previous;
  reconcileRegionGeometry(previous, next); return next;
}
