import type { GraphReadContext } from './graphReadContext';
import { graphQueryDependency } from './graphQueries';
import type { GraphState } from '@/v3/types';
import type { FrozenRead, Observation } from '../contextState';
import type { ProtocolMessage, SourceRef, Task, ToolCallRecord } from '../domain';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex } from './canvasView';
import { requireValue } from './errors';
import { semanticHashes } from './graph';
import { hash } from './repository';
import { currentRelationHashes, relationDependency, relationDependencyKey } from './graphRelationDependencies';
import { captureSubgraphHashes, subgraphDependency } from './subgraphVersions';
import { fullyObservedNodeIds } from './canvasReadEvidence';

export const GRAPH_READ_DEPENDENCIES_VERSION = 4;
export type GraphReadHashes = Record<string, string>;

/** Capture from the graph that produced the payload, never from a later live graph. */
export function captureGraphReadHashes(graph: GraphState, sources: SourceRef[], directoryRefs: string[] = [], canvasId?:string): GraphReadHashes {
  const result: GraphReadHashes = {};
  if(canvasId){
    const index=canvasIndex(graph,canvasId,canvasMemberIds(graph,canvasId));
    for(const source of sources){
      if((source.kind==='node'||source.kind==='edge')&&typeof source.version==='string')result[`${source.kind==='node'?'nodes':'edges'}:${source.id}`]=source.version;
      if(source.kind==='document')Object.assign(result,captureSubgraphHashes(index,[source.id],'content'));
      if(source.kind==='node'||source.kind==='document')Object.assign(result,captureSubgraphHashes(index,[source.id],'path'));
    }
    Object.assign(result,captureSubgraphHashes(index,directoryRefs,'members'));
    return result;
  }
  const rememberCanvas = (canvas: GraphState['canvases'][number]) => {
    const key = `canvases:${canvas.canvasId}:structure`;
    result[key] ??= hash([canvas.childIds, canvas.directories, canvas.excludedDocumentIds, canvas.nodeReferenceIds, canvas.isDraft]);
  };
  for (const source of sources) {
    if (source.kind === 'node' || source.kind === 'edge') {
      // These source versions already hash the complete object, including design fields.
      if (typeof source.version === 'string') result[`${source.kind === 'node' ? 'nodes' : 'edges'}:${source.id}`] = source.version;
    } else if (source.kind === 'document') {
      const document = graph.documents[source.id];
      const canvas = graph.canvases.find(value => value.directories[source.id]);
      const value = document ?? canvas?.directories[source.id];
      requireValue(value && source.version === hash(value), '目录读取版本已变化，请重新读取', 'VERSION_CONFLICT',
        { failedRefs: [source.id], executed: false, nextAction: 'reread_before_proposing' });
      // A document source hashes the whole record; it is not a semantic content hash.
      if (document) {
        result[`documents:${source.id}:content`] = hash([document.name, document.metadata.description]);
        result[`documents:${source.id}:structure`] = hash([document.kind, document.childNodeIds, document.childDocumentIds]);
      } else if (canvas) rememberCanvas(canvas);
    }
  }
  for (const ref of directoryRefs) {
    const canvas = graph.canvases.find(value => value.canvasId === ref || value.directories[ref]);
    if (canvas) rememberCanvas(canvas);
    else if (graph.documents[ref]) {
      const document = graph.documents[ref];
      result[`documents:${ref}:structure`] = hash([document.kind, document.childNodeIds, document.childDocumentIds]);
    }
  }
  return result;
}

/** Old observations without a bound version must be reread, never rebound to live state. */
export function observationReadHashes(graph: GraphState, observation: Observation): GraphReadHashes {
  if (observation.structureOnly) return observation.graphReadDependenciesVersion===GRAPH_READ_DEPENDENCIES_VERSION?observation.readHashes??{}:{};
  const unverifiedRelations = Object.fromEntries([...new Set([...observation.sources.filter(s => s.kind === 'node').map(s => s.id), ...observation.refs.filter(ref => graph.nodes[ref])])]
    .map(ref => [relationDependencyKey(observation.canvasId, ref), 'unverified-read-version']));
  if (observation.readHashes) return observation.graphReadDependenciesVersion === GRAPH_READ_DEPENDENCIES_VERSION ? observation.readHashes
    : { ...observation.readHashes, ...unverifiedRelations };
  const result: GraphReadHashes = {};
  for (const source of observation.sources) {
    if (source.kind === 'node' || source.kind === 'edge') {
      if (typeof source.version === 'string') result[`${source.kind === 'node' ? 'nodes' : 'edges'}:${source.id}`] = source.version;
    } else if (source.kind === 'document') {
      const canvas = graph.canvases.find(value => value.directories[source.id]);
      result[canvas ? `canvases:${canvas.canvasId}:structure` : `documents:${source.id}:content`] = 'unverified-read-version';
    }
  }
  return { ...result, ...unverifiedRelations };
}

