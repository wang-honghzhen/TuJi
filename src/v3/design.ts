import type { CanvasMode, DesignNodeData, GraphNodeRecord, GraphState } from './types';
import { graphIdAllocator } from './ids';

export const modeOf = (value: { mode?: CanvasMode }): CanvasMode => value.mode ?? 'explore';
export const MODE_LABELS = { explore: '探索', design: '设计' };
export const DESIGN_LABELS = { proposal: '方案', combination: '组合', flow: '流程', general: '通用' };
export function canvasMode(value: unknown): CanvasMode {
  if (value === undefined) return 'explore';
  if (value !== 'explore' && value !== 'design') throw new Error('画布模式必须是探索或设计');
  return value;
}
export function designData(value: unknown): DesignNodeData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设计内容格式无效');
  const data = value as DesignNodeData;
  if (!Object.hasOwn(DESIGN_LABELS, data.type)) throw new Error('请选择方案、组合、流程或通用类型');
  if (Object.keys(data).some(key => !['type', 'pros', 'cons', 'memberIds', 'subjectIds'].includes(key))) throw new Error('未知的设计字段');
  for (const key of ['pros', 'cons'] as const) if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error('优缺点必须是文字');
  for (const key of ['memberIds', 'subjectIds'] as const) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key]!.some(id => typeof id !== 'string') || new Set(data[key]).size !== data[key]!.length)) throw new Error('关联对象列表无效或重复');
  if (data.memberIds?.length && data.type !== 'combination') throw new Error('只有组合可以设置成员方案');
  if (data.subjectIds?.length && data.type !== 'flow') throw new Error('只有流程可以设置描述对象');
  if (data.type !== 'combination' && (Object.hasOwn(data, 'pros') || Object.hasOwn(data, 'cons'))) throw new Error('只有组合保留独立的优缺点字段；方案的必要评价请写入正文');
  return structuredClone(data);
}

/** Preserve existing wording when retiring evaluation fields; never invent an evaluation. */
export function appendDesignEvaluation(content: string, data: Pick<DesignNodeData, 'pros' | 'cons'>): string {
  const parts: string[] = [];
  for (const [key, label] of [['pros', '优点'], ['cons', '缺点 / 代价']] as const) {
    const value = data[key];
    if (value !== undefined && typeof value !== 'string') throw new Error('原优缺点字段不是文字，无法迁移');
    if (value?.trim()) parts.push(`${label}：\n${value}`);
  }
  return parts.length ? `${content}${content ? '\n\n' : ''}原有评价\n${parts.join('\n\n')}` : content;
}

/** Used only for persisted/archived data, not to accept retired fields in new commands. */
export function migrateProposalNode(node: GraphNodeRecord): GraphNodeRecord {
  const data = node.design;
  if (!data || data.type === 'combination' || !Object.hasOwn(data, 'pros') && !Object.hasOwn(data, 'cons')) return node;
  // Older tools also permitted empty evaluation fields on flow/general nodes.
  // Preserve invalid nonempty values for validation instead of silently dropping them.
  if (data.type !== 'proposal' && [data.pros, data.cons].some(value => value !== undefined && value !== '')) return node;
  const content = data.type === 'proposal' ? appendDesignEvaluation(node.content, data) : node.content, design = { ...data };
  delete design.pros; delete design.cons;
  return { ...node, content, design };
}
export function migrateProposalEvaluations(state: GraphState): GraphState {
  let nodes = state.nodes;
  for (const node of Object.values(state.nodes)) {
    const next = migrateProposalNode(node);
    if (next !== node) { if (nodes === state.nodes) nodes = { ...nodes }; nodes[node.nodeId] = next; }
  }
  return nodes === state.nodes ? state : { ...state, nodes };
}

