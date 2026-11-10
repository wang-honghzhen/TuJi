import { canvasDirectories, canvasDirectoryEntries } from './canvas';
import type { CanvasRecord, GraphState } from './types';

export interface DocumentProjection { records: Set<string>; nodes: Set<string> }
export function documentProjection(state: GraphState, id: string, excluded: ReadonlySet<string>): DocumentProjection {
  const records = new Set<string>(); const nodes = new Set<string>(); const visiting = new Set<string>();
  const visit = (key: string) => {
    if (excluded.has(key) || !state.documents[key]) return;
    if (visiting.has(key)) throw new Error('图文档目录不能成环');
    if (records.has(key)) return;
    visiting.add(key); records.add(key);
    state.documents[key].childNodeIds.forEach(node => nodes.add(node));
    state.documents[key].childDocumentIds.forEach(visit); visiting.delete(key);
  };
  visit(id); return { records, nodes };
}

/** Only mounts actually displayed through a reachable path count as duplicates. */
export function reconcileCanvasReferences(state: GraphState, canvas: CanvasRecord): CanvasRecord {
  const excluded = new Set(canvas.excludedDocumentIds ?? []);
  const entries = canvasDirectories(canvas).flatMap(d => d.childIds).filter(id => state.documents[id] && !excluded.has(id));
  const nestedRecords = new Set<string>(); const nestedNodes = new Set<string>();
  for (const id of entries) {
    const projection = documentProjection(state, id, excluded);
    projection.records.forEach(child => { if (child !== id) nestedRecords.add(child); });
    projection.nodes.forEach(child => nestedNodes.add(child));
  }
  const refs = new Set(canvas.nodeReferenceIds ?? []);
  const removed = new Set<string>(); const directories = { ...canvas.directories }; let roots = canvas.childIds;
  for (const [id, directory] of canvasDirectoryEntries(canvas)) {
    const childIds = directory.childIds.filter(child => {
      const redundant = nestedRecords.has(child) || (refs.has(child) && nestedNodes.has(child));
      if (redundant) removed.add(child); return !redundant;
    });
    if (childIds.length !== directory.childIds.length) {
      if (id === canvas.canvasId) roots = childIds; else directories[id] = { ...directory, childIds };
    }
  }
  if (!removed.size) return canvas;
  const placements = { ...canvas.placements }; removed.forEach(id => { delete placements[id]; });
  return { ...canvas, childIds: roots, directories, placements, nodeReferenceIds: canvas.nodeReferenceIds?.filter(id => !removed.has(id)) };
}

export interface DocumentImportPlan { canvas: CanvasRecord; restore: boolean; mergedNodeIds: string[] }
/** Reference imports and restoration share the same preflight. Document-entry
 * conflicts are refused; redundant node *references* can safely be absorbed. */
export function planDocumentImport(state: GraphState, canvas: CanvasRecord, id: string): DocumentImportPlan {
  if (state.documents[id]?.kind !== 'document') throw new Error('图文档不存在');
  const currentExcluded = new Set(canvas.excludedDocumentIds ?? []);
  const nextExcluded = new Set(currentExcluded); nextExcluded.delete(id);
  const entries = canvasDirectories(canvas).flatMap(d => d.childIds).filter(child => Boolean(state.documents[child]));
  const existingRecords = new Set<string>(); const existingNodes = new Set<string>();
  let restore = false;
  for (const entry of entries) {
    const projection = documentProjection(state, entry, currentExcluded);
    projection.records.forEach(child => existingRecords.add(child)); projection.nodes.forEach(child => existingNodes.add(child));
    if (currentExcluded.has(id) && documentProjection(state, entry, nextExcluded).records.has(id)) restore = true;
  }
  if (existingRecords.has(id)) throw new Error(`《${state.documents[id].name}》已在当前画布中（包括通过父级显示），无需再次引入`);
  const incoming = documentProjection(state, id, nextExcluded);
  const conflict = [...incoming.records].find(child => existingRecords.has(child));
  if (conflict) throw new Error(`无法${restore ? '恢复' : '以图文档形式引入'}《${state.documents[id].name}》：《${state.documents[conflict].name}》已在当前画布中，属于它的后代。请先移出该后代，或改为以独立子图形式引入。`);
  const localNodes = new Set(canvasDirectories(canvas).flatMap(d => d.childIds).filter(child => Boolean(state.nodes[child])));
  const refs = new Set(canvas.nodeReferenceIds ?? []); const mergedNodeIds: string[] = [];
  for (const node of incoming.nodes) {
    if (localNodes.has(node) && refs.has(node)) mergedNodeIds.push(node);
    else if (existingNodes.has(node) || localNodes.has(node)) throw new Error(`无法引入：节点“${state.nodes[node]?.name ?? node}”已在画布中，请先处理它的展示引用。`);
  }
  const merged = new Set(mergedNodeIds); const placements = { ...canvas.placements };
  merged.forEach(node => { delete placements[node]; });
  return { restore, mergedNodeIds, canvas: { ...canvas,
    childIds: canvas.childIds.filter(child => !merged.has(child)),
    excludedDocumentIds: [...nextExcluded], placements,
    directories: Object.fromEntries(Object.entries(canvas.directories).map(([key, directory]) =>
      [key, mergedNodeIds.length ? { ...directory, childIds: directory.childIds.filter(child => !merged.has(child)) } : directory])),
    nodeReferenceIds: canvas.nodeReferenceIds?.filter(node => !merged.has(node)) } };
}
