import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.cache', 'layout-benchmark');
await mkdir(directory, { recursive: true });
const outfile = path.join(directory, 'expansion-engine.cjs');
await build({ stdin: { contents: [
  "export {toggleCollapse, planGraphUpdate} from './src/v3/storage';",
  "export {buildRenderModel} from './src/v3/layout';",
  "export {EdgeRoutingCache} from './src/v3/edgeRouting';",
].join('\n'), resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') } });
const engine = createRequire(import.meta.url)(outfile);
const automatic = (x, y) => ({ x, y, source: 'auto' });
const manual = (x, y) => ({ x, y, source: 'manual', manualAnchor: { x, y }, lastManualAt: 1 });
const node = (id, name) => ({ nodeId: id, name, content: '' });
const doc = (id, nodes, docs, placements) => ({ documentId: id, name: id, kind: 'subgraph', childNodeIds: nodes,
  childDocumentIds: docs, placements, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3' } });
const canvas = (id, childIds, placements, collapsed) => ({ canvasId: id, canvasName: id, updatedAt: '', childIds, placements,
  collapsed, directories: {} });
const edge = (source, target) => ({ edgeId: `${source}-${target}`, sourceNodeId: source, targetNodeId: target, edgeContent: '', directed: true });
function simple(manualNeighbour) {
  return { layoutVersion: 3, nodes: { a: node('a', 'Inside A'), z: node('z', 'Inside Z'), b: node('b', manualNeighbour ? 'Fixed neighbour' : 'Automatic neighbour'), c: node('c', 'Neighbour 2'), far: node('far', 'Unrelated fixed card') },
    documents: { d: doc('d', ['a', 'z'], [], { a: automatic(0, 0), z: automatic(650, 100) }) },
    canvases: [canvas('c1', ['d', 'b', 'c', 'far'], { d: manual(0, 0), b: manualNeighbour ? manual(310, 0) : automatic(310, 0), c: automatic(540, 0), far: manual(1200, 480) }, { d: true })],
    edges: [edge('a', 'z'), edge('z', 'b'), edge('b', 'c')] };
}
function sharedNested() {
  const graph = { layoutVersion: 3, nodes: { a: node('a', 'Inner A'), z: node('z', 'Inner Z'), b: node('b', 'Fixed inner neighbour'), outside: node('outside', 'Outer neighbour') },
    documents: { inner: doc('inner', ['a', 'z'], [], { a: automatic(0, 0), z: automatic(700, 0) }),
      d: doc('d', ['b'], ['inner'], { inner: manual(0, 0), b: manual(310, 0) }) },
    canvases: [canvas('c1', ['d', 'outside'], { d: manual(0, 0), outside: automatic(20, 310) }, { inner: true })],
    edges: [edge('a', 'z'), edge('z', 'b'), edge('b', 'outside')] };
  graph.canvases.push({ ...structuredClone(graph.canvases[0]), canvasId: 'c2', canvasName: 'Other canvas' });
  return graph;
}
const fixtures = [
  { id: 'automatic-neighbours', title: '展开固定子图，自动邻居让位', state: simple(false), opener: 'd', fixed: ['d', 'far'] },
  { id: 'manual-neighbour', title: '人工邻居保持原位，展开对象寻找空位', state: simple(true), opener: 'd', fixed: ['b', 'far'] },
  { id: 'nested-shared', title: '嵌套共享子图：仅当前画布避让，外层随尺寸增长调整', state: sharedNested(), opener: 'inner', fixed: ['d', 'b'], otherCanvas: 'c2' },
];
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function render(state, canvasId) {
  const canvas = state.canvases.find(c => c.canvasId === canvasId);
  const model = engine.buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: false, deferRouting: true });
  const cache = new engine.EdgeRoutingCache(), started = performance.now();
  let routed = cache.route(model, { labels: false, budgetMs: 150 }), passes = 1;
  while (routed.stats.pending && passes < 10) { routed = cache.route(model, { labels: false, budgetMs: 150 }); passes++; }
  const points = routed.edges.flatMap(e => e.route.segments.flat());
  const x = Math.min(model.bounds.x, ...points.map(p => p.x)) - 45, y = Math.min(model.bounds.y, ...points.map(p => p.y)) - 45;
  const width = Math.max(model.bounds.x + model.bounds.width, ...points.map(p => p.x)) - x + 45;
  const height = Math.max(model.bounds.y + model.bounds.height, ...points.map(p => p.y)) - y + 45;
  const position = id => canvas.placements[id] ?? Object.values(state.documents).find(d => d.placements[id])?.placements[id];
  const boxes = model.blocks.filter(b => b.kind !== 'node').sort((a, b) => a.depth - b.depth).map(b => {
    const fixed = position(b.id)?.source === 'manual';
    return `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" fill="${fixed ? '#fff9ec' : '#eaf2fb'}" stroke="${fixed ? '#be8d31' : '#94abc7'}" rx="10"/><text x="${b.rect.x + 14}" y="${b.rect.y + 30}" font-size="20" fill="#243d5b">${xml(b.name)}${b.collapsed ? ' (collapsed)' : ' (expanded)'}</text>`;
  }).join('');
  const paths = routed.edges.map(e => `<path d="${xml(e.route.path)}" fill="none" stroke="${e.route.fallback ? '#bd6934' : '#778da8'}" stroke-width="2" marker-end="url(#arrow)"/>`).join('');
  const nodes = model.blocks.filter(b => b.kind === 'node').map(b => `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" fill="${position(b.id)?.source === 'manual' ? '#fff0cd' : 'white'}" stroke="#607f9e" rx="7"/><text x="${b.rect.x + 12}" y="${b.rect.y + 29}" font-size="16" fill="#243d5b">${xml(b.name)}</text>`).join('');
  let overlaps = 0;
  for (let i = 0; i < model.blocks.length; i++) for (let j = i + 1; j < model.blocks.length; j++) {
    const a = model.blocks[i], b = model.blocks[j]; if (a.parentId !== b.parentId) continue;
    if (a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width && a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height) overlaps++;
  }
  return { model, overlaps, routing: { ...routed.stats, passes, totalMs: performance.now() - started },
    source: `<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial,sans-serif" viewBox="${x} ${y} ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#778da8"/></marker></defs><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f8fafc"/>${boxes}${paths}${nodes}</svg>` };
}
const rows = [];
for (const fixture of fixtures) {
  const before = render(fixture.state, 'c1');
  const started = performance.now();
  const result = engine.planGraphUpdate(() => engine.toggleCollapse(fixture.state, 'c1', fixture.opener));
  const elapsedMs = performance.now() - started;
  const after = render(result, 'c1');
  assert.equal(before.overlaps, 0, `${fixture.id}: fixture must be valid when folded`);
  assert.equal(after.overlaps, 0, `${fixture.id}: opened objects must not overlap their peers`);
  assert.deepEqual(result.documents, fixture.state.documents, 'Canonical shared content must remain unchanged');
  assert.deepEqual(result.canvases[0].placements, fixture.state.canvases[0].placements, 'Canonical positions must remain unchanged');
  for (const id of fixture.fixed) {
    const a = before.model.blocks.find(b => b.id === id), b = after.model.blocks.find(b => b.id === id);
    assert.equal(a.rect.x, b.rect.x, `${fixture.id}: fixed ${id} x`); assert.equal(a.rect.y, b.rect.y, `${fixture.id}: fixed ${id} y`);
  }
  await writeFile(path.join(directory, `expand-${fixture.id}-before.svg`), before.source);
  await writeFile(path.join(directory, `expand-${fixture.id}-after.svg`), after.source);
  if (fixture.otherCanvas) {
    assert.deepEqual(result.canvases[1], fixture.state.canvases[1]);
    const otherBefore = render(fixture.state, fixture.otherCanvas), otherAfter = render(result, fixture.otherCanvas);
    assert.deepEqual(otherBefore.model.blocks, otherAfter.model.blocks, 'Other canvas geometry must remain identical');
    await writeFile(path.join(directory, 'expand-other-canvas.svg'), otherAfter.source);
  }
  rows.push({ id: fixture.id, title: fixture.title, before, after, elapsedMs: +elapsedMs.toFixed(2),
    changes: result.canvases[0].presentationPlacements, fixed: fixture.fixed, otherCanvasUnchanged: !!fixture.otherCanvas });
}
const html = rows.map(r => `<article><h2>${xml(r.title)}</h2><p>展开处理 ${r.elapsedMs} ms · 同层重叠 ${r.before.overlaps} → ${r.after.overlaps} · ${r.fixed.join(', ')} 保持显示位置 · 原始布局和共享内容不变${r.otherCanvasUnchanged ? ' · 第二画布完全不变' : ''}<br>实际路由：${r.after.routing.pending} 条待计算 / ${r.after.routing.fallbacks} 条回退</p><div class="pair"><figure><figcaption>展开前</figcaption><img src="expand-${r.id}-before.svg"/></figure><figure><figcaption>展开后</figcaption><img src="expand-${r.id}-after.svg"/></figure></div></article>`).join('');
await writeFile(path.join(directory, 'expand.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>展开避让验证</title><style>body{font:15px system-ui;background:#f1f5fa;color:#23374c;margin:32px}article{padding:24px;background:white;border-radius:14px;margin:24px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}figcaption{font-weight:bold;padding:10px}img{width:100%;height:420px;object-fit:contain;background:#f8fafc;border:1px solid #e0e8ef}p{line-height:1.7}</style><h1>展开子图后的自动避让</h1><p>使用真实折叠状态、应用渲染模型和连线路由。黄色对象具有人工位置；视图避让记录独立于共享文档。</p>${html}<article><h2>未操作的第二画布</h2><p>共享文档内部展开，只改变第一画布的显示；下图仍保持折叠。</p><img src="expand-other-canvas.svg"/></article></html>`);
await writeFile(path.join(directory, 'expand.json'), JSON.stringify(rows.map(({ before, after, ...rest }) => ({ ...rest, overlapsBefore: before.overlaps, overlapsAfter: after.overlaps, routing: after.routing })), null, 2));
try { GlobalFonts.registerFromPath('C:/Windows/Fonts/arial.ttf', 'Report Sans'); } catch {}
const png = createCanvas(1440, 110 + rows.length * 500), ctx = png.getContext('2d');
ctx.fillStyle = '#f1f5fa'; ctx.fillRect(0, 0, png.width, png.height);
ctx.fillStyle = '#23374c'; ctx.font = 'bold 28px "Report Sans",sans-serif'; ctx.fillText('Expand a subgraph: before / after', 30, 46);
ctx.font = '17px "Report Sans",sans-serif'; ctx.fillText('Actual rendering and routes. Amber: manual positions. Shared content and the other canvas stay unchanged.', 30, 82);
for (let i = 0; i < rows.length; i++) {
  const row = rows[i], y = 110 + i * 500;
  ctx.font = 'bold 22px "Report Sans",sans-serif'; ctx.fillText(`${row.id}: no overlaps | ${row.elapsedMs} ms`, 30, y + 27);
  for (const [column, source] of [row.before.source, row.after.source].entries()) {
    const bitmap = await loadImage(Buffer.from(source.replace('<svg ', '<svg width="680" height="420" ')));
    ctx.drawImage(bitmap, 30 + column * 700, y + 50, 680, 420);
  }
}
await writeFile(path.join(directory, 'expand.png'), png.toBuffer('image/png'));
console.log(`3 expansion scenarios passed. Report: ${path.join(directory, 'expand.html')}`);