/** A changed query/path must not discard a fresh object body actually included in the same input. */
export function currentObservationReadHashes(graph: GraphState, observations: Observation[], canvasId: string, context?: GraphReadContext): GraphReadHashes {
  observations=observations.filter(o=>!o.evidenceUnknown);
  const captured = observations.map(o => observationReadHashes(graph, o));
  const keys = [...new Set(captured.flatMap(h => Object.keys(h)))];
  const current = { ...semanticHashes(graph), ...currentRelationHashes(graph, keys, context) }, members = canvasMemberIds(graph, canvasId);
  const index=context?.graph===graph?context.index(canvasId):canvasIndex(graph,canvasId,members);
  return Object.assign(Object.fromEntries(fullyObservedNodeIds(index,observations).map(id=>[`nodes:${id}`,hash(graph.nodes[id])])), ...captured.map(h => Object.fromEntries(Object.entries(h).filter(([key, version]) => {
    const { kind, refId } = dependencyIdentity(key);
    return current[key] === version && (kind === 'canvases' || !!refId && members.has(refId));
  }))));
}

/** Called only after the payload was admitted. A fresh read can replace an old binding. */
export function rememberGraphReadHashes(task: Task, hashes: GraphReadHashes, historical = false): void {
  const remembered = task.readHashes ??= {};
  for (const [key, version] of Object.entries(hashes)) {
    // Historical comparisons can establish an old binding, but never roll back a live reread.
    if (!historical || remembered[key] === undefined) remembered[key] = version;
  }
}

export function advanceResponseReadHashes(task: Task, before: GraphState, after: GraphState): void {
  const expected = task.responseReadHashes?.hashes; if (!expected) return;
  const keys = Object.keys(expected);
  const old = { ...semanticHashes(before), ...currentRelationHashes(before, keys) };
  const current = { ...semanticHashes(after), ...currentRelationHashes(after, keys) };
  for (const key of keys) if (expected[key] === old[key] && old[key] !== current[key]) {
    if (current[key] === undefined) delete expected[key]; else expected[key] = current[key];
  }
  for (const [key, version] of Object.entries(current)) if (!key.endsWith(':view') && old[key] !== version && expected[key] === undefined) expected[key] = version;
}

export function hasGraphReadDependencies(read: FrozenRead): boolean {
  return read.graphReadDependenciesVersion === GRAPH_READ_DEPENDENCIES_VERSION
    && read.pageReadHashes?.length === read.pages.length;
}

export function frozenGraphReadHashes(read: FrozenRead, page: number): GraphReadHashes {
  requireValue(hasGraphReadDependencies(read), '分页快照缺少读取版本信息，请从原入口重新读取', 'CURSOR_EXPIRED');
  return read.pageReadHashes![page - 1];
}

/** Live rereads may reuse a page only while all versions it binds are still current. */
export function graphReadDependenciesCurrent(graph: GraphState, read: FrozenRead): boolean {
  if (!hasGraphReadDependencies(read)) return false;
  const current = { ...semanticHashes(graph), ...currentRelationHashes(graph, read.pageReadHashes!.flatMap(page => Object.keys(page))) };
  return read.pageReadHashes!.every(page => Object.entries(page).every(([key, version]) => current[key] === version));
}

export function dependencyIdentity(key: string) {
  const query=graphQueryDependency(key);if(query)return {kind:'canvases',refId:query.canvasId};
  const subgraph=subgraphDependency(key);if(subgraph)return {kind:'subgraphs',refId:subgraph.refId,part:subgraph.part};
  const relation = relationDependency(key);
  if (relation) return { kind: 'relations', refId: relation.refId };
  const match = /^(nodes|edges):(.+)$/.exec(key) ?? /^(documents|canvases):(.+):(content|structure|view)$/.exec(key);
  return { kind: match?.[1], refId: match?.[2] };
}

