import type { GraphReadContext } from './graphReadContext';
import { createHash } from 'node:crypto';
import type { AppSnapshot, Task } from '../domain';
import type { GraphState } from '@/v3/types';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { requireValue } from './errors';

export interface NodeSearch {
  query?: string; scope: 'node_names'; match?: 'contains' | 'exact'; refId?: string;
  recursive?: boolean; designTypes?: string[]; output?: 'content' | 'cards'; limit?: number | 'all';
}
export interface GraphQuery { tool: string; arguments: Record<string, unknown> }
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const enhancedSearch = (args: Record<string, unknown>) => ['match','refId','recursive','designTypes','output'].some(k => args[k] !== undefined) || args.limit === 'all' || args.query === undefined;
export function assertDesignQuery(state: AppSnapshot, task: Task) {
  requireValue(state.sessions.find(s => s.id === task.sessionId)?.mode === 'design'
    && state.graph?.canvases.find(c => c.canvasId === task.canvasId)?.mode === 'design',
  '此工具仅向设计模式AI开放', 'TOOL_NOT_ALLOWED');
}
export function validateNodeSearch(index: CanvasIndex, args: Record<string, unknown>): NodeSearch {
  requireValue(args.scope === 'node_names', '新增搜索参数仅用于scope:node_names', 'INVALID_ARGUMENT');
  requireValue(args.query === undefined || typeof args.query === 'string', 'query必须是文本', 'INVALID_ARGUMENT');
  requireValue(Boolean(String(args.query ?? '').trim()) || typeof args.refId === 'string' || Array.isArray(args.designTypes) && args.designTypes.length > 0,
    '需要查询词、子图或设计类型筛选', 'INVALID_ARGUMENT');
  requireValue(args.limit !== 'all' || args.output === 'cards', 'limit:all仅用于cards结果', 'INVALID_ARGUMENT');
  requireValue(args.limit === undefined || args.limit === 'all' || Number.isSafeInteger(args.limit) && Number(args.limit) >= 0, 'limit无效', 'INVALID_ARGUMENT');
  requireValue(args.match === undefined || ['contains','exact'].includes(String(args.match)), 'match无效', 'INVALID_ARGUMENT');
  requireValue(args.output === undefined || ['content','cards'].includes(String(args.output)), 'output无效', 'INVALID_ARGUMENT');
  if (args.refId !== undefined) requireValue(typeof args.refId === 'string' && index.rows.has(args.refId) && index.rows.get(args.refId)!.kind !== 'node', '子图不属于当前画布', 'OUT_OF_SCOPE');
  if (args.designTypes !== undefined) requireValue(Array.isArray(args.designTypes) && args.designTypes.length > 0 && args.designTypes.every(t => ['proposal','combination','flow','general'].includes(String(t))), 'designTypes无效', 'INVALID_ARGUMENT');
  return args as unknown as NodeSearch;
}
export function nodeSearchMatches(index: CanvasIndex, spec: NodeSearch): string[] {
  const query = (spec.query ?? '').trim().toLowerCase(), terms = query.split(/\s+/).filter(Boolean), root = spec.refId ?? index.rootId;
  return [...index.rows.values()].filter(row => {
    if (row.kind !== 'node' || !row.readable) return false;
    if (spec.recursive === false ? row.parentId !== root : !row.segments.some(s => s.id === root)) return false;
    if (spec.designTypes && !spec.designTypes.includes(index.graph.nodes[row.id]?.design?.type ?? '')) return false;
    const name = row.segments.at(-1)!.name.toLowerCase();
    return !query || (spec.match === 'exact' ? name === query : terms.some(term => name.includes(term)));
  }).map(row => row.id).sort();
}
export interface DesignReference { kind: 'member' | 'subject'; sourceNodeId: string; targetNodeId: string }
export function designReferences(index: CanvasIndex, args: Record<string, unknown>): DesignReference[] {
  const refs = new Set(args.refs as string[]), kinds = args.kinds as string[] | undefined ?? ['member','subject'];
  const direction = args.direction ?? 'both', result: DesignReference[] = [];
  for (const row of index.rows.values()) {
    if (row.kind !== 'node' || !row.readable) continue;
    const design = index.graph.nodes[row.id]?.design;
    for (const [kind, values] of [['member', design?.memberIds], ['subject', design?.subjectIds]] as const) {
      if (!kinds.includes(kind)) continue;
      for (const targetNodeId of new Set(values ?? [])) {
        if (index.rows.get(targetNodeId)?.kind !== 'node' || !index.rows.get(targetNodeId)?.readable) continue;
        if ((direction !== 'incoming' && refs.has(row.id)) || (direction !== 'outgoing' && refs.has(targetNodeId)))
          result.push({kind, sourceNodeId:row.id, targetNodeId});
      }
    }
  }
  return result.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export const SUBGRAPH_EDGE_TOOLS = new Set(['graph_read_subgraph_edges','graph_read_between_subgraphs']);
/** Query identity includes direct node membership, even when the edge set is empty. */
export function subgraphEdges(index:CanvasIndex,query:GraphQuery) {
  const between=query.tool==='graph_read_between_subgraphs',args=query.arguments;
  const left=String(between?args.sourceRefId:args.refId),right=between?String(args.targetRefId):left;
  requireValue(!between||left!==right,'两个子图必须不同；内部边使用graph_read_subgraph_edges','INVALID_ARGUMENT');
  const direct=(id:string)=>{const row=index.rows.get(id);
    requireValue(row&&row.kind!=='node'&&row.kind!=='root'&&row.readable,'子图不属于当前画布','OUT_OF_SCOPE');
    return row.children.filter(child=>index.rows.get(child)?.kind==='node'&&index.rows.get(child)?.readable).sort();};
  const leftNodes=direct(left),rightNodes=between?direct(right):leftNodes,a=new Set(leftNodes),b=new Set(rightNodes);
  const edges=index.edges.filter(e=>a.has(e.sourceNodeId)&&b.has(e.targetNodeId)||between&&b.has(e.sourceNodeId)&&a.has(e.targetNodeId))
    .sort((x,y)=>x.edgeId.localeCompare(y.edgeId));
  return {left,right,leftNodes,rightNodes,edges};
}
export function graphQueryVersion(index: CanvasIndex, query: GraphQuery): string {
  if(SUBGRAPH_EDGE_TOOLS.has(query.tool)){const result=subgraphEdges(index,query);return digest([result.left,result.right,result.leftNodes,result.rightNodes,result.edges]);}
  if (query.tool === 'graph_search') return digest(nodeSearchMatches(index, query.arguments as unknown as NodeSearch));
  if (query.tool === 'graph_read_design_references') return digest(designReferences(index, query.arguments));
  return digest((query.arguments.refs as string[]).map(ref => [ref, index.rows.get(ref)?.readable ? index.graph.nodes[ref] : null]));
}
const PREFIX = 'graph-query:';
export const graphQueryKey = (canvasId: string, query: GraphQuery) => PREFIX + JSON.stringify([canvasId, query]);
export function graphQueryDependency(key: string): {canvasId:string; query:GraphQuery} | undefined {
  if (!key.startsWith(PREFIX)) return;
  try { const [canvasId, query] = JSON.parse(key.slice(PREFIX.length));
    if (typeof canvasId === 'string' && ['graph_search','graph_read_design_references','graph_search_node_content',...SUBGRAPH_EDGE_TOOLS].includes(query?.tool) && query.arguments) return {canvasId, query};
  } catch { /* Invalid saved keys are rejected by the dependency check. */ }
}
export function currentGraphQueryHashes(graph: GraphState, keys: string[], context?: GraphReadContext): Record<string,string> {
  const indices = new Map<string,CanvasIndex>(), result: Record<string,string> = {};
  for (const key of keys) {
    const dependency = graphQueryDependency(key); if (!dependency || !graph.canvases.some(c => c.canvasId === dependency.canvasId)) continue;
    let index = indices.get(dependency.canvasId);
    if (!index) { index = context?.graph === graph ? context.index(dependency.canvasId) : canvasIndex(graph,dependency.canvasId,canvasMemberIds(graph,dependency.canvasId)); indices.set(dependency.canvasId,index); }
    const args=dependency.query.arguments,targets=[...(Array.isArray(args.refs)?args.refs as string[]:[]),...(typeof args.refId==='string'?[args.refId]:[]),...[args.sourceRefId,args.targetRefId].filter((v):v is string=>typeof v==='string')];
    if(targets.some(ref=>!index!.rows.get(ref)?.readable))continue;
    const compute = () => graphQueryVersion(index!,dependency.query);
    result[key] = context?.graph === graph ? context.version(key,compute)! : compute();
  }
  return result;
}
