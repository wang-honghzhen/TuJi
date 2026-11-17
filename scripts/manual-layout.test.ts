import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activePlacementProtection, manualMoveBasis } from '../src/ai/server/manualLayout';
import { planMutation, normalizedGraph } from '../src/ai/server/graph';
import { buildRenderModel } from '../src/v3/layout';
import { normalizeRegionLayout, previewBlockMove, validateRegionLayout } from '../src/v3/regionLayout';
import { intersects } from '../src/v3/rectangleIndex';
import type { GraphState } from '../src/v3/types';

function fixture(): GraphState {
  return { layoutVersion: 3, nodes: { n: { nodeId: 'n', name: 'node', content: '' }, other: { nodeId: 'other', name: 'other', content: '' } },
    documents: { d: { documentId: 'd', kind: 'document', name: 'shared', childNodeIds: ['n'], childDocumentIds: [],
      placements: { n: { x: 10, y: 20, source: 'manual', lastManualAt: 100, manualAnchor: { x: 10, y: 20 } } },
      rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } } }, edges: [],
    canvases: [{ canvasId: 'c', canvasName: 'current', updatedAt: '', childIds: ['folder'],
      directories: { folder: { name: 'folder', childIds: ['d'] } }, collapsed: {},
      placements: { folder: { x: 100, y: 100, source: 'manual' }, d: { x: 0, y: 0, source: 'auto' } },
      presentationPlacements: { n: { parentId: 'd', baseX: 10, baseY: 20, x: 300, y: 400 } } },
    { canvasId: 'other-canvas', canvasName: 'other', updatedAt: '', childIds: ['d', 'other'], directories: {}, collapsed: {},
      placements: { d: { x: 1000, y: 1000, source: 'manual' }, other: { x: 2000, y: 0, source: 'auto' } } }] };
}

test('manual move basis ignores unrelated revisions, names, body edits, and other canvas positions', () => {
  const before = fixture(), basis = manualMoveBasis(before, 'c', 'n'); assert.ok(basis);
  const next = structuredClone(before);
  next.nodes.n.content = 'body changed'; next.nodes.n.name = 'renamed'; next.nodes.other.content = 'unrelated';
  next.documents.d.rev++; next.documents.d.name = 'renamed shared'; next.documents.d.metadata.updatedAt = 'new';
  next.canvases[0].canvasName = 'renamed canvas'; next.canvases[0].directories.folder.name = 'renamed folder';
  next.canvases[1].placements.d.x = 2500;
  next.edges.push({ edgeId: 'edge', sourceNodeId: 'n', targetNodeId: 'other', directed: true, edgeContent: '' });
  assert.equal(manualMoveBasis(next, 'c', 'n'), basis);
});

test('manual move basis fences canonical positions, drag timestamps, anchors, folds, and raw view offsets', () => {
  const before = fixture(), basis = manualMoveBasis(before, 'c', 'n');
  const changes: Array<(graph: GraphState) => void> = [
    graph => { graph.documents.d.placements.n.x++; },
    graph => { graph.documents.d.placements.n.lastManualAt = 101; },
    graph => { graph.documents.d.placements.n.manualAnchor!.y++; },
    graph => { graph.documents.d.placements.n.source = 'auto'; },
    graph => { graph.canvases[0].placements.folder.x++; },
    graph => { graph.canvases[0].placements.d.y++; },
    graph => { graph.canvases[0].collapsed.d = true; },
    graph => { graph.canvases[0].collapsed.folder = true; },
    graph => { graph.canvases[0].presentationPlacements!.n.x++; },
    graph => { graph.canvases[0].presentationPlacements!.n.baseX++; },
    graph => { delete graph.canvases[0].presentationPlacements!.n; },
    graph => { graph.canvases[0].presentationPlacements!.folder = { parentId: 'c', baseX: 100, baseY: 100, x: 100, y: 700 }; },
  ];
  for (const mutate of changes) {
    const next = structuredClone(before); mutate(next);
    assert.notEqual(manualMoveBasis(next, 'c', 'n'), basis, mutate.toString());
  }
});

