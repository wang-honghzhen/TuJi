const automatic = (x, y) => ({ x, y, source: 'auto' });
const manual = (x, y) => ({ x, y, source: 'manual', manualAnchor: { x, y }, lastManualAt: 1 });
const node = id => ({ nodeId: id, name: id, content: '' });
const edge = (source, target, i) => ({ edgeId: `cross${i}`, sourceNodeId: source, targetNodeId: target, directed: true, edgeContent: '' });
function document(id) {
  return { documentId: id, name: `Subgraph ${id}`, kind: 'subgraph', childNodeIds: [`${id}.top`, `${id}.middle`, `${id}.bottom`], childDocumentIds: [],
    placements: { [`${id}.top`]: automatic(0, 0), [`${id}.middle`]: automatic(0, 280), [`${id}.bottom`]: automatic(0, 560) },
    rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3' } };
}
function graph(names, pairs) {
  const documents = Object.fromEntries(names.map(id => [id, document(id)]));
  const ids = Object.values(documents).flatMap(doc => doc.childNodeIds).concat(['U', 'V']);
  return { layoutVersion: 3, nodes: Object.fromEntries(ids.map(id => [id, node(id)])), documents,
    canvases: [{ canvasId: 'boundary', canvasName: 'Boundary terminals', updatedAt: '', childIds: [...names, 'U', 'V'], directories: {}, collapsed: {},
      placements: { ...Object.fromEntries(names.map((id, i) => [id, id === 'A' ? manual(0, 0) : automatic(i * 800, 0)])), U: automatic(3000, 0), V: automatic(3000, 260) } }],
    edges: [...pairs.map(([a, b], i) => edge(a, b, i)), { ...edge('U', 'V', 'unrelated'), edgeId: 'unrelated' }] };
}
export function makeBoundaryFixtures() {
  const fixtures = [];
  const add = (id, title, state, extra = {}) => fixtures.push({ id, title, state, fixed: ['A'], unrelated: ['U', 'V'], ...extra });
  add('top-bottom', 'A 上方端点 → N 下方端点', graph(['A', 'N'], [['A.top', 'N.bottom']]));
  add('bottom-top', 'A 下方端点 → N 上方端点', graph(['A', 'N'], [['A.bottom', 'N.top']]));
  const external = graph(['A'], [['A.top', 'X'], ['A.bottom', 'Y']]);
  for (const [id, y] of [['X', 560], ['Y', 0]]) { external.nodes[id] = node(id); external.canvases[0].childIds.push(id); external.canvases[0].placements[id] = automatic(800, y); }
  add('two-external', 'A 的两个内部端点连接位置相反的外部节点', external);
  add('multi-subgraphs', 'A、N、M 内部多条跨子图关系', graph(['A', 'N', 'M'], [
    ['A.top', 'N.bottom'], ['A.middle', 'N.middle'], ['A.bottom', 'M.top'], ['A.middle', 'M.top'], ['N.bottom', 'M.top'],
  ]));
  add('drag-container', '用户下移 A 后，相关邻居局部跟随', graph(['A', 'N'], [['A.middle', 'N.middle']]),
    { command: { type: 'moveBlock', id: 'A', parentId: 'boundary', point: { x: 0, y: 400 } } });
  add('drag-internal', '用户移动 A 内部端点后，外部子图局部调整', graph(['A', 'N'], [['A.top', 'N.top']]),
    { command: { type: 'moveBlock', id: 'A.top', parentId: 'A', point: { x: 0, y: 400 } }, fixed: ['A', 'A.top'] });
  const anchored = graph(['A', 'N'], [['A.top', 'N.bottom'], ['A.bottom', 'X']]);
  anchored.canvases[0].placements.N = manual(800, 0); anchored.nodes.X = node('X');
  anchored.canvases[0].childIds.push('X'); anchored.canvases[0].placements.X = automatic(1300, 0);
  add('manual-neighbour', '人工 N 不动，仅自动外部邻居调整', anchored, { fixed: ['A', 'N'] });
  const folded = graph(['A', 'N'], [['A.top', 'N.bottom']]); folded.canvases[0].collapsed = { A: true, N: true };
  add('both-folded', '双方折叠时使用可见容器端点', folded);
  const half = graph(['A', 'N'], [['A.bottom', 'N.top']]); half.canvases[0].collapsed.N = true;
  add('one-folded', 'A 展开、N 折叠时混合端点', half);
  const shared = graph(['A', 'N'], [['A.top', 'N.bottom']]);
  shared.canvases.push({ ...structuredClone(shared.canvases[0]), canvasId: 'other', canvasName: 'Other view', childIds: ['A', 'N'],
    placements: { A: manual(0, 0), N: automatic(1000, 1200) }, collapsed: { N: true } });
  add('shared-view', '同一共享文档仅调整当前画布的相对位置', shared, { otherCanvas: 'other' });
  const nested = graph(['A', 'N'], [['A.top', 'N.bottom']]);
  for (const [id, x, y] of [['A', 100, 100], ['N', 0, 300]]) {
    const old = nested.documents[id], innerId = `${id}.inner`;
    nested.documents[innerId] = { ...old, documentId: innerId, name: `Inner ${id}` };
    nested.documents[id] = { ...old, childNodeIds: [], childDocumentIds: [innerId], placements: { [innerId]: automatic(x, y) } };
  }
  add('nested-terminals', '跨两层内部端点的真实偏移', nested);
  const bounded = graph(['A'], [['A.top', 'A.bottom']]);
  bounded.documents.A.placements = { 'A.top': manual(0, 0), 'A.middle': manual(0, 112), 'A.bottom': automatic(0, 400) };
  bounded.canvases[0].placements.U = automatic(310, 0); bounded.canvases[0].placements.V = automatic(310, 260);
  add('bounded-ancestor', '内部自动邻居无安全空位时不扩大祖先撞到外部对象', bounded,
    { command: { type: 'moveBlock', id: 'A.top', parentId: 'A', point: { x: 0, y: 8 } },
      fixed: ['A', 'A.top', 'A.middle'], stableFrames: ['A'], renderOptions: { showUnrelated: true } });
  const mounted = graph(['A', 'N'], [['N.top', 'N.bottom']]);
  mounted.documents.P = { documentId: 'P', name: 'Canonical ancestor elsewhere', kind: 'document', childNodeIds: [], childDocumentIds: ['N'],
    placements: { N: automatic(0, 0) }, rev: 1, metadata: { createdAt: '', updatedAt: '', version: '3' } };
  mounted.canvases[0].collapsed.P = true; // A stale fold preference, not a mount in this view.
  mounted.canvases.push({ canvasId: 'other', canvasName: 'Canonical parent view', updatedAt: '', childIds: ['P'], directories: {},
    placements: { P: manual(0, 0) }, collapsed: {} });
  add('mounted-child', '直接挂载 N 的当前展示父链不受别处 P 的折叠标记影响', mounted,
    { command: { type: 'moveBlock', id: 'N.top', parentId: 'N', point: { x: 0, y: 20 } }, fixed: ['A', 'N', 'N.top'], otherCanvas: 'other', expectedMoved: ['N.bottom'], renderOptions: { focusRoots: ['N'] } });
  const remote = Array.from({ length: 98 }, (_, i) => `R${i}`);
  const large = graph(['A', 'N', ...remote], [['A.middle', 'N.middle']]);
  remote.forEach((id, i) => { large.canvases[0].placements[id] = automatic(2000 + i % 10 * 400, Math.floor(i / 10) * 800); });
  large.canvases[0].placements.U = automatic(7500, 0); large.canvases[0].placements.V = automatic(7500, 260);
  for (let i = 0; i < remote.length; i += 2) large.edges.push({ ...edge(`${remote[i]}.middle`, `${remote[i + 1]}.middle`, i), edgeId: `unrelated-${i}` });
  add('large-local', '100 个子图、302 个节点中只调整 A 的局部邻居', large,
    { command: { type: 'moveBlock', id: 'A', parentId: 'boundary', point: { x: 0, y: 400 } }, unrelated: ['U', 'V', ...remote] });
  return fixtures;
}
