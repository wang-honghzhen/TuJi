import { nodeGeometry } from './nodeGeometry';
import { canvasDirectories, canvasDirectory, canvasDirectoryIds } from './canvas';
import { graphIdAllocator, validateGraphIdentities } from './ids';
import type { DocumentMeta } from '@/types/document';
import { findFreeDocumentPlacement, getCanvasDocumentIds } from './layout';
import type { CanvasRecord, EdgeRouteStyle, GraphEdge, GraphRecord, GraphState, Point } from './types';
import { inheritRegionGeometry, invalidateRegionGeometry, isRegionPreview, normalizeRegionLayout, previewBlockMove,
  REGION_LAYOUT_VERSION, retainRegionGeometry, validateRegionLayout } from './regionLayout';
import { planDocumentImport } from './canvasProjection';
import { invalidateHierarchyIndex, retainHierarchyIndex } from './hierarchyIndex';
import { migrateProposalEvaluations, modeOf, reconcileDesign, remapDesign, validateDesign } from './design';
import type { CanvasMode } from './types';

const NODES_KEY = 'qixue_nodes';
const CANVASES_KEY = 'qixue_canvases';
const EDGES_KEY = 'qixue_cross_edges';
const STRUCTURE_WRITE_KEY = 'qixue_v3_structure_pending';
const LAYOUT_VERSION_KEY = 'qixue_v3_region_layout_version';
const LAYOUT_BACKUP_KEY = 'qixue_v3_region_layout_backup';
export const DRAFT_ID = 'qixue-draft-canvas';
const published = new WeakSet<GraphState>();
let planningDepth = 0;
/** Reuse domain rules without writing browser storage. The callback is synchronous. */
export function planGraphUpdate<T>(action: () => T): T {
  planningDepth++;
  try { return action(); } finally { planningDepth--; }
}
function publish(state: GraphState): GraphState {
  retainHierarchyIndex(state); retainRegionGeometry(state); published.add(state); return state;
}
function unchangedGeometry(previous: GraphState, next: GraphState): GraphState {
  inheritRegionGeometry(previous, next);
  if (published.has(previous)) published.add(next);
  return next;
}
interface StructurePatch { format: 'patch-v1'; puts: Record<string, string>; deletes: string[] }

function documentKey(id: string): string { return `qixue_documents_${id}`; }
function storedDocumentIds(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((key): key is string => Boolean(key?.startsWith('qixue_documents_')))
    .map((key) => key.slice('qixue_documents_'.length));
}
function parse<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { throw new Error(`存储记录损坏：${key}`); }
}
function write(key: string, value: unknown): void {
  if (planningDepth) return;
  if (key !== STRUCTURE_WRITE_KEY && localStorage.getItem(STRUCTURE_WRITE_KEY)) throw new Error('结构变更尚未恢复，请刷新后继续');
  localStorage.setItem(key, JSON.stringify(value));
}

export function finishStructureWrite(): boolean {
  const pending = parse<GraphState | StructurePatch | null>(STRUCTURE_WRITE_KEY, null); if (!pending) return false;
  if ('format' in pending) {
    const allowed = (key: string) => [NODES_KEY, CANVASES_KEY, EDGES_KEY, LAYOUT_VERSION_KEY].includes(key) || key.startsWith('qixue_documents_');
    if (pending.format !== 'patch-v1' || !pending.puts || !Array.isArray(pending.deletes) ||
      Object.entries(pending.puts).some(([key, value]) => !allowed(key) || typeof value !== 'string') ||
      pending.deletes.some(key => typeof key !== 'string' || !key.startsWith('qixue_documents_'))) throw new Error('结构恢复记录损坏');
    // All values were validated before journaling. Replaying is idempotent,
    // including after some of these individual writes have already succeeded.
    for (const [key, raw] of Object.entries(pending.puts)) localStorage.setItem(key, raw);
    pending.deletes.forEach(key => localStorage.removeItem(key));
    localStorage.removeItem(STRUCTURE_WRITE_KEY); return true;
  }
  throw new Error('结构恢复记录损坏');
}

