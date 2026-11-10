import { canvasDirectories, canvasDirectory, canvasDirectoryEntries } from '@/v3/canvas';
import type { CanvasRecord, GraphEdge, GraphState } from '@/v3/types';
import { canvasMemberIds } from '../canvasScope';
import { graphIdAllocator } from '@/v3/ids';
import { documentParents, getDocumentTree } from '@/v3/documentTrees';
import { normalizeRegionLayout, validateRegionLayout } from '@/v3/regionLayout';
import { recordPlacementIntent } from '@/v3/placementIntent';
import { applyStructureCommand, StructureConfirmationRequired, type StructureCommand } from '@/v3/structure';
import { planGraphUpdate, commitStructure, createCanvas, cloneCanvas, createDocument, createEdge, emptyCanvas,
  moveBlock, pruneInvalidEdges, reconnectEdge, removeDocument, toggleCollapse, updateEdge, updateNodeText, validateStructure,
  type CreateEdgeInput, type EdgePatch } from '@/v3/storage';
import type { GraphPatch, Task } from '../domain';
import { DomainError, requireValue, strings, text } from './errors';
import { hash, now } from './repository';
import { AI_STRUCTURE_BOUNDARY_MESSAGE, assertAiStructureBoundary } from './aiStructurePolicy';
import { appendDesignEvaluation, canvasMode, designData, migrateProposalEvaluations, migrateProposalNode, modeOf } from '@/v3/design';
import type { GraphNodeRecord } from '@/v3/types';

export function canvasOf(state: GraphState, canvasId: string): CanvasRecord {
  const canvas = state.canvases.find(c => c.canvasId === canvasId); requireValue(canvas, '画布不存在', 'NOT_FOUND'); return canvas;
}
export function memberIds(state: GraphState, canvasId: string): Set<string> {
  canvasOf(state, canvasId);
  return canvasMemberIds(state, canvasId);
}
export function readableIds(state: GraphState, task: Task): Set<string> {
  return memberIds(state, task.canvasId);
}
export function entity(state: GraphState, ref: string): unknown {
  return state.nodes[ref] ?? state.documents[ref] ?? state.edges.find(e => e.edgeId === ref)
    ?? state.canvases.find(c => c.canvasId === ref) ?? state.canvases.flatMap(c => canvasDirectoryEntries(c)).find(([key]) => key === ref)?.[1] ?? null;
}
/** Resolve repeatedly against one synchronous graph snapshot. Never retain across edits. */
export function graphEntityLookup(state: GraphState) {
  const others = new Map<string, unknown>();
  const add = (id: string, value: unknown) => { if (!others.has(id)) others.set(id, value); };
  for (const edge of state.edges) add(edge.edgeId, edge);
  for (const canvas of state.canvases) add(canvas.canvasId, canvas);
  for (const canvas of state.canvases) for (const [id, directory] of canvasDirectoryEntries(canvas)) add(id, directory);
  return (ref: string): unknown => state.nodes[ref] ?? state.documents[ref] ?? others.get(ref) ?? null;
}
export function assertAiObjectRefs(state: GraphState, refs: string[]) {
  const protectedIds = new Set(state.canvases.flatMap(canvas => [canvas.canvasId]));
  requireValue(refs.every(ref => !protectedIds.has(ref)), '画布及根目录不是AI可操作对象；顶层新增或移动请省略parentId', 'ROOT_READ_ONLY');
}
export function assertAiCommandRefs(state: GraphState, command: Record<string, unknown>) {
  const refs = ['id', 'parentId', 'nodeId'].flatMap(key => typeof command[key] === 'string' ? [command[key] as string] : []);
  if (Array.isArray(command.ids)) refs.push(...command.ids.filter((ref): ref is string => typeof ref === 'string'));
  for (const key of ['input', 'patch']) {
    const fields = command[key] as Record<string, unknown> | undefined;
    if (fields) for (const endpoint of ['sourceNodeId', 'targetNodeId']) if (typeof fields[endpoint] === 'string') refs.push(fields[endpoint] as string);
  }
  assertAiObjectRefs(state, refs);
}
export function semanticHashes(state: GraphState): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [ref, node] of Object.entries(state.nodes)) values[`nodes:${ref}`] = hash(node);
  for (const [ref, doc] of Object.entries(state.documents)) {
    values[`documents:${ref}:content`] = hash([doc.name, doc.metadata.description]);
    values[`documents:${ref}:structure`] = hash([doc.kind, doc.childNodeIds, doc.childDocumentIds]);
    values[`documents:${ref}:view`] = hash(doc.placements);
  }
  for (const canvas of state.canvases) {
    values[`canvases:${canvas.canvasId}:structure`] = hash([canvas.childIds, canvas.directories, canvas.excludedDocumentIds, canvas.nodeReferenceIds, canvas.isDraft]);
    values[`canvases:${canvas.canvasId}:view`] = hash([canvas.placements, canvas.collapsed]);
  }
  for (const edge of state.edges) values[`edges:${edge.edgeId}`] = hash(edge);
  return values;
}
export function resourcesFor(state: GraphState, canvasId: string, refs: Iterable<string>): string[] {
  const parents = documentParents(state), resources = new Set<string>();
  const ownerOfNode = new Map(Object.values(state.documents).flatMap(doc => doc.childNodeIds.map(node => [node, doc.documentId] as const)));
  const visit = (ref: string) => {
    const edge = state.edges.find(e => e.edgeId === ref); if (edge) { visit(edge.sourceNodeId); visit(edge.targetNodeId); return; }
    let owner = state.documents[ref] ? ref : ownerOfNode.get(ref);
    if (owner) { while (parents.has(owner)) owner = parents.get(owner)!; resources.add(`document-tree:${getDocumentTree(state, owner).rootId}`); }
    else resources.add(`canvas-local:${canvasId}`);
  };
  for (const ref of refs) visit(ref); return [...resources].sort();
}

