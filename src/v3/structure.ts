import { canvasDirectories, canvasDirectory, canvasDirectoryEntries } from './canvas';
import { graphIdAllocator } from './ids';
import { buildRenderModel, findFreeDocumentPlacement } from './layout';
import { commitStructure, prepareDocumentAddition, pruneInvalidEdges, removeDocument } from './storage';
import { documentParents, getDocumentTree, structureRevision, type DocumentTree } from './documentTrees';
import { copyAsSubgraph } from './snapshots';
import type { CanvasRecord, GraphRecord, GraphState, Placement, Point } from './types';
import { RECORD_HEADER_HEIGHT, RECORD_PADDING } from './types';
import { getCanvasPaths, type GraphPath } from './paths';
import { reconcileCanvasReferences } from './canvasProjection';
import { designData, modeOf } from './design';
import type { DesignNodeData } from './types';

export type TransferChoice = 'cut' | 'copy-target' | 'copy-source';
export interface StructureResolution { revision: string; choices: Record<string, TransferChoice> }
export interface StructureConflict { id: string; name: string; sourceTree: string; targetTree: string; sourceParent: string; outsideCanvas: boolean }
export class StructureConfirmationRequired extends Error {
  constructor(public conflicts: StructureConflict[], public revision: string) {
    super('非根图文档分支将跨目录树移动，请选择剪切或独立复制方案');
  }
}
export type StructureCommand = (
  | { type: 'createNode'; parentId: string; name: string; content: string; design?: DesignNodeData; point?: Point }
  | { type: 'createSubgraph'; parentId: string; name: string; content: string; ids?: string[]; point?: Point }
  | { type: 'move' | 'moveCanvasItems' | 'reparentContent'; ids: string[]; parentId: string }
  | { type: 'deleteNode'; id: string }
  | { type: 'deleteEdge'; id: string }
  | { type: 'deleteSubgraph'; id: string; mode: 'cascade' | 'promote' }
  | { type: 'deleteDocument'; id: string; mode: 'detach' | 'promote' }
  | { type: 'replaceDocument'; id: string }
  | { type: 'registerDocument'; id: string }
  | { type: 'importDocument'; id: string; mode: 'reference' | 'snapshot'; point?: Point }
  | { type: 'cleanupEdges' }) & { resolution?: StructureResolution };
export interface StructureResult { state: GraphState; id?: string; cleanedEdges: number; identityMap?: Record<string, string> }
export type PathOption = GraphPath;

export function getStructurePaths(state: GraphState, canvas: CanvasRecord): PathOption[] {
  return getCanvasPaths(state, canvas);
}

export function normalizeStructureSelection(state: GraphState, canvas: CanvasRecord, ids: string[]): string[] {
  const paths = getStructurePaths(state, canvas); const parents = new Map(paths.map((item) => [item.id, item.parentId]));
  const chosen = new Set(ids);
  return [...chosen].filter((id) => {
    const item = paths.find((row) => row.id === id);
    if (!item || item.kind === 'root') throw new Error('请选择节点、子图或图文档，画布根不能移动');
    let parent = parents.get(id); while (parent) { if (chosen.has(parent)) return false; parent = parents.get(parent); }
    return true;
  });
}

export function getMoveTargets(state: GraphState, canvas: CanvasRecord, ids: string[]): PathOption[] {
  const paths = getStructurePaths(state, canvas); const parents = new Map(paths.map((item) => [item.id, item.parentId]));
  const selected = new Set(ids);
  const originalParents = documentParents(state);
  const carriedRecords = new Set<string>();
  const hasDocument = (id: string): boolean => state.documents[id]?.kind === 'document' ||
    (canvasDirectory(canvas, id)?.childIds ?? state.documents[id]?.childDocumentIds ?? []).some(hasDocument);
  const carriesDocument = modeOf(canvas) === 'design' && ids.some(hasDocument);
  const collect = (id: string) => {
    if (state.documents[id]) { carriedRecords.add(id); return; }
    canvasDirectory(canvas, id)?.childIds.forEach(collect);
  };
  ids.forEach(collect);
  return paths.filter((item) => {
    if (item.kind === 'node') return false;
    if (carriesDocument) {
      let ancestor: string | undefined = item.id;
      while (ancestor) { if (state.documents[ancestor]?.kind === 'document') return false; ancestor = originalParents.get(ancestor); }
    }
    let id: string | undefined = item.id;
    while (id) { if (selected.has(id)) return false; id = parents.get(id); }
    id = item.id;
    while (id) { if (carriedRecords.has(id)) return false; id = originalParents.get(id); }
    return true;
  });
}