test('ownership changes, removal, and exclusion fence a drop even if coordinates stay equal', () => {
  const before = fixture(), basis = manualMoveBasis(before, 'c', 'n');
  const moved = structuredClone(before);
  moved.documents.d.childNodeIds = []; moved.canvases[0].directories.folder.childIds.push('n');
  moved.canvases[0].placements.n = { ...moved.documents.d.placements.n };
  assert.notEqual(manualMoveBasis(moved, 'c', 'n'), basis);
  const deleted = structuredClone(before); delete deleted.nodes.n;
  assert.equal(manualMoveBasis(deleted, 'c', 'n'), undefined);
  const excluded = structuredClone(before); excluded.canvases[0].excludedDocumentIds = ['d'];
  assert.equal(manualMoveBasis(excluded, 'c', 'n'), undefined);
  assert.equal(manualMoveBasis(before, 'missing', 'n'), undefined);
  assert.equal(manualMoveBasis(before, 'c', 'c'), undefined);
  // Original ownership can change while the same document stays mounted here.
  const reowned = structuredClone(before);
  reowned.documents.outer = { documentId: 'outer', kind: 'document', name: '', childNodeIds: [], childDocumentIds: ['d'],
    placements: { d: { x: 0, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } };
  assert.notEqual(manualMoveBasis(reowned, 'c', 'n'), basis);
});

test('active editing protection includes every ancestor and shared mount but no siblings', () => {
  const graph = fixture();
  assert.deepEqual([...activePlacementProtection(graph, 'c', ['n'])].sort(), ['c', 'd', 'folder', 'n', 'other-canvas']);
  assert.deepEqual([...activePlacementProtection(graph, 'c', [])], []);
  assert.equal(activePlacementProtection(graph, 'c', ['n']).has('other'), false);
  const local = activePlacementProtection(graph, 'other-canvas', ['other']);
  assert.deepEqual([...local].sort(), ['other', 'other-canvas']);
});

function growingFixture(): GraphState {
  const graph = fixture();
  graph.canvases = [{ canvasId: 'c', canvasName: '', updatedAt: '', childIds: ['d', 'other'], directories: {}, collapsed: {},
    placements: { d: { x: 0, y: 0, source: 'auto' }, other: { x: 310, y: 0, source: 'auto' } } }];
  graph.documents.d.placements.n = { x: 0, y: 0, source: 'auto' };
  return graph;
}
const block = (graph: GraphState, id: string) => buildRenderModel(graph, graph.canvases[0], { zoom: 1, skipEdges: true }).blocks.find(item => item.id === id)!;
const coordinates = (graph: GraphState) => Object.fromEntries(Object.entries(graph.canvases[0].placements)
  .map(([id, p]) => [id, { x: p.x, y: p.y, source: p.source }]));

test('dragging a child to enlarge its container preserves its exact world-space drop', () => {
  const graph = growingFixture(), origin = block(graph, 'n').anchor;
  const preview = previewBlockMove(graph, 'c', 'n', 'd', { x: 500, y: 0 });
  assert.deepEqual(preview.canvases[0].placements.d, graph.canvases[0].placements.d);
  assert.deepEqual(preview.canvases[0].placements.other, graph.canvases[0].placements.other, 'neighbours do not shift while the pointer moves');
  assert.deepEqual(block(preview, 'n').anchor, { x: origin.x + 500, y: origin.y });
  const committed = planMutation(graph, 'c', { type: 'moveBlock', id: 'n', parentId: 'd', point: { x: 500, y: 0 } }, 'user').state;
  assert.deepEqual(committed.canvases[0].placements.d, graph.canvases[0].placements.d);
  assert.deepEqual(block(committed, 'n').anchor, { x: origin.x + 500, y: origin.y });
  assert.equal(committed.documents.d.placements.n.source, 'manual');
  assert.equal(committed.canvases[0].placements.d.source, 'auto', 'temporary ancestor protection is not a persistent manual flag');
});

test('a growing dragged container may overlap an active neighbour without moving either fixed object', () => {
  const graph = growingFixture(), beforeOther = block(graph, 'other').anchor;
  const active = new Set(['other']);
  const preview = previewBlockMove(graph, 'c', 'n', 'd', { x: 500, y: 0 }, active);
  assert.deepEqual(preview.canvases[0].placements, graph.canvases[0].placements);
  const committed = planMutation(graph, 'c', { type: 'moveBlock', id: 'n', parentId: 'd', point: { x: 500, y: 0 } }, 'user', active).state;
  assert.deepEqual(block(committed, 'other').anchor, beforeOther);
  assert.deepEqual(coordinates(committed), coordinates(graph));
});

test('active descendants protect automatic ancestor containers during another drop', () => {
  const graph = growingFixture();
  graph.documents.e = { ...structuredClone(graph.documents.d), documentId: 'e', childNodeIds: ['other'], placements: { other: { x: 0, y: 0, source: 'auto' } } };
  graph.canvases[0].childIds = ['d', 'e']; delete graph.canvases[0].placements.other;
  graph.canvases[0].placements.e = { x: 310, y: 0, source: 'auto' };
  const before = block(graph, 'other').anchor;
  const committed = planMutation(graph, 'c', { type: 'moveBlock', id: 'n', parentId: 'd', point: { x: 500, y: 0 } }, 'user', new Set(['other'])).state;
  assert.deepEqual(block(committed, 'other').anchor, before);
  assert.deepEqual(coordinates(committed), coordinates(graph));
});

const overlappedDrop = () => planMutation(growingFixture(), 'c',
  { type: 'moveBlock', id: 'n', parentId: 'd', point: { x: 500, y: 0 } }, 'user', new Set(['other'])).state;

test('a drag-created fixed overlap survives serialization and subsequent ordinary writes', () => {
  const committed = overlappedDrop(), before = coordinates(committed);
  assert.ok(committed.canvases[0].placements.d.overlapAllowances?.some(row => row.otherId === 'other'));
  assert.equal(committed.canvases[0].placements.d.source, 'auto');
  validateRegionLayout(committed);
  const restored = normalizedGraph(JSON.parse(JSON.stringify(committed)));
  assert.deepEqual(coordinates(restored), before);
  const written = planMutation(restored, 'c', { type: 'createEdge', input: { sourceNodeId: 'n', targetNodeId: 'other' } }, 'user').state;
  assert.deepEqual(coordinates(written), before);
  validateRegionLayout(written);
});

test('an overlap allowance does not grant a third automatic object permission to intersect either member', () => {
  const before = overlappedDrop(), changed = structuredClone(before);
  changed.nodes.extra = { nodeId: 'extra', name: 'third', content: '' };
  changed.canvases[0].childIds.push('extra'); changed.canvases[0].placements.extra = { x: 400, y: 0, source: 'auto' };
  assert.throws(() => validateRegionLayout(changed), /区域重叠/);
  const arranged = normalizeRegionLayout(changed, before);
  assert.equal(intersects(block(arranged, 'extra').rect, block(arranged, 'd').rect), false);
  assert.equal(intersects(block(arranged, 'extra').rect, block(arranged, 'other').rect), false);
  validateRegionLayout(arranged);
});

test('changing either footprint invalidates and removes its pair-specific overlap exception', () => {
  const before = overlappedDrop(), resized = structuredClone(before);
  resized.nodes.other.content = 'larger card '.repeat(200);
  assert.throws(() => validateRegionLayout(resized), /区域重叠/);
  const arranged = normalizeRegionLayout(resized, before);
  assert.equal(arranged.canvases[0].placements.d.overlapAllowances, undefined);
  assert.equal(intersects(block(arranged, 'd').rect, block(arranged, 'other').rect), false);
  const moved = structuredClone(before); moved.canvases[0].placements.d.y = 1000;
  const cleared = normalizedGraph(moved, before);
  assert.equal(cleared.canvases[0].placements.d.overlapAllowances, undefined);
  const returned = structuredClone(cleared); returned.canvases[0].placements.d.y = 0;
  assert.throws(() => validateRegionLayout(returned), /区域重叠/, 'returning to old coordinates cannot resurrect the exception');
});

test('consecutive explicit child drags renew an existing fixed-overlap pair to its new size', () => {
  const first = overlappedDrop();
  const second = planMutation(first, 'c', { type: 'moveBlock', id: 'n', parentId: 'd', point: { x: 600, y: 0 } }, 'user', new Set(['other'])).state;
  assert.deepEqual(coordinates(second), coordinates(first));
  const allowance = second.canvases[0].placements.d.overlapAllowances?.find(row => row.otherId === 'other');
  assert.ok(allowance);
  assert.ok(allowance.self.width > first.canvases[0].placements.d.overlapAllowances![0].self.width);
  validateRegionLayout(second);
  const restored = normalizedGraph(JSON.parse(JSON.stringify(second)));
  assert.deepEqual(coordinates(restored), coordinates(second));
  const written = planMutation(restored, 'c', { type: 'createEdge', input: { sourceNodeId: 'n', targetNodeId: 'other' } }, 'user').state;
  assert.deepEqual(coordinates(written), coordinates(second));
});

test('moving both overlapping objects to another parent does not transfer the old allowance', () => {
  const before = overlappedDrop(), moved = structuredClone(before);
  moved.canvases[0].directories.folder = { name: 'new parent', childIds: ['d', 'other'] };
  moved.canvases[0].childIds = ['folder']; moved.canvases[0].placements.folder = { x: 0, y: 0, source: 'auto' };
  assert.throws(() => validateRegionLayout(moved), /区域重叠/);
  const arranged = normalizedGraph(moved, before);
  assert.equal(arranged.canvases[0].placements.d.overlapAllowances, undefined);
  assert.equal(intersects(block(arranged, 'd').rect, block(arranged, 'other').rect), false);
  validateRegionLayout(arranged);
});