export function commitStructure(next: GraphState, previous?: GraphState): GraphState {
  next = reconcileDesign(next, previous);
  if (!planningDepth && localStorage.getItem(STRUCTURE_WRITE_KEY)) throw new Error('请先恢复上一次结构变更');
  const preview = previous && published.has(previous) && isRegionPreview(next, previous);
  if (!preview) {
    // A caller may hand us a mutable draft (including one reused by an importer).
    invalidateHierarchyIndex(next); invalidateRegionGeometry(next); published.delete(next);
    validateStructure(next);
    next = normalizeRegionLayout(next, previous);
    validateRegionLayout(next);
  }
  const baseline = previous && published.has(previous) ? previous : undefined;
  if (planningDepth) return publish(next);
  const patch: StructurePatch = { format: 'patch-v1', puts: {}, deletes: [] };
  const put = (key: string, value: unknown, old: unknown) => {
    if (baseline && value === old) return;
    const raw = JSON.stringify(value); if (localStorage.getItem(key) !== raw) patch.puts[key] = raw;
  };
  put(NODES_KEY, next.nodes, baseline?.nodes); put(EDGES_KEY, next.edges, baseline?.edges);
  put(CANVASES_KEY, next.canvases, baseline?.canvases); put(LAYOUT_VERSION_KEY, next.layoutVersion ?? 0, baseline?.layoutVersion);
  for (const [id, record] of Object.entries(next.documents)) put(documentKey(id), record, baseline?.documents[id]);
  for (const id of baseline ? Object.keys(baseline.documents) : storedDocumentIds()) if (!next.documents[id]) patch.deletes.push(documentKey(id));
  if (!Object.keys(patch.puts).length && !patch.deletes.length) return publish(next);
  write(STRUCTURE_WRITE_KEY, patch);
  try { finishStructureWrite(); } catch {
    // A transient interruption can be retried immediately. A persistent error
    // leaves the durable intent in place and prevents unrelated writes.
    try { finishStructureWrite(); } catch { throw new Error('保存未完成，恢复记录已保留；请刷新后继续操作'); }
  }
  return publish(next);
}

export function pruneInvalidEdges(state: GraphState): GraphState {
  const exists = (id: string) => Boolean(state.nodes[id] || state.documents[id] || state.canvases.some((canvas) => canvasDirectory(canvas, id)));
  const edges = state.edges.filter((edge) => !edge.removed && exists(edge.sourceNodeId) && exists(edge.targetNodeId));
  return edges.length === state.edges.length ? state : { ...state, edges };
}
export function emptyCanvas(canvasId: string, canvasName: string, isDraft = false,
  mode: CanvasMode = 'explore'): CanvasRecord {
  return {
    canvasId, canvasName, mode, updatedAt: new Date().toISOString(),
    childIds: [], directories: {},
    placements: {},
    collapsed: {}, isDraft,
  };
}

/** Flatten only the synthetic directory introduced by the first v3 renderer. */
function readState(): GraphState {
  const documents: GraphState['documents'] = {};
  for (const id of storedDocumentIds()) {
    const record = parse<GraphRecord | null>(documentKey(id), null);
    if (record) documents[id] = record;
  }
  return {
    layoutVersion: parse<number>(LAYOUT_VERSION_KEY, 0),
    documents,
    nodes: parse(NODES_KEY, {}),
    canvases: parse(CANVASES_KEY, []),
    edges: parse(EDGES_KEY, []),
  };
}