export function ownershipNotice(state: GraphState, canvas: CanvasRecord, ids: string[], parentId: string): string | null {
  if (!canvasDirectory(canvas, parentId)) return null;
  let count = 0;
  const documentNodes = new Set(Object.values(state.documents).flatMap((record) => record.childNodeIds));
  const visit = (id: string) => {
    if (state.nodes[id]) { if (documentNodes.has(id)) count++; return; }
    const record = state.documents[id]; if (record?.kind === 'document') return;
    (canvasDirectory(canvas, id)?.childIds ?? (record ? [...record.childNodeIds, ...record.childDocumentIds] : [])).forEach(visit);
  };
  const parents = new Map(getStructurePaths(state, canvas).map(row => [row.id, row.parentId]));
  normalizeStructureSelection(state, canvas, ids).filter(id => !canvasDirectory(canvas, parents.get(id) ?? '')).forEach(visit);
  return count ? `${count} 个节点将从图文档归属转为当前画布局部节点。其他引用原图文档的画布将不再包含这些节点；节点和关系数据会保留。` : null;
}

export function applyStructureCommand(state: GraphState, canvasId: string, command: StructureCommand): StructureResult {
  const source = state.canvases.find((item) => item.canvasId === canvasId); if (!source) throw new Error('画布不存在');
  if (command.type === 'importDocument' && state.documents[command.id] && modeOf(source) !== modeOf(state.documents[command.id])) throw new Error('探索与设计图文档不能互相引入');
  if (command.type === 'deleteEdge' && state.edges.find(edge => edge.edgeId === command.id)?.membershipFor) throw new Error('请在组合详情中移除成员方案');
  const revision = structureRevision(state);
  if (command.resolution && command.resolution.revision !== revision) throw new Error('目录结构已变化，请重新发起操作并确认');
  if (command.type === 'importDocument' && command.mode === 'reference') {
    return { state: commitStructure(prepareDocumentAddition(state, canvasId, command.id, command.point), state), id: command.id, cleanedEdges: 0 };
  }
  if (command.type === 'deleteDocument' && command.mode === 'detach') {
    if (state.documents[command.id]?.kind !== 'document') throw new Error('图文档不存在');
    return { state: removeDocument(state, canvasId, command.id), cleanedEdges: 0 };
  }
  if (command.type === 'replaceDocument') return replaceDocumentWithDirectory(state, source, command.id);
  const natural = buildRenderModel(state, source, { zoom: 1, ignoreCollapse: true, skipEdges: true });
  const world = new Map(natural.blocks.map((block) => [block.id, block.anchor]));
  const next: GraphState = JSON.parse(JSON.stringify(state));
  const canvas = next.canvases.find((item) => item.canvasId === canvasId)!;
  const now = new Date().toISOString();
  const pathRows = getStructurePaths(state, source);
  const parents = new Map(pathRows.map((item) => [item.id, item.parentId]));
  const originalParents = documentParents(state); const conflicts = new Map<string, StructureConflict>();
  const getChildren = (id: string) => canvasDirectory(canvas, id)?.childIds ??
    (next.documents[id] ? [...next.documents[id].childDocumentIds, ...next.documents[id].childNodeIds] : []);
  const touch = (record: GraphRecord) => { record.rev++; record.metadata.updatedAt = now; };
  const containsDocument = (id: string): boolean => state.documents[id]?.kind === 'document' ||
    Boolean(state.documents[id]?.childDocumentIds.some(containsDocument));
  const transfer = (id: string, targetTree?: DocumentTree): string => {
    const originalParent = originalParents.get(id);
    if (!targetTree || !originalParent || !containsDocument(id)) return id;
    const sourceTree = getDocumentTree(state, id);
    if (sourceTree.rootId === id || sourceTree.rootId === targetTree.rootId) return id;
    conflicts.set(id, { id, name: state.documents[id].name, sourceTree: sourceTree.name, targetTree: targetTree.name,
      sourceParent: state.documents[originalParent].name, outsideCanvas: !pathRows.some((row) => row.id === originalParent) });
    const choice = command.resolution?.choices[id];
    if (choice && !['cut', 'copy-target', 'copy-source'].includes(choice)) throw new Error('无效的目录树处理方案');
    if (choice === 'copy-target') return copyAsSubgraph(next, canvas, id);
    if (choice === 'copy-source') {
      const copyId = copyAsSubgraph(next, canvas, id); const parent = next.documents[originalParent];
      parent.childDocumentIds.push(copyId); parent.placements[copyId] = { ...(parent.placements[id] ?? { x: 0, y: 0, source: 'auto' }) }; touch(parent);
    }
    return id;
  };
  const detachEverywhere = (id: string) => {
    for (const record of Object.values(next.documents)) {
      if (!record.childNodeIds.includes(id) && !record.childDocumentIds.includes(id)) continue;
      record.childNodeIds = record.childNodeIds.filter((child) => child !== id);
      record.childDocumentIds = record.childDocumentIds.filter((child) => child !== id); delete record.placements[id]; touch(record);
    }
    for (const item of next.canvases) for (const directory of canvasDirectories(item)) {
      if (!directory.childIds.includes(id)) continue;
      directory.childIds = directory.childIds.filter((child) => child !== id); delete item.placements[id]; item.updatedAt = now;
    }
    for (const item of next.canvases) if (item.nodeReferenceIds) item.nodeReferenceIds = item.nodeReferenceIds.filter((child) => child !== id);
  };
  const detachDocumentParent = (id: string) => {
    for (const record of Object.values(next.documents)) {
      if (!record.childDocumentIds.includes(id)) continue;
      record.childDocumentIds = record.childDocumentIds.filter((child) => child !== id); delete record.placements[id]; touch(record);
    }
  };
  const detachCanvasReference = (id: string) => {
    for (const directory of canvasDirectories(canvas)) directory.childIds = directory.childIds.filter((child) => child !== id);
    delete canvas.placements[id];
  };
  const origin = (id: string): Point => {
    if (id === canvas.canvasId) return { x: 0, y: 0 };
    const anchor = world.get(id); if (!anchor) throw new Error('目标目录不在当前画布');
    return { x: anchor.x + RECORD_PADDING, y: anchor.y + RECORD_HEADER_HEIGHT + RECORD_PADDING };
  };
  const checkParent = (id: string) => {
    if (!pathRows.some((item) => item.id === id && item.kind !== 'node')) throw new Error('请选择当前画布中的有效目录');
  };
  const attach = (id: string, parentId: string, anchor: Point) => {
    const base = origin(parentId); const placement: Placement = { x: anchor.x - base.x, y: anchor.y - base.y, source: 'auto' };
    const parent = next.documents[parentId];
    if (parent) {
      (next.nodes[id] ? parent.childNodeIds : parent.childDocumentIds).push(id); parent.placements[id] = placement; touch(parent);
    } else {
      canvasDirectory(canvas, parentId).childIds.push(id); canvas.placements[id] = placement;
    }
  };
  const convert = (id: string, toCanvas: boolean, targetTree?: DocumentTree) => {
    if (next.nodes[id]) return;
    const record = next.documents[id]; const directory = canvasDirectory(canvas, id);
    if (toCanvas && record?.kind === 'subgraph') {
      const children = [...record.childDocumentIds, ...record.childNodeIds];
      canvas.directories[id] = { name: record.name, description: record.metadata.description, childIds: children };
      children.forEach((child) => { canvas.placements[child] = record.placements[child] ?? { x: 0, y: 0, source: 'auto' }; });
      delete next.documents[id];
      for (const item of next.canvases) if (item.canvasId !== canvasId) for (const dir of canvasDirectories(item)) {
        dir.childIds = dir.childIds.filter((child) => child !== id); delete item.placements[id]; delete item.collapsed[id];
      }
      children.forEach((child) => convert(child, true));
    } else if (!toCanvas && directory) {
      const originals = [...directory.childIds];
      const children = originals.map((child) => next.documents[child] ? transfer(child, targetTree) : child);
      const placements = Object.fromEntries(originals.map((child, index) => [children[index], canvas.placements[child] ?? { x: 0, y: 0, source: 'auto' }]));
      // A promoted node can be a reference here. Registration/moving into a
      // document transfers its actual ownership once while retaining other views.
      for (const child of originals.filter((child) => next.nodes[child] && canvas.nodeReferenceIds?.includes(child))) {
        for (const owner of Object.values(next.documents)) if (owner.childNodeIds.includes(child)) {
          owner.childNodeIds = owner.childNodeIds.filter((id) => id !== child); delete owner.placements[child]; touch(owner);
        }
        for (const view of next.canvases) if (!view.nodeReferenceIds?.includes(child)) for (const folder of canvasDirectories(view)) {
          if (!folder.childIds.includes(child)) continue;
          folder.childIds = folder.childIds.filter((id) => id !== child); delete view.placements[child]; view.updatedAt = now;
        }
      }
      // A document child was a reference in the canvas. Reparent its original
      // record once when it becomes a child of a document-owned subgraph.
      children.filter((child) => Boolean(next.documents[child])).forEach(detachDocumentParent);
      next.documents[id] = { documentId: id, kind: 'subgraph', mode: modeOf(canvas), name: directory.name,
        childNodeIds: children.filter((child) => Boolean(next.nodes[child])), childDocumentIds: children.filter((child) => !next.nodes[child]),
        placements, rev: 1,
        metadata: { createdAt: now, updatedAt: now, version: '3.0', description: directory.description } };
      delete canvas.directories[id]; originals.forEach((child) => { delete canvas.placements[child]; }); children.forEach((child) => convert(child, false, targetTree));
    }
  };
  const relocate = (id: string, parentId: string, anchor: Point) => {
    // Moving an existing canvas entry is a view operation, even when the entry
    // is a promoted shared node or an original ordinary subgraph.
    if (canvasDirectory(canvas, parentId) && canvasDirectory(source, parents.get(id) ?? '')) {
      detachCanvasReference(id); attach(id, parentId, anchor); return;
    }
    const parentTree = next.documents[parentId] ? getDocumentTree(next, parentId) : undefined;
    const targetTree = parentTree && next.documents[parentTree.rootId]?.kind === 'document' ? parentTree : undefined;
    const movedId = transfer(id, targetTree);
    if (movedId !== id) {
      const pos = findFreeDocumentPlacement(next, canvas, parentId, movedId); const base = origin(parentId);
      attach(movedId, parentId, { x: base.x + pos.x, y: base.y + pos.y }); return;
    }
    if (next.documents[id]?.kind === 'document') {
      // Canvas entries are references. Reparenting the original document must
      // preserve independent references in other canvases.
      if (next.documents[parentId] || state.documents[parents.get(id) ?? '']) detachDocumentParent(id);
      detachCanvasReference(id);
    } else detachEverywhere(id);
    convert(id, Boolean(canvasDirectory(canvas, parentId)), targetTree); attach(id, parentId, anchor);
  };
  const move = (ids: string[], parentId: string) => {
    checkParent(parentId);
    if (!getMoveTargets(state, source, ids).some((item) => item.id === parentId)) throw new Error('不能移入自身或后代');
    for (const id of normalizeStructureSelection(state, source, ids)) {
      const anchor = world.get(id); if (!anchor) throw new Error('移动对象不存在');
      if (parents.get(id) === parentId) continue;
      relocate(id, parentId, anchor);
    }
  };
  // The shared region allocator handles full footprints at commit time.
  const freeAnchor = (parentId: string, preferred?: Point): Point => preferred ?? origin(parentId);
  const remove = (id: string, cascade: boolean) => {
    const children = [...getChildren(id)];
    if (cascade) children.forEach((child) => {
      // Canvas folders own local nodes/folders and reference whole documents.
      if (next.documents[child]?.kind === 'document') return;
      if (canvasDirectory(canvas, id) && canvas.nodeReferenceIds?.includes(child)) return;
      remove(child, true);
    });
    detachEverywhere(id); delete next.nodes[id]; delete next.documents[id];
    for (const item of next.canvases) { delete item.directories[id]; delete item.placements[id]; delete item.collapsed[id]; }
  };
  let createdId: string | undefined;
  if (command.type === 'importDocument') {
    if (state.documents[command.id]?.kind !== 'document') throw new Error('图文档不存在');
    createdId = copyAsSubgraph(next, canvas, command.id, canvas);
    // Measure the whole copied branch, including folded content, before assigning space.
    const position = findFreeDocumentPlacement(next, canvas, canvas.canvasId, createdId, command.point);
    canvasDirectory(canvas, canvas.canvasId).childIds.push(createdId); canvas.placements[createdId] = position;
  } else if (command.type === 'registerDocument') {
    if (!pathRows.some((row) => row.id === command.id && row.kind === 'subgraph')) throw new Error('只能将普通子图注册为图文档');
    if (canvasDirectory(canvas, command.id)) {
      const tree = { rootId: command.id, name: `${canvasDirectory(canvas, command.id).name}目录树` };
      const position = canvas.placements[command.id];
      convert(command.id, false, tree);
      if (position) canvas.placements[command.id] = position;
    }
    next.documents[command.id].kind = 'document'; touch(next.documents[command.id]); createdId = command.id;
  } else if (command.type === 'createNode' || command.type === 'createSubgraph') {
    checkParent(command.parentId); if (!command.name.trim()) throw new Error('名称不能为空');
    createdId = graphIdAllocator(next)(command.type === 'createSubgraph' && canvasDirectory(canvas, command.parentId) ? `canvas-dir:${canvasId}:` : '');
    if (command.type === 'createNode') {
      if (modeOf(canvas) !== 'design' && command.design !== undefined) throw new Error('探索画布不使用设计节点类型');
      const design = modeOf(canvas) === 'design' ? designData(command.design ?? { type: 'general' }) : undefined;
      if (design && [...(design.memberIds ?? []), ...(design.subjectIds ?? [])].some(id => !pathRows.some(row => row.id === id))) throw new Error('只能关联当前画布中的方案或组合');
      next.nodes[createdId] = { nodeId: createdId, name: command.name.trim(), content: command.content,
        ...(design ? { design } : {}) };
      attach(createdId, command.parentId, freeAnchor(command.parentId, command.point));
    } else {
      const ids = normalizeStructureSelection(state, source, command.ids ?? []);
      if (!getMoveTargets(state, source, ids).some((item) => item.id === command.parentId)) throw new Error('不能在选中对象内部创建分组');
      const anchors = ids.map((id) => world.get(id)!);
      const anchor = anchors.length ? { x: Math.min(...anchors.map((point) => point.x)) - RECORD_PADDING,
        y: Math.min(...anchors.map((point) => point.y)) - RECORD_HEADER_HEIGHT - RECORD_PADDING } : freeAnchor(command.parentId, command.point);
      world.set(createdId, anchor);
      if (canvasDirectory(canvas, command.parentId)) canvas.directories[createdId] = { name: command.name.trim(), description: command.content, childIds: [] };
      else next.documents[createdId] = { documentId: createdId, kind: 'subgraph', mode: modeOf(canvas), name: command.name.trim(), childNodeIds: [], childDocumentIds: [], placements: {}, rev: 1,
        metadata: { createdAt: now, updatedAt: now, version: '3.0', description: command.content } };
      attach(createdId, command.parentId, anchor);
      for (const id of ids) relocate(id, createdId, world.get(id)!);
    }
  } else if (command.type === 'move' || command.type === 'moveCanvasItems' || command.type === 'reparentContent') {
    const selected = normalizeStructureSelection(state, source, command.ids);
    const viewOnly = (id: string) => Boolean(canvasDirectory(source, command.parentId) && canvasDirectory(source, parents.get(id) ?? ''));
    if (command.type === 'moveCanvasItems' && selected.some(id => !viewOnly(id))) throw new Error('调整画布展示只能在画布目录之间移动现有入口；移动原始内容请使用 reparentContent');
    if (command.type === 'reparentContent' && selected.some(viewOnly)) throw new Error('这次操作只改变画布展示位置，请使用 moveCanvasItems');
    move(selected, command.parentId);
  }
  else if (command.type === 'deleteEdge') next.edges = next.edges.filter((edge) => edge.edgeId !== command.id);
  else if (command.type === 'deleteNode') {
    if (!natural.membership.has(command.id) || !next.nodes[command.id]) throw new Error('节点不存在');
    remove(command.id, true);
  } else if (command.type === 'deleteSubgraph') {
    if (!pathRows.some((item) => item.id === command.id && item.kind === 'subgraph')) throw new Error('只能删除子图，不能删除画布根或图文档');
    if (command.mode === 'promote') {
      const parentId = parents.get(command.id)!;
      const children = [...getChildren(command.id)];
      for (const child of children) {
        const pos = next.documents[command.id]?.placements[child] ?? canvas.placements[child] ?? { x: 0, y: 0 };
        const base = world.get(command.id)!;
        const anchor = world.get(child) ?? { x: base.x + RECORD_PADDING + pos.x, y: base.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + pos.y };
        world.set(child, anchor); relocate(child, parentId, anchor);
      }
      remove(command.id, false);
    } else remove(command.id, true);
  } else if (command.type === 'deleteDocument') {
    if (!pathRows.some((row) => row.id === command.id && row.kind === 'document')) throw new Error('图文档不在当前画布');
    const displayParent = parents.get(command.id)!;
    // Migrate identities once. Other canvases retain references, never duplicate originals.
    const originalParent = originalParents.get(command.id);
    const destination = originalParent ?? displayParent;
    const children = [...getChildren(command.id)];
    const docAnchor = world.get(command.id)!;
    const childAnchors = new Map(children.map((child) => { const pos = state.documents[command.id].placements[child] ?? { x: 0, y: 0 };
      return [child, world.get(child) ?? { x: docAnchor.x + RECORD_PADDING + pos.x, y: docAnchor.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + pos.y }]; }));
    const entryLocations = next.canvases.flatMap((item) => canvasDirectoryEntries(item).filter(([, directory]) => directory.childIds.includes(command.id))
      .map(([directoryId]) => ({ canvas: item, directoryId, base: { ...(item.placements[command.id] ?? { x: 0, y: 0, source: 'auto' as const }) } })));
    for (const child of children) {
      if (originalParent) {
        const base = next.documents[originalParent].placements[command.id] ?? { x: 0, y: 0, source: 'auto' as const };
        const local = next.documents[command.id].placements[child] ?? { x: 0, y: 0, source: 'auto' as const };
        if (next.nodes[child]) detachEverywhere(child); else detachDocumentParent(child);
        const parent = next.documents[originalParent];
        (next.nodes[child] ? parent.childNodeIds : parent.childDocumentIds).push(child);
        parent.placements[child] = { x: base.x + RECORD_PADDING + local.x, y: base.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + local.y, source: 'auto' }; touch(parent);
      } else {
        if (next.nodes[child]) detachEverywhere(child); else detachDocumentParent(child);
        attach(child, destination, childAnchors.get(child)!);
      }
    }
    for (const entry of entryLocations) {
      const other = entry.canvas; const directory = canvasDirectory(other, entry.directoryId);
      directory.childIds = [...new Set(directory.childIds.flatMap((id) => id === command.id ? children : [id]))];
      children.forEach((child) => { const pos = state.documents[command.id].placements[child] ?? { x: 0, y: 0 };
        other.placements[child] = { x: entry.base.x + RECORD_PADDING + pos.x, y: entry.base.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + pos.y, source: 'auto' };
        if (next.nodes[child] && (originalParent || other.canvasId !== canvasId)) other.nodeReferenceIds = [...new Set([...(other.nodeReferenceIds ?? []), child])]; });
    }
    remove(command.id, false);
  }
  if (conflicts.size && [...conflicts.keys()].some((id) => !command.resolution?.choices[id])) throw new StructureConfirmationRequired([...conflicts.values()], revision);
  canvas.updatedAt = now;
  // Excluded branches do not make a separate visible entry redundant.
  next.canvases = next.canvases.map(item => reconcileCanvasReferences(next, item));
  for (const item of next.canvases) {
    if (item.excludedDocumentIds) item.excludedDocumentIds = item.excludedDocumentIds.filter((id) => Boolean(next.documents[id]));
    if (item.nodeReferenceIds) {
      const localIds = new Set(canvasDirectories(item).flatMap((directory) => directory.childIds));
      item.nodeReferenceIds = item.nodeReferenceIds.filter((id) => localIds.has(id) && Boolean(next.nodes[id]));
    }
    const members = new Set(getStructurePaths(next, item).map((row) => row.id));
    Object.keys(item.placements).forEach((id) => { if (!members.has(id)) delete item.placements[id]; });
    Object.keys(item.collapsed).forEach((id) => { if (!members.has(id)) delete item.collapsed[id]; });
  }
  const cleaned = pruneInvalidEdges(next);
  return { state: commitStructure(cleaned, state), id: createdId, cleanedEdges: next.edges.length - cleaned.edges.length };
}

