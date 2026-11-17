import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeFixtures, canvasId } from './layout-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const label = arg('--label', 'current');
if (!/^[\w-]+$/.test(label)) throw new Error('label must be a filename-safe word');
const directory = path.join(root, '.cache', 'layout-benchmark');
await mkdir(directory, { recursive: true });
const engineFile = path.join(directory, `${label}-engine.cjs`);
let provenance;
if (!args.includes('--frozen')) {
const compiled = await build({ stdin: { contents: [
  "export {layoutRelationships} from './src/v3/relationshipLayout';",
  "export {nodeGeometry} from './src/v3/nodeGeometry';",
  "export {getNaturalGeometry, normalizeRegionLayout} from './src/v3/regionLayout';",
  "export {getRelationProjection} from './src/v3/relationProjection';",
  "export {buildRenderModel} from './src/v3/layout';",
  "export {EdgeRoutingCache} from './src/v3/edgeRouting';",
].join('\n'), loader: 'ts', resolveDir: root }, outfile: engineFile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', metafile: true });
const sourceFiles = Object.keys(compiled.metafile.inputs).filter(file => file.replaceAll('\\', '/').startsWith('src/')).sort();
const digest = createHash('sha256');
for (const file of sourceFiles) { digest.update(file); digest.update('\0'); digest.update(await readFile(path.resolve(root, file))); digest.update('\0'); }
provenance = { sourceSha256: digest.digest('hex'), sourceFiles };
await writeFile(path.join(directory, `${label}-engine.source.json`), JSON.stringify(provenance, null, 2));
} else {
  try { provenance = JSON.parse(await readFile(path.join(directory, `${label}-engine.source.json`), 'utf8')); } catch { provenance = { sourceSha256: null, sourceFiles: [], note: 'Historical frozen engine; source identity is represented by engineSha256.' }; }
}
provenance.engineSha256 = createHash('sha256').update(await readFile(engineFile)).digest('hex');
const engine = createRequire(import.meta.url)(engineFile);
const budgetMs = args.includes('--budget') ? Number(arg('--budget')) : undefined;
const repeats = Number(arg('--repeats', '3'));
const wanted = arg('--case', '').split(',').filter(Boolean);
const fixtures = makeFixtures(engine.normalizeRegionLayout).filter(f => !wanted.length || wanted.includes(f.id));
const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const cross = (a, b, c, d) => {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
};
function metrics(state, original, fixture) {
  const geometry = engine.getNaturalGeometry(state), canvas = state.canvases[0];
  const originalPositions = { ...original.canvases[0].placements, ...Object.assign({}, ...Object.values(original.documents).map(d => d.placements)) };
  const positions = { ...canvas.placements, ...Object.assign({}, ...Object.values(state.documents).map(d => d.placements)) };
  let overlaps = 0, crossings = 0, length = 0, count = 0, area = 0;
  const regions = [...state.canvases.map(c => ({ id: c.canvasId, ids: c.childIds, positions: c.placements })), ...Object.values(state.documents).map(d => ({ id: d.documentId, ids: [...d.childNodeIds, ...d.childDocumentIds], positions: d.placements }))];
  const relations = [...engine.getRelationProjection(state).values()];
  for (const region of regions) {
    const rectangles = new Map(region.ids.map(id => [id, { ...(state.nodes[id] ? engine.nodeGeometry(state.nodes[id]) : geometry.document(id)), ...region.positions[id] }]));
    const rects = [...rectangles.values()];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps++;
    }
    if (region.id === canvasId && rects.length) area = (Math.max(...rects.map(r => r.x + r.width)) - Math.min(...rects.map(r => r.x))) * (Math.max(...rects.map(r => r.y + r.height)) - Math.min(...rects.map(r => r.y)));
    const edges = relations.filter(r => r.id === region.id).flatMap(r => r.relations).filter(e => rectangles.has(e.source) && rectangles.has(e.target));
    const segments = edges.map(e => [center(rectangles.get(e.source)), center(rectangles.get(e.target))]);
    segments.forEach(([a, b]) => { length += Math.hypot(b.x - a.x, b.y - a.y); count++; });
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue;
      if (cross(...segments[i], ...segments[j])) crossings++;
    }
  }
  const moved = Object.keys(positions).filter(id => originalPositions[id] && (positions[id].x !== originalPositions[id].x || positions[id].y !== originalPositions[id].y));
  const fixed = Object.keys(originalPositions).filter(id => originalPositions[id].source === 'manual' || originalPositions[id].manualAnchor || fixture.protectedIds?.includes(id));
  const fixedMoved = moved.filter(id => fixed.includes(id));
  for (const c of state.canvases.slice(1)) {
    const previous = original.canvases.find(old => old.canvasId === c.canvasId);
    for (const [id, p] of Object.entries(previous?.placements ?? {})) if ((p.source === 'manual' || p.manualAnchor || fixture.protectedIds?.includes(id)) && (c.placements[id]?.x !== p.x || c.placements[id]?.y !== p.y)) fixedMoved.push(`${c.canvasId}/${id}`);
  }
  return { overlaps, crossings, averageEdgeLength: Math.round(length / Math.max(1, count)), area: Math.round(area), moved: moved.length,
    fixedMoved, tailMoved: fixture.tailIds ? moved.filter(id => fixture.tailIds.includes(id)).length : undefined,
    finite: Object.values(positions).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) };
}
function run(fixture) {
  const original = structuredClone(fixture.state);
  let state = original;
  const fullEdges = original.edges;
  const stats = [], times = [];
  const solve = (extra) => {
    const started = performance.now();
    const result = engine.layoutRelationships(state, { canvasId, mode: fixture.organize ? 'organize' : 'auto',
      ...(fixture.organize ? { regionId: canvasId } : {}), permittedIds: fixture.ids, protectedIds: fixture.protectedIds,
      solveTime: Date.parse('2026-11-15T00:00:00.000Z'), ...(budgetMs === undefined ? {} : { budgetMs }), ...extra });
    times.push(performance.now() - started); stats.push(result.stats); state = result.state;
  };
  if (fixture.delayed) {
    state = { ...state, edges: [] }; solve({ insertedIds: fixture.ids, movableIds: fixture.ids });
    for (let i = 1; i <= 3; i++) {
      const next = fullEdges.slice(0, Math.ceil(fullEdges.length * i / 3));
      const changedEdgeIds = next.slice(state.edges.length).map(e => e.edgeId);
      state = { ...state, edges: next };
      solve({ provisionalIds: fixture.ids, changedEdgeIds });
    }
  } else solve({ insertedIds: fixture.organize ? [] : fixture.ids, movableIds: fixture.organize ? [] : fixture.ids,
    changedEdgeIds: fullEdges.map(e => e.edgeId) });
  return { state, stats, times, metrics: metrics(state, original, fixture) };
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function svg(state, fixture, route = true) {
  const model = engine.buildRenderModel(state, state.canvases[0], { zoom: 1, ignoreCollapse: true, deferRouting: true });
  const routingStarted = performance.now();
  const cache = new engine.EdgeRoutingCache();
  let routed = route ? cache.route(model, { labels: false, budgetMs: 200 }) : { edges: model.edges, stats: {} };
  let passes = route ? 1 : 0;
  while (route && routed.stats.pending && passes < 12 && performance.now() - routingStarted < 2400) {
    routed = cache.route(model, { labels: false, budgetMs: 200 }); passes++;
  }
  if (route) routed.stats = { ...routed.stats, passes, totalMs: +(performance.now() - routingStarted).toFixed(2), complete: !routed.stats.pending };
  const routePoints = routed.edges.flatMap(edge => edge.route.segments.flat());
  const x = Math.min(model.bounds.x, ...routePoints.map(point => point.x));
  const y = Math.min(model.bounds.y, ...routePoints.map(point => point.y));
  const width = Math.max(model.bounds.x + model.bounds.width, ...routePoints.map(point => point.x)) - x;
  const height = Math.max(model.bounds.y + model.bounds.height, ...routePoints.map(point => point.y)) - y;
  const containers = model.blocks.filter(b => b.kind !== 'node').sort((a, b) => a.depth - b.depth).map(b => `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" rx="12" fill="${b.depth % 2 ? '#e8f0fb' : '#f0f5fa'}" stroke="#a0b8d0"/><text x="${b.rect.x + 16}" y="${b.rect.y + 30}" font-size="18" fill="#28415b">${xml(b.name)}</text>`).join('');
  const edges = routed.edges.map(e => `<path d="${xml(e.route.path)}" fill="none" stroke="${e.route.fallback ? '#c76b28' : '#7c93af'}" stroke-width="1.8" opacity=".7"${e.edge.directed ? ' marker-end="url(#arrow)"' : ''}/>`).join('');
  const nodes = model.blocks.filter(b => b.kind === 'node').map(b => {
    const p = state.canvases[0].placements[b.id] ?? Object.values(state.documents).find(d => d.placements[b.id])?.placements[b.id];
    const fixed = p?.source === 'manual' || fixture.protectedIds?.includes(b.id);
    return `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.width}" height="${b.rect.height}" rx="7" fill="${fixed ? '#fff1d6' : '#ffffff'}" stroke="${fixed ? '#bd8425' : '#5476a1'}" stroke-width="2"/><text x="${b.rect.x + 12}" y="${b.rect.y + 27}" font-size="16" fill="#203652">${xml(b.name.slice(0, 22))}</text>${b.content ? `<text x="${b.rect.x + 12}" y="${b.rect.y + 55}" font-size="12" fill="#65788d">多行内容 · ${b.rect.width} × ${b.rect.height}</text>` : ''}`;
  }).join('');
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x - 40} ${y - 40} ${width + 80} ${height + 80}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7c93af"/></marker></defs><rect x="${x - 40}" y="${y - 40}" width="${width + 80}" height="${height + 80}" fill="#f8fafc"/>${containers}${edges}${nodes}</svg>`, stats: routed.stats };
}
// Warm up Dagre/JIT before recording timed runs. Fixtures always start from fresh state.
if (fixtures.length) run(fixtures[0]);
const rows = [];
for (const fixture of fixtures) {
  const results = Array.from({ length: repeats }, () => run(fixture));
  const ordered = results.slice().sort((a, b) => a.times.reduce((n, t) => n + t, 0) - b.times.reduce((n, t) => n + t, 0));
  const representative = ordered[Math.floor(ordered.length / 2)];
  const values = results.flatMap(r => r.times).sort((a, b) => a - b);
  const before = metrics(fixture.state, fixture.state, fixture), after = representative.metrics;
  const rendered = fixture.performanceOnly ? { stats: {}, source: undefined } : svg(representative.state, fixture);
  await writeFile(path.join(directory, `${label}-${fixture.id}-state.json`), JSON.stringify(representative.state));
  if (rendered.source) {
    await writeFile(path.join(directory, `${label}-${fixture.id}.svg`), rendered.source);
    await writeFile(path.join(directory, `${label}-${fixture.id}-before.svg`), svg(fixture.state, fixture, false).source);
  }
  const row = { id: fixture.id, title: fixture.title, performanceOnly: !!fixture.performanceOnly, nodes: Object.keys(fixture.state.nodes).length, edges: fixture.state.edges.length,
    before, after, timing: { medianSolveMs: +values[Math.floor(values.length / 2)].toFixed(2), p95SolveMs: +values[Math.min(values.length - 1, Math.floor(values.length * .95))].toFixed(2),
      medianTotalMs: +representative.times.reduce((n, t) => n + t, 0).toFixed(2) }, stats: representative.stats, routing: rendered.stats,
    qualityRange: { crossingsMin: Math.min(...results.map(r => r.metrics.crossings)), crossingsMax: Math.max(...results.map(r => r.metrics.crossings)) } };
  rows.push(row);
  console.log(`${row.id.padEnd(14)} crossings ${before.crossings} -> ${after.crossings}; overlap ${after.overlaps}; fixed moved ${after.fixedMoved.length}; median ${row.timing.medianSolveMs} ms; p95 ${row.timing.p95SolveMs} ms`);
}
const report = { label, generatedAt: new Date().toISOString(), provenance, budgetMs: budgetMs ?? 'default', repeats,
  metricNotes: 'Crossings/edge lengths use all same-parent projected straight segments, excluding shared endpoints. They are layout proxies, not routed intersection counts. SVGs show application routing. Timings exclude rendering, fixture normalization and metrics. P95 is descriptive for this small deterministic suite, not a production latency guarantee.', rows };
