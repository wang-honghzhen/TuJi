import { isAcyclic, layeredLayout, type LayeredFlow, type LayeredLayout, type LayeredNode } from './layeredSeed';
import type { ProjectedRelation } from './relationProjection';
import type { Point } from './types';
import { BLOCK_GAP } from './types';
import { measureArrangement } from './arrangementMetrics';
import { stressLayout } from './stressLayout';

export interface StructuralCandidate extends LayeredLayout { algorithm: string }

/** All edges participate in ranking and barycentre sweeps. Unlike a repeated
 * geometric search, this pass scales with the graph and always places every
 * member. IDs only break ties; caller order has no influence. */
export function structuralCandidates(nodes: readonly LayeredNode[], relations: readonly ProjectedRelation[],
  flow: LayeredFlow, deadline: number): StructuralCandidate[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const neighbours = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of relations) if (byId.has(edge.source) && byId.has(edge.target)) {
    neighbours.get(edge.source)!.add(edge.target); neighbours.get(edge.target)!.add(edge.source);
  }
  const groups: string[][] = [], owner = new Map<string, number>();
  for (const id of [...byId.keys()].sort()) {
    if (owner.has(id)) continue;
    const group = [id], index = groups.length; owner.set(id, index);
    for (let head = 0; head < group.length; head++) for (const next of neighbours.get(group[head])!) {
      if (!owner.has(next)) { owner.set(next, index); group.push(next); }
    }
    groups.push(group);
  }
  if (groups.length <= 1) return connectedCandidates(nodes, relations, flow, deadline);
  const edges = groups.map(() => [] as ProjectedRelation[]);
  for (const edge of relations) if (owner.has(edge.source) && owner.get(edge.source) === owner.get(edge.target)) edges[owner.get(edge.source)!].push(edge);
  const components = groups.map((group, index) => {
    const members = group.map(id => byId.get(id)!);
    const sizes = new Map(members.map(node => [node.id, { x: 0, y: 0, width: node.width, height: node.height }]));
    const choices = connectedCandidates(members, edges[index], flow, nodes.length > 100 ? -Infinity : deadline);
    let winner = choices[0], score = Infinity;
    for (const choice of choices) {
      const value = measureArrangement(group, sizes, Object.fromEntries(choice.positions), edges[index]).score;
      if (value < score) { winner = choice; score = value; }
    }
    return { ...winner, id: group[0] };
  }).sort((a, b) => b.height - a.height || a.id.localeCompare(b.id));
  const gap = BLOCK_GAP * 3;
  const targetWidth = Math.max(...components.map(component => component.width),
    Math.sqrt(components.reduce((area, component) => area + (component.width + gap) * (component.height + gap), 0) * 1.3));
  const positions = new Map<string, Point>();
  let x = 0, y = 0, rowHeight = 0, width = 0;
  for (const component of components) {
    if (x && x + component.width > targetWidth) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    for (const [id, point] of component.positions) positions.set(id, { x: point.x + x, y: point.y + y });
    width = Math.max(width, x + component.width); rowHeight = Math.max(rowHeight, component.height); x += component.width + gap;
  }
  return [{ positions, width, height: y + rowHeight, algorithm: 'components' }];
}