const structureTypes = new Set(['createNode', 'createSubgraph', 'move', 'moveCanvasItems', 'reparentContent', 'deleteNode', 'deleteEdge', 'deleteSubgraph', 'deleteDocument', 'replaceDocument', 'registerDocument', 'importDocument', 'cleanupEdges']);
export function planMutation(state: GraphState, canvasId: string, raw: Record<string, unknown>,
  actor: 'user' | 'ai' = 'user'): { state: GraphState; id?: string; cleanedEdges: number; identityMap?: Record<string, string> } {
  const command = structuredClone(raw); const kind = text(command.type, '操作类型', 80);
  if (kind === 'replaceDocument') requireValue(actor === 'user', '图文档替换仅由用户执行', 'USER_ONLY_MANAGEMENT');
  requireValue(command.designListPatch === undefined || kind === 'updateDesignNode', 'designListPatch仅用于updateDesignNode', 'INVALID_ARGUMENT');
  requireValue(command.designPatch === undefined || kind === 'updateDesignNode', 'designPatch仅用于updateDesignNode', 'INVALID_ARGUMENT');
  if (actor === 'ai') requireValue(command.resolution === undefined, AI_STRUCTURE_BOUNDARY_MESSAGE, 'AI_STRUCTURE_BOUNDARY');
  if (kind === 'moveBlock' || command.point !== undefined) {
    const point = command.point as { x?: unknown; y?: unknown } | null;
    requireValue(point && typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y), '位置坐标必须是有效数字');
  }
  try { return planGraphUpdate(() => {
    let next = state, createdId: string | undefined;
    if (structureTypes.has(kind)) {
      if (['createNode', 'createSubgraph'].includes(kind)) { text(command.parentId, '父对象'); text(command.name, '名称', 1000); text(command.content ?? '', '正文'); command.content ??= ''; }
      if (['move', 'moveCanvasItems', 'reparentContent'].includes(kind)) { strings(command.ids, '移动对象'); text(command.parentId, '父对象'); }
      const result = applyStructureCommand(state, canvasId, command as unknown as StructureCommand);
      if (result.id && command.point && ['createNode', 'createSubgraph'].includes(kind)) result.state = recordPlacementIntent(result.state,
        canvasId, String(command.parentId), result.id, actor, Date.now());
      return result;
    }
    if (kind === 'createEdge') { next = createEdge(state, (command.input ?? command) as unknown as CreateEdgeInput); createdId = next.edges.at(-1)?.edgeId; }
    else if (kind === 'updateDesignNode') {
      const id = text(command.id, '节点'), canvas = canvasOf(state, canvasId);
      requireValue(modeOf(canvas) === 'design' && memberIds(state, canvasId).has(id) && state.nodes[id]?.design, '只能编辑当前设计画布的设计节点');
      requireValue(command.expectedDesign === undefined || hash(command.expectedDesign) === hash(state.nodes[id].design), '设计信息在编辑期间已更新，请关闭并重新打开后核对', 'VERSION_CONFLICT');
      requireValue([command.design,command.designPatch,command.designListPatch].filter(v=>v!==undefined).length===1, 'design、designPatch、designListPatch必须且只能提供一种', 'INVALID_ARGUMENT');
      let value = command.design;
      if (command.designPatch !== undefined) {
        const patch = command.designPatch;
        requireValue(patch && typeof patch === 'object' && !Array.isArray(patch), 'designPatch必须是字段对象', 'INVALID_ARGUMENT');
        const fields = patch as Record<string, unknown>, type = state.nodes[id].design!.type;
        const permitted = type === 'combination' ? ['memberIds', 'pros', 'cons'] : type === 'flow' ? ['subjectIds'] : [];
        requireValue(Object.keys(fields).length && Object.keys(fields).every(key => permitted.includes(key) && fields[key] !== undefined), '局部修改只接受当前类型的字段；类型切换使用design完整替换', 'INVALID_ARGUMENT');
        // The caller's object-version fence is checked before planning and again at commit.
        value = { ...state.nodes[id].design, ...fields };
      }
      if(command.designListPatch!==undefined){
        const patch=command.designListPatch;
        requireValue(patch&&typeof patch==='object'&&!Array.isArray(patch),'designListPatch必须是对象','INVALID_ARGUMENT');
        const fields=patch as Record<string,unknown>,old=state.nodes[id].design!,keys=old.type==='combination'?['addMemberIds','removeMemberIds']:old.type==='flow'?['addSubjectIds','removeSubjectIds']:[];
        requireValue(Object.keys(fields).length>0&&Object.keys(fields).every(k=>keys.includes(k)),'当前设计类型不支持这些列表操作','INVALID_ARGUMENT');
        const field=old.type==='combination'?'memberIds':'subjectIds', addKey=keys[0],removeKey=keys[1];
        const add=fields[addKey]===undefined?[]:strings(fields[addKey],'新增引用',10000),remove=fields[removeKey]===undefined?[]:strings(fields[removeKey],'移除引用',10000);
        requireValue(!add.some(ref=>remove.includes(ref)),'同一引用不能同时新增和移除','INVALID_ARGUMENT');
        const retained=(old[field]??[]).filter(ref=>!remove.includes(ref));
        value={...old,[field]:[...new Set([...retained,...add])]};
      }
      const design = designData(value);
      const visible = memberIds(state, canvasId);
      const oldRefs = new Set([...(state.nodes[id].design?.memberIds ?? []), ...(state.nodes[id].design?.subjectIds ?? [])]);
      requireValue([...(design.memberIds ?? []), ...(design.subjectIds ?? [])].every(ref => visible.has(ref) || oldRefs.has(ref)), '只能新增当前画布中的关联对象', 'OUT_OF_SCOPE');
      const node = state.nodes[id];
      const content = node.design?.type === 'combination' && design.type !== 'combination' ? appendDesignEvaluation(node.content, node.design) : node.content;
      next = { ...state, nodes: { ...state.nodes, [id]: { ...node, content, design } } };
    }
    else if(kind==='patchNodeContent'){
      const id=text(command.id,'节点'),node=state.nodes[id];
      requireValue(node&&memberIds(state,canvasId).has(id),'节点不属于当前画布','OUT_OF_SCOPE');
      const oldText=text(command.oldText,'原文片段'),newText=text(command.newText,'新片段');
      requireValue(oldText.length>0,'oldText不能为空','INVALID_ARGUMENT');
      const start=node.content.indexOf(oldText);
      requireValue(start>=0&&node.content.indexOf(oldText,start+1)<0,'原文片段必须唯一命中，请读取后提供更具体的原文','TEXT_MATCH_CONFLICT');
      next=updateNodeText(state,id,'content',node.content.slice(0,start)+newText+node.content.slice(start+oldText.length));
    }
    else if (kind === 'updateSubgraphText') {
      const id = text(command.id, '子图'), canvas = canvasOf(state, canvasId), field = command.field;
      requireValue(field === 'name' || field === 'content', '子图字段无效');
      requireValue(id !== canvasId && memberIds(state, canvasId).has(id), '子图不属于当前画布', 'OUT_OF_SCOPE');
      const value = text(command.value, field === 'name' ? '名称' : '正文', field === 'name' ? 1000 : undefined);
      const local = canvas.directories[id], document = state.documents[id];
      requireValue(local || document?.kind === 'subgraph', '只能修改普通子图，不能修改图文档层', 'USER_ONLY_MANAGEMENT');
      if (local) next = { ...state, canvases: state.canvases.map(c => c.canvasId === canvasId
        ? { ...c, directories: { ...c.directories, [id]: { ...local, [field === 'name' ? 'name' : 'description']: value } }, updatedAt: now() } : c) };
      else next = { ...state, documents: { ...state.documents, [id]: { ...document, ...(field === 'name' ? { name: value } : {}), rev: document.rev + 1,
        metadata: { ...document.metadata, ...(field === 'content' ? { description: value } : {}), updatedAt: now() } } } };
    }
    else if (kind === 'updateNodeText') {
      requireValue(command.field === 'name' || command.field === 'content', '节点字段无效'); next = updateNodeText(state, text(command.id, '节点'), command.field, text(command.value, '正文'));
    } else if (kind === 'updateEdge') next = updateEdge(state, text(command.id, '边'), command.patch as EdgePatch);
    else if (kind === 'reconnectEdge') {
      requireValue(command.end === 'source' || command.end === 'target', '边端点无效'); next = reconnectEdge(state, text(command.id, '边'), command.end, text(command.nodeId, '节点'));
    } else if (kind === 'moveBlock') next = moveBlock(state, canvasId, text(command.id, '对象'), text(command.parentId, '父对象'), command.point as { x: number; y: number });
    else if (kind === 'toggleCollapse') next = toggleCollapse(state, canvasId, text(command.id, '对象'));
    else if (kind === 'createCanvas') { next = createCanvas(state, text(command.name, '画布名称', 1000), canvasMode(command.mode)); createdId = next.canvases.at(-1)?.canvasId; }
    else if (kind === 'cloneCanvas') { next = cloneCanvas(state, canvasId, text(command.name, '画布名称', 1000)); createdId = next.canvases.at(-1)?.canvasId; }
    else if (kind === 'createDocument') { next = createDocument(state, text(command.name, '图文档名称', 1000), modeOf(canvasOf(state, canvasId))); createdId = Object.keys(next.documents).find(key => !state.documents[key]); }
    else if (kind === 'removeDocument') next = removeDocument(state, canvasId, text(command.id, '图文档'));
    else if (kind === 'saveCanvas') {
      const canvas = canvasOf(state, canvasId), name = text(command.name, '画布名称', 1000).trim(); requireValue(name, '名称不能为空');
      const saved = { ...canvas, canvasName: name, isDraft: false, updatedAt: now() };
      const canvases = state.canvases.map(c => c.canvasId === canvasId ? saved : c);
      if (canvas.isDraft) canvases.push(emptyCanvas(graphIdAllocator({ ...state, canvases })('draft:'), '临时画布', true));
      next = { ...state, canvases }; createdId = canvasId;
    } else if (kind === 'clearCanvas') {
      const source = canvasOf(state, canvasId); const nodes = { ...state.nodes };
      const others = structuredClone(state.canvases.filter(c => c.canvasId !== canvasId));
      const ownerNodes = new Set(canvasDirectories(source).flatMap(d => d.childIds).filter(ref => state.nodes[ref] && !source.nodeReferenceIds?.includes(ref)));
      for (const ref of ownerNodes) {
        const retained = others.find(c => c.nodeReferenceIds?.includes(ref));
        if (retained) retained.nodeReferenceIds = retained.nodeReferenceIds!.filter(node => node !== ref); else delete nodes[ref];
      }
      next = pruneInvalidEdges({ ...state, nodes, canvases: [...others, emptyCanvas(canvasId, source.canvasName, source.isDraft, modeOf(source))] });
    } else throw new DomainError('未开放的图操作', 'UNSUPPORTED_COMMAND');
    next = compactEdges(commitStructure(next, state));
    if (kind === 'moveBlock') next = recordPlacementIntent(next, canvasId, String(command.parentId), String(command.id), actor, Date.now());
    return { state: next, id: createdId, cleanedEdges: state.edges.length - next.edges.length };
  }); } catch (cause) {
    if (cause instanceof StructureConfirmationRequired && actor === 'ai')
      throw new DomainError(AI_STRUCTURE_BOUNDARY_MESSAGE, 'AI_STRUCTURE_BOUNDARY');
    if (cause instanceof DomainError || cause instanceof StructureConfirmationRequired) throw cause;
    // Existing v3 commands use plain Error for user-correctable tree rules.
    // Planning is pure, so preserve those messages as a rejected user action.
    if (cause instanceof Error && cause.constructor === Error) throw new DomainError(cause.message, 'STRUCTURE_INVALID', 400);
    throw cause;
  }
}
/** Keep structure only; backgrounds belong to global personalization settings. */
const canvasKeys = ['canvasId', 'canvasName', 'updatedAt', 'childIds', 'directories', 'placements', 'collapsed',
  'excludedDocumentIds', 'nodeReferenceIds', 'isDraft', 'mode'];
