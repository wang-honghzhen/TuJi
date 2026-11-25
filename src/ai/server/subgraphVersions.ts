import type { GraphReadContext } from './graphReadContext';
import { createHash } from 'node:crypto';
import type { GraphState } from '@/v3/types';
import { getHierarchyIndex } from '@/v3/hierarchyIndex';
import type { AppSnapshot } from '../domain';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, hasDirectNodes, type CanvasIndex } from './canvasView';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Revisions audit transitions; equal semantic payloads can be equivalent after ABA. */
export function equivalentSubgraphVersion(a:string|undefined,b:string|undefined){
  if(a===b)return true;
  const payload=(v:string|undefined)=>v?.match(/^\d+:([a-f0-9]{64})$/)?.[1];
  return !!payload(a)&&payload(a)===payload(b);
}
export type SubgraphPart = 'directory' | 'direct' | 'members' | 'content' | 'path' | 'owner' | 'name' | 'design' | 'body' | 'editScope' | 'designType';
const parts: SubgraphPart[] = ['directory', 'direct', 'members', 'content', 'path', 'owner', 'name', 'design', 'body', 'editScope','designType'];
type Ledger = NonNullable<AppSnapshot['directoryVersions']>;
// A graph and its committed ledger travel together. Uncommitted edits derive the
// same next revision that the repository will atomically commit.
const ledgers = new WeakMap<GraphState, Ledger>();
export function bindSubgraphVersions(graph: GraphState | null, ledger: Ledger | undefined) {
  if (graph) ledgers.set(graph, { ...ledger });
}
export const subgraphKey = (canvasId: string, refId: string, part: SubgraphPart) => 'subgraphs:' + JSON.stringify([canvasId, refId, part]);
export function subgraphDependency(key: string): { canvasId: string; refId: string; part: SubgraphPart } | undefined {
  if (!key.startsWith('subgraphs:')) return;
  try {
    const value = JSON.parse(key.slice(10));
    if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'string') && parts.includes(value[2] as SubgraphPart))
      return { canvasId: value[0], refId: value[1], part: value[2] as SubgraphPart };
  } catch { /* Invalid dependency keys fail closed in the caller. */ }
}
const caches = new WeakMap<CanvasIndex, Map<string, ReturnType<typeof computeFacts>>>();
const scopeCache=new WeakMap<CanvasIndex,{
  versions:Map<string,string>;members:Map<string,Set<string>>;hierarchy:ReturnType<typeof getHierarchyIndex>;
}>();
function textScope(index:CanvasIndex,refId:string):string|undefined{
  const row=index.rows.get(refId);
  if(!row?.readable||!(row.kind==='node'||row.kind==='subgraph'))return;
  if(row.kind==='subgraph'&&!index.graph.documents[refId])return digest(['local',index.canvasId]);
  let cache=scopeCache.get(index);
  if(!cache){
    cache={versions:new Map(),members:new Map([[index.canvasId,index.members]]),hierarchy:getHierarchyIndex(index.graph)};
    scopeCache.set(index,cache);
  }
  const known=cache.versions.get(refId);if(known)return known;
  const hierarchy=cache.hierarchy;
  const parent=row.kind==='node'?hierarchy.nodeParents.get(refId):hierarchy.documentParents.get(refId);
  let document=parent,localOwner:string|undefined;
  while(document&&index.graph.documents[document]?.kind!=='document')document=hierarchy.documentParents.get(document);
  const surfaces:string[]=[];
  for(const canvas of index.graph.canvases){
    const mounted=hierarchy.canvasParents.get(canvas.canvasId)?.has(refId);
    if(mounted&&!canvas.nodeReferenceIds?.includes(refId)&&row.kind==='node')localOwner=canvas.canvasId;
    if(!parent&&row.kind==='node'){
      if(mounted)surfaces.push(canvas.canvasId);
      continue;
    }
    let members=cache.members.get(canvas.canvasId);
    if(!members){members=canvasMemberIds(index.graph,canvas.canvasId);cache.members.set(canvas.canvasId,members);}
    if(members.has(refId))surfaces.push(canvas.canvasId);
  }
  const version=digest([row.kind,document??null,localOwner??null,surfaces.sort()]);
  cache.versions.set(refId,version);return version;
}
function directoryFingerprint(index:CanvasIndex,refId:string){
  const row=index.rows.get(refId)!;
  return digest([row.kind,row.segments.at(-1)?.name,row.parentId,hasDirectNodes(index,refId),row.children.filter(id=>index.rows.get(id)!.kind!=='node').sort()
    .map(id=>[id,index.rows.get(id)!.kind,index.rows.get(id)!.segments.at(-1)?.name]),...(row.spatial ? [row.spatial] : [])]);
}
function computeFacts(index: CanvasIndex, refId: string) {
  const row = index.rows.get(refId)!;
  const children = [...row.children].sort();
  const nodes = children.filter(id => index.rows.get(id)?.kind === 'node');
  const content = [row.kind, row.segments.at(-1)?.name, row.content];
  const structure = directoryFingerprint(index,refId);
  // The explicit directory bundle covers directly listed entries and node bodies.
  // Its aggregate stamp is separate from reading a single node or the directory tree.
  const signature = digest([content, nodes.map(id => {
    const child=index.rows.get(id)!,node=index.graph.nodes[id];
    return [id,child.segments.at(-1)?.name,child.content,node?.design];
  }),children.filter(id=>index.rows.get(id)?.kind!=='node').map(id=>[id,index.rows.get(id)!.kind])]);
  return { structure, signature };
}
export function subgraphFacts(index: CanvasIndex, refId: string) {
  let cache = caches.get(index); if (!cache) { cache = new Map(); caches.set(index, cache); }
  if (!cache.has(refId)) cache.set(refId, computeFacts(index, refId));
  return cache.get(refId)!;
}
export function subgraphVersion(index: CanvasIndex, refId: string, part: SubgraphPart): string | undefined {
  const row = index.rows.get(refId); if (!row || !['path','owner','name','body','editScope','design','designType'].includes(part) && row.kind === 'node') return;
  if(part==='designType')return digest(index.graph.nodes[refId]?.design?.type??null);
  if(part==='name')return digest(row.segments.at(-1)?.name??'');
  if(part==='design')return digest(index.graph.nodes[refId]?.design??null);
  if(part==='path')return digest(row.segments.map(s=>[s.id,s.name,s.kind]));
  if(part==='owner')return digest(row.parentId??null);
  if(part==='body')return digest(row.content);
  if(part==='editScope')return textScope(index,refId);
  if(part==='content')return digest([row.kind,row.segments.at(-1)?.name,row.content]);
  if(part==='members')return digest(row.children.filter(id=>index.rows.get(id)?.kind==='node').sort());
  const entry = ledgers.get(index.graph)?.[`${index.canvasId}/${refId}`];
  const stamp = part === 'directory' ? directoryFingerprint(index,refId) : subgraphFacts(index, refId).signature;
  const previous = part === 'directory' ? entry?.structure : entry?.signature;
  const revision = part === 'directory' ? entry?.directoryVersion ?? 0 : entry?.directDataVersion ?? entry?.version ?? 0;
  return `${revision + (!entry || previous !== stamp || part==='directory'&&entry.directoryVersion===undefined ? 1 : 0)}:${stamp}`;
}
export function captureSubgraphHashes(index: CanvasIndex, refs: string[], part: SubgraphPart): Record<string, string> {
  return Object.fromEntries([...new Set(refs)].flatMap(refId => {
    const version = subgraphVersion(index, refId, part);
    return version ? [[subgraphKey(index.canvasId, refId, part), version]] : [];
  }));
}
export function currentSubgraphHashes(graph: GraphState, keys: string[], context?: GraphReadContext): Record<string, string> {
  const indices = new Map<string, CanvasIndex>(), result: Record<string, string> = {};
  for (const key of keys) {
    const query = subgraphDependency(key); if (!query || !graph.canvases.some(c => c.canvasId === query.canvasId)) continue;
    let index = indices.get(query.canvasId);
    if (!index) { index = context?.graph === graph ? context.index(query.canvasId) : canvasIndex(graph, query.canvasId, canvasMemberIds(graph, query.canvasId)); indices.set(query.canvasId, index); }
    const compute = () => subgraphVersion(index!, query.refId, query.part);
    const version = context?.graph === graph ? context.version(key,compute) : compute(); if (version) result[key] = version;
  }
  return result;
}
