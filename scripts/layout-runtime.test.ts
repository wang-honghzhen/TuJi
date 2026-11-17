import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationLayoutIds } from '../src/ai/server/generationLayout';
import { planRelationshipLayout } from '../src/ai/server/layoutService';
import { layoutRelationships } from '../src/v3/relationshipLayout';
import { nodeGeometry } from '../src/v3/nodeGeometry';
import { normalizeRegionLayout } from '../src/v3/regionLayout';
import type { GraphState } from '../src/v3/types';
import type { ChangeSet, GraphPatch } from '../src/ai/domain';

function fixture(): GraphState {
  const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
  return normalizeRegionLayout({ layoutVersion: 3, documents: {},
    nodes: Object.fromEntries(ids.map(id => [id, { nodeId: id, name: `${id} 较长的节点标题用于检查后台和画布的尺寸一致性`, content: '多行正文\n第二行内容\n第三行内容\n第四行内容' }])),
    canvases: [{ canvasId: 'c', canvasName: 'test', updatedAt: '', childIds: ids, directories: {}, collapsed: {},
      placements: Object.fromEntries(ids.map((id, i) => [id, { x: (i % 3) * 430, y: Math.floor(i / 3) * 270, source: 'auto' as const }])) }],
    edges: ids.slice(1).map((id, i) => ({ edgeId: `e${i}`, sourceNodeId: ids[i], targetNodeId: id, directed: true, edgeContent: '' })),
  });
}
const receipt = (taskId: string, patches: GraphPatch[], status: ChangeSet['status'] = 'committed') => ({ taskId, patches, status } as ChangeSet);

test('generation mobility spans committed calls and excludes other tasks, reverted creations, removed objects and user anchors', () => {
  const graph = fixture(), canvas = graph.canvases[0];
  canvas.placements.n1.source = 'manual';
  canvas.placements.n2.manualAnchor = { x: 0, y: 0 };
  canvas.directories.d = { name: 'new directory', childIds: [] };
  const node = (id: string): GraphPatch => ({ collection: 'nodes', id, before: null, after: {} });
  const changes = [receipt('task', ['n0', 'n1', 'n2', 'removed'].map(node)),
    receipt('other', [node('n3')]), receipt('task', [node('n4')], 'reverted'),
    receipt('task', [node('n5')], 'proposed'), receipt('task', [{ collection: 'canvases', id: 'c', before: { directories: {} }, after: canvas }])];
  const members = new Set([...Object.keys(graph.nodes), 'd']);
  graph.canvases.push({ ...canvas, canvasId: 'other-canvas', placements: { n0: { x: 999, y: 999, source: 'manual' } } });
  assert.deepEqual(generationLayoutIds(graph, 'c', members, 'task', changes, ['n6']), ['d', 'n0', 'n6']);
  assert.deepEqual(generationLayoutIds(graph, 'c', members, 'next-task', changes, []), []);
});

test('packaged worker agrees with in-process layout for full-sized text cards', async () => {
  const graph = fixture();
  const old = graph.canvases[0].placements.n3;
  graph.canvases[0].presentationPlacements = { n3: { x: 1800, y: 1800, parentId: 'c', baseX: old.x, baseY: old.y } };
  const options = { canvasId: 'c', mode: 'auto' as const, insertedIds: Object.keys(graph.nodes),
    movableIds: Object.keys(graph.nodes), changedEdgeIds: graph.edges.map(e => e.edgeId), budgetMs: 2000, solveTime: 1000 };
  const direct = layoutRelationships(graph, options);
  const remote = await planRelationshipLayout(graph, options);
  assert.deepEqual(remote.state.canvases[0].placements, direct.state.canvases[0].placements);
  assert.notDeepEqual(direct.state.canvases[0].presentationPlacements, graph.canvases[0].presentationPlacements,
    'fixture exercises removal of an expansion adjustment after its canonical anchor moves');
  assert.deepEqual(remote.state.canvases[0].presentationPlacements, direct.state.canvases[0].presentationPlacements,
    'worker must return presentation updates as well as canonical coordinates');
  const ids = Object.keys(graph.nodes), positions = remote.state.canvases[0].placements;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = { ...nodeGeometry(graph.nodes[ids[i]]), ...positions[ids[i]] };
    const b = { ...nodeGeometry(graph.nodes[ids[j]]), ...positions[ids[j]] };
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `actual cards overlap: ${ids[i]}, ${ids[j]}`);
  }
});
