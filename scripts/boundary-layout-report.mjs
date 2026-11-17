import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { makeBoundaryFixtures } from './boundary-layout-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.cache', 'layout-benchmark'); await mkdir(directory, { recursive: true });
const args = process.argv.slice(2), arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const label = arg('--label', 'boundary-current'), repeats = Number(arg('--repeats', '3'));
if (!/^[\w-]+$/.test(label)) throw new Error('Invalid label');
const engineFile = path.join(directory, `${label}-engine.cjs`);
if (!args.includes('--frozen')) {
  const built = await build({ stdin: { contents: [
    "export {layoutRelationships} from './src/v3/relationshipLayout';",
    "export {buildRenderModel} from './src/v3/layout';",
    "export {EdgeRoutingCache} from './src/v3/edgeRouting';",
    "export {pointOnRoute} from './src/v3/edgeGeometry';",
    "export {normalizeRegionLayout} from './src/v3/regionLayout';",
    "export {planMutation} from './src/ai/server/graph';",
  ].join('\n'), resolveDir: root, loader: 'ts' }, outfile: engineFile, bundle: true, format: 'cjs', platform: 'node', target: 'node24', alias: { '@': path.join(root, 'src') }, metafile: true });
  const sourceFiles = Object.keys(built.metafile.inputs).filter(p => p.replaceAll('\\', '/').startsWith('src/')).sort(), digest = createHash('sha256');
  for (const file of sourceFiles) { digest.update(file); digest.update(await readFile(path.resolve(root, file))); }
  await writeFile(path.join(directory, `${label}-engine.source.json`), JSON.stringify({ sourceSha256: digest.digest('hex'), sourceFiles }, null, 2));
}
const engine = createRequire(import.meta.url)(engineFile);
const provenance = JSON.parse(await readFile(path.join(directory, `${label}-engine.source.json`), 'utf8'));
provenance.engineSha256 = createHash('sha256').update(await readFile(engineFile)).digest('hex');
const canvasId = 'boundary', distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const crossing = (a, b, c, d) => {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < -0.01 && side(c, d, a) * side(c, d, b) < -0.01;
};
// Sampling can put the intersection exactly on a sample boundary. Include
// touching/overlapping sampled segments here; shared graph endpoints are excluded above.
const intersectsSegments = (a, b, c, d) => {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const epsilon = 1e-6;
  return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + epsilon &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + epsilon &&
    side(a, b, c) * side(a, b, d) <= epsilon && side(c, d, a) * side(c, d, b) <= epsilon;
};
function model(state, id = canvasId) { return engine.buildRenderModel(state, state.canvases.find(c => c.canvasId === id), { zoom: 1, ignoreCollapse: false, deferRouting: true }); }
function render(state, renderOptions = {}) {
  const view = model(state), started = performance.now(), cache = new engine.EdgeRoutingCache();
  let routed = cache.route(view, { labels: false, budgetMs: 120 }), passes = 1;
  while (routed.stats.pending && passes++ < 12) routed = cache.route(view, { labels: false, budgetMs: 120 });
  const routeMs = performance.now() - started;
  const edges = routed.edges.filter(e => !e.edge.edgeId.startsWith('unrelated')), lines = edges.map(e => [e.source, e.target]);
  const sampled = edges.map(e => Array.from({ length: 65 }, (_, i) => engine.pointOnRoute(e.route, i / 64)));
  let endpointCrossings = 0, routedIntersectingPairs = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i].edge, b = edges[j].edge;
    if ([a.sourceNodeId, a.targetNodeId].some(id => [b.sourceNodeId, b.targetNodeId].includes(id))) continue;
    if (crossing(...lines[i], ...lines[j])) endpointCrossings++;
    const first = sampled[i], second = sampled[j]; let hit = false;
    for (let p = 1; p < first.length && !hit; p++) for (let q = 1; q < second.length; q++) if (intersectsSegments(first[p - 1], first[p], second[q - 1], second[q])) { hit = true; break; }
    if (hit) routedIntersectingPairs++;
  }
  const routeLength = sampled.reduce((total, line) => total + line.slice(1).reduce((sum, point, i) => sum + distance(line[i], point), 0), 0);
  let overlaps = 0;
  for (let i = 0; i < view.blocks.length; i++) for (let j = i + 1; j < view.blocks.length; j++) {
    const a = view.blocks[i], b = view.blocks[j]; if (a.parentId !== b.parentId) continue;
    if (a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width && a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height) overlaps++;
  }
  const metrics = { endpointDistance: +lines.reduce((n, [a, b]) => n + distance(a, b), 0).toFixed(1), routeLength: +routeLength.toFixed(1), endpointCrossings, routedIntersectingPairs,
    overlaps, routingMs: +routeMs.toFixed(2), pending: routed.stats.pending, fallbacks: routed.stats.fallbacks,
    endpoints: edges.map(e => ({ edgeId: e.edge.edgeId, source: e.source, target: e.target, sourceSide: e.sourceSide, targetSide: e.targetSide })) };
  // Exclude the distant unrelated component from the illustration, but keep it in routing and assertions.
  const blocks = view.blocks.filter(b => renderOptions.focusRoots ? renderOptions.focusRoots.some(id => b.id === id || b.id.startsWith(`${id}.`))
    : renderOptions.showUnrelated || !['U', 'V'].includes(b.id) && !/^R\d+(?:\.|$)/.test(b.id));
  const points = edges.flatMap(e => e.route.segments.flat());
  const x = Math.min(...blocks.map(b => b.rect.x), ...points.map(p => p.x)) - 35, y = Math.min(...blocks.map(b => b.rect.y), ...points.map(p => p.y)) - 35;
  const width = Math.max(...blocks.map(b => b.rect.x + b.rect.width), ...points.map(p => p.x)) - x + 35;
  const height = Math.max(...blocks.map(b => b.rect.y + b.rect.height), ...points.map(p => p.y)) - y + 35;
  const containers = blocks.filter(b => b.kind !== 'node').map(b => `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" rx="9" fill="${b.id === 'A' ? '#fff5dd' : '#edf3fa'}" stroke="#9fb3ca"/><text x="${b.rect.x + 12}" y="${b.rect.y + 28}" font-size="20" fill="#263d58">${xml(b.name)}${b.collapsed ? ' (folded)' : ''}</text>`).join('');
  const paths = edges.map(e => `<path d="${xml(e.route.path)}" fill="none" stroke="${e.route.fallback ? '#b86e24' : '#3e80ad'}" stroke-width="3" opacity=".8" marker-end="url(#arrow)"/>`).join('');
  const nodes = blocks.filter(b => b.kind === 'node').map(b => `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" rx="6" fill="white" stroke="#547396"/><text x="${b.rect.x + 12}" y="${b.rect.y + 28}" font-size="18" fill="#203b5a">${xml(b.name)}</text>`).join('');
  return { view, metrics, source: `<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial,sans-serif" viewBox="${x} ${y} ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#3e80ad"/></marker></defs><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f8fafc"/>${containers}${paths}${nodes}</svg>` };
}
const selected = arg('--case', '').split(',').filter(Boolean);
const fixtures = makeBoundaryFixtures().filter(f => !selected.length || selected.includes(f.id));
function solve(fixture) {
  const original = engine.normalizeRegionLayout(structuredClone(fixture.state));
  const before = fixture.command ? engine.planMutation(original, canvasId, fixture.command, 'user').state : original;
  const options = { canvasId, mode: 'auto', viewOnly: true, solveTime: 1, permittedIds: [...Object.keys(before.nodes), ...Object.keys(before.documents)],
    ...(fixture.command ? { changedObjectIds: [fixture.command.id], protectedIds: [fixture.command.id], budgetMs: 80 } : { changedEdgeIds: before.edges.filter(e => e.edgeId !== 'unrelated').map(e => e.edgeId) }) };
  const started = performance.now(), result = engine.layoutRelationships(before, options);
  return { before, after: result.state, elapsedMs: performance.now() - started, stats: result.stats };
}
if (fixtures.length) solve(fixtures[0]);
const rows = [];
for (const fixture of fixtures) {
  const trials = Array.from({ length: repeats }, () => solve(fixture)).sort((a, b) => a.elapsedMs - b.elapsedMs);
  const trial = trials[Math.floor(trials.length / 2)], before = render(trial.before, fixture.renderOptions), after = render(trial.after, fixture.renderOptions);
  const positions = new Map(before.view.blocks.map(b => [b.id, b.rect]));
  const displacements = after.view.blocks.map(b => ({ id: b.id, distance: +distance(positions.get(b.id), b.rect).toFixed(2) })).filter(d => d.distance > .01);
  assert.equal(after.metrics.overlaps, 0, `${fixture.id}: same-parent rectangles overlap`);
  if (label !== 'boundary-baseline') {
    assert.deepEqual(trial.after.documents, trial.before.documents, 'Local view adjustment must not rewrite shared document layout');
    assert.deepEqual(trial.after.canvases[0].placements, trial.before.canvases[0].placements, 'Local view adjustment must not overwrite canonical positions');
  }
  for (const id of [...fixture.fixed, ...fixture.unrelated]) assert.ok(!displacements.some(d => d.id === id), `${fixture.id}: protected/unrelated object moved: ${id}`);
  for (const id of fixture.stableFrames ?? []) {
    const original = before.view.blocks.find(b => b.id === id).rect, next = after.view.blocks.find(b => b.id === id).rect;
    assert.deepEqual(next, original, `${fixture.id}: local adjustment grew ancestor ${id}`);
  }
  if (label !== 'boundary-baseline') for (const id of fixture.expectedMoved ?? []) assert.ok(displacements.some(d => d.id === id), `${fixture.id}: expected related visible object to move: ${id}`);
  if (fixture.otherCanvas) assert.deepEqual(model(trial.after, fixture.otherCanvas).blocks, model(trial.before, fixture.otherCanvas).blocks, 'Other view must stay identical');
  await writeFile(path.join(directory, `${label}-${fixture.id}.svg`), after.source);
  await writeFile(path.join(directory, `${label}-${fixture.id}-input.svg`), before.source);
  await writeFile(path.join(directory, `${label}-${fixture.id}-state.json`), JSON.stringify(trial.after));
  const row = { id: fixture.id, title: fixture.title, before: before.metrics, after: after.metrics, displacements,
    totalDisplacement: +displacements.reduce((n, d) => n + d.distance, 0).toFixed(1), medianMs: +trial.elapsedMs.toFixed(2),
    p95Ms: +trials[Math.min(trials.length - 1, Math.floor(trials.length * .95))].elapsedMs.toFixed(2), stats: trial.stats };
  rows.push(row);
  console.log(`${row.id.padEnd(18)} endpoint ${row.before.endpointDistance}->${row.after.endpointDistance}; route ${row.before.routeLength}->${row.after.routeLength}; routed pairs ${row.before.routedIntersectingPairs}->${row.after.routedIntersectingPairs}; ${row.medianMs} ms`);
}
await writeFile(path.join(directory, `${label}.json`), JSON.stringify({ label, provenance, repeats, notes: 'Lengths/intersecting pairs sample real routed curves at 64 intervals, including contacts and overlaps, excluding shared graph endpoints; near tangencies may be missed. Displacements compare the post-user-move snapshot to the solver result. Unrelated U/V remain in computations and stability assertions but are cropped from figures.', rows }, null, 2));
let baseline; try { baseline = JSON.parse(await readFile(path.join(directory, 'boundary-baseline.json'), 'utf8')); } catch {}
const cards = rows.map(row => {
  const old = baseline?.rows.find(r => r.id === row.id), left = old && label !== 'boundary-baseline' ? `boundary-baseline-${row.id}` : `${label}-${row.id}-input`;
  return `<article><h2>${xml(row.title)}</h2><p>真实端点距离 ${row.before.endpointDistance} → ${row.after.endpointDistance} · 实际路径总长 ${row.before.routeLength} → ${row.after.routeLength} · 曲线相交或重合边对 ${row.before.routedIntersectingPairs} → ${row.after.routedIntersectingPairs}<br>求解中位 ${row.medianMs} ms / p95 ${row.p95Ms} ms · 位移 ${row.displacements.map(d => `${d.id}: ${d.distance}`).join(', ') || '无'}<br>人工锚点与无关区域保持位置；同层重叠 ${row.after.overlaps} · 路由待完成 ${row.after.pending} · 回退 ${row.after.fallbacks}</p><div class="pair"><figure><figcaption>${old && label !== 'boundary-baseline' ? '旧算法结果' : '操作后、布局前'}</figcaption><img src="${left}.svg"/></figure><figure><figcaption>${label} 调整后</figcaption><img src="${label}-${row.id}.svg"/></figure></div></article>`;
}).join('');
await writeFile(path.join(directory, `${label}.html`), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>内部端点与局部布局</title><style>body{font:16px system-ui;background:#f1f5fa;color:#23374c;margin:30px}article{padding:22px;background:white;margin:22px 0;border-radius:14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0}figcaption{padding:10px;font-weight:bold}img{width:100%;height:500px;object-fit:contain;background:#f8fafc}p{line-height:1.8}</style><h1>内部端点与手动移动后的局部调整</h1><p>使用真实折叠状态和应用路由。数值比较的是用户操作后的输入与布局结果；左图在存在旧版报告时展示旧算法结果。源码 SHA-256：${provenance.sourceSha256}</p>${cards}</html>`);
try { GlobalFonts.registerFromPath('C:/Windows/Fonts/arial.ttf', 'Report Sans'); } catch {}
const overviewIds = ['top-bottom', 'bottom-top', 'two-external', 'multi-subgraphs', 'drag-container', 'drag-internal'];
const overviewRows = rows.filter(r => overviewIds.includes(r.id));
if (overviewRows.length) {
  const canvas = createCanvas(1440, 100 + overviewRows.length * 500), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1f5fa'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#23374c';
  ctx.font = 'bold 27px "Report Sans",sans-serif'; ctx.fillText(`Internal terminals and local layout: ${label}`, 30, 46);
  for (const [i, row] of overviewRows.entries()) {
    const y = 100 + i * 500, left = baseline && label !== 'boundary-baseline' ? `boundary-baseline-${row.id}` : `${label}-${row.id}-input`;
    ctx.font = 'bold 21px "Report Sans",sans-serif'; ctx.fillText(`${row.id} | route ${row.before.routeLength} -> ${row.after.routeLength} | ${row.medianMs} ms`, 30, y + 27);
    for (const [column, file] of [left, `${label}-${row.id}`].entries()) {
      const svg = (await readFile(path.join(directory, `${file}.svg`), 'utf8')).replace('<svg ', '<svg width="680" height="420" ');
      ctx.drawImage(await loadImage(Buffer.from(svg)), 30 + column * 700, y + 50, 680, 420);
    }
  }
  await writeFile(path.join(directory, `${label}.png`), canvas.toBuffer('image/png'));
}
console.log(`Report ${path.join(directory, `${label}.html`)}\nSource ${provenance.sourceSha256}`);