function connectedCandidates(nodes: readonly LayeredNode[], relations: readonly ProjectedRelation[],
  flow: LayeredFlow, deadline: number): StructuralCandidate[] {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(ordered.map(node => node.id));
  const edges = relations.filter(edge => edge.source !== edge.target && ids.has(edge.source) && ids.has(edge.target))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  if (!ordered.length) return [];
  // A connected directed path has exactly one card per rank. Placing those
  // ranks a normal card gap apart already gives Dagre's compact chain.
  const chain = edges.length === ordered.length - 1 && edges.every(edge => edge.directed !== false)
    && new Set(edges.map(edge => edge.source)).size === edges.length && new Set(edges.map(edge => edge.target)).size === edges.length;
  const result: StructuralCandidate[] = [{ ...sweepLayout(ordered, edges, flow, chain ? BLOCK_GAP : BLOCK_GAP * 2), algorithm: 'layer-sweep' }];
  if (chain) return result;
  const cyclic = edges.some(edge => edge.directed === false) || !isAcyclic(ordered.map(node => node.id), edges);
  const ring = cyclic || edges.length >= nodes.length * 2 ? cycleLayout(ordered, edges) : undefined;
  if (ring) result.push({ ...ring, algorithm: 'cycle' });
  // Dagre is useful on small modules. Its synchronous rank/order work cannot be
  // interrupted, so large modules use the bounded sweep above instead.
  if (ordered.length <= 100 && edges.length <= Math.min(350, ordered.length * 3) && edges.every(edge => edge.directed !== false)
    && performance.now() + 15 < deadline) {
    const dagre = layeredLayout(ordered, edges, flow);
    if (dagre) result.push({ ...dagre, algorithm: 'dagre' });
  }
  if (cyclic && ordered.length >= 6 && ordered.length <= 100 && edges.length > ordered.length
    && edges.length <= ordered.length * 6 && performance.now() + 10 < deadline) {
    const stress = stressLayout(ordered, edges);
    const sizes = new Map(ordered.map(node => [node.id, { x: 0, y: 0, width: node.width, height: node.height }]));
    const metrics = (layout: LayeredLayout) => measureArrangement([...ids], sizes, Object.fromEntries(layout.positions), edges);
    // Distance stress can shorten a dense hub by putting a great many edges
    // across one another. Keep the improvement only if it also matches the
    // crossing count of the best existing structural choice.
    const reference = result.map(metrics).reduce((best, next) => next.score < best.score ? next : best);
    if (metrics(stress).crossings <= reference.crossings) result.push({ ...stress, algorithm: 'stress' });
  }
  return result;
}

function sweepLayout(nodes: readonly LayeredNode[], edges: readonly ProjectedRelation[], flow: LayeredFlow, rankGap: number): LayeredLayout {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const neighbours = new Map(nodes.map(node => [node.id, [] as Array<{ id: string; weight: number }>]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    neighbours.get(edge.source)!.push({ id: edge.target, weight: edge.weight });
    neighbours.get(edge.target)!.push({ id: edge.source, weight: edge.weight });
    if (edge.directed !== false) {
      outgoing.get(edge.source)!.push(edge.target);
      degree.set(edge.target, degree.get(edge.target)! + 1);
    }
  }
  const directed = edges.some(edge => edge.directed !== false);
  const rank = new Map(nodes.map(node => [node.id, 0]));
  if (directed) {
    const queue = nodes.filter(node => !degree.get(node.id)).map(node => node.id);
    const visited = new Set<string>();
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]; visited.add(id);
      for (const target of outgoing.get(id)!) {
        rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
        degree.set(target, degree.get(target)! - 1);
        if (!degree.get(target)) queue.push(target);
      }
    }
    if (visited.size !== nodes.length) {
      // DFS finish order gives a deterministic feedback-edge ordering. Only the
      // ranking graph ignores backward edges; original directions stay intact.
      const seen = new Set<string>(), finish: string[] = [];
      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        const stack: Array<{ id: string; index: number }> = [{ id: node.id, index: 0 }]; seen.add(node.id);
        while (stack.length) {
          const top = stack[stack.length - 1], links = outgoing.get(top.id)!;
          if (top.index >= links.length) { finish.push(top.id); stack.pop(); continue; }
          const child = links[top.index++];
          if (!seen.has(child)) { seen.add(child); stack.push({ id: child, index: 0 }); }
        }
      }
      const order = finish.reverse(), ordinal = new Map(order.map((id, index) => [id, index]));
      nodes.forEach(node => rank.set(node.id, 0));
      for (const id of order) for (const target of outgoing.get(id)!) {
        if (ordinal.get(target)! > ordinal.get(id)!) rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      }
    }
  } else {
    // An undirected knowledge network has no reading direction. Distance from
    // its strongest hub gives compact levels without inventing arrow semantics.
    const roots = [...nodes].sort((a, b) => neighbours.get(b.id)!.length - neighbours.get(a.id)!.length || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    for (const root of roots) {
      if (seen.has(root.id)) continue;
      const queue = [root.id]; seen.add(root.id);
      for (let head = 0; head < queue.length; head++) for (const next of neighbours.get(queue[head])!) {
        if (seen.has(next.id)) continue;
        seen.add(next.id); rank.set(next.id, rank.get(queue[head])! + 1); queue.push(next.id);
      }
    }
  }
  const layers: string[][] = [];
  for (const node of nodes) (layers[rank.get(node.id)!] ??= []).push(node.id);
  const order = new Map<string, number>();
  const refresh = () => layers.forEach(layer => layer?.forEach((id, index) => order.set(id, (index + .5) / layer.length)));
  refresh();
  for (let pass = 0; pass < 8; pass++) {
    const indices = layers.map((_, index) => index); if (pass % 2) indices.reverse();
    for (const r of indices) {
      const layer = layers[r]; if (!layer || layer.length < 2) continue;
      const barycentres = new Map(layer.map(id => {
        let weight = 0, sum = 0;
        for (const next of neighbours.get(id)!) {
          const other = rank.get(next.id)!;
          if (pass % 2 ? other <= r : other >= r) continue;
          weight += next.weight; sum += order.get(next.id)! * next.weight;
        }
        return [id, weight ? sum / weight : order.get(id)!] as const;
      }));
      layer.sort((a, b) => barycentres.get(a)! - barycentres.get(b)! || order.get(a)! - order.get(b)! || a.localeCompare(b));
      layer.forEach((id, index) => order.set(id, (index + .5) / layer.length));
    }
  }
  const horizontal = flow === 'left' || flow === 'right';
  const crossSize = (id: string) => horizontal ? nodeMap.get(id)!.height : nodeMap.get(id)!.width;
  const mainSize = (id: string) => horizontal ? nodeMap.get(id)!.width : nodeMap.get(id)!.height;
  const extents = layers.map(layer => (layer ?? []).reduce((sum, id) => sum + crossSize(id) + BLOCK_GAP, -BLOCK_GAP));
  const maxCross = Math.max(0, ...extents), positions = new Map<string, Point>();
  let main = 0;
  for (let r = 0; r < layers.length; r++) {
    const layer = layers[r]; if (!layer?.length) continue;
    let cross = (maxCross - extents[r]) / 2;
    for (const id of layer) {
      positions.set(id, horizontal ? { x: main, y: cross } : { x: cross, y: main });
      cross += crossSize(id) + BLOCK_GAP;
    }
    main += Math.max(...layer.map(mainSize)) + rankGap;
  }
  main = Math.max(0, main - rankGap);
  const width = horizontal ? main : maxCross, height = horizontal ? maxCross : main;
  if (flow === 'left' || flow === 'up') for (const node of nodes) {
    const p = positions.get(node.id)!;
    if (flow === 'left') p.x = width - p.x - node.width; else p.y = height - p.y - node.height;
  }
  return { positions, width, height };
}

