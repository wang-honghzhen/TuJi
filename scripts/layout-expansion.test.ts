import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planMutation, graphDiff, applyPatches, semanticHashes, compactCanvasPresentation, normalizedGraph } from '../src/ai/server/graph';
import { buildRenderModel } from '../src/v3/layout';
import { previewBlockMove } from '../src/v3/regionLayout';
import { intersects } from '../src/v3/rectangleIndex';
import { presentationPlacement } from '../src/v3/presentationLayout';
import type { GraphState, Placement } from '../src/v3/types';

const manual = (x: number, y: number): Placement => ({ x, y, source: 'manual', manualAnchor: { x, y } });
function fixture(): GraphState {
  return { layoutVersion: 3, nodes: { n: { nodeId: 'n', name: 'inside', content: '' }, b: { nodeId: 'b', name: 'neighbour', content: '' } },
    documents: { d: { documentId: 'd', kind: 'document', name: 'region', childNodeIds: ['n'], childDocumentIds: [],
      placements: { n: { x: 500, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } } },
    edges: [], canvases: [{ canvasId: 'c', canvasName: 'test', updatedAt: '', childIds: ['d', 'b'], directories: {}, collapsed: { d: true },
      placements: { d: manual(0, 0), b: manual(310, 0) } }] };
}
const model = (graph: GraphState, canvasId = 'c') => buildRenderModel(graph, graph.canvases.find(c => c.canvasId === canvasId)!, { zoom: 1, skipEdges: true });
const rect = (graph: GraphState, id: string, canvasId = 'c') => model(graph, canvasId).blocks.find(block => block.id === id)!.rect;
const toggle = (graph: GraphState, id = 'd') => planMutation(graph, 'c', { type: 'toggleCollapse', id }, 'user').state;

test('expand avoids a manual neighbour while preserving canonical placements and undo', () => {
  const before = fixture(); assert.equal(intersects(rect(before, 'd'), rect(before, 'b')), false);
  const after = toggle(before);
  assert.equal(intersects(rect(after, 'd'), rect(after, 'b')), false);
  assert.deepEqual(rect(after, 'b'), rect(before, 'b'));
  assert.deepEqual(after.documents, before.documents);
  assert.deepEqual(after.canvases[0].placements, before.canvases[0].placements);
  const patch = graphDiff(before, after); assert.deepEqual(patch.map(p => p.collection), ['canvases']);
  const undone = applyPatches(after, patch, true);
  assert.deepEqual(undone.canvases, before.canvases);
  const hashes = semanticHashes(after), oldHashes = semanticHashes(before);
  assert.notEqual(hashes['canvases:c:view'], oldHashes['canvases:c:view']);
  assert.equal(hashes['canvases:c:structure'], oldHashes['canvases:c:structure']);
  assert.deepEqual(compactCanvasPresentation(after).canvases, after.canvases);
});

test('a manual opener stays anchored when only automatic neighbours need to yield', () => {
  const before = fixture(); before.canvases[0].placements.b = { x: 310, y: 0, source: 'auto' };
  const after = toggle(before);
  assert.equal(rect(after, 'd').x, 0); assert.equal(rect(after, 'd').y, 0);
  assert.equal(intersects(rect(after, 'd'), rect(after, 'b')), false);
});

test('primary expansion avoids an actively edited automatic neighbour without moving it', () => {
  const before = fixture(); before.canvases[0].placements.b = { x: 310, y: 0, source: 'auto' };
  const after = planMutation(before, 'c', { type: 'toggleCollapse', id: 'd' }, 'user', new Set(['b'])).state;
  assert.deepEqual(rect(after, 'b'), rect(before, 'b'));
  assert.equal(intersects(rect(after, 'd'), rect(after, 'b')), false);
});

test('already intentional folded overlap is preserved', () => {
  const before = fixture(); before.canvases[0].placements.b = manual(150, 0);
  assert.equal(intersects(rect(before, 'd'), rect(before, 'b')), true);
  const after = toggle(before);
  assert.equal(after.canvases[0].presentationPlacements, undefined);
  assert.deepEqual(after.canvases[0].placements, before.canvases[0].placements);
});

test('nested expansion adjusts only the current canvas and contains all visible children', () => {
  const before = fixture();
  before.documents.p = { documentId: 'p', kind: 'document', name: 'shared', childNodeIds: ['b'], childDocumentIds: ['d'],
    placements: { d: manual(0, 0), b: manual(310, 0) }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } };
  before.documents.d.kind = 'subgraph';
  before.canvases[0].childIds = ['p']; before.canvases[0].placements = { p: manual(0, 0) };
  before.canvases.push({ ...structuredClone(before.canvases[0]), canvasId: 'other' });
  const beforeOther = model(before, 'other');
  const after = toggle(before);
  assert.equal(intersects(rect(after, 'd'), rect(after, 'b')), false);
  assert.deepEqual(after.documents, before.documents);
  assert.deepEqual(after.canvases[1], before.canvases[1]);
  assert.deepEqual(model(after, 'other'), beforeOther);
  const parent = rect(after, 'p'), child = rect(after, 'd');
  assert.ok(parent.x <= child.x && parent.y <= child.y && parent.x + parent.width >= child.x + child.width && parent.y + parent.height >= child.y + child.height);
});

