import { canvasDirectoryEntries } from '../v3/canvas';
import { canvasEdgeScope, getCanvasMembership, type CanvasEdgeScope } from '../v3/hierarchyIndex';
import { isEdgeScopeVisible, type EdgeVisibilityOptions } from '../v3/layout';
import type { CanvasRecord, GraphEdge, GraphState } from '../v3/types';

export type ObservationScope = 'all' | 'selected' | 'neighbors';
export interface GroupSettings {
  expanded?: boolean;
  internalEdges?: boolean;
  /** One-hop focus for this group's direct contents. Null removes the restriction. */
  focusNodeId?: string | null;
}
export interface RelationSettings {
  mode: 'aggregate' | 'expanded' | 'partial' | 'hidden';
  memberIds?: readonly string[];
}
export interface CanvasGranularity {
  defaultExpanded: boolean;
  defaultRelation: 'aggregate' | 'expanded';
  groups: Record<string, GroupSettings>;
  relations: Record<string, RelationSettings>;
  /** Canvas-local offsets calculated when opening planar regions. */
  planarPlacements?: CanvasRecord['presentationPlacements'];
}
export interface SubgraphRelation {
  id: string;
  sourceSubgraphId: string;
  targetSubgraphId: string;
  directed: boolean;
  memberEdgeIds: string[];
  relationCount: number;
  summary?: string;
}
export interface GranularityIndex {
  rootId: string;
  parents: Map<string, string>;
  children: Map<string, string[]>;
  groupIds: Set<string>;
  nodeIds: Set<string>;
  edgesById: Map<string, GraphEdge>;
  relations: Map<string, SubgraphRelation>;
  relationOfEdge: Map<string, string>;
  edgeScopes: Map<string, CanvasEdgeScope>;
  incidentEdges: Map<string, GraphEdge[]>;
}
export interface GranularityProjection {
  nodeIds: Set<string>;
  groupIds: Set<string>;
  collapsedGroupIds: Set<string>;
  edges: GraphEdge[];
  /** Each residual summary lists exactly the members it represents in this frame. */
  relations: SubgraphRelation[];
}

export function createGranularity(canvas: CanvasRecord): CanvasGranularity {
  return {
    defaultExpanded: true, defaultRelation: 'aggregate', relations: {},
    groups: Object.fromEntries(Object.keys(canvas.collapsed ?? {}).map(id => [id, { expanded: false }])),
  };
}

function lookup<T>(values: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined;
}

export function groupSettings(state: CanvasGranularity, id: string) {
  const own = lookup(state.groups, id);
  return { expanded: own?.expanded ?? state.defaultExpanded, internalEdges: own?.internalEdges ?? true, focusNodeId: own?.focusNodeId ?? null };
}

/** The same inherited switch applies even while an observation scope hides this group. */
export function groupExpanded(index:GranularityIndex,state:CanvasGranularity,id:string,cache?:Map<string,boolean>):boolean {
  const cached=cache?.get(id);
  if(cached!==undefined)return cached;
  const parent=index.parents.get(id);
  const own=lookup(state.groups,id)?.expanded;
  const value=own??(state.defaultExpanded&&(!parent||groupExpanded(index,state,parent,cache)));
  cache?.set(id,value);
  return value;
}

export function relationSettings(state: CanvasGranularity, id: string): RelationSettings {
  return lookup(state.relations, id) ?? { mode: state.defaultRelation };
}

