import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasId, makeFixtures } from './layout-fixtures.mjs';
import { makeBoundaryFixtures } from './boundary-layout-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.cache', 'layout-tests');
await mkdir(out, { recursive: true });
await build({ stdin: { contents: [
  "export { layoutRelationships } from './src/v3/relationshipLayout';",
  "export { normalizeRegionLayout, getNaturalGeometry } from './src/v3/regionLayout';",
  "export { nodeGeometry } from './src/v3/nodeGeometry';",
  "export { buildRenderModel } from './src/v3/layout';",
  "export { previewBlockMove } from './src/v3/regionLayout';",
  "export { getRelationProjection } from './src/v3/relationProjection';",
  "export { relationEndpointGeometry } from './src/v3/relationEndpointGeometry';",
  "export { validateStructure } from './src/v3/storage';",
  "export { measureArrangement } from './src/v3/arrangementMetrics';",
].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  outfile: path.join(out, 'solver.cjs') });
const engine = createRequire(import.meta.url)(path.join(out, 'solver.cjs'));
const fixtures = makeFixtures(engine.normalizeRegionLayout);
const fixture = id => structuredClone(fixtures.find(f => f.id === id));
const placements = state => ({ canvas: state.canvases.map(c => c.placements),
  docs: Object.fromEntries(Object.entries(state.documents).map(([id, doc]) => [id, doc.placements])) });
const solve = (f, state = f.state, extra = {}) => engine.layoutRelationships(state, { canvasId, mode: 'auto',
  provisionalIds: f.ids, permittedIds: f.ids, solveTime: 1794700800000, ...extra });
function quality(state) {
  const geometry = engine.getNaturalGeometry(state);
  let score = 0, crossings = 0;
  for (const region of engine.getRelationProjection(state).values()) {
    const doc = state.documents[region.id], canvas = state.canvases.find(c => c.canvasId === (region.canvasId ?? canvasId));
    const ids = doc ? [...doc.childNodeIds, ...doc.childDocumentIds] : canvas.childIds;
    const sizes = new Map(ids.map(id => [id, state.nodes[id] ? engine.nodeGeometry(state.nodes[id]) : geometry.document(id)]));
    const metrics = engine.measureArrangement(ids, sizes, doc?.placements ?? canvas.placements, region.relations);
    score += metrics.score; crossings += metrics.crossings;
  }
  return { score, crossings };
}

test('delayed edges recover the same zero-crossing chain and tree as a single batch', () => {
  for (const name of ['chain-delayed', 'tree-delayed']) {
    const f = fixture(name), fullEdges = f.state.edges;
    let state = { ...f.state, edges: [] };
    for (let part = 1; part <= 3; part++) {
      state = { ...state, edges: fullEdges.slice(0, Math.ceil(fullEdges.length * part / 3)) };
      const before = quality(state).score;
      state = solve(f, state).state;
      assert.ok(quality(state).score <= before + .01, `${name} part ${part} improved`);
    }
    assert.equal(quality(state).crossings, 0);
    assert.equal(quality(solve(f).state).crossings, 0);
  }
});

test('repeated provisional layout is stable after accepting a structural candidate', () => {
  for (const name of ['chain-delayed', 'tree-delayed', 'cycle', 'undirected', 'late-edges']) {
    const f = fixture(name);
    const first = solve(f).state;
    const second = solve(f, first).state;
    assert.deepEqual(placements(second), placements(first), name);
  }
});

test('all late relations participate and zero refinement budget still covers every region', () => {
  const f = fixture('late-edges');
  const result = solve(f, f.state, { budgetMs: 0 });
  assert.ok(f.tailIds.some(id => result.state.canvases[0].placements[id].x !== f.state.canvases[0].placements[id].x ||
    result.state.canvases[0].placements[id].y !== f.state.canvases[0].placements[id].y));
  const nested = fixture('nested'), arranged = solve(nested, nested.state, { budgetMs: 0 });
  assert.equal(arranged.stats.regions, engine.getRelationProjection(nested.state).size);
  assert.equal(quality(arranged.state).crossings, 0);
});

test('manual and actively protected objects keep their exact placement', () => {
  const f = fixture('manual'), before = structuredClone(f.state);
  const result = solve(f, f.state, { protectedIds: f.protectedIds }).state;
  for (const [id, position] of Object.entries(before.canvases[0].placements)) {
    if (position.source === 'manual' || f.protectedIds.includes(id)) assert.deepEqual(result.canvases[0].placements[id], position);
  }
  assert.deepEqual(f.state, before, 'solver does not mutate input');
});

test('pure cycles use a crossing-free circular candidate', () => {
  const f = fixture('cycle'); f.state.edges = f.state.edges.slice(0, 32);
  const result = solve(f).state;
  assert.equal(quality(result).crossings, 0);
});

test('undirected endpoint order does not change the layout', () => {
  const f = fixture('undirected'), reversed = structuredClone(f.state);
  reversed.edges.forEach(edge => { [edge.sourceNodeId, edge.targetNodeId] = [edge.targetNodeId, edge.sourceNodeId]; });
  assert.deepEqual(placements(solve(f, reversed).state), placements(solve(f).state));
});

test('organizing an already organized region keeps positions stable', () => {
  const f = fixture('organize'), opts = { mode: 'organize', regionId: canvasId };
  const first = solve(f, f.state, opts).state;
  const second = solve(f, first, opts).state;
  assert.deepEqual(placements(first), placements(second));
});

test('normalization preserves an actively edited automatic neighbour when a container grows', () => {
  const before = { layoutVersion: 3, nodes: { a: { nodeId: 'a', name: 'a', content: '' }, b: { nodeId: 'b', name: 'b', content: '' } },
    documents: { d: { documentId: 'd', kind: 'subgraph', name: 'd', childNodeIds: ['a'], childDocumentIds: [],
      placements: { a: { x: 0, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '' } } },
    edges: [], canvases: [{ canvasId, canvasName: '', childIds: ['d', 'b'], directories: {}, collapsed: {}, updatedAt: '',
      placements: { d: { x: 0, y: 0, source: 'auto' }, b: { x: 400, y: 0, source: 'auto' } } }] };
  const after = structuredClone(before); after.documents.d.placements.a.x = 600;
  const normalized = engine.normalizeRegionLayout(after, before, new Set(['b']));
  assert.deepEqual(normalized.canvases[0].placements.b, before.canvases[0].placements.b);
  assert.notDeepEqual(normalized.canvases[0].placements.d, before.canvases[0].placements.d);
});

const viewFixture = () => ({ layoutVersion: 3, nodes: {
  a: { nodeId: 'a', name: 'a', content: '' }, b: { nodeId: 'b', name: 'b', content: '' } }, documents: {}, edges: [],
  canvases: [{ canvasId, canvasName: '', childIds: ['a', 'b'], directories: {}, collapsed: {}, updatedAt: '',
    placements: { a: { x: 0, y: 0, source: 'auto' }, b: { x: 700, y: 0, source: 'auto' } },
    presentationPlacements: { a: { x: 400, y: 0, parentId: canvasId, baseX: 0, baseY: 0 } } }] });
function renderedOverlaps(state) {
  const blocks = engine.buildRenderModel(state, state.canvases[0], { zoom: 1, deferRouting: true }).blocks;
  const a = blocks.find(block => block.id === 'a').rect, b = blocks.find(block => block.id === 'b').rect;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
test('canonical movement revalidates a neighbouring unchanged presentation offset', () => {
  const before = viewFixture(), after = structuredClone(before); after.canvases[0].placements.b.x = 400;
  assert.equal(renderedOverlaps(after), true);
  const result = engine.normalizeRegionLayout(after, before);
  assert.equal(renderedOverlaps(result), false);
  assert.deepEqual(result.canvases[0].placements, after.canvases[0].placements);
});
test('revalidating display offsets preserves actively edited objects', () => {
  const before = viewFixture(), after = structuredClone(before); after.canvases[0].placements.b.x = 400;
  const result = engine.normalizeRegionLayout(after, before, new Set(['a']));
  assert.equal(renderedOverlaps(result), false);
  assert.deepEqual(result.canvases[0].presentationPlacements.a, before.canvases[0].presentationPlacements.a);
});
test('text growth revalidates display geometry while explicit dragging keeps its intent', () => {
  const before = viewFixture(); before.canvases[0].placements.b = { x: 400, y: 100, source: 'auto' };
  const after = structuredClone(before); after.nodes.a.content = 'A long paragraph that expands the card.\n'.repeat(30);
  assert.equal(renderedOverlaps(after), true);
  const result = engine.normalizeRegionLayout(after, before);
  assert.equal(renderedOverlaps(result), false);
  const dragged = engine.previewBlockMove(before, canvasId, 'b', canvasId, { x: 400, y: 0 });
  const committed = engine.normalizeRegionLayout(dragged, before);
  assert.deepEqual(committed.canvases[0].presentationPlacements.a, before.canvases[0].presentationPlacements.a);
  assert.equal(committed.canvases[0].placements.b.x, 400);
});

test('cross-container edges retain their distinct internal terminals for crossing scores', () => {
  const f = makeBoundaryFixtures().find(f => f.id === 'top-bottom');
  f.state.edges.push({ edgeId: 'opposite', sourceNodeId: 'A.bottom', targetNodeId: 'N.top', directed: true, edgeContent: '' });
  const state = engine.normalizeRegionLayout(f.state), canvas = state.canvases[0], geometry = engine.getNaturalGeometry(state);
  const region = [...engine.getRelationProjection(state).values()].find(region => region.id === canvas.canvasId);
  const sizes = new Map(canvas.childIds.map(id => [id, state.nodes[id] ? engine.nodeGeometry(state.nodes[id]) : geometry.document(id)]));
  const endpoints = engine.relationEndpointGeometry(state, canvas, canvas.childIds, sizes, region.relations);
  const measured = engine.measureArrangement(canvas.childIds, sizes, canvas.placements, region.relations, endpoints);
  assert.equal(measured.crossings, 1, 'two distinct endpoints inside the same owner pair still cross');
});

test('endpoint-aware view refinement preserves shared canonical state and settles after one run', () => {
  const f = makeBoundaryFixtures().find(f => f.id === 'shared-view'), before = engine.normalizeRegionLayout(f.state);
  const options = { canvasId: 'boundary', mode: 'auto', viewOnly: true, changedObjectIds: ['A'], solveTime: 1 };
  const first = engine.layoutRelationships(before, options).state;
  assert.equal(first.documents, before.documents);
  assert.equal(first.canvases[1], before.canvases[1]);
  assert.deepEqual(first.canvases[0].placements, before.canvases[0].placements);
  assert.ok(first.canvases[0].presentationPlacements.N, 'connected automatic sibling adjusts');
  assert.deepEqual(engine.layoutRelationships(first, options).state, first);
});

test('ordinary node drop adjusts only its direct automatic neighbour in the view', () => {
  const before = viewFixture(); delete before.canvases[0].presentationPlacements;
  before.nodes.u = { nodeId: 'u', name: 'unrelated', content: '' }; before.canvases[0].childIds.push('u');
  before.canvases[0].placements.u = { x: 3000, y: 0, source: 'auto' };
  before.edges = [{ edgeId: 'ab', sourceNodeId: 'a', targetNodeId: 'b', directed: true, edgeContent: '' }];
  const movedId = 'a', neighbour = 'b';
  const dropped = engine.previewBlockMove(before, canvasId, movedId, canvasId, { x: 0, y: 400 });
  const result = engine.layoutRelationships(dropped, { canvasId, mode: 'auto', viewOnly: true, changedObjectIds: [movedId], protectedIds: [movedId], solveTime: 1 });
  assert.deepEqual(result.state.canvases[0].placements, dropped.canvases[0].placements);
  assert.ok(Object.keys(result.state.canvases[0].presentationPlacements ?? {}).every(id => id === neighbour));
  assert.ok(result.stats.moved > 0);
});

test('a legally mounted shared descendant uses its current canvas parent, not its hidden canonical ancestor', () => {
  const f = makeBoundaryFixtures().find(f => f.id === 'shared-view');
  f.state.documents.P = { documentId: 'P', kind: 'subgraph', name: 'Hidden canonical parent', childNodeIds: [], childDocumentIds: ['N'],
    placements: { N: { x: 0, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3' } };
  f.state.documents.N.childNodeIds = ['N.top', 'N.bottom']; delete f.state.documents.N.placements['N.middle']; delete f.state.nodes['N.middle'];
  f.state.canvases[0].collapsed.P = true; // A stale preference for an unmounted ancestor must not hide N.
  f.state.canvases[1] = { ...f.state.canvases[1], childIds: ['P'], placements: { P: { x: 0, y: 0, source: 'auto' } }, collapsed: { P: true } };
  f.state.edges.push({ edgeId: 'inside-N', sourceNodeId: 'N.top', targetNodeId: 'N.bottom', directed: true, edgeContent: '' });
  engine.validateStructure(f.state);
  const before = engine.normalizeRegionLayout(f.state);
  const moved = engine.previewBlockMove(before, 'boundary', 'N.top', 'N', { x: 0, y: 200 });
  const result = engine.layoutRelationships(moved, { canvasId: 'boundary', mode: 'auto', viewOnly: true,
    changedObjectIds: ['N.top'], protectedIds: ['N.top'], solveTime: 1 });
  assert.ok(result.state.canvases[0].presentationPlacements?.['N.bottom'], 'the visible mounted subgraph is refined');
  assert.equal(result.state.documents, moved.documents);
  assert.equal(result.state.canvases[1], moved.canvases[1]);
});
