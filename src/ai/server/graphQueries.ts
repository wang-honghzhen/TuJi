import type { GraphReadContext } from './graphReadContext';
import { createHash } from 'node:crypto';
import type { AppSnapshot, Task } from '../domain';
import type { GraphState } from '@/v3/types';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { GRAPH_READ_LIMITS, resourceLimit } from './graphReadLimits';
import { requireValue } from './errors';
import { graphTables } from './graphReadTables';
import { visibleDependency } from '@/v3/dependencies';

export interface NodeSearch {
  query?: string; scope: 'node_names'; match?: 'contains' | 'exact'; refId?: string;
  recursive?: boolean; designTypes?: string[]; output?: 'content' | 'cards'; limit?: number | 'all';
}
export interface GraphQuery { version?: 2; projection?: 'edge'|'count'; tool: string; arguments: Record<string, unknown> }
export const isNavigationScope = (scope: unknown): scope is 'children' | 'path' => scope === 'children' || scope === 'path';
export const usesCardSearch = (args: Record<string, unknown>) => args.output !== 'content';
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
  requireValue(args.limit !== 'all' || args.output !== 'content', 'limit:all仅用于cards结果', 'INVALID_ARGUMENT');
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
/** Names are literal segments, so separators and short-reference lookalikes remain ordinary names. */
export function navigationMatches(index: CanvasIndex, args: Record<string, unknown>): string[] {
  const { scope, refId, segments } = args;
  requireValue(isNavigationScope(scope), '未知的导航查询', 'INVALID_ARGUMENT');
  if (refId !== undefined) {
    const start = typeof refId === 'string' ? index.rows.get(refId) : undefined;
    requireValue(start && start.kind !== 'node' && (start.readable || start.id === index.rootId), '起点不属于当前画布可读目录', 'OUT_OF_SCOPE');
  }
  if (scope === 'children') {
    const start = index.rows.get(typeof refId === 'string' ? refId : index.rootId);
    return (start?.children ?? []).filter(id => index.rows.get(id)?.readable).sort();
  }
  requireValue(Array.isArray(segments) && segments.length > 0 && segments.every(name => typeof name === 'string'), '路径需要至少一个名称段', 'INVALID_ARGUMENT');
  const matches: string[] = [];
  for (const row of index.rows.values()) {
    if (!row.readable || row.kind === 'root') continue;
    const offset: number = row.segments.length - segments.length;
    if (offset < 0 || (refId !== undefined && row.segments[offset - 1]?.id !== refId)) continue;
    if (segments.every((name, i) => name === row.segments[offset + i].name)) matches.push(row.id);
  }
  return matches.sort();
}
export function searchMatches(index: CanvasIndex, query: string, scope: 'all' | 'node_names' = 'all') {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (scope === 'node_names') return [...index.rows.values()].filter(r => r.kind === 'node' && r.readable
    && terms.some(t => r.segments.at(-1)!.name.toLowerCase().includes(t))).map(r => r.id).sort();
  return [...index.rows.values()].filter(r => r.kind !== 'root' && r.readable && terms.some(t => `${r.segments.at(-1)?.name}\n${r.content}\n${JSON.stringify(index.graph.nodes[r.id]?.design ?? '')}`.toLowerCase().includes(t)))
    .map(r => r.id).concat(index.edges.filter(e=>terms.some(t=>e.edgeContent.toLowerCase().includes(t))).map(e=>e.edgeId)).sort();
}
/** Literal matching keeps UTF-16 offsets even when case folding changes character length. */
export function textMatches(content: string, query: string, caseSensitive = false, versionCheck=false): Array<{start:number;end:number}> {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
  const result: Array<{start:number;end:number}> = [];
  for (const match of content.matchAll(pattern)) {
    result.push({start:match.index!,end:match.index!+match[0].length});
    // An over-limit live set differs from every snapshot that could have been admitted.
    if(versionCheck&&result.length>GRAPH_READ_LIMITS.objects)break;
    resourceLimit(result.length<=GRAPH_READ_LIMITS.objects,'matches');
  }
  return result;
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
export function dependencyEndpoints(index:CanvasIndex,edgeId:string) {
  const edge=graphTables(index).edges.get(edgeId);
  if(edge && visibleDependency(edge,id=>{const row=index.rows.get(id);return row?.kind==='node' && row.readable;}))
    return [edge.sourceNodeId,edge.targetNodeId];
}
/** The source depends on the target. Only endpoints visible in this canvas are returned. */
export function nodeDependencies(index: CanvasIndex, refId: string, direction: unknown = 'outgoing') {
  const row = index.rows.get(refId);
  requireValue(row?.kind === 'node' && row.readable, '请选择当前画布的可读节点', 'OUT_OF_SCOPE');
  requireValue(['outgoing', 'incoming', 'both'].includes(String(direction)), '依赖查询方向无效', 'INVALID_ARGUMENT');
  return graphTables(index).related(refId).filter(edge => (direction !== 'incoming' && edge.sourceNodeId === refId || direction !== 'outgoing' && edge.targetNodeId === refId)
    && dependencyEndpoints(index,edge.edgeId))
    .map(({ edgeId, sourceNodeId, targetNodeId }) => ({edgeId, sourceNodeId, targetNodeId}));
}
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
/** A delivered UTF-16 range also exposed the total character count. */
export function bodyRangeQuery(refId:string, field:string, start:number, end:number, directory=false):GraphQuery {
  return {version:2,tool:directory?'graph_read_directory_content':'graph_read_node_content',arguments:{refId,field,start,end}};
}
export function isBodyRangeQuery(query:GraphQuery) {
  return query.version===2 && (query.tool==='graph_read_node_content'||query.tool==='graph_read_directory_content');
}
export function queryReadWith(query:GraphQuery) {
  if(query.tool==='graph_read_dependencies')return {tool:query.tool,arguments:{refId:query.arguments.refId,direction:query.arguments.direction}};
  if(!isBodyRangeQuery(query))return {tool:query.tool,arguments:query.arguments};
  const {refId,field,start,end}=query.arguments;
  return {tool:query.tool,arguments:{refId,current:true,...(field==='pros'||field==='cons'?{field}:query.tool==='graph_read_node_content'?{start,end}:{})}};
}
export function graphQueryVersion(index: CanvasIndex, query: GraphQuery): string {
  if (query.tool === 'graph_read_dependencies') {
    if(query.projection==='edge')return digest(dependencyEndpoints(index,String(query.arguments.edgeId))??null);
    const rows=nodeDependencies(index,String(query.arguments.refId),query.arguments.direction);
    return digest(query.projection==='count'?rows.length:rows);
  }
  if (isBodyRangeQuery(query)) {
    const {refId,field,start,end}=query.arguments, row=index.rows.get(String(refId));
    const node=index.graph.nodes[String(refId)];
    const text=field==='pros'||field==='cons' ? node?.design?.[field]??'' : row?.content;
    return digest(row?.readable && typeof text==='string' ? [text.length,text.slice(Number(start),Number(end))] : null);
  }
  if(query.tool==='graph_search_node_content'&&query.version===2){
    const {refs,query:word,caseSensitive}=query.arguments;
    return digest((refs as string[]).map(id=>[id,textMatches(index.rows.get(id)?.content??'',String(word),caseSensitive===true,true)]));
  }
  if(SUBGRAPH_EDGE_TOOLS.has(query.tool)){const result=subgraphEdges(index,query);return digest([result.left,result.right,result.leftNodes,result.rightNodes,result.edges]);}
  if (query.tool === 'graph_search') {
    if (isNavigationScope(query.arguments.scope)) return digest(navigationMatches(index,query.arguments).map(id => [id,index.rows.get(id)!.kind]));
    const matches=query.arguments.scope==='all'?searchMatches(index,String(query.arguments.query)):nodeSearchMatches(index,query.arguments as unknown as NodeSearch);
    if(query.version===2){
      const limit=query.arguments.limit;
      return digest([matches.length,matches.slice(0,limit==='all'?matches.length:Math.min(50,Number(limit??12)))]);
    }
    return digest(matches);
  }
  if (query.tool === 'graph_read_design_references') return digest(designReferences(index, query.arguments));
  return digest((query.arguments.refs as string[]).map(ref => [ref, index.rows.get(ref)?.readable ? index.graph.nodes[ref] : null]));
}
const PREFIX = 'graph-query:';
export const graphQueryKey = (canvasId: string, query: GraphQuery) => PREFIX + JSON.stringify([canvasId, query]);
export function graphQueryDependency(key: string): {canvasId:string; query:GraphQuery} | undefined {
  if (!key.startsWith(PREFIX)) return;
  try { const [canvasId, query] = JSON.parse(key.slice(PREFIX.length));
    if(query?.tool==='graph_read_node_content'||query?.tool==='graph_read_directory_content'){
      const args=query.arguments;
      if(!isBodyRangeQuery(query)||typeof args?.refId!=='string'||!['content','pros','cons'].includes(args.field)
        ||!Number.isSafeInteger(args.start)||!Number.isSafeInteger(args.end)||args.start<0||args.end<args.start)return;
    }
    if (typeof canvasId === 'string' && ['graph_search','graph_read_dependencies','graph_read_design_references','graph_search_node_content','graph_read_node_content','graph_read_directory_content',...SUBGRAPH_EDGE_TOOLS].includes(query?.tool) && query.arguments) return {canvasId, query};
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