/** Modes and document ownership are enforced on every committed graph, including imports. */
export function validateDesign(state: GraphState): void {
  const parents = new Map(Object.values(state.documents).flatMap(doc => doc.childDocumentIds.map(id => [id, doc.documentId] as const)));
  const checkNode = (id: string, mode: CanvasMode) => {
    const node = state.nodes[id]; if (!node) return;
    if ((mode === 'design') !== Boolean(node.design)) throw new Error('节点类型与所属画布或图文档的模式不一致');
  };
  for (const doc of Object.values(state.documents)) {
    const mode = canvasMode(doc.mode);
    doc.childNodeIds.forEach(id => checkNode(id, mode));
    for (const id of doc.childDocumentIds) if (state.documents[id] && modeOf(state.documents[id]) !== mode) throw new Error('探索与设计图文档不能互相引入');
    if (mode === 'design' && doc.kind === 'document') {
      let parent = parents.get(doc.documentId); const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        if (state.documents[parent].kind === 'document') throw new Error('设计图文档不能嵌套；请将图文档放在画布目录中');
        parent = parents.get(parent);
      }
    }
  }
  for (const canvas of state.canvases) {
    const mode = canvasMode(canvas.mode);
    for (const id of [...canvas.childIds, ...Object.values(canvas.directories).flatMap(dir => dir.childIds)]) {
      checkNode(id, mode);
      if (state.documents[id] && modeOf(state.documents[id]) !== mode) throw new Error('探索与设计图文档不能互相引入');
    }
  }
  for (const node of Object.values(state.nodes)) if (node.design) {
    const data = designData(node.design);
    for (const id of data.memberIds ?? []) if (id === node.nodeId || state.nodes[id]?.design?.type !== 'proposal') throw new Error('组合成员只能是已有的方案');
    for (const id of data.subjectIds ?? []) if (id === node.nodeId || !['proposal', 'combination'].includes(state.nodes[id]?.design?.type ?? '')) throw new Error('流程的描述对象只能是已有的方案或组合');
  }
  const membership = new Set<string>();
  for (const edge of state.edges) if (edge.membershipFor) {
    const key = `${edge.sourceNodeId}\0${edge.targetNodeId}`;
    if (edge.removed || edge.membershipFor !== edge.sourceNodeId || !state.nodes[edge.sourceNodeId]?.design?.memberIds?.includes(edge.targetNodeId) || membership.has(key)) throw new Error('组合成员连线与成员列表不一致');
    membership.add(key);
  }
  for (const node of Object.values(state.nodes)) for (const member of node.design?.memberIds ?? []) if (!membership.has(`${node.nodeId}\0${member}`)) throw new Error('组合成员缺少关联连线');
}

/** Deleting content also removes its references. Membership has one source of truth. */
export function reconcileDesign(next: GraphState, previous?: GraphState): GraphState {
  let nodes = next.nodes;
  for (const node of Object.values(nodes)) if (node.design) {
    let data = node.design;
    for (const key of ['memberIds', 'subjectIds'] as const) if (data[key]?.some(id => !nodes[id] && previous?.nodes[id])) data = { ...data, [key]: data[key]!.filter(id => Boolean(nodes[id]) || !previous?.nodes[id]) };
    if (data !== node.design) { if (nodes === next.nodes) nodes = { ...nodes }; nodes[node.nodeId] = { ...node, design: data }; }
  }
  const desired = new Map(Object.values(nodes).flatMap(node => (node.design?.memberIds ?? []).map(id => [`${node.nodeId}\0${id}`, { source: node.nodeId, target: id }])));
  const edges = next.edges.filter(edge => {
    if (!edge.membershipFor) return true;
    const key = `${edge.sourceNodeId}\0${edge.targetNodeId}`;
    if (edge.membershipFor !== edge.sourceNodeId || !desired.has(key)) return false;
    desired.delete(key); return true;
  });
  const allocate = graphIdAllocator(next);
  for (const { source, target } of desired.values()) edges.push({ edgeId: allocate(), sourceNodeId: source, targetNodeId: target, directed: true, edgeContent: '包含方案', membershipFor: source });
  return nodes === next.nodes && edges.length === next.edges.length && edges.every((edge, i) => edge === next.edges[i]) ? next : { ...next, nodes, edges };
}

export function remapDesign(data: DesignNodeData | undefined, renamed: Record<string, string>, keepExternal = false): DesignNodeData | undefined {
  if (!data) return undefined;
  const refs = (ids: string[]) => ids.flatMap(id => renamed[id] ? [renamed[id]] : keepExternal ? [id] : []);
  return { ...data, ...(data.memberIds ? { memberIds: refs(data.memberIds) } : {}), ...(data.subjectIds ? { subjectIds: refs(data.subjectIds) } : {}) };
}