/** Explicitly scoped proposals still protect command targets, their relations and active progress. */
export function scopedGraphReadHashes(graph: GraphState, task: Task, commands: Record<string, unknown>[],
  extraRefs: string[] | undefined, activeRefs: string[] = []): GraphReadHashes {
  if (extraRefs === undefined) return { ...task.readHashes };
  const selected = new Set([...extraRefs, ...activeRefs]);
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && ['id','parentId','nodeId','sourceNodeId','targetNodeId','ids','memberIds','subjectIds','addMemberIds','removeMemberIds','addSubjectIds','removeSubjectIds'].includes(key)) selected.add(value);
    else if (Array.isArray(value)) value.forEach(item => visit(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  commands.forEach(command => visit(command));
  const members = canvasMemberIds(graph, task.canvasId), index = canvasIndex(graph, task.canvasId, members);
  const queue = [...selected];
  for (let at = 0; at < queue.length; at++) for (const child of index.rows.get(queue[at])?.children ?? [])
    if (!selected.has(child)) { selected.add(child); queue.push(child); }
  for (const edge of graph.edges) if (selected.has(edge.sourceNodeId) || selected.has(edge.targetNodeId)) selected.add(edge.edgeId);
  for (const ref of [...selected]) {
    const edge = graph.edges.find(e => e.edgeId === ref);
    if (edge) { selected.add(edge.sourceNodeId); selected.add(edge.targetNodeId); }
  }
  for (const ref of extraRefs) {
    requireValue(members.has(ref), '操作依据不在当前画布范围', 'OUT_OF_SCOPE', { failedRefs: [ref], executed: false });
    requireValue(Object.keys(task.readHashes ?? {}).some(key => dependencyIdentity(key).refId === ref),
      '操作依据尚未读取', 'READ_REQUIRED', { failedRefs: [ref], executed: false, readWith: { tool: 'graph_read', arguments: { refs: [ref] } } });
  }
  return Object.fromEntries(Object.entries(task.readHashes ?? {}).filter(([key]) => {
    const identity = dependencyIdentity(key);
    const group=subgraphDependency(key);
    if(group)return selected.has(group.refId);
    // Structural reads are conservative: structural operations may affect descendants not named in the command.
    return identity.kind === 'canvases' || key.endsWith(':structure') || !!identity.refId && selected.has(identity.refId);
  }));
}

export function assertGraphReadHashes(graph: GraphState, expected: GraphReadHashes, message: string, canvasId?: string): void {
  const current = { ...semanticHashes(graph), ...currentRelationHashes(graph, Object.keys(expected)) };
  const members = canvasId ? canvasMemberIds(graph, canvasId) : undefined;
  const unavailable = (key: string) => {
    const { kind, refId } = dependencyIdentity(key);
    return current[key] === undefined || Boolean(members && refId && kind !== 'canvases' && !members.has(refId))
      || Boolean(canvasId && (relationDependency(key)??subgraphDependency(key)) && (relationDependency(key)??subgraphDependency(key))!.canvasId !== canvasId);
  };
  const conflicts = Object.entries(expected).filter(([key, version]) => current[key] !== version || unavailable(key)).map(([key, expectedVersion]) => {
    const { kind, refId } = dependencyIdentity(key), inaccessible = unavailable(key);
    const group=subgraphDependency(key);
    return { ...(refId && kind !== 'canvases' ? { refId } : { scope: 'current_canvas' }), expectedVersion,
      currentVersion: inaccessible ? null : current[key], ...(inaccessible ? { unavailable: true } : {}),
      ...(kind === 'relations' ? { dependency: 'incident_edges' } : {}),
      ...(group?{dependency:['directory','path','owner'].includes(group.part)?'directory_data':'direct_data'}:{}),
      readWith: graphQueryDependency(key) && !inaccessible ? graphQueryDependency(key)!.query : kind === 'canvases' || inaccessible ? { tool: 'graph_read_subgraph', arguments: {} }
        : group ? ['name','design'].includes(group.part)?{tool:'graph_read_object_field',arguments:{refId:group.refId,field:group.part}}:graph.nodes[group.refId]?{tool:'graph_read',arguments:{refs:[group.refId]}}:
          {tool:['directory','path','owner'].includes(group.part)?'graph_read_directory':'graph_read_subgraph',arguments:refId===canvasId?{}:{refId}}
        : kind === 'relations' ? { tool: 'graph_read_node_edges', arguments: { refId } }
        : { tool: 'graph_read', arguments: { refs: refId ? [refId] : [] } } };
  });
  requireValue(!conflicts.length, message, 'VERSION_CONFLICT', {
    failedRefs: [...new Set(conflicts.flatMap(conflict => 'refId' in conflict ? [conflict.refId] : []))],
    conflicts, executed: false, nextAction: 'reread_before_proposing',
  });
}

/** An unavailable source can be released only after its actual receipt reached the model. */
export function acknowledgeDeletedGraphReads(graph: GraphState, task: Task, calls: ToolCallRecord[], messages: ProtocolMessage[]): void {
  const delivered = new Set(messages.filter(message => message.role === 'tool').map(message => message.toolCallId));
  const current = { ...semanticHashes(graph), ...currentRelationHashes(graph, Object.keys(task.readHashes ?? {})) };
  const members = canvasMemberIds(graph, task.canvasId);
  for (const call of calls) {
    if (call.taskId !== task.id || !delivered.has(call.providerCallId)) continue;
    let result: { code?: string; details?: { conflicts?: Array<{ refId?: string; unavailable?: boolean; expectedVersion?: string }> } };
    try { result = JSON.parse(call.result ?? '{}'); } catch { continue; }
    if (result.code !== 'VERSION_CONFLICT') continue;
    for (const conflict of result.details?.conflicts ?? []) if (conflict.unavailable && conflict.refId) {
      for (const [key, version] of Object.entries(task.readHashes ?? {})) {
        const ref = dependencyIdentity(key).refId;
        if (ref === conflict.refId && version === conflict.expectedVersion && (current[key] === undefined || !members.has(ref))) delete task.readHashes![key];
      }
    }
  }
}
