import type { LayeredLayout, LayeredNode } from './layeredSeed';
import type { ProjectedRelation } from './relationProjection';
import { nearestRegionSpace } from './regionLayout';
import { RectangleIndex } from './rectangleIndex';
import { BLOCK_GAP, type Point } from './types';

/** Short graph distances pull related nodes together, while distant branches
 * have room to separate. Used as an additional candidate on small cyclic
 * components where a single flow axis can put unrelated branches in one rank. */
export function stressLayout(nodes: readonly LayeredNode[], edges: readonly ProjectedRelation[]): LayeredLayout {
  const n = nodes.length, index = new Map(nodes.map((node, i) => [node.id, i]));
  const links = nodes.map(() => new Set<number>());
  for (const edge of edges) {
    const a = index.get(edge.source)!, b = index.get(edge.target)!;
    links[a].add(b); links[b].add(a);
  }
  // The caller supplies one connected component in a stable ID order.
  const hops = nodes.map((_, i) => {
    const distances = new Uint16Array(n), queue = [i];
    for (let head = 0; head < queue.length; head++) for (const j of links[queue[head]]) {
      if (j !== i && !distances[j]) { distances[j] = distances[queue[head]] + 1; queue.push(j); }
    }
    return distances;
  });
  // Stretch the seed along a long graph path so bridges between dense groups
  // do not start out folded back into the same neighbourhood.
  const farthest = (distances: Uint16Array) => distances.indexOf(Math.max(...distances));
  const a = farthest(hops[0]), b = farthest(hops[a]);
  let centres = nodes.map((_, i) => ({
    x: (hops[a][i] - hops[b][i]) / 2 + .05 * Math.cos(2 * Math.PI * i / n),
    y: Math.sin(2 * Math.PI * i / n) + .5 * Math.cos(2 * Math.PI * i * .61803398875),
  }));
  // Minimise weighted distance stress (weight = 1 / desiredDistance²).
  for (let pass = 0; pass < 64; pass++) {
    centres = centres.map((p, i) => {
      let x = 0, y = 0, total = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const q = centres[j], desired = hops[i][j], w = 1 / (desired * desired);
        const dx = p.x - q.x, dy = p.y - q.y;
        const scale = desired / Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
        x += w * (q.x + dx * scale); y += w * (q.y + dy * scale); total += w;
      }
      return { x: x / total, y: y / total };
    });
  }
  const stepX = nodes.reduce((sum, node) => sum + node.width, 0) / n + BLOCK_GAP;
  const stepY = nodes.reduce((sum, node) => sum + node.height, 0) / n + BLOCK_GAP;
  const occupied = new RectangleIndex(), positions = new Map<string, Point>();
  for (let i = 0; i < n; i++) {
    const node = nodes[i], centre = centres[i], size = { width: node.width, height: node.height, x: 0, y: 0 };
    const point = nearestRegionSpace(size, {
      x: Math.round(centre.x * stepX * 2 - node.width / 2), y: Math.round(centre.y * stepY * 2 - node.height / 2),
    }, occupied, true);
    occupied.add({ ...size, ...point }); positions.set(node.id, point);
  }
  const left = Math.min(...occupied.rects.map(r => r.x)), top = Math.min(...occupied.rects.map(r => r.y));
  for (const p of positions.values()) { p.x -= left; p.y -= top; }
  return { positions, width: Math.max(...occupied.rects.map(r => r.x + r.width)) - left,
    height: Math.max(...occupied.rects.map(r => r.y + r.height)) - top };
}