/** Detach only this canvas's projection and replace it with an independent local branch. */
function replaceDocumentWithDirectory(state: GraphState, source: CanvasRecord, documentId: string): StructureResult {
  const rows = getStructurePaths(state, source), row = rows.find(row => row.id === documentId);
  if (row?.kind !== 'document' || state.documents[documentId]?.kind !== 'document') throw new Error('图文档不在当前画布');
  const next = structuredClone(state), canvas = next.canvases.find(c => c.canvasId === source.canvasId)!;
  const mapping = new Map<string, string>();
  const fresh = copyAsSubgraph(next, canvas, documentId, canvas, mapping);
  const localParent = row.parentId && canvasDirectory(canvas, row.parentId);
  if (localParent) {
    localParent.childIds = localParent.childIds.map(id => id === documentId ? fresh : id);
    canvas.placements[fresh] = { ...(source.placements[documentId] ?? { x: 0, y: 0, source: 'auto' as const }) };
  } else {
    // A canvas-local folder cannot belong to a shared document. Keep the source tree
    // untouched, hide its nested projection here, and place the copy at the canvas root.
    canvas.excludedDocumentIds = [...new Set([...(canvas.excludedDocumentIds ?? []), documentId])];
    canvas.childIds.push(fresh);
    const anchor = buildRenderModel(state, source, { zoom: 1, ignoreCollapse: true, skipEdges: true }).blocks.find(b => b.id === documentId)?.anchor;
    canvas.placements[fresh] = { x: anchor?.x ?? 0, y: anchor?.y ?? 0, source: 'auto' };
  }
  for (const [oldId, newId] of mapping) if (source.collapsed[oldId]) canvas.collapsed[newId] = true;
  delete canvas.placements[documentId]; delete canvas.collapsed[documentId];
  canvas.updatedAt = new Date().toISOString();
  return { state: commitStructure(next, state), id: fresh, identityMap: Object.fromEntries(mapping), cleanedEdges: 0 };
}