export function updateGroup(state: CanvasGranularity, id: string, patch: GroupSettings): CanvasGranularity {
  return { ...state, groups: { ...state.groups, [id]: { ...lookup(state.groups, id), ...patch } } };
}
export function updateRelation(state: CanvasGranularity, id: string, config: RelationSettings): CanvasGranularity {
  return { ...state, relations: { ...state.relations, [id]: config.mode === 'partial'
    ? { mode: 'partial', memberIds: [...new Set(config.memberIds)] } : { mode: config.mode } } };
}
export function setAllGroups(state: CanvasGranularity, expanded: boolean): CanvasGranularity {
  // Global contents toggles must preserve local edge visibility and one-hop scopes.
  const groups: Record<string, GroupSettings> = Object.create(null);
  for (const [id, { expanded: _expanded, ...other }] of Object.entries(state.groups)) {
    if (Object.keys(other).length) groups[id] = other;
  }
  return { ...state, groups, defaultExpanded: expanded };
}
/** A global toggle reflects every current pair, including local overrides. */
export function crossAggregationState(index: GranularityIndex, state: CanvasGranularity): boolean | 'mixed' {
  let aggregateCount = state.defaultRelation === 'aggregate' ? index.relations.size : 0;
  for (const [id, { mode }] of Object.entries(state.relations)) {
    if (!index.relations.has(id)) continue;
    if (mode === 'partial' || mode === 'hidden') return 'mixed';
    if (mode !== state.defaultRelation) aggregateCount += mode === 'aggregate' ? 1 : -1;
  }
  if (!index.relations.size) return state.defaultRelation === 'aggregate';
  if (aggregateCount === 0) return false;
  return aggregateCount === index.relations.size ? true : 'mixed';
}
export function setAllRelations(state: CanvasGranularity, mode: CanvasGranularity['defaultRelation']): CanvasGranularity {
  return { ...state, relations: {}, defaultRelation: mode };
}

/** Explicit navigation, including references from search or a presentation, may
 * reveal one member of a coarse relation without expanding its other members. */
export function revealCanvasObjects(index:GranularityIndex, state:CanvasGranularity, ids:readonly string[]):CanvasGranularity {
  let next=state;
  for(const id of ids){
    const pairId=index.relationOfEdge.get(id);
    if(pairId){
      const setting=relationSettings(next,pairId);
      if(setting.mode==='expanded'||setting.mode==='partial'&&setting.memberIds?.includes(id))continue;
      const pair=index.relations.get(pairId)!;
      const picked=new Set(setting.mode==='partial'?setting.memberIds:[]);
      picked.add(id);
      const members=pair.memberEdgeIds.filter(member=>picked.has(member));
      next=updateRelation(next,pairId,members.length===pair.relationCount?
        {mode:'expanded'}:{mode:'partial',memberIds:members});
    }else{
      const edge=index.edgesById.get(id);
      for(const endpoint of edge?[edge.sourceNodeId,edge.targetNodeId]:[id]){
        const owner=index.parents.get(endpoint);
        if(index.nodeIds.has(endpoint)&&owner&&!groupExpanded(index,next,owner))next=updateGroup(next,owner,{expanded:true});
      }
    }
  }
  return next;
}

/** In the planar view each ancestor is a physical container. Locating an
 * object must open that chain even when the original edge was already shown. */
export function openPlanarAncestors(index: GranularityIndex, state: CanvasGranularity, ids: Iterable<string>, localFoldsOnly = false) {
  let next = state;
  const opened = new Set<string>();
  for (const id of ids) {
    const edge = index.edgesById.get(id);
    for (const endpoint of edge ? [edge.sourceNodeId, edge.targetNodeId] : [id]) {
      let group = index.parents.get(endpoint);
      const chain: string[] = [];
      while (group && !opened.has(group)) {
        // Top-level subgraphs still have a card in the coarse overview.
        if (group === index.rootId && !(index.nodeIds.has(endpoint) && index.parents.get(endpoint) === group)) break;
        chain.push(group);
        opened.add(group);
        group = index.parents.get(group);
      }
      for (const ancestor of chain.reverse()) {
        const closed = localFoldsOnly ? lookup(next.groups, ancestor)?.expanded === false : !groupExpanded(index, next, ancestor);
        if (closed) next = updateGroup(next, ancestor, { expanded: true });
      }
    }
  }
  return next;
}

