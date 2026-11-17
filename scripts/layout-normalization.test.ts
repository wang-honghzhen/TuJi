import assert from 'node:assert/strict';
import { getNaturalGeometry, normalizeRegionLayout, previewBlockMove, validateRegionLayout } from '../src/v3/regionLayout';
import { nodeGeometry } from '../src/v3/nodeGeometry';
import { intersects } from '../src/v3/rectangleIndex';
import type { GraphState, Placement } from '../src/v3/types';

const manual = (x: number, y: number): Placement => ({ x, y, source: 'manual', manualAnchor: { x, y }, lastManualAt: 1 });
function fixture(): GraphState {
  return { layoutVersion: 3, nodes: {
    a: { nodeId: 'a', name: 'a', content: '' }, b: { nodeId: 'b', name: 'b', content: '' },
  }, documents: {}, edges: [], canvases: [{ canvasId: 'c', canvasName: '', updatedAt: '', childIds: ['a', 'b'],
    directories: {}, collapsed: {}, placements: { a: manual(0, 0), b: { x: 230, y: 0, source: 'auto' } } }] };
}
function documentFixture(): GraphState {
  const graph = fixture();
  graph.documents.d = { documentId: 'd', name: 'd', kind: 'document', childNodeIds: ['a'], childDocumentIds: [],
    placements: { a: { x: 0, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '' } };
  graph.canvases[0].childIds = ['d', 'b'];
  graph.canvases[0].placements = { d: manual(0, 0), b: { x: 310, y: 0, source: 'auto' } };
  return graph;
}

// Text growth preserves the author's anchor and moves automatic neighbours.
{
  const before = fixture(), changed = structuredClone(before);
  changed.nodes.a.content = '正文'.repeat(500);
  const result = normalizeRegionLayout(changed, before), placements = result.canvases[0].placements;
  assert.deepEqual(placements.a, before.canvases[0].placements.a);
  assert.equal(intersects({ ...nodeGeometry(result.nodes.a), ...placements.a }, { ...nodeGeometry(result.nodes.b), ...placements.b }), false);
  assert.deepEqual(normalizeRegionLayout(result, result).canvases[0].placements, placements);
  validateRegionLayout(result);
}

// Internal rearrangement grows a fixed document in every canvas where it appears.
{
  const before = documentFixture();
  before.nodes.b2 = { nodeId: 'b2', name: 'b2', content: '' };
  before.canvases.push({ ...structuredClone(before.canvases[0]), canvasId: 'c2', childIds: ['d', 'b2'],
    placements: { d: manual(100, 200), b2: { x: 410, y: 200, source: 'auto' } } });
  const changed = structuredClone(before); changed.documents.d.placements.a.x = 600;
  const result = normalizeRegionLayout(changed, before), size = getNaturalGeometry(result).document('d');
  for (let i = 0; i < 2; i++) {
    const placements = result.canvases[i].placements, sibling = i ? 'b2' : 'b';
    assert.deepEqual(placements.d, before.canvases[i].placements.d);
    assert.equal(intersects({ ...size, ...placements.d }, { ...nodeGeometry(result.nodes[sibling]), ...placements[sibling] }), false);
  }
  validateRegionLayout(result);
}

// Canvas directories obey the same rule as shared documents.
{
  const before = fixture();
  before.canvases[0].childIds = ['d', 'b'];
  before.canvases[0].directories.d = { name: 'directory', childIds: ['a'] };
  before.canvases[0].placements = { a: { x: 0, y: 0, source: 'auto' }, d: manual(0, 0), b: { x: 310, y: 0, source: 'auto' } };
  const changed = structuredClone(before); changed.canvases[0].placements.a.x = 600;
  const result = normalizeRegionLayout(changed, before), canvas = result.canvases[0];
  assert.deepEqual(canvas.placements.d, before.canvases[0].placements.d);
  assert.equal(intersects({ ...getNaturalGeometry(result).directory(canvas, 'd'), ...canvas.placements.d },
    { ...nodeGeometry(result.nodes.b), ...canvas.placements.b }), false);
}

// Explicit manual overlap remains intentional, including growth of two fixed cards.
{
  const before = fixture(); before.canvases[0].placements.b = manual(230, 0);
  const changed = structuredClone(before); changed.nodes.a.content = 'A'.repeat(1000);
  const result = normalizeRegionLayout(changed, before);
  assert.deepEqual(result.canvases[0].placements, before.canvases[0].placements);
  validateRegionLayout(result);
}

// Direct drags follow the pointer without evicting a stable automatic sibling.
{
  const before = fixture();
  const result = previewBlockMove(before, 'c', 'a', 'c', { x: 230, y: 0 });
  assert.deepEqual(result.canvases[0].placements.b, before.canvases[0].placements.b);
  assert.equal(result.canvases[0].placements.a.x, 230);
}

// The same applies when a drag inside a container expands its footprint.
{
  const before = documentFixture();
  const result = previewBlockMove(before, 'c', 'a', 'd', { x: 600, y: 0 });
  assert.deepEqual(result.canvases[0].placements, before.canvases[0].placements);
  assert.equal(result.documents.d.placements.a.x, 600);
}

console.log('Layout normalization: six scenarios passed (manual growth, shared document, directory, fixed overlap, direct drag, nested drag).');
