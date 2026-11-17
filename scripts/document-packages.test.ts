import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exportDocumentPackage, importDocumentPackage } from '../src/ai/server/documentPackages';
import { Application } from '../src/ai/server/application';
import { Repository } from '../src/ai/server/repository';
import { graphIdentities } from '../src/v3/ids';
import type { GraphState, GraphRecord, Placement } from '../src/v3/types';

const position = (x = 0, y = 0): Placement => ({ x, y, source: 'manual', manualAnchor: { x, y }, lastManualAt: 100 });
const doc = (id: string, children: string[] = [], nodes: string[] = [], kind: GraphRecord['kind'] = 'document'): GraphRecord => ({
  documentId: id, kind, mode: 'explore', name: '名称 ' + id, childNodeIds: nodes, childDocumentIds: children,
  placements: Object.fromEntries([...children, ...nodes].map((id, i) => [id, position(i * 500, 30)])), rev: 2,
  metadata: { createdAt: '2026-11-17', updatedAt: '2026-11-17', version: '3.0', description: '描述' },
});
function fixture(): GraphState {
  return { layoutVersion: 3, documents: { root: doc('root', ['sub'], ['a']), sub: doc('sub', ['nested'], [], 'subgraph'), nested: doc('nested', [], ['b']), outside: doc('outside', [], ['c']) },
    nodes: Object.fromEntries(['a', 'b', 'c'].map(nodeId => [nodeId, { nodeId, name: nodeId, content: '正文 ' + nodeId }])),
    edges: [
      { edgeId: 'inside', sourceNodeId: 'a', targetNodeId: 'b', directed: true, edgeContent: '内部关系', routeStyle: 'orthogonal' },
      { edgeId: 'directory', sourceNodeId: 'root', targetNodeId: 'nested', directed: false, edgeContent: '目录关系' },
      { edgeId: 'outsideEdge', sourceNodeId: 'b', targetNodeId: 'c', directed: true, edgeContent: '跨文件' },
      { edgeId: 'deleted', sourceNodeId: 'a', targetNodeId: 'b', directed: true, edgeContent: '', removed: true },
    ], canvases: [{ canvasId: 'canvas', canvasName: '画布', childIds: ['root', 'outside'], directories: {}, collapsed: {}, placements: { root: position(), outside: position(4000) }, updatedAt: '2026-11-17' }] };
}
test('exports exactly the requested nested subtree and both-endpoint internal edges', () => {
  const original = fixture(), before = structuredClone(original), bundle = exportDocumentPackage(original, 'root');
  assert.deepEqual(bundle.documents.map(d => [d.documentId, d.kind]), [['root', 'document'], ['sub', 'subgraph'], ['nested', 'document']]);
  assert.deepEqual(bundle.nodes.map(n => n.nodeId).sort(), ['a', 'b']);
  assert.deepEqual(bundle.edges.map(e => e.edgeId), ['inside', 'directory']);
  assert.equal('canvases' in bundle, false); assert.equal('graph' in bundle, false);
  assert.deepEqual(original, before);
  const child = exportDocumentPackage(original, 'nested');
  assert.deepEqual(child.documents.map(d => d.documentId), ['nested']);
  assert.deepEqual(child.edges, []);
  assert.throws(() => exportDocumentPackage(original, 'sub'), /图文档/);
});
test('incremental copies remap every identity and preserve nesting, mode, coordinates and originals', () => {
  const original = fixture(), before = structuredClone(original), bundle = exportDocumentPackage(original, 'root');
  const first = importDocumentPackage(original, JSON.parse(JSON.stringify(bundle))), second = importDocumentPackage(first.graph, bundle);
  const oldIds = new Set(graphIdentities(original));
  assert.ok(!oldIds.has(first.documentId)); assert.notEqual(first.documentId, second.documentId);
  const root = first.graph.documents[first.documentId], sub = first.graph.documents[root.childDocumentIds[0]], nested = first.graph.documents[sub.childDocumentIds[0]];
  assert.equal(root.kind, 'document'); assert.equal(sub.kind, 'subgraph'); assert.equal(nested.kind, 'document'); assert.equal(root.mode, 'explore');
  assert.equal(first.documentCount, 2);
  assert.deepEqual(root.placements[root.childNodeIds[0]], original.documents.root.placements.a);
  assert.equal(first.graph.nodes[root.childNodeIds[0]].content, '正文 a');
  assert.ok(first.graph.edges.some(e => e.sourceNodeId === root.childNodeIds[0] && e.targetNodeId === nested.childNodeIds[0] && e.routeStyle === 'orthogonal'));
  assert.equal(new Set(graphIdentities(second.graph)).size, graphIdentities(second.graph).length);
  assert.deepEqual(original, before); assert.deepEqual(first.graph.canvases, before.canvases);
  for (const id of Object.keys(before.documents)) assert.deepEqual(first.graph.documents[id], before.documents[id]);
  for (const id of Object.keys(before.nodes)) assert.deepEqual(first.graph.nodes[id], before.nodes[id]);
});
test('design member/subject references and generated edges remap internally and drop external references', () => {
  const source: GraphState = { layoutVersion: 3, canvases: [], documents: { design: { ...doc('design', [], ['proposal', 'group', 'flow']), mode: 'design' }, other: { ...doc('other', [], ['external']), mode: 'design' } },
    nodes: { proposal: { nodeId: 'proposal', name: '', content: '', design: { type: 'proposal' } }, external: { nodeId: 'external', name: '', content: '', design: { type: 'proposal' } },
      group: { nodeId: 'group', name: '', content: '', design: { type: 'combination', memberIds: ['proposal', 'external'], pros: '评价' } },
      flow: { nodeId: 'flow', name: '', content: '', design: { type: 'flow', subjectIds: ['group', 'external'] } } },
    edges: ['proposal', 'external'].map(id => ({ edgeId: 'member-' + id, sourceNodeId: 'group', targetNodeId: id, membershipFor: 'group', directed: true, edgeContent: '包含方案' })) };
  const bundle = exportDocumentPackage(source, 'design');
  assert.deepEqual(bundle.nodes.find(n => n.nodeId === 'group')?.design?.memberIds, ['proposal']);
  assert.deepEqual(bundle.nodes.find(n => n.nodeId === 'flow')?.design?.subjectIds, ['group']);
  assert.equal(bundle.edges.length, 1);
  const imported = importDocumentPackage(fixture(), bundle), root = imported.graph.documents[imported.documentId];
  const [proposal, group, flow] = root.childNodeIds;
  assert.equal(imported.mode, 'design'); assert.equal(root.mode, 'design');
  assert.deepEqual(imported.graph.nodes[group].design?.memberIds, [proposal]);
  assert.deepEqual(imported.graph.nodes[flow].design?.subjectIds, [group]);
  assert.ok(imported.graph.edges.some(e => e.membershipFor === group && e.sourceNodeId === group && e.targetNodeId === proposal));
});
test('layout overlap identities are remapped without changing geometry', () => {
  const original = fixture();
  original.documents.root.placements.a.overlapAllowances = [{ parentId: 'root', otherId: 'sub', self: { x: 10, y: 20, width: 180, height: 80 }, other: { x: 50, y: 80, width: 220, height: 110 } }];
  const result = importDocumentPackage(original, exportDocumentPackage(original, 'root')), root = result.graph.documents[result.documentId];
  const allowance = root.placements[root.childNodeIds[0]].overlapAllowances![0];
  assert.equal(allowance.parentId, result.documentId); assert.equal(allowance.otherId, root.childDocumentIds[0]);
  assert.deepEqual(allowance.self, original.documents.root.placements.a.overlapAllowances[0].self);
});
test('invalid file boundaries, old backups, cycles, duplicate IDs and coordinates are rejected atomically', () => {
  const original = fixture(), before = structuredClone(original), source = exportDocumentPackage(original, 'root');
  const variants: unknown[] = [{ format: 'qixue-graph-backup-v1', graph: original }, { ...source, version: 2 }, { ...source, sessions: [] }];
  let bad = structuredClone(source); bad.documents.push(doc('extra')); variants.push(bad);
  bad = structuredClone(source); bad.documents[0].childDocumentIds.push('root'); variants.push(bad);
  bad = structuredClone(source); bad.nodes.push(structuredClone(bad.nodes[0])); variants.push(bad);
  bad = structuredClone(source); bad.edges[0].targetNodeId = 'outside'; variants.push(bad);
  bad = structuredClone(source); bad.documents[0].placements.a.x = Number.NaN; variants.push(bad);
  bad = structuredClone(source); bad.documents[0].mode = 'design'; variants.push(bad);
  for (const value of variants) { assert.throws(() => importDocumentPackage(original, value)); assert.deepEqual(original, before); }
});
test('public document routes commit one independent import and reject retired whole-library actions', async () => {
  const cache = path.resolve('.cache/document-packages'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'application-')), repo = new Repository(path.join(directory, 'test.sqlite'));
  repo.transaction(state => { state.graph = fixture(); });
  const app = new Application(repo, { artifactDirectory: path.join(directory, 'artifacts') });
  try {
    await app.ready();
    const bundle = await app.dispatch('document.export', { documentId: 'root' });
    const revision = repo.state.graphRevision, sessions = structuredClone(repo.state.sessions), canvases = structuredClone(repo.state.graph!.canvases);
    const result = await app.dispatch('document.import', { package: bundle }) as { documentId: string };
    assert.ok(repo.state.graph!.documents[result.documentId]); assert.equal(repo.state.graphRevision, revision + 1);
    assert.deepEqual(repo.state.sessions, sessions); assert.deepEqual(repo.state.graph!.canvases, canvases);
    const graph = structuredClone(repo.state.graph);
    await assert.rejects(app.dispatch('document.import', { package: { format: 'qixue-graph-backup-v1', graph: fixture() } }));
    await assert.rejects(app.dispatch('backup.export'), /未开放/); await assert.rejects(app.dispatch('backup.import', { backup: bundle }), /未开放/);
    assert.deepEqual(repo.state.graph, graph); assert.equal(repo.state.graphRevision, revision + 1);
  } finally { await app.close(); repo.close(); }
  const reopened = new Repository(path.join(directory, 'test.sqlite'));
  try { assert.equal(Object.values(reopened.state.graph!.documents).filter(d => d.name === '名称 root').length, 2); } finally { reopened.close(); }
});