/** Parent lists are the authority. Report corrupt multiple parents instead of picking one. */
export function validateStructure(state: GraphState): void {
  validateGraphIdentities(state);
  const owner = new Map<string, string>();
  const canvasNodeOwner = new Map<string, string>();
  const claim = (id: string, parent: string) => {
    if (owner.has(id)) throw new Error(`结构冲突：${id} 同时属于 ${owner.get(id)} 和 ${parent}`);
    owner.set(id, parent);
  };
  for (const doc of Object.values(state.documents)) {
    for (const id of doc.childNodeIds) {
      if (!state.nodes[id]) throw new Error(`结构缺失：${doc.documentId} 引用了节点 ${id}`);
      claim(id, doc.documentId);
    }
    for (const id of doc.childDocumentIds) {
      if (!state.documents[id]) throw new Error(`结构缺失：${doc.documentId} 引用了文档 ${id}`);
      claim(id, doc.documentId);
    }
  }
  for (const id of Object.keys(state.nodes)) if (state.documents[id]) throw new Error(`节点与文档 ID 冲突：${id}`);
  for (const canvas of state.canvases) {
    if (!Array.isArray(canvas.childIds) || 'rootDirectoryId' in canvas) throw new Error(`画布 ${canvas.canvasId} 顶层成员或身份格式无效`);
    const local = new Map<string, string>();
    const visiting = new Set<string>();
    const visitDirectory = (id: string) => {
      if (visiting.has(id)) throw new Error(`画布目录成环：${id}`);
      visiting.add(id);
      for (const child of canvasDirectory(canvas, id).childIds) {
        if (local.has(child)) throw new Error(`画布 ${canvas.canvasId} 的 ${child} 有重复父级`);
        local.set(child, id);
        if (canvasDirectory(canvas, child)) visitDirectory(child);
        else if (!state.documents[child] && !state.nodes[child]) throw new Error(`画布引用缺失：${child}`);
        if (state.nodes[child]) {
          if (!canvas.nodeReferenceIds?.includes(child)) {
            if (owner.has(child) || canvasNodeOwner.has(child)) throw new Error(`画布局部节点重复归属：${child}`);
            canvasNodeOwner.set(child, `${canvas.canvasId}/${id}`);
          }
        }
      }
      visiting.delete(id);
    };
    visitDirectory(canvas.canvasId);
    for (const id of canvas.nodeReferenceIds ?? []) if (!state.nodes[id] || !local.has(id)) throw new Error(`画布节点引用失效：${id}`);
    const seen = new Set<string>();
    const displayedNodes = new Set([...local.keys()].filter((id) => Boolean(state.nodes[id])));
    const visitDoc = (id: string) => {
      if (canvas.excludedDocumentIds?.includes(id)) return;
      if (seen.has(id)) throw new Error(`画布 ${canvas.canvasId} 重复渲染文档 ${id}`);
      seen.add(id);
      for (const nodeId of state.documents[id]?.childNodeIds ?? []) {
        if (displayedNodes.has(nodeId)) throw new Error(`画布 ${canvas.canvasName} 重复显示节点“${state.nodes[nodeId]?.name ?? nodeId}”`);
        displayedNodes.add(nodeId);
      }
      state.documents[id]?.childDocumentIds.forEach(visitDoc);
    };
    for (const id of local.keys()) if (state.documents[id]) visitDoc(id);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitDoc = (id: string) => {
    if (visiting.has(id)) throw new Error(`文档成环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    state.documents[id].childDocumentIds.forEach(visitDoc);
    visiting.delete(id);
    visited.add(id);
  };
  Object.keys(state.documents).forEach(visitDoc);
  for (const id of Object.keys(state.nodes)) if (!owner.has(id) && !canvasNodeOwner.has(id)) throw new Error(`无主节点：${id}`);
  validateDesign(state);
}

/** A fresh canvas with no browser storage involved: what a first start needs when the
 *  stored records belong to an older format and cannot be read at all. */
export function emptyGraph(): GraphState {
  return { layoutVersion: REGION_LAYOUT_VERSION, documents: {}, nodes: {}, canvases: [emptyCanvas(DRAFT_ID, '临时画布', true)], edges: [] };
}

/** First start and every later start share one path: the stored graph, or a fresh empty canvas. */
export function bootstrap(): GraphState {
  finishStructureWrite();
  const stored = readState(), state = migrateProposalEvaluations(stored);
  validateStructure(state);
  if (!state.canvases.some((canvas) => canvas.canvasId === DRAFT_ID)) {
    state.canvases.push(emptyCanvas(DRAFT_ID, '临时画布', true));
    validateGraphIdentities(state);
    write(CANVASES_KEY, state.canvases);
  }
  const cleaned = pruneInvalidEdges(state);
  if (cleaned !== state) write(EDGES_KEY, cleaned.edges);
  if (state !== stored) return commitStructure(cleaned);
  return upgradeRegionLayout(cleaned);
}

function upgradeRegionLayout(state: GraphState): GraphState {
  const next = normalizeRegionLayout(state);
  if (next === state) return publish(state);
  if (state.layoutVersion !== REGION_LAYOUT_VERSION && !localStorage.getItem(LAYOUT_BACKUP_KEY)) write(LAYOUT_BACKUP_KEY, state);
  return commitStructure(next);
}

function saveCanvas(state: GraphState, updated: CanvasRecord): GraphState {
  const canvas = { ...updated, updatedAt: new Date().toISOString() };
  const canvases = state.canvases.map((c) => c.canvasId === canvas.canvasId ? canvas : c);
  write(CANVASES_KEY, canvases);
  return unchangedGeometry(state, { ...state, canvases });
}
export function createCanvas(state: GraphState, name: string, mode: CanvasMode = 'explore'): GraphState {
  const canvas = emptyCanvas(graphIdAllocator(state)(), name, false, mode);
  const canvases = [...state.canvases, canvas];
  write(CANVASES_KEY, canvases);
  return { ...state, canvases };
}
export function cloneCanvas(state: GraphState, id: string, name: string): GraphState {
  const source = state.canvases.find((canvas) => canvas.canvasId === id);
  if (!source) return state;
  const allocate = graphIdAllocator(state), copyId = allocate();
  const dirIds = Object.keys(source.directories);
  const localNodes = [...new Set(canvasDirectories(source).flatMap(dir => dir.childIds.filter(childId => Boolean(state.nodes[childId]) && !source.nodeReferenceIds?.includes(childId))))];
  const renamed = Object.fromEntries([[source.canvasId, copyId], ...dirIds.map((dirId) => [dirId, allocate(`canvas-dir:${copyId}:`)]), ...localNodes.map((nodeId) => [nodeId, allocate()])]);
  const directories = Object.fromEntries(dirIds.map((dirId) => [renamed[dirId], {
    ...canvasDirectory(source, dirId),
    name: canvasDirectory(source, dirId).name,
    childIds: canvasDirectory(source, dirId).childIds.map((childId) => renamed[childId] ?? childId),
  }]));
  const placements = Object.fromEntries(Object.entries(source.placements).map(([key, pos]) => [renamed[key] ?? key, pos]));
  const collapsed = Object.fromEntries(Object.keys(source.collapsed).map((key) => [renamed[key] ?? key, true])) as Record<string, true>;
  const canvas: CanvasRecord = { ...source, canvasId: copyId, canvasName: name, childIds: source.childIds.map(id => renamed[id] ?? id), directories, placements, collapsed, isDraft: false, updatedAt: new Date().toISOString() };
  const canvases = [...state.canvases, canvas];
  const nodes = { ...state.nodes, ...Object.fromEntries(localNodes.map((nodeId) => [renamed[nodeId], { ...state.nodes[nodeId], nodeId: renamed[nodeId], design: remapDesign(state.nodes[nodeId].design, renamed, true) }])) };
  const copiedEdges = state.edges.filter((edge) => !edge.removed && !edge.membershipFor && (renamed[edge.sourceNodeId] || renamed[edge.targetNodeId])).map((edge) => ({
    ...edge, edgeId: allocate(), sourceNodeId: renamed[edge.sourceNodeId] ?? edge.sourceNodeId, targetNodeId: renamed[edge.targetNodeId] ?? edge.targetNodeId,
  }));
  return commitStructure({ ...state, nodes, canvases, edges: [...state.edges, ...copiedEdges] });
}
export function createDocument(state: GraphState, name: string, mode: CanvasMode = 'explore'): GraphState {
  const id = graphIdAllocator(state)();
  const now = new Date().toISOString();
  const document: GraphRecord = { documentId: id, kind: 'document', mode, name, childNodeIds: [], childDocumentIds: [], placements: {}, rev: 1,
    metadata: { createdAt: now, updatedAt: now, version: '3.0' } };
  write(documentKey(id), document);
  return { ...state, documents: { ...state.documents, [id]: document } };
}
export function prepareDocumentAddition(state: GraphState, canvasId: string, id: string, preferredWorld?: Point): GraphState {
  const canvas = state.canvases.find((c) => c.canvasId === canvasId);
  if (!canvas || state.documents[id]?.kind !== 'document') throw new Error('画布或图文档不存在');
  if (modeOf(canvas) !== modeOf(state.documents[id])) throw new Error('探索与设计图文档不能互相引入');
  const plan = planDocumentImport(state, canvas, id);
  const base = plan.canvas;
  const directoryId = canvas.canvasId;
  const position = plan.restore ? undefined : findFreeDocumentPlacement(state, base, directoryId, id, preferredWorld);
  const updated: CanvasRecord = {
    ...base,
    childIds: position ? [...base.childIds, id] : base.childIds,
    placements: position ? { ...base.placements, [id]: position } : base.placements,
    updatedAt: new Date().toISOString(),
  };
  const next = { ...state, canvases: state.canvases.map((c) => c.canvasId === canvasId ? updated : c) };
  validateStructure(next);
  return next;
}
export function removeDocument(state: GraphState, canvasId: string, id: string): GraphState {
  const canvas = state.canvases.find((c) => c.canvasId === canvasId);
  if (!canvas) return state;
  const parentId = canvasDirectoryIds(canvas).find((dirId) => canvasDirectory(canvas, dirId).childIds.includes(id));
  if (!state.documents[id] || !getCanvasDocumentIds(state, canvas).has(id)) return state;
  const directories = parentId && parentId !== canvasId ? { ...canvas.directories, [parentId]: { ...canvasDirectory(canvas, parentId), childIds: canvasDirectory(canvas, parentId).childIds.filter((childId) => childId !== id) } } : canvas.directories;
  const childIds = parentId === canvasId ? canvas.childIds.filter(child => child !== id) : canvas.childIds;
  const placements = { ...canvas.placements }; delete placements[id];
  const collapsed = { ...canvas.collapsed }; delete collapsed[id];
  const updated = { ...canvas, childIds, directories, placements, collapsed,
    excludedDocumentIds: parentId ? canvas.excludedDocumentIds : [...new Set([...(canvas.excludedDocumentIds ?? []), id])], updatedAt: new Date().toISOString() };
  return commitStructure({ ...state, canvases: state.canvases.map((item) => item.canvasId === canvasId ? updated : item) });
}
export function moveBlock(state: GraphState, canvasId: string, id: string, parentId: string, point: Point): GraphState {
  const next = previewBlockMove(state, canvasId, id, parentId, point);
  return next === state ? state : commitStructure(next, state);
}
export function toggleCollapse(state: GraphState, canvasId: string, id: string): GraphState {
  const canvas = state.canvases.find((c) => c.canvasId === canvasId);
  if (!canvas || (!state.documents[id] && !canvasDirectory(canvas, id))) return state;
  const collapsed = { ...canvas.collapsed };
  if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true;
  return saveCanvas(state, { ...canvas, collapsed });
}

export interface CreateEdgeInput {
  sourceNodeId: string;
  targetNodeId: string;
  edgeContent?: string;
  directed?: boolean;
  routeStyle?: EdgeRouteStyle;
}

function assertEndpoint(state: GraphState, id: string): void {
  if (!state.nodes[id] && !state.documents[id] && !state.canvases.some((canvas) => canvasDirectory(canvas, id))) {
    throw new Error('连接的节点或记录不存在');
  }
}
function assertRouteStyle(style?: EdgeRouteStyle): void {
  if (style !== undefined && !['curve', 'orthogonal'].includes(style)) throw new Error('连线样式必须是曲线或正交');
}

/** Which side an edge leaves is decided by the renderer from current positions;
 *  an edge stores only what it means, never how it is drawn. */
export function createEdge(state: GraphState, input: CreateEdgeInput): GraphState {
  assertEndpoint(state, input.sourceNodeId);
  assertEndpoint(state, input.targetNodeId);
  assertRouteStyle(input.routeStyle);
  if (input.sourceNodeId === input.targetNodeId) throw new Error('请选择另一个节点进行连接');
  const edge: GraphEdge = {
    edgeId: graphIdAllocator(state)(), sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId,
    edgeContent: input.edgeContent ?? '', directed: input.directed ?? true,
    ...(input.routeStyle ? { routeStyle: input.routeStyle } : {}),
  };
  const edges = [...state.edges, edge];
  write(EDGES_KEY, edges);
  return unchangedGeometry(state, { ...state, edges });
}

export function reconnectEdge(state: GraphState, edgeId: string, end: 'source' | 'target', nodeId: string): GraphState {
  assertEndpoint(state, nodeId);
  const original = state.edges.find((edge) => edge.edgeId === edgeId && !edge.removed);
  if (!original) throw new Error('这条边已经不存在');
  if (original.membershipFor) throw new Error('请在组合详情中调整成员方案');
  const otherId = end === 'source' ? original.targetNodeId : original.sourceNodeId;
  if (otherId === nodeId) throw new Error('请选择另一个节点进行连接');
  const edges = state.edges.map((edge) => edge.edgeId === edgeId ? {
    ...edge, [end === 'source' ? 'sourceNodeId' : 'targetNodeId']: nodeId,
  } : edge);
  write(EDGES_KEY, edges);
  return unchangedGeometry(state, { ...state, edges });
}

export interface EdgePatch {
  sourceNodeId?: string;
  targetNodeId?: string;
  /** 'auto' restores the default curve. */
  routeStyle?: EdgeRouteStyle | 'auto';
  direction?: 'forward' | 'reverse' | 'none';
  edgeContent?: string;
}

export function updateNodeText(state: GraphState, nodeId: string, field: 'name' | 'content', value: string): GraphState {
  if (!state.nodes[nodeId]) throw new Error('这个节点已经不存在');
  const nodes = { ...state.nodes, [nodeId]: { ...state.nodes[nodeId], [field]: value } };
  const before = nodeGeometry(state.nodes[nodeId]), after = nodeGeometry(nodes[nodeId]);
  if (before.width !== after.width || before.height !== after.height) return commitStructure({ ...state, nodes }, state);
  write(NODES_KEY, nodes);
  return unchangedGeometry(state, { ...state, nodes });
}

/** One pool write keeps endpoint identity and direction consistent. */
export function updateEdge(state: GraphState, edgeId: string, patch: EdgePatch): GraphState {
  const original = state.edges.find((edge) => edge.edgeId === edgeId && !edge.removed);
  if (!original) throw new Error('这条边已经不存在');
  if (original.membershipFor) throw new Error('请在组合详情中调整成员方案');
  const updated = { ...original };
  if (patch.sourceNodeId !== undefined) { assertEndpoint(state, patch.sourceNodeId); updated.sourceNodeId = patch.sourceNodeId; }
  if (patch.targetNodeId !== undefined) { assertEndpoint(state, patch.targetNodeId); updated.targetNodeId = patch.targetNodeId; }
  if (updated.sourceNodeId === updated.targetNodeId) throw new Error('请选择另一个节点进行连接');
  if (patch.edgeContent !== undefined) updated.edgeContent = patch.edgeContent;
  if (patch.routeStyle === 'auto') delete updated.routeStyle;
  else if (patch.routeStyle !== undefined) { assertRouteStyle(patch.routeStyle); updated.routeStyle = patch.routeStyle; }
  if (patch.direction === 'reverse') {
    [updated.sourceNodeId, updated.targetNodeId] = [updated.targetNodeId, updated.sourceNodeId];
    updated.directed = true;
  } else if (patch.direction !== undefined) updated.directed = patch.direction === 'forward';
  const edges = state.edges.map((edge) => edge.edgeId === edgeId ? updated : edge);
  write(EDGES_KEY, edges);
  return unchangedGeometry(state, { ...state, edges });
}

export function listDocumentMeta(state: GraphState): DocumentMeta[] {
  const incidentEdges = new Map<string, number[]>();
  state.edges.forEach((edge, index) => {
    if (edge.removed) return;
    for (const id of new Set([edge.sourceNodeId, edge.targetNodeId])) {
      const indexes = incidentEdges.get(id);
      if (indexes) indexes.push(index); else incidentEdges.set(id, [index]);
    }
  });
  return Object.values(state.documents).filter((record) => record.kind === 'document').map((doc) => {
    const all = new Set<string>(); const nodes = new Set<string>(); const subgraphs = new Set<string>();
    const visit = (id: string) => { if (all.has(id)) return; all.add(id); const r = state.documents[id]; if (!r) return;
      r.childNodeIds.forEach((nodeId) => nodes.add(nodeId)); r.childDocumentIds.forEach((childId) => { subgraphs.add(childId); visit(childId); }); };
    visit(doc.documentId);
    const edges = new Set<number>();
    for (const id of [...all, ...nodes]) for (const index of incidentEdges.get(id) ?? []) edges.add(index);
    return { documentId: doc.documentId, documentName: doc.name, description: doc.metadata.description,
      createdAt: doc.metadata.createdAt, updatedAt: doc.metadata.updatedAt, currentVersion: doc.metadata.version,
      stats: { nodeCount: nodes.size, subgraphCount: subgraphs.size,
        edgeCount: edges.size } };
  });
}
