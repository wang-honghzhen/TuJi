import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repository } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { planRelationshipLayout } from '../src/ai/server/layoutService';
import { layoutRelationships } from '../src/v3/relationshipLayout';
import { normalizeRegionLayout } from '../src/v3/regionLayout';
import { makeBoundaryFixtures } from './boundary-layout-fixtures.mjs';
import type { GraphState } from '../src/v3/types';

const fixture = (): GraphState => ({ layoutVersion: 3, documents: {},
  nodes: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { nodeId: id, name: id, content: '' }])),
  edges: [{ edgeId: 'ab', sourceNodeId: 'a', targetNodeId: 'b', directed: true, edgeContent: '' }],
  canvases: [{ canvasId: 'view', canvasName: 'view', childIds: ['a', 'b', 'c'], directories: {}, collapsed: {}, updatedAt: '',
    placements: { a: { x: 0, y: 0, source: 'auto' }, b: { x: 900, y: 0, source: 'auto' }, c: { x: 0, y: 600, source: 'auto' } } }],
});
function refinement(state: GraphState) {
  return { state: { ...state, canvases: state.canvases.map(canvas => ({ ...canvas,
    presentationPlacements: { b: { x: 700, y: 200, baseX: 900, baseY: 0, parentId: 'view' } },
  })) }, stats: { regions: 1, candidates: 1, moved: 1, elapsedMs: 1, exhausted: false } };
}
const drop = (x = 300) => ({ canvasId: 'view', operationId: `drop-${x}`, command: { type: 'moveBlock', id: 'a', parentId: 'view', point: { x, y: 200 } } });
function setup(planner: typeof planRelationshipLayout, graph = fixture()) {
  const repo = new Repository(':memory:');
  const runtime = new Runtime(repo, async () => { throw Error('No provider calls allowed'); }, undefined, planner);
  repo.transaction(state => { state.graph = graph; });
  return { repo, runtime, close: async () => { await runtime.dispose(); repo.close(); } };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('drop and local refinement commit once, preserve the drop anchor, and undo together', async () => {
  const env = setup(async (state, options) => {
    assert.equal(options.viewOnly, true);
    assert.deepEqual(options.changedObjectIds, ['a']);
    assert.ok(options.protectedIds?.includes('a'));
    return refinement(state);
  });
  try {
    const original = structuredClone(env.repo.state.graph!);
    const result = await env.runtime.mutateGraph(drop());
    const canvas = env.repo.state.graph!.canvases[0];
    assert.deepEqual(canvas.placements.a.manualAnchor, { x: 300, y: 200 });
    assert.deepEqual(canvas.placements.b, original.canvases[0].placements.b);
    assert.deepEqual(canvas.placements.c, original.canvases[0].placements.c);
    assert.equal(canvas.presentationPlacements?.b.x, 700);
    assert.ok(result.changeSetId);
    assert.equal((await env.runtime.mutateGraph(drop())).changeSetId, result.changeSetId);
    env.runtime.undo(result.changeSetId as string);
    assert.deepEqual(env.repo.state.graph!.canvases[0].placements, original.canvases[0].placements);
    assert.equal(env.repo.state.graph!.canvases[0].presentationPlacements, undefined);
  } finally { await env.close(); }
});

test('optional layout failure still saves the user drop', async () => {
  const env = setup(async () => { throw Error('Simulated worker timeout'); });
  try {
    const result = await env.runtime.mutateGraph(drop());
    assert.equal(result.ok, true);
    assert.equal(env.repo.state.graph!.canvases[0].placements.a.x, 300);
    assert.equal(env.repo.state.graph!.canvases[0].presentationPlacements, undefined);
  } finally { await env.close(); }
});

test('the packaged worker improves the connected automatic neighbour after a real drop', async () => {
  const env = setup(planRelationshipLayout);
  try {
    const before = structuredClone(env.repo.state.graph!);
    await env.runtime.mutateGraph(drop());
    const canvas = env.repo.state.graph!.canvases[0];
    assert.deepEqual(canvas.placements.a.manualAnchor, { x: 300, y: 200 });
    assert.ok(canvas.presentationPlacements?.b, 'related automatic neighbour should receive a visible improvement');
    assert.deepEqual(canvas.placements.b, before.canvases[0].placements.b, 'automatic follow-up is view local');
    assert.deepEqual(canvas.placements.c, before.canvases[0].placements.c);
    assert.equal(canvas.presentationPlacements?.c, undefined);
  } finally { await env.close(); }
});

test('the packaged worker retains real nested endpoints and matches in-process view refinement', async () => {
  const sample = makeBoundaryFixtures().find((item: { id: string }) => item.id === 'top-bottom')!;
  const graph = normalizeRegionLayout(sample.state as GraphState);
  const options = { canvasId: graph.canvases[0].canvasId, mode: 'auto' as const, viewOnly: true,
    changedObjectIds: ['A'], protectedIds: ['A'], solveTime: 1 };
  const local = layoutRelationships(graph, options), worker = await planRelationshipLayout(graph, options);
  assert.deepEqual(worker.state, local.state);
  assert.ok(worker.state.canvases[0].presentationPlacements?.N);
  assert.deepEqual(worker.state.documents, graph.documents);
  assert.deepEqual(worker.state.canvases[0].placements, graph.canvases[0].placements);
});

test('editing begins during refinement: keep the drop and discard the neighbour movement', async () => {
  const started = signal(), resume = signal();
  const env = setup(async state => { started.resolve(); await resume.promise; return refinement(state); });
  try {
    const pending = env.runtime.mutateGraph(drop()); await started.promise;
    env.runtime.editing('b', 'name', true);
    resume.resolve(); await pending;
    assert.equal(env.repo.state.graph!.canvases[0].placements.a.x, 300);
    assert.equal(env.repo.state.graph!.canvases[0].presentationPlacements, undefined);
  } finally { resume.resolve(); await env.close(); }
});

test('unrelated concurrent text change survives a fresh reapplication of the user drop', async () => {
  const started = signal(), resume = signal();
  const env = setup(async state => { started.resolve(); await resume.promise; return refinement(state); });
  try {
    const pending = env.runtime.mutateGraph(drop()); await started.promise;
    await env.runtime.mutateGraph({ canvasId: 'view', command: { type: 'updateNodeText', id: 'c', field: 'content', value: 'new text' } });
    resume.resolve(); await pending;
    assert.equal(env.repo.state.graph!.nodes.c.content, 'new text');
    assert.equal(env.repo.state.graph!.canvases[0].placements.a.x, 300);
    assert.equal(env.repo.state.graph!.canvases[0].presentationPlacements, undefined);
  } finally { resume.resolve(); await env.close(); }
});

test('a newer drop on the same object wins over an older pending refinement', async () => {
  const started = signal(), resume = signal(); let calls = 0;
  const env = setup(async state => {
    if (++calls > 1) throw Error('Skip second refinement');
    started.resolve(); await resume.promise; return refinement(state);
  });
  try {
    const pending = env.runtime.mutateGraph(drop()); await started.promise;
    await env.runtime.mutateGraph(drop(500));
    resume.resolve(); await assert.rejects(pending, /位置已变化/);
    assert.equal(env.repo.state.graph!.canvases[0].placements.a.x, 500);
  } finally { resume.resolve(); await env.close(); }
});

test('the newer drop still wins when the older layout worker finishes first', async () => {
  const started = [signal(), signal()], resume = [signal(), signal()]; let calls = 0;
  const env = setup(async state => {
    const index = calls++; started[index].resolve(); await resume[index].promise; return refinement(state);
  });
  try {
    const older = env.runtime.mutateGraph(drop()); await started[0].promise;
    const newer = env.runtime.mutateGraph(drop(500)); await started[1].promise;
    resume[0].resolve(); await assert.rejects(older, /后一次拖动/);
    resume[1].resolve(); await newer;
    assert.equal(env.repo.state.graph!.canvases[0].placements.a.x, 500);
  } finally { resume.forEach(item => item.resolve()); await env.close(); }
});

test('concurrent retries of the same drop share one committed receipt', async () => {
  const started = [signal(), signal()], resume = [signal(), signal()]; let calls = 0;
  const env = setup(async state => {
    const index = calls++; started[index].resolve(); await resume[index].promise; return refinement(state);
  });
  try {
    const first = env.runtime.mutateGraph(drop()); await started[0].promise;
    const second = env.runtime.mutateGraph(drop()); await started[1].promise;
    resume[0].resolve(); const committed = await first;
    resume[1].resolve(); const repeated = await second;
    assert.equal(repeated.changeSetId, committed.changeSetId);
    assert.equal(env.repo.state.changes.filter(change => change.operationId === 'drop-300').length, 1);
  } finally { resume.forEach(item => item.resolve()); await env.close(); }
});

function nestedFixture(): GraphState {
  const graph = fixture();
  graph.documents.d = { documentId: 'd', kind: 'document', name: 'container', childNodeIds: ['a'], childDocumentIds: [],
    placements: { a: { x: 0, y: 0, source: 'auto' } }, rev: 1,
    metadata: { createdAt: '', updatedAt: '', version: '3.0' } };
  graph.canvases[0].childIds = ['d', 'b', 'c'];
  graph.canvases[0].placements = { d: { x: 0, y: 0, source: 'auto' }, b: { x: 310, y: 0, source: 'auto' }, c: { x: 0, y: 600, source: 'auto' } };
  return graph;
}
const nestedDrop = () => ({ canvasId: 'view', command: { type: 'moveBlock', id: 'a', parentId: 'd', point: { x: 500, y: 0 } } });

test('an older expansion cannot reappear after a newer expansion and collapse round trip', async () => {
  const started = signal(), resume = signal(); let calls = 0;
  const graph = nestedFixture(); graph.canvases[0].collapsed.d = true;
  const env = setup(async state => {
    if (++calls > 1) throw Error('Skip optional layout');
    started.resolve(); await resume.promise; return refinement(state);
  }, graph);
  try {
    const toggle = { canvasId: 'view', command: { type: 'toggleCollapse', id: 'd' } };
    const older = env.runtime.mutateGraph(toggle); await started.promise;
    await env.runtime.mutateGraph(toggle);
    await env.runtime.mutateGraph(toggle);
    resume.resolve(); await assert.rejects(older, /后一次操作/);
    assert.equal(env.repo.state.graph!.canvases[0].collapsed.d, true);
  } finally { resume.resolve(); await env.close(); }
});

test('a child drop cannot move its ancestor or an actively edited neighbouring object', async () => {
  const env = setup(async () => { throw Error('Skip optional refinement'); }, nestedFixture());
  try {
    env.runtime.editing('b', 'name', true);
    await env.runtime.mutateGraph(nestedDrop());
    const graph = env.repo.state.graph!;
    assert.equal(graph.documents.d.placements.a.x, 500);
    assert.equal(graph.canvases[0].placements.d.x, 0);
    assert.equal(graph.canvases[0].placements.b.x, 310);
  } finally { await env.close(); }
});

test('editing that starts during a child drop also protects against primary container-growth displacement', async () => {
  const started = signal(), resume = signal();
  const env = setup(async state => {
    started.resolve(); await resume.promise;
    return { state, stats: { regions: 0, candidates: 0, moved: 0, elapsedMs: 0, exhausted: false } };
  }, nestedFixture());
  try {
    const pending = env.runtime.mutateGraph(nestedDrop()); await started.promise;
    env.runtime.editing('b', 'name', true);
    resume.resolve(); await pending;
    const graph = env.repo.state.graph!;
    assert.equal(graph.documents.d.placements.a.x, 500);
    assert.equal(graph.canvases[0].placements.d.x, 0);
    assert.equal(graph.canvases[0].placements.b.x, 310);
  } finally { resume.resolve(); await env.close(); }
});

test('an organize preview cannot move a container after editing starts inside it', async () => {
  const env = setup(async state => ({ state: { ...state, canvases: state.canvases.map(canvas => ({ ...canvas,
    placements: { ...canvas.placements, d: { ...canvas.placements.d, x: -400 } },
  })) }, stats: { regions: 1, candidates: 1, moved: 1, elapsedMs: 1, exhausted: false } }), nestedFixture());
  try {
    const preview = await env.runtime.previewLayout('view', 'view');
    env.runtime.editing('a', 'name', true);
    assert.throws(() => env.runtime.applyLayout(preview.proposalId, 'apply-preview'), /正在编辑或拖动/);
    assert.equal(env.repo.state.graph!.canvases[0].placements.d.x, 0);
  } finally { await env.close(); }
});
