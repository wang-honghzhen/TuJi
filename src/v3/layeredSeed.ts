import dagre from 'dagre';
import type { Point } from './types';
import { BLOCK_GAP } from './types';

/**
 * A structural seed for a batch of new children that arrive already related.
 *
 * The incremental solver places one child at a time beside the strongest
 * partner it can see, which is right for an addition to a settled region and
 * wrong for a whole structure that arrives at once: nothing in that batch is
 * "settled", so every child is placed as if it were the first. This module
 * produces an alternative starting arrangement — ranks along the flow, one row
 * per depth — and nothing else. The caller keeps its own acceptance test, so a
 * seed can be rejected; the seed never writes positions by itself.
 *
 * Only acyclic input gets a rank assignment. A cyclic batch has no flow to
 * order, and inventing one would misrepresent the relations the AI just wrote.
 */

export type LayeredFlow = 'down' | 'up' | 'right' | 'left';

export interface LayeredNode { id: string; width: number; height: number }
export interface LayeredRelation { source: string; target: string; weight: number }

export interface LayeredLayout {
  /** Region-local top-left corners, normalised so the block starts at (0, 0). */
  positions: Map<string, Point>;
  width: number;
  height: number;
}

const RANKDIR: Record<LayeredFlow, string> = { down: 'TB', up: 'BT', right: 'LR', left: 'RL' };

/** Kahn's algorithm over the induced subgraph; self-loops carry no flow. */
export function isAcyclic(ids: readonly string[], relations: readonly LayeredRelation[]): boolean {
  const inside = new Set(ids);
  const degree = new Map(ids.map(id => [id, 0]));
  const outgoing = new Map<string, string[]>();
  let edges = 0;
  for (const relation of relations) {
    if (relation.source === relation.target) continue;
    if (!inside.has(relation.source) || !inside.has(relation.target)) continue;
    degree.set(relation.target, degree.get(relation.target)! + 1);
    outgoing.set(relation.source, [...(outgoing.get(relation.source) ?? []), relation.target]);
    edges += 1;
  }
  const queue = ids.filter(id => degree.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!; visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      const remaining = degree.get(next)! - 1; degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return edges === 0 ? false : visited === ids.length;
}

export function layeredLayout(
  nodes: readonly LayeredNode[],
  relations: readonly LayeredRelation[],
  flow: LayeredFlow = 'down',
  // 'tight-tree' ranks and orders as well as the network-simplex default on
  // small batches and costs about a millisecond less, which matters because the
  // whole insertion budget is 16 ms.
  ranker = 'tight-tree',
): LayeredLayout | undefined {
  if (nodes.length < 2) return undefined;
  const ids = nodes.map(node => node.id);
  if (!isAcyclic(ids, relations)) return undefined;
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: RANKDIR[flow], nodesep: BLOCK_GAP, ranksep: BLOCK_GAP, marginx: 0, marginy: 0, ranker });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  for (const relation of relations) {
    if (relation.source === relation.target) continue;
    graph.setEdge(relation.source, relation.target, { weight: relation.weight });
  }
  dagre.layout(graph);
  const placed = new Map<string, Point>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const point = graph.node(node.id);
    const x = point.x - node.width / 2, y = point.y - node.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    placed.set(node.id, { x, y });
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + node.width); maxY = Math.max(maxY, y + node.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  for (const [id, point] of placed) placed.set(id, { x: Math.round(point.x - minX), y: Math.round(point.y - minY) });
  return { positions: placed, width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
}
