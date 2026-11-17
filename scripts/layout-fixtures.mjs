// Deterministic graphs used by layout-benchmark.mjs. No user workspace data is read.
const time = '2026-11-15T00:00:00.000Z';
export const canvasId = 'benchmark';
const nodeId = n => `n${String(n).padStart(4, '0')}`;
function shuffled(count, seed = 17) {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
function flat(count, pairs, { longText = false, directed = true } = {}) {
  const ids = Array.from({ length: count }, (_, i) => nodeId(i));
  const order = shuffled(count), columns = Math.ceil(Math.sqrt(count));
  const placements = Object.fromEntries(ids.map((id, i) => [id, {
    x: (order[i] % columns) * 400, y: Math.floor(order[i] / columns) * 260, source: 'auto',
  }]));
  return { layoutVersion: 3, documents: {}, nodes: Object.fromEntries(ids.map((id, i) => [id, {
    nodeId: id, name: `${i + 1}${longText && i % 3 === 0 ? ' · 图谱布局中的长标题与多行内容' : ''}`,
    content: longText && i % 3 === 0 ? '有向关系、子图边界与可变尺寸需要一并考虑。\n'.repeat(4) : '',
  }])), canvases: [{ canvasId, canvasName: 'Layout benchmark', updatedAt: time, childIds: ids,
    directories: {}, placements, collapsed: {} }],
  edges: pairs.map(([source, target], i) => ({ edgeId: `e${i}`, sourceNodeId: nodeId(source),
    targetNodeId: nodeId(target), edgeContent: '', directed })) };
}
const chain = count => Array.from({ length: count - 1 }, (_, i) => [i, i + 1]);
const tree = count => Array.from({ length: count - 1 }, (_, i) => [Math.floor(i / 2), i + 1]);
function layers(width, depth) {
  const pairs = [];
  for (let level = 0; level < depth - 1; level++) for (let i = 0; i < width; i++) {
    pairs.push([level * width + i, (level + 1) * width + i]);
    if (i % 2 === 0) pairs.push([level * width + i, (level + 1) * width + (i + 1) % width]);
  }
  return pairs;
}
function nested() {
  const groups = 4, groupSize = 12, pairs = [];
  for (let g = 0; g < groups; g++) for (const [a, b] of tree(groupSize)) pairs.push([g * groupSize + a, g * groupSize + b]);
  for (let g = 0; g < groups - 1; g++) for (let i = 0; i < 4; i++) pairs.push([g * groupSize + i, (g + 1) * groupSize + i]);
  const state = flat(groups * groupSize, pairs, { longText: true });
  const canvas = state.canvases[0]; canvas.childIds = [];
  for (let g = 0; g < groups; g++) {
    const id = `module${g}`, nestedId = `${id}-detail`;
    const all = Array.from({ length: groupSize }, (_, i) => nodeId(g * groupSize + i));
    const document = (documentId, childNodeIds, childDocumentIds, placements) => ({ documentId, kind: 'subgraph',
      name: documentId, childNodeIds, childDocumentIds, placements, rev: 1,
      metadata: { createdAt: time, updatedAt: time, version: '3.0' } });
    const placements = Object.fromEntries(all.map((node, i) => [node, { x: i % 3 * 400, y: Math.floor(i / 3) * 260, source: 'auto' }]));
    state.documents[nestedId] = document(nestedId, all.slice(8), [], Object.fromEntries(all.slice(8).map((node, i) => [node, { x: i % 2 * 400, y: Math.floor(i / 2) * 260, source: 'auto' }])));
    state.documents[id] = document(id, all.slice(0, 8), [nestedId], { ...Object.fromEntries(all.slice(0, 8).map(node => [node, placements[node]])), [nestedId]: { x: 0, y: 900, source: 'auto' } });
    canvas.childIds.push(id); canvas.placements[id] = { x: g % 2 * 1500, y: Math.floor(g / 2) * 1800, source: 'auto' };
    all.forEach(node => delete canvas.placements[node]);
  }
  return state;
}
export function makeFixtures(normalize) {
  const fixtures = [];
  const add = (id, title, state, extra = {}) => {
    const normalized = normalize(state);
    fixtures.push({ id, title, state: normalized, ids: Object.keys(normalized.nodes).concat(Object.keys(normalized.documents)), ...extra });
  };
  add('chain-batch', '24 节点链 · 同批提交', flat(24, chain(24)));
  add('chain-delayed', '24 节点链 · 分三批补边', flat(24, chain(24)), { delayed: true });
  add('tree-batch', '63 节点树 · 同批提交', flat(63, tree(63)));
  add('tree-delayed', '63 节点树 · 分三批补边', flat(63, tree(63)), { delayed: true });
  add('layered', '60 节点依赖图', flat(60, layers(10, 6)));
  add('long-text', '48 节点 · 不同卡片尺寸', flat(48, layers(8, 6), { longText: true }));
  add('cycle', '32 节点环及弦', flat(32, [...chain(32), [31, 0], [0, 16], [8, 24]]), { delayed: true });
  const clusters = [];
  for (let i = 0; i < 72; i++) { const start = Math.floor(i / 12) * 12; clusters.push([i, start + (i + 1) % 12], [i, start + (i + 3) % 12]); }
  for (let i = 0; i < 5; i++) clusters.push([i * 12, (i + 1) * 12]);
  add('undirected', '72 节点 · 无向关联簇', flat(72, clusters, { directed: false }));
  add('nested', '48 节点 · 两级嵌套子图', nested(), { delayed: true });
  const shared = nested();
  const second = structuredClone(shared.canvases[0]);
  second.canvasId = 'second-view'; second.canvasName = 'Same shared content, second view';
  second.placements.module0 = { x: 600, y: 200, source: 'manual', manualAnchor: { x: 600, y: 200 }, lastManualAt: Date.parse(time) };
  shared.canvases.push(second);
  add('shared', '共享子图 · 双画布与固定容器', shared, { delayed: true });
  const manual = flat(48, layers(8, 6));
  for (const index of [0, 7, 18]) {
    const p = manual.canvases[0].placements[nodeId(index)];
    p.source = 'manual'; p.manualAnchor = { x: p.x, y: p.y }; p.lastManualAt = Date.parse(time);
  }
  add('manual', '48 节点 · 三个人工锚点', manual, { delayed: true, protectedIds: [nodeId(24)] });
  add('organize', '60 节点 · 手动整理已有图', flat(60, layers(10, 6)), { organize: true });
  const dense = [];
  for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++) if ((i + j) % 2) dense.push([i, j]);
  for (let i = 24; i < 64; i++) dense.push([i, 24 + (i - 24 + 1) % 40], [i, 24 + (i - 24 + 4) % 40]);
  dense.push(...chain(64).map(([a, b]) => [64 + a, 64 + b]));
  add('late-edges', '128 节点 · 第 180 条之后的关系', flat(128, dense), { delayed: true, tailIds: Array.from({ length: 64 }, (_, i) => nodeId(64 + i)) });
  add('large', '400 节点 · 大图耗时', flat(400, layers(20, 20)), { delayed: true });
  add('stress', '1000 节点 · 性能压力', flat(1000, layers(25, 40)), { delayed: true, performanceOnly: true });
  return fixtures;
}
