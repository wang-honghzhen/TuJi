import { graphIdAllocator, graphIdentities } from '@/v3/ids';
import { modeOf, remapDesign, designData } from '@/v3/design';
import { REGION_LAYOUT_VERSION, validateRegionLayout } from '@/v3/regionLayout';
import { validateStructure } from '@/v3/storage';
import type { GraphState, GraphRecord, GraphNodeRecord, GraphEdge, Placement, Point, Rect } from '@/v3/types';
import { requireValue } from './errors';

export const MAX_DOCUMENT_PACKAGE_BYTES = 120 * 1024 * 1024;
export interface DocumentPackage {
  format: 'qixue-document'; version: 1; exportedAt: string; rootDocumentId: string; layoutVersion: number;
  documents: GraphRecord[]; nodes: GraphNodeRecord[]; edges: GraphEdge[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function row(value: unknown, label: string): Record<string, unknown> {
  requireValue(object(value), `${label}格式无效`); return value;
}
function string(value: unknown, label: string): string {
  requireValue(typeof value === 'string', `${label}必须是文字`); return value;
}
function identity(value: unknown): string {
  const result = string(value, '对象 ID');
  requireValue(!!result && result.length < 1000 && !['__proto__', 'constructor', 'prototype'].includes(result), '对象 ID 无效'); return result;
}
function ids(value: unknown): string[] {
  requireValue(Array.isArray(value), '成员列表格式无效');
  const result = value.map(identity); requireValue(new Set(result).size === result.length, '成员列表包含重复对象'); return result;
}
function point(value: unknown): Point {
  const data = row(value, '位置'); requireValue(Number.isFinite(data.x) && Number.isFinite(data.y), '对象坐标无效');
  return { x: data.x as number, y: data.y as number };
}
function rect(value: unknown): Rect {
  const data = row(value, '区域'), position = point(value);
  requireValue(Number.isFinite(data.width) && Number.isFinite(data.height) && Number(data.width) >= 0 && Number(data.height) >= 0, '区域尺寸无效');
  return { ...position, width: data.width as number, height: data.height as number };
}
function placement(value: unknown): Placement {
  const data = row(value, '布局'); requireValue(data.source === 'auto' || data.source === 'manual', '布局来源无效');
  const result: Placement = { ...point(data), source: data.source };
  if (data.manualAnchor !== undefined) result.manualAnchor = point(data.manualAnchor);
  if (data.lastManualAt !== undefined) { requireValue(Number.isFinite(data.lastManualAt), '布局时间无效'); result.lastManualAt = data.lastManualAt as number; }
  if (data.overlapAllowances !== undefined) {
    requireValue(Array.isArray(data.overlapAllowances), '布局重叠记录无效');
    result.overlapAllowances = data.overlapAllowances.map(value => { const item = row(value, '布局重叠记录');
      return { parentId: identity(item.parentId), otherId: identity(item.otherId), self: rect(item.self), other: rect(item.other) }; });
  }
  return result;
}
function document(value: unknown): GraphRecord {
  const data = row(value, '图文档'), metadata = row(data.metadata, '图文档信息');
  requireValue(data.kind === 'document' || data.kind === 'subgraph', '图文档类型无效');
  requireValue(data.mode === undefined || data.mode === 'explore' || data.mode === 'design', '图文档模式无效');
  requireValue(Number.isSafeInteger(data.rev) && Number(data.rev) >= 0, '图文档版本无效');
  const childNodeIds = ids(data.childNodeIds), childDocumentIds = ids(data.childDocumentIds), members = new Set([...childNodeIds, ...childDocumentIds]);
  const positions = row(data.placements, '图文档布局');
  requireValue(Object.keys(positions).every(id => members.has(id)), '布局包含图文档之外的对象');
  return { documentId: identity(data.documentId), kind: data.kind, mode: data.mode ?? 'explore', name: string(data.name, '图文档名称'),
    childNodeIds, childDocumentIds, placements: Object.fromEntries(Object.entries(positions).map(([id, value]) => [identity(id), placement(value)])), rev: data.rev as number,
    metadata: { createdAt: string(metadata.createdAt, '创建时间'), updatedAt: string(metadata.updatedAt, '修改时间'), version: string(metadata.version, '版本'),
      ...(metadata.description === undefined ? {} : { description: string(metadata.description, '描述') }) } };
}
function node(value: unknown): GraphNodeRecord {
  const data = row(value, '节点');
  requireValue(data.provisional === undefined || typeof data.provisional === 'boolean', '节点状态无效');
  const design = data.design === undefined ? undefined : designData(data.design);
  if (design?.memberIds) design.memberIds = ids(design.memberIds);
  if (design?.subjectIds) design.subjectIds = ids(design.subjectIds);
  return { nodeId: identity(data.nodeId), name: string(data.name, '节点名'), content: string(data.content, '节点正文'),
    ...(data.provisional === undefined ? {} : { provisional: data.provisional }), ...(design ? { design } : {}) };
}
function edge(value: unknown): GraphEdge {
  const data = row(value, '关系边'); requireValue(typeof data.directed === 'boolean', '关系方向无效');
  requireValue(data.routeStyle === undefined || data.routeStyle === 'curve' || data.routeStyle === 'orthogonal', '关系路径类型无效');
  requireValue(data.removed === undefined || data.removed === false, '不能导入已删除的关系边');
  requireValue(data.relationKind === undefined || (data.relationKind === 'dependency' && data.directed && data.membershipFor === undefined), '依赖边的类型或方向无效');
  return { edgeId: identity(data.edgeId), sourceNodeId: identity(data.sourceNodeId), targetNodeId: identity(data.targetNodeId),
    edgeContent: string(data.edgeContent, '关系正文'), directed: data.directed,
    ...(data.relationKind === 'dependency' ? { relationKind: data.relationKind } : {}),
    ...(data.routeStyle === undefined ? {} : { routeStyle: data.routeStyle }), ...(data.membershipFor === undefined ? {} : { membershipFor: identity(data.membershipFor) }) };
}
function packageGraph(value: unknown): { bundle: DocumentPackage; graph: GraphState } {
  const data = row(value, '图文档文件');
  requireValue(data.format === 'qixue-document' && data.version === 1, '只支持图文档文件；旧版整库或画布备份不能导入', 'INVALID_DOCUMENT_PACKAGE');
  requireValue(Object.keys(data).every(key => ['format', 'version', 'exportedAt', 'rootDocumentId', 'layoutVersion', 'documents', 'nodes', 'edges'].includes(key)), '文件包含图文档之外的数据');
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= MAX_DOCUMENT_PACKAGE_BYTES, '图文档文件不能超过 120 MiB');
  requireValue(data.layoutVersion === REGION_LAYOUT_VERSION, '图文档布局版本不受支持');
  requireValue(Array.isArray(data.documents) && Array.isArray(data.nodes) && Array.isArray(data.edges), '图文档对象列表无效');
  const bundle: DocumentPackage = { format: 'qixue-document', version: 1, exportedAt: string(data.exportedAt, '导出时间'), rootDocumentId: identity(data.rootDocumentId),
    layoutVersion: REGION_LAYOUT_VERSION, documents: data.documents.map(document), nodes: data.nodes.map(node), edges: data.edges.map(edge) };
  const allIds = [...bundle.documents.map(d => d.documentId), ...bundle.nodes.map(n => n.nodeId), ...bundle.edges.map(e => e.edgeId)];
  requireValue(new Set(allIds).size === allIds.length, '文件包含重复的对象 ID');
  const graph: GraphState = { layoutVersion: bundle.layoutVersion, documents: Object.fromEntries(bundle.documents.map(d => [d.documentId, d])),
    nodes: Object.fromEntries(bundle.nodes.map(n => [n.nodeId, n])), edges: bundle.edges, canvases: [] };
  requireValue(graph.documents[bundle.rootDocumentId]?.kind === 'document', '导入根对象必须是图文档');
  // A file is one complete subtree. Reject hidden extra roots, dangling members and cycles.
  const members = new Set<string>(), pending = [bundle.rootDocumentId];
  while (pending.length) {
    const id = pending.pop()!; requireValue(!members.has(id), '图文档存在重复父级或循环嵌套'); members.add(id);
    const doc = graph.documents[id]; requireValue(doc, '嵌套图文档缺失');
    for (const nodeId of doc.childNodeIds) { requireValue(graph.nodes[nodeId] && !members.has(nodeId), '图文档节点缺失或重复归属'); members.add(nodeId); }
    pending.push(...doc.childDocumentIds);
  }
  requireValue(members.size === bundle.documents.length + bundle.nodes.length, '文件包含所选图文档之外的内容');
  requireValue(graph.edges.every(e => members.has(e.sourceNodeId) && members.has(e.targetNodeId)), '关系边的两端必须都在图文档中');
  requireValue(graph.edges.every(e => !e.relationKind || (e.sourceNodeId !== e.targetNodeId && graph.nodes[e.sourceNodeId] && graph.nodes[e.targetNodeId])), '依赖边必须连接两个不同节点');
  const keep = Object.fromEntries(Object.keys(graph.nodes).map(id => [id, id]));
  for (const n of bundle.nodes) if (n.design) n.design = remapDesign(n.design, keep);
  for (const doc of bundle.documents) for (const p of Object.values(doc.placements)) if (p.overlapAllowances)
    p.overlapAllowances = p.overlapAllowances.filter(a => a.parentId === doc.documentId && [...doc.childNodeIds, ...doc.childDocumentIds].includes(a.otherId));
  validateStructure(graph); validateRegionLayout(graph); return { bundle, graph };
}

export function exportDocumentPackage(graph: GraphState, rootDocumentId: string): DocumentPackage {
  requireValue(Object.hasOwn(graph.documents, rootDocumentId) && graph.documents[rootDocumentId].kind === 'document', '请选择要导出的图文档');
  const documents: GraphRecord[] = [], nodes = new Map<string, GraphNodeRecord>(), members = new Set<string>(), pending = [rootDocumentId];
  while (pending.length) {
    const id = pending.pop()!; requireValue(!members.has(id), '图文档结构重复或成环');
    const doc = graph.documents[id]; requireValue(doc, '嵌套图文档缺失'); members.add(id); documents.push(structuredClone(doc));
    for (const nodeId of doc.childNodeIds) { requireValue(graph.nodes[nodeId], '图文档节点缺失'); members.add(nodeId); nodes.set(nodeId, structuredClone(graph.nodes[nodeId])); }
    pending.push(...doc.childDocumentIds);
  }
  const bundle: DocumentPackage = { format: 'qixue-document', version: 1, exportedAt: new Date().toISOString(), rootDocumentId,
    layoutVersion: graph.layoutVersion ?? REGION_LAYOUT_VERSION, documents, nodes: [...nodes.values()],
    edges: graph.edges.filter(e => !e.removed && members.has(e.sourceNodeId) && members.has(e.targetNodeId)).map(e => structuredClone(e)) };
  return packageGraph(bundle).bundle;
}

export function importDocumentPackage(current: GraphState, value: unknown) {
  const { bundle, graph } = packageGraph(value);
  // Exclude source IDs too, so importing into an empty library still creates a copy.
  const sourceIds = new Set(graphIdentities(graph)), allocate = graphIdAllocator(current);
  const renamed = Object.fromEntries([...sourceIds].map(id => {
    let copyId = allocate(); while (sourceIds.has(copyId)) copyId = allocate(); return [id, copyId];
  }));
  const documents = bundle.documents.map(doc => ({ ...doc, documentId: renamed[doc.documentId],
    childNodeIds: doc.childNodeIds.map(id => renamed[id]), childDocumentIds: doc.childDocumentIds.map(id => renamed[id]),
    placements: Object.fromEntries(Object.entries(doc.placements).map(([id, p]) => [renamed[id], { ...p,
      ...(p.overlapAllowances ? { overlapAllowances: p.overlapAllowances.map(a => ({ ...a, parentId: renamed[a.parentId], otherId: renamed[a.otherId] })) } : {}) }])) }));
  const nodes = bundle.nodes.map(n => ({ ...n, nodeId: renamed[n.nodeId], ...(n.design ? { design: remapDesign(n.design, renamed) } : {}) }));
  const edges = bundle.edges.map(e => ({ ...e, edgeId: renamed[e.edgeId], sourceNodeId: renamed[e.sourceNodeId], targetNodeId: renamed[e.targetNodeId],
    ...(e.membershipFor ? { membershipFor: renamed[e.membershipFor] } : {}) }));
  const next = { ...current, documents: { ...current.documents, ...Object.fromEntries(documents.map(d => [d.documentId, d])) },
    nodes: { ...current.nodes, ...Object.fromEntries(nodes.map(n => [n.nodeId, n])) }, edges: [...current.edges, ...edges] };
  validateStructure(next);
  return { graph: next, documentId: renamed[bundle.rootDocumentId], name: graph.documents[bundle.rootDocumentId].name,
    mode: modeOf(graph.documents[bundle.rootDocumentId]), documentCount: documents.filter(d => d.kind === 'document').length };
}