export function revealPlanarObjects(index: GranularityIndex, state: CanvasGranularity, ids: readonly string[], localFoldsOnly = false) {
  return revealCanvasObjects(index, openPlanarAncestors(index, state, ids, localFoldsOnly), ids);
}

/** Uses actual mounted ownership, even when the existing 2D model has folded
 * descendants into representatives. No projection is stored in GraphState. */
export function buildGranularityIndex(graph: GraphState, canvas: CanvasRecord): GranularityIndex {
  const membership = getCanvasMembership(graph, canvas);
  const children = new Map<string, string[]>();
  for (const [id, parent] of membership.parents) {
    const siblings = children.get(parent);
    if (siblings) siblings.push(id); else children.set(parent, [id]);
  }
  const groupIds = new Set<string>(), nodeIds = new Set<string>();
  for (const id of membership.members) (graph.nodes[id] ? nodeIds : groupIds).add(id);
  const endpoints = new Set([...Object.keys(graph.nodes), ...Object.keys(graph.documents)]);
  for (const record of graph.canvases) for (const [id] of canvasDirectoryEntries(record)) endpoints.add(id);
  const occupied = new Set([...endpoints, ...graph.edges.map(e => e.edgeId)]);
  const edgesById = new Map<string, GraphEdge>(), edgeScopes = new Map<string, CanvasEdgeScope>();
  const relations = new Map<string, SubgraphRelation>(), relationOfEdge = new Map<string,string>();
  const batches = new Map<string, SubgraphRelation>(), incidentEdges = new Map<string, GraphEdge[]>();
  const owner = (id: string) => groupIds.has(id) ? id : membership.parents.get(id);
  for (const edge of graph.edges) {
    const { sourceNodeId: a, targetNodeId: b, edgeId } = edge;
    if (edge.removed || (!membership.members.has(a) && !membership.members.has(b))) continue;
    if (!endpoints.has(a) || !endpoints.has(b)) continue;
    edgesById.set(edgeId, edge);
    const scope = canvasEdgeScope(graph, membership, edge);
    edgeScopes.set(edgeId, scope);
    for (const id of a === b ? [a] : [a,b]) {
      const list = incidentEdges.get(id);
      if (list) list.push(edge); else incidentEdges.set(id, [edge]);
    }
    let from = owner(a), to = owner(b);
    // Design membership is structural; it never contributes to a knowledge relation count.
    if (scope !== 'cross' || edge.membershipFor || !from || !to || from === to) continue;
    if (!edge.directed && from > to) [from,to] = [to,from];
    const key = JSON.stringify([from,to,edge.directed]);
    let batch = batches.get(key);
    if (!batch) {
      let id = 'spatial-group:' + key;
      while (occupied.has(id)) id += '#';
      occupied.add(id);
      batch = { id, sourceSubgraphId: from, targetSubgraphId: to, directed: edge.directed, memberEdgeIds: [], relationCount: 0 };
      batches.set(key,batch); relations.set(id,batch);
    }
    batch.memberEdgeIds.push(edgeId); batch.relationCount++;
    relationOfEdge.set(edgeId,batch.id);
  }
  return { rootId: canvas.canvasId, parents: membership.parents, children, groupIds, nodeIds, edgesById, edgeScopes, relations, relationOfEdge, incidentEdges };
}