export function compactCanvasPresentation(state: GraphState): GraphState {
  let changed = false;
  const canvases = state.canvases.map(canvas => {
    if (Object.keys(canvas).every(key => canvasKeys.includes(key))) return canvas;
    changed = true;
    return Object.fromEntries(Object.entries(canvas).filter(([key]) => canvasKeys.includes(key))) as unknown as CanvasRecord;
  });
  return changed ? { ...state, canvases } : state;
}
function normalizeCanvases(state: GraphState): GraphState {
  return compactCanvasPresentation(state);
}
/** An edge stores what it means (who relates to whom, how, and in which style).
 *  Retired fields — the old manual source/target anchors — are dropped here at
 *  the single ingestion boundary instead of lingering in stored JSON. */
const edgeKeys = ['edgeId', 'edgeContent', 'directed', 'sourceNodeId', 'targetNodeId', 'routeStyle', 'removed', 'membershipFor'];
export function compactEdges<T extends { edges: GraphEdge[] }>(graph: T): T {
  let changed = false;
  const edges = graph.edges.map(edge => {
    const record = edge as unknown as Record<string, unknown>;
    if (!Object.keys(record).some(key => !edgeKeys.includes(key))) return edge;
    changed = true;
    const kept: Record<string, unknown> = {};
    for (const key of edgeKeys) if (key in record) kept[key] = record[key];
    return kept as unknown as GraphEdge;
  });
  return changed ? { ...graph, edges } : graph;
}
export function normalizedGraph(state: GraphState, previous?: GraphState): GraphState {
  const next = compactEdges(normalizeCanvases(normalizeRegionLayout(migrateProposalEvaluations(state), previous)));
  validateStructure(next); validateRegionLayout(next); return next;
}
function collectionsOf(state: GraphState) {
  return { nodes: state.nodes, documents: state.documents, canvases: Object.fromEntries(state.canvases.map(c => [c.canvasId, c])), edges: Object.fromEntries(state.edges.map(e => [e.edgeId, e])) };
}
export function graphDiff(before: GraphState, after: GraphState): GraphPatch[] {
  const a = collectionsOf(before), b = collectionsOf(after), patches: GraphPatch[] = [];
  for (const collection of ['nodes', 'documents', 'canvases', 'edges'] as const) for (const ref of new Set([...Object.keys(a[collection]), ...Object.keys(b[collection])])) {
    const old = a[collection][ref] ?? null, next = b[collection][ref] ?? null;
    if (hash(old) !== hash(next)) patches.push({ collection, id: ref, before: old, after: next });
  }
  return patches;
}
export function applyPatches(current: GraphState, patches: GraphPatch[], reverse = false): GraphState {
  const next = structuredClone(current), collections = collectionsOf(next);
  for (const patch of patches) {
    const before = patchValue(patch.collection, reverse ? patch.after : patch.before) as Record<string, unknown> | null;
    const after = patchValue(patch.collection, reverse ? patch.before : patch.after) as Record<string, unknown> | null;
    const values = collections[patch.collection] as Record<string, unknown>;
    const existing = values[patch.id] as Record<string, unknown> | undefined;
    if (!before && after) requireValue(!entity(current, patch.id), '新对象 ID 已被占用，请重新规划', 'ID_CONFLICT');
    if (!after) delete values[patch.id];
    else if (!before || !existing) values[patch.id] = structuredClone(after);
    else {
      values[patch.id] = applyObjectDelta(existing, before, after);
    }
  }
  next.canvases = Object.values(collections.canvases); next.edges = Object.values(collections.edges);
  return normalizedGraph(next);
}
/** Old patch values must be compared/applied in the same representation as the live graph. */
export function patchValue(collection: GraphPatch['collection'], value: unknown): unknown {
  return collection === 'nodes' && value ? migrateProposalNode(value as GraphNodeRecord) : value;
}
const objectValue = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function applyObjectDelta(existing: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const updated = { ...existing };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (hash(before[key] ?? null) === hash(after[key] ?? null)) continue;
    if (!(key in after)) delete updated[key];
    else if (objectValue(before[key]) && objectValue(after[key]) && objectValue(existing[key])) updated[key] = applyObjectDelta(existing[key], before[key], after[key]);
    else updated[key] = structuredClone(after[key]);
  }
  return updated;
}
/** Check only fields written by the batch, preserving unrelated later edits. */
export function patchCanUndo(current: unknown, before: unknown, after: unknown, path: string[] = []): boolean {
  if (hash(before ?? null) === hash(after ?? null)) return true;
  if (path.at(-1) === 'updatedAt' || path.at(-1) === 'rev') return true;
  if (objectValue(before) && objectValue(after) && objectValue(current)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .every(key => patchCanUndo(current[key], before[key], after[key], [...path, key]));
  return hash(current ?? null) === hash(after ?? null);
}
export function checkAiEffects(before: GraphState, after: GraphState, canvasId: string, allowed: Set<string>) {
  requireValue(hash(before.canvases.map(canvas => canvas.canvasId)) === hash(after.canvases.map(canvas => canvas.canvasId)), 'AI不能创建、删除或替换画布和根目录', 'ROOT_READ_ONLY');
  for (const canvas of before.canvases) {
    const next = canvasOf(after, canvas.canvasId), root = canvasDirectory(canvas, canvas.canvasId), nextRoot = canvasDirectory(next, next.canvasId);
    requireValue(nextRoot && modeOf(canvas) === modeOf(next) && canvas.canvasName === next.canvasName && hash({ ...root, childIds: [] }) === hash({ ...nextRoot, childIds: [] }), 'AI不能改名、删除、改变模式或改写画布根目录', 'ROOT_READ_ONLY');
  }
  const a = new Set(Object.values(before.documents).filter(doc => doc.kind === 'document').map(doc => doc.documentId));
  assertAiStructureBoundary(before, after);
  for (const canvas of before.canvases) {
    const oldMembers = memberIds(before, canvas.canvasId), newMembers = memberIds(after, canvas.canvasId);
    for (const ref of a) requireValue(oldMembers.has(ref) === newMembers.has(ref), '图文档引入或移出画布仅由用户执行', 'USER_ONLY_MANAGEMENT');
  }
  const oldMembers = memberIds(before, canvasId), newMembers = memberIds(after, canvasId);
  for (const patch of graphDiff(before, after)) {
    if (patch.collection === 'edges') {
      for (const edge of [patch.before, patch.after]) if (edge) {
        const value = edge as { sourceNodeId: string; targetNodeId: string };
        assertAiObjectRefs(before, [value.sourceNodeId, value.targetNodeId]);
      }
    }
    if (patch.collection === 'canvases') {
      // Other canvases may only change through canonical shared projection updates.
      requireValue(patch.id === canvasId || hash([(patch.before as CanvasRecord).childIds, (patch.before as CanvasRecord).directories]) === hash([(patch.after as CanvasRecord).childIds, (patch.after as CanvasRecord).directories]), '不能改变其他画布组织', 'OUT_OF_SCOPE');
      continue;
    }
    if (patch.before === null) requireValue(newMembers.has(patch.id), '新增内容必须留在当前画布', 'OUT_OF_SCOPE');
    else requireValue(allowed.has(patch.id), '修改超出当前画布范围', 'OUT_OF_SCOPE');
  }
  for (const ref of newMembers) if (!oldMembers.has(ref) && entity(before, ref)) requireValue(allowed.has(ref), '不能通过移动引入原范围外的数据', 'OUT_OF_SCOPE');
}