/** A circular candidate for cycles and networks. Low-degree neighbours are
 * visited first to follow a cycle's perimeter before its chords; the caller
 * compares this against the layered candidate on the same geometric score. */
function cycleLayout(nodes: readonly LayeredNode[], edges: readonly ProjectedRelation[]): LayeredLayout | undefined {
  if (nodes.length < 3) return undefined;
  const neighbours = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) { neighbours.get(edge.source)!.add(edge.target); neighbours.get(edge.target)!.add(edge.source); }
  const order = [nodes[0].id], seen = new Set(order);
  while (order.length < nodes.length) {
    const next = [...neighbours.get(order[order.length - 1])!]
      .sort((a, b) => neighbours.get(a)!.size - neighbours.get(b)!.size || a.localeCompare(b))
      .find(id => !seen.has(id)) ?? nodes.find(node => !seen.has(node.id))!.id;
    order.push(next); seen.add(next);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const diameter = Math.max(...nodes.map(node => Math.hypot(node.width, node.height))) + BLOCK_GAP;
  const radius = diameter / (2 * Math.sin(Math.PI / nodes.length));
  const positions = new Map<string, Point>();
  for (let index = 0; index < order.length; index++) {
    const angle = index / order.length * Math.PI * 2 - Math.PI / 2, node = byId.get(order[index])!;
    positions.set(node.id, { x: radius * (1 + Math.cos(angle)) + diameter / 2 - node.width / 2,
      y: radius * (1 + Math.sin(angle)) + diameter / 2 - node.height / 2 });
  }
  return { positions, width: radius * 2 + diameter, height: radius * 2 + diameter };
}