export function projectGranularity(index: GranularityIndex, state: CanvasGranularity, selection: ReadonlySet<string>,
  scope: ObservationScope = 'all', visibility: EdgeVisibilityOptions = {}): GranularityProjection {
  const { rootId, parents } = index;
  const groupIds = new Set<string>(), nodeIds = new Set<string>(), collapsedGroupIds = new Set<string>();
  const edges: GraphEdge[] = [], relations: SubgraphRelation[] = [];
  const expansion = new Map<string,boolean>();
  const expanded=(id:string)=>groupExpanded(index,state,id,expansion);
  function show(id: string) {
    if (index.nodeIds.has(id)) nodeIds.add(id);
    let group = index.groupIds.has(id) ? id : parents.get(id);
    while (group && !groupIds.has(group)) { groupIds.add(group); group = parents.get(group); }
  }
  function edgeIsEnabled(edge: GraphEdge) {
    const kind = index.edgeScopes.get(edge.edgeId)!;
    if (!isEdgeScopeVisible(kind,edge.edgeId,visibility)) return false;
    if (kind === 'internal' && lookup(state.groups,parents.get(edge.sourceNodeId)!)?.internalEdges === false) return false;
    const relationId = index.relationOfEdge.get(edge.edgeId);
    return !relationId || relationSettings(state,relationId).mode !== 'hidden';
  }
  const localScopes = new Map<string,Set<string>>();
  for (const [group,config] of Object.entries(state.groups)) {
    const seed = config.focusNodeId;
    if (!seed || !index.nodeIds.has(seed)) continue;
    const allowed = new Set([seed]);
    for (const edge of index.incidentEdges.get(seed) ?? []) {
      if (edge.membershipFor || !edgeIsEnabled(edge)) continue;
      allowed.add(edge.sourceNodeId); allowed.add(edge.targetNodeId);
    }
    localScopes.set(group,allowed);
  }
  const inLocalScope = (id: string) => localScopes.get(parents.get(id)!)?.has(id) !== false;
  // Unlike structural ancestors added by show(), only actual selected objects
  // can seed the graph hop. An incidental ancestor must never reveal its siblings.
  const objectScope = new Set<string>(), explicitEdges = new Set<string>(), relationScope = new Set<string>();
  const contents = new Set<string>(), openedForScope = new Set<string>();
  function openPath(group: string | undefined) {
    while (group && !openedForScope.has(group)) {
      openedForScope.add(group);
      group = parents.get(group);
    }
  }
  if (scope !== 'all') {
    // Only a group in the actual input selection owns a subtree. Ancestors
    // needed to draw a node or the far end of a relation do not own a hop.
    const pending = [...selection].filter(id => index.groupIds.has(id));
    while (pending.length) {
      const id = pending.pop()!;
      if (contents.has(id)) continue;
      contents.add(id);
      if (index.groupIds.has(id) || inLocalScope(id)) show(id);
      if (index.groupIds.has(id)) {
        openPath(id);
        for (const child of index.children.get(id) ?? []) pending.push(child);
      }
    }
    for (const id of selection) {
      if (index.nodeIds.has(id) || index.groupIds.has(id)) objectScope.add(id);
      // A point picked inside a temporarily opened group becomes the next
      // focus. Keep its own path navigable without opening adjacent branches.
      if (index.nodeIds.has(id) && inLocalScope(id)) openPath(parents.get(id));
      const edge = index.edgesById.get(id);
      if (edge && edgeIsEnabled(edge)) {
        explicitEdges.add(id); objectScope.add(edge.sourceNodeId); objectScope.add(edge.targetNodeId);
        openPath(parents.get(edge.sourceNodeId)); openPath(parents.get(edge.targetNodeId));
      }
      const relation = index.relations.get(id);
      if (relation && relationSettings(state,id).mode !== 'hidden') {
        relationScope.add(id);
        objectScope.add(relation.sourceSubgraphId); objectScope.add(relation.targetSubgraphId);
      }
    }
    if (scope === 'neighbors') {
      const seedGroups = new Set<string>();
      for (const id of [...objectScope]) {
        for (const edge of index.incidentEdges.get(id) ?? []) {
          if (!edgeIsEnabled(edge) || edge.membershipFor || !inLocalScope(edge.sourceNodeId) || !inLocalScope(edge.targetNodeId)) continue;
          explicitEdges.add(edge.edgeId); objectScope.add(edge.sourceNodeId); objectScope.add(edge.targetNodeId);
        }
        if (index.groupIds.has(id) && !contents.has(id)) seedGroups.add(id);
      }
      if (seedGroups.size) {
        // A folded group represents its descendants. Compare the two visible
        // ends so a relation entirely inside the fold does not become a hop.
        const owners = new Map<string, string | undefined>();
        function seedOwner(group: string): string | undefined {
          if (owners.has(group)) return owners.get(group);
          const parent = parents.get(group);
          const ancestor = parent && seedOwner(parent);
          const owner = ancestor && !expanded(ancestor) ? ancestor : seedGroups.has(group) ? group : undefined;
          owners.set(group, owner);
          return owner;
        }
        for (const relation of index.relations.values()) {
          const source = seedOwner(relation.sourceSubgraphId), target = seedOwner(relation.targetSubgraphId);
          if (source !== target && (source || target)) relationScope.add(relation.id);
        }
      }
    }
    for (const id of objectScope) if (inLocalScope(id)) show(id);
  } else {
    for (const id of index.groupIds) groupIds.add(id);
    for (const id of index.nodeIds) if (expanded(parents.get(id)!) && inLocalScope(id)) nodeIds.add(id);
  }
  groupIds.add(rootId);
  // Explicit cross-relation endpoints can later be added to a folded group.
  // Those exceptions must not expose extra internal edges based on array order.
  const ordinaryNodes = new Set(nodeIds);
  const ordinaryEndpointVisible = (id: string) => index.groupIds.has(id) || ordinaryNodes.has(id);
  const partial = new Map<string,Set<string>>(), residual = new Map<string,string[]>();
  for (const edge of index.edgesById.values()) {
    const { sourceNodeId: a, targetNodeId: b, edgeId } = edge;
    if (!edgeIsEnabled(edge) || !inLocalScope(a) || !inLocalScope(b)) continue;
    const relationId = index.relationOfEdge.get(edgeId);
    const touchesContents = contents.has(a) || contents.has(b);
    const picked = touchesContents || explicitEdges.has(edgeId);
    if (scope !== 'all' && !picked && !(relationId && relationScope.has(relationId))) continue;
    const localMode = relationId ? lookup(state.relations, relationId)?.mode : undefined;
    if (relationId && (!picked || localMode === 'aggregate' || (touchesContents && localMode === 'partial'))) {
      const settings = relationSettings(state,relationId);
      if (settings.mode === 'partial' && !partial.has(relationId)) partial.set(relationId,new Set(settings.memberIds));
      if (settings.mode === 'aggregate' || (settings.mode === 'partial' && !partial.get(relationId)!.has(edgeId))) {
        const list = residual.get(relationId);
        if (list) list.push(edgeId); else residual.set(relationId,[edgeId]);
        continue;
      }
    } else if (!picked) {
      const outside = index.edgeScopes.get(edgeId) === 'outside';
      if (outside ? !(ordinaryEndpointVisible(a)||ordinaryEndpointVisible(b)) : !(ordinaryEndpointVisible(a)&&ordinaryEndpointVisible(b))) continue;
    }
    edges.push(edge); show(a); show(b);
    if (touchesContents) { openPath(parents.get(a)); openPath(parents.get(b)); }
  }
  for (const [id,members] of residual) {
    const original = index.relations.get(id)!;
    relations.push(members.length === original.relationCount ? original : { ...original, memberEdgeIds: members, relationCount: members.length });
    show(original.sourceSubgraphId); show(original.targetSubgraphId);
    if (contents.has(original.sourceSubgraphId) || contents.has(original.targetSubgraphId)) {
      openPath(parents.get(original.sourceSubgraphId)); openPath(parents.get(original.targetSubgraphId));
    }
  }
  for (const id of groupIds) if (!openedForScope.has(id) && !expanded(id)) collapsedGroupIds.add(id);
  return { nodeIds, groupIds, collapsedGroupIds, edges, relations };
}