test('fold and reopen are stable, while a subsequent drag replaces the view adjustment', () => {
  const before = fixture(), expanded = toggle(before), closed = toggle(expanded), reopened = toggle(closed);
  assert.deepEqual(reopened.canvases[0].presentationPlacements, expanded.canvases[0].presentationPlacements);
  const moved = previewBlockMove(expanded, 'c', 'd', 'c', { x: 0, y: 0 });
  assert.equal(moved.canvases[0].presentationPlacements?.d, undefined);
  assert.equal(rect(moved, 'd').x, 0); assert.equal(rect(moved, 'd').y, 0);
});

test('dragging from a displayed offset starts at its visible position without a jump', () => {
  const expanded = toggle(fixture()), canvas = expanded.canvases[0];
  const start = presentationPlacement(canvas, 'd', 'c', canvas.placements.d);
  const before = rect(expanded, 'd');
  const preview = previewBlockMove(expanded, 'c', 'd', 'c', { x: start.x + 20, y: start.y + 10 });
  assert.equal(rect(preview, 'd').x, before.x + 20);
  assert.equal(rect(preview, 'd').y, before.y + 10);
  const committed = planMutation(expanded, 'c', { type: 'moveBlock', id: 'd', parentId: 'c', point: { x: start.x + 20, y: start.y + 10 } }, 'user').state;
  assert.equal(rect(committed, 'd').x, before.x + 20);
  assert.equal(rect(committed, 'd').y, before.y + 10);
});

test('canonical position changes invalidate old view adjustments', () => {
  const expanded = toggle(fixture()), moved = structuredClone(expanded);
  moved.canvases[0].placements.d.x = 1500;
  assert.equal(rect(moved, 'd').x, 1500);
  const committed = normalizedGraph(moved, expanded);
  committed.canvases[0].placements.d.x = 0;
  assert.equal(committed.canvases[0].presentationPlacements?.d, undefined);
  assert.equal(rect(committed, 'd').y, 0);
});

test('reparenting then returning does not revive an old adjustment', () => {
  const expanded = toggle(fixture()), moved = structuredClone(expanded);
  moved.canvases[0].directories.folder = { name: 'folder', childIds: ['d'] };
  moved.canvases[0].childIds = ['folder', 'b'];
  moved.canvases[0].placements.folder = manual(2000, 0);
  const committed = normalizedGraph(moved, expanded);
  assert.equal(committed.canvases[0].presentationPlacements?.d, undefined);
  committed.canvases[0].childIds = ['d', 'b'];
  delete committed.canvases[0].directories.folder; delete committed.canvases[0].placements.folder;
  assert.equal(rect(committed, 'd').y, 0);
});

test('nested frame growth also avoids previously disjoint outer neighbours', () => {
  const before = fixture();
  before.documents.p = { documentId: 'p', kind: 'document', name: 'parent', childNodeIds: ['b'], childDocumentIds: ['d'],
    placements: { d: manual(0, 0), b: manual(310, 0) }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } };
  before.documents.d.kind = 'subgraph'; before.nodes.z = { nodeId: 'z', name: 'outer neighbour', content: '' };
  before.canvases[0].childIds = ['p', 'z']; before.canvases[0].placements = { p: manual(0, 0), z: manual(0, 310) };
  assert.equal(intersects(rect(before, 'p'), rect(before, 'z')), false);
  const after = toggle(before);
  assert.equal(intersects(rect(after, 'p'), rect(after, 'z')), false);
  assert.equal(intersects(rect(after, 'd'), rect(after, 'b')), false);
  assert.deepEqual(rect(after, 'z'), rect(before, 'z'));
});
