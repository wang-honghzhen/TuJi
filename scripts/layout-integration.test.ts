import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repository } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { changedPlacementRefs } from '../src/ai/server/graphLayoutDependencies';
import { buildRenderModel } from '../src/v3/layout';
import { normalizeRegionLayout } from '../src/v3/regionLayout';
import type { GraphState } from '../src/v3/types';

test('view-only moves and removed display offsets participate in concurrency protection', () => {
  assert.deepEqual(changedPlacementRefs([{ collection: 'canvases', id: 'c',
    before: { placements: { a: { x: 0, y: 0 } }, presentationPlacements: { a: { x: 400, y: 0 }, b: { x: 700, y: 0 } } },
    after: { placements: { a: { x: 0, y: 0 } }, presentationPlacements: { b: { x: 800, y: 0 } } },
  }]).sort(), ['a', 'b']);
});

test('expansion avoidance is committed and undone atomically through the application runtime', async () => {
  const repo = new Repository(':memory:');
  const runtime = new Runtime(repo, async () => { throw new Error('This test must never contact an AI provider'); });
  try {
    const graph: GraphState = normalizeRegionLayout({ layoutVersion: 3, nodes: {
      n: { nodeId: 'n', name: 'inside', content: '' }, b: { nodeId: 'b', name: 'fixed neighbour', content: '' },
    }, documents: { d: { documentId: 'd', kind: 'document', name: 'expand me', childNodeIds: ['n'], childDocumentIds: [],
      placements: { n: { x: 500, y: 0, source: 'auto' } }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3.0' } } }, edges: [],
    canvases: [{ canvasId: 'c', canvasName: 'test', updatedAt: '', childIds: ['d', 'b'], directories: {}, collapsed: { d: true },
      placements: { d: { x: 0, y: 0, source: 'manual' }, b: { x: 310, y: 0, source: 'manual' } } }] });
    repo.transaction(state => { state.graph = graph; });
    const before = structuredClone(repo.state.graph!);
    const request = { canvasId: 'c', operationId: 'expand-test', command: { type: 'toggleCollapse', id: 'd' } };
    const result = await runtime.mutateGraph(request);
    assert.ok(result.changeSetId, 'position changes must provide the existing layout undo control');
    const after = repo.state.graph!, model = buildRenderModel(after, after.canvases[0], { zoom: 1, deferRouting: true });
    const d = model.blocks.find(block => block.id === 'd')!.rect, b = model.blocks.find(block => block.id === 'b')!.rect;
    assert.ok(d.x + d.width <= b.x || b.x + b.width <= d.x || d.y + d.height <= b.y || b.y + b.height <= d.y);
    assert.deepEqual(after.documents, before.documents, 'view expansion must not rewrite shared content positions');
    assert.equal((await runtime.mutateGraph(request)).changeSetId, result.changeSetId, 'retried requests retain undo receipt');
    runtime.undo(result.changeSetId!);
    assert.deepEqual(repo.state.graph!.canvases[0].collapsed, before.canvases[0].collapsed);
    assert.deepEqual(repo.state.graph!.canvases[0].placements, before.canvases[0].placements);
    assert.deepEqual(repo.state.graph!.canvases[0].presentationPlacements, before.canvases[0].presentationPlacements);
  } finally { await runtime.dispose(); repo.close(); }
});
