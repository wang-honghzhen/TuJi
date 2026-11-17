// Compare the dense 24-node component using the application's actual edge routes.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.cache', 'layout-benchmark');
const labels = process.argv.slice(2).length ? process.argv.slice(2) : ['dense-before', 'dense-after'];
const focus = new Set(Array.from({ length: 24 }, (_, i) => `n${String(i).padStart(4, '0')}`));
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
try { GlobalFonts.registerFromPath('C:/Windows/Fonts/arial.ttf', 'Report Sans'); } catch {}
const overview = createCanvas(1600, 1280), context = overview.getContext('2d');
context.fillStyle = '#f1f5fa'; context.fillRect(0, 0, 1600, 1280);
context.font = 'bold 26px "Report Sans",sans-serif'; context.fillStyle = '#23374c';
context.fillText('Dense component: 24 nodes, 144 relationships', 30, 42);
context.font = '17px "Report Sans",sans-serif'; context.fillText('Actual application routes, all surrounding obstacles retained during routing.', 30, 74);
const cards = [];
for (const [column, label] of labels.entries()) {
  const engine = createRequire(import.meta.url)(path.join(directory, `${label}-engine.cjs`));
  const state = JSON.parse(await readFile(path.join(directory, `${label}-late-edges-state.json`), 'utf8'));
  const model = engine.buildRenderModel(state, state.canvases[0], { zoom: 1, ignoreCollapse: true, deferRouting: true });
  const cache = new engine.EdgeRoutingCache();
  let routed = cache.route(model, { labels: false, budgetMs: 200 }), passes = 1;
  while (routed.stats.pending && passes++ < 12) routed = cache.route(model, { labels: false, budgetMs: 200 });
  const nodes = model.blocks.filter(b => focus.has(b.id));
  const edges = routed.edges.filter(e => focus.has(e.edge.sourceNodeId) && focus.has(e.edge.targetNodeId));
  const points = edges.flatMap(e => e.route.segments.flat());
  const x = Math.min(...nodes.map(n => n.rect.x), ...points.map(p => p.x)) - 35;
  const y = Math.min(...nodes.map(n => n.rect.y), ...points.map(p => p.y)) - 35;
  const width = Math.max(...nodes.map(n => n.rect.x + n.rect.width), ...points.map(p => p.x)) - x + 35;
  const height = Math.max(...nodes.map(n => n.rect.y + n.rect.height), ...points.map(p => p.y)) - y + 35;
  const content = edges.map(e => `<path d="${xml(e.route.path)}" stroke="${e.route.fallback ? '#c66a27' : '#527da4'}" stroke-width="2.1" fill="none" opacity=".65"/>`).join('') + nodes.map(n => `<rect x="${n.rect.x}" y="${n.rect.y}" width="${n.rect.width}" height="${n.rect.height}" fill="white" stroke="#375c83" rx="6"/><text x="${n.rect.x + 12}" y="${n.rect.y + 28}" font-size="19" fill="#223c57">${xml(n.name)}</text>`).join('');
  const source = `<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial,sans-serif" viewBox="${x} ${y} ${width} ${height}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f8fafc"/>${content}</svg>`;
  await writeFile(path.join(directory, `${label}-dense-detail.svg`), source);
  const image = await loadImage(Buffer.from(source.replace('<svg ', '<svg width="750" height="1120" ')));
  context.font = 'bold 22px "Report Sans",sans-serif'; context.fillStyle = '#23374c'; context.fillText(label, 30 + 800 * column, 116);
  context.drawImage(image, 30 + 800 * column, 140, 750, 1120);
  cards.push(`<figure><figcaption>${label}</figcaption><img src="${label}-dense-detail.svg"/></figure>`);
}
await writeFile(path.join(directory, 'dense-detail.png'), overview.toBuffer('image/png'));
await writeFile(path.join(directory, 'dense-detail.html'), `<!doctype html><html><meta charset="utf-8"><title>Dense component detail</title><style>body{font:18px system-ui;background:#f1f5fa;color:#23374c;margin:30px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%;height:1000px;object-fit:contain}figcaption{padding:20px;font-weight:bold}</style><h1>Dense component: 24 nodes, 144 relationships</h1><p>Actual routes, with all surrounding obstacles retained during routing. Orange routes are fallbacks.</p><div class="pair">${cards.join('')}</div></html>`);
console.log(`Dense detail: ${path.join(directory, 'dense-detail.png')}`);