await writeFile(path.join(directory, `${label}.json`), JSON.stringify(report, null, 2));
let baseline;
try { baseline = JSON.parse(await readFile(path.join(directory, 'baseline.json'), 'utf8')); } catch {}
const cards = rows.map(row => {
  const old = baseline?.rows.find(r => r.id === row.id);
  if (row.performanceOnly) return `<article><h2>${xml(row.title)}</h2><p>${row.nodes} 节点 / ${row.edges} 边 · 交叉代理 ${row.before.crossings} → ${row.after.crossings} · 重叠 ${row.after.overlaps} · 单次求解中位 ${row.timing.medianSolveMs} ms / p95 ${row.timing.p95SolveMs} ms · 此压力样例不进行路由及绘图</p></article>`;
  return `<article><h2>${xml(row.title)}</h2><p>${row.nodes} 节点 / ${row.edges} 边 · 直线关系交叉：初始 ${row.before.crossings} → ${row.after.crossings}${old && label !== 'baseline' ? `（旧版 ${old.after.crossings}）` : ''} · 同层重叠 ${row.after.overlaps} · 人工锚点移动 ${row.after.fixedMoved.length} · 单次求解中位 ${row.timing.medianSolveMs} ms / p95 ${row.timing.p95SolveMs} ms<br>路由单独耗时 ${row.routing.totalMs} ms · ${row.routing.passes} 轮 · 回退 ${row.routing.fallbacks} 条 · ${row.routing.pending ? `仍有 ${row.routing.pending} 条临时路径（续算达到上限）` : '路由计算完成'}</p><div class="pair"><figure><figcaption>${old && label !== 'baseline' ? '旧版布局' : '初始位置'}</figcaption><a href="${old && label !== 'baseline' ? `baseline-${row.id}` : `${label}-${row.id}-before`}.svg"><img loading="lazy" src="${old && label !== 'baseline' ? `baseline-${row.id}` : `${label}-${row.id}-before`}.svg"/></a></figure><figure><figcaption>${xml(label)} · 点击查看完整图</figcaption><a href="${label}-${row.id}.svg"><img loading="lazy" src="${label}-${row.id}.svg"/></a></figure></div></article>`;
}).join('');
await writeFile(path.join(directory, `${label}.html`), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>布局实验 · ${xml(label)}</title><style>body{font:15px system-ui;margin:32px;color:#23374c;background:#f1f5fa}h1{font-size:28px}article{background:white;border:1px solid #dce4ed;border-radius:14px;padding:20px;margin:24px 0}h2{font-size:20px;margin:0 0 8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}figcaption{padding:10px 0;font-weight:600}img{width:100%;height:470px;object-fit:contain;border:1px solid #e1e8f1;border-radius:8px;background:#f8fafc}p{line-height:1.7}@media(max-width:900px){.pair{grid-template-columns:1fr}}</style><h1>布局实验 · ${xml(label)}</h1><p>每个样例从相同的确定性初始图开始，重复 ${repeats} 次，展示总耗时居中的结果。黄色为人工锚点或保护对象。交叉数按同层投影直线计算；图中显示应用实际路由（橙色为回退路径）。测试不读取现有软件数据。</p>${cards}</html>`);
const failures = rows.filter(r => !r.after.finite || r.after.overlaps || r.after.fixedMoved.length);
if (failures.length) { console.error('Invariant failures:', failures.map(r => r.id).join(', ')); process.exitCode = 1; }
console.log(`Report: ${path.join(directory, `${label}.html`)}`);
console.log(`Source SHA-256: ${provenance.sourceSha256 ?? 'historical frozen engine'}; engine SHA-256: ${provenance.engineSha256}`);
const overviewCases = ['chain-delayed', 'tree-delayed', 'long-text', 'cycle', 'nested', 'manual'].filter(id => rows.some(row => row.id === id));
if (overviewCases.length) {
  const { createCanvas, loadImage, GlobalFonts } = await import('@napi-rs/canvas');
  try { GlobalFonts.registerFromPath('C:/Windows/Fonts/arial.ttf', 'Report Sans'); } catch {}
  try { GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'Report CJK'); } catch {}
  const width = 1440, tileHeight = 440;
  const canvas = createCanvas(width, 110 + overviewCases.length * tileHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1f5fa'; ctx.fillRect(0, 0, width, canvas.height);
  ctx.font = 'bold 27px "Report Sans", sans-serif'; ctx.fillStyle = '#23374c'; ctx.fillText(`Layout comparison: baseline / ${label}`, 30, 43);
  ctx.font = '16px "Report Sans", sans-serif'; ctx.fillText('Application edge routes. Amber cards: fixed positions. Crossings below are straight-line proxies.', 30, 78);
  for (let i = 0; i < overviewCases.length; i++) {
    const id = overviewCases[i], row = rows.find(r => r.id === id), y = 110 + i * tileHeight;
    ctx.font = 'bold 20px "Report Sans", sans-serif'; ctx.fillStyle = '#23374c';
    const leftCrossings = label !== 'baseline' ? baseline?.rows.find(r => r.id === id)?.after.crossings ?? row.before.crossings : row.before.crossings;
    ctx.fillText(`${id} | crossings ${leftCrossings} -> ${row.after.crossings} | ${row.timing.medianSolveMs} ms`, 30, y + 26);
    const left = baseline?.rows.some(r => r.id === id) && label !== 'baseline' ? `baseline-${id}.svg` : `${label}-${id}-before.svg`;
    for (const [column, file] of [left, `${label}-${id}.svg`].entries()) {
      const content = (await readFile(path.join(directory, file), 'utf8')).replace('<svg ', '<svg font-family="Report CJK, Report Sans, sans-serif" width="680" height="380" ');
      const bitmap = await loadImage(Buffer.from(content));
      ctx.drawImage(bitmap, 30 + column * 700, y + 45, 680, 380);
    }
  }
  await writeFile(path.join(directory, `${label}-overview.png`), canvas.toBuffer('image/png'));
}
