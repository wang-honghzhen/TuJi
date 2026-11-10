import type { GraphState } from '@/v3/types';
import type { AppSnapshot, MemorySnapshot, Task, ToolCallRecord } from '../domain';
import type { FrozenRead } from '../contextState';
import { canvasMemberIds } from '../canvasScope';
import { canvasIndex, type CanvasIndex } from './canvasView';
import { selectHistory } from './historyRepresentations';
import { allRetainedCalls, originResultId, isReceipted } from './readVisibility';
import { DIRECTORY_REPLAY_TOOLS, GRAPH_USAGE_TOOLS } from './toolContextKinds';
import { GRAPH_READ_LIMITS } from './graphReadLimits';
import { sourceVisible } from '../memory';

export interface DirectoryReplayRequest {
  schemaVersion: 1; canvasId: string; rootRefId: string;
  mode: 'children' | 'recursive'; requestedBudget: number;
}
/** Private evidence; read candidates become evidence only after actual delivery. */
export interface GraphUsageEvidence {
  canvasId: string; subgraphId: string; eventId: string; kind: 'read' | 'write'; sequence?: number;
  /** Stable event ownership, independent of a particular inherited snapshot path. */
  originTaskId?: string; originCallId?: string;
  /** Added only after host verification; the proof survives body/call material cleanup. */
  provenance?: { version: 1; localSessionId?: string; snapshotPaths?: Array<{ id: string; contentHash: string }> };
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const json = (value: string | undefined): Row | undefined => { try { return record(JSON.parse(value ?? 'null')); } catch { return undefined; } };
const successful = (value: Row | undefined) => !!value && (value.status === 'ok' || value.status === 'partial') && value.executed !== false;
function boundedUsage(values: GraphUsageEvidence[]): GraphUsageEvidence[] {
  let bytes = 0;
  return values.slice(0, GRAPH_READ_LIMITS.objects).filter(value => {
    bytes += Buffer.byteLength(JSON.stringify(value)); return bytes <= GRAPH_READ_LIMITS.sourceBytes;
  });
}

export function validDirectoryReplay(value: unknown): value is DirectoryReplayRequest {
  const r = record(value);
  return !!r && r.schemaVersion === 1 && typeof r.canvasId === 'string' && !!r.canvasId
    && typeof r.rootRefId === 'string' && !!r.rootRefId && (r.mode === 'children' || r.mode === 'recursive')
    && Number.isSafeInteger(r.requestedBudget) && Number(r.requestedBudget) > 0;
}
export function directoryReplayRequest(canvasId: string, rootRefId: string, mode: 'children' | 'recursive', requestedBudget: number): DirectoryReplayRequest {
  return { schemaVersion: 1, canvasId, rootRefId, mode, requestedBudget: Math.max(1, Math.floor(requestedBudget)) };
}

/** A legacy page can be converted only from an explicitly identified direct directory list. */
export function frozenDirectoryReplay(read: FrozenRead, page: number): DirectoryReplayRequest | undefined {
  const data = record(read.pages[page - 1]);
  if (!data || !['graph_read_directory', 'graph_read_directory_children'].includes(read.kind)) return;
  if (data.listOnly !== true || typeof data.scope !== 'string'
    || !['graph_read_directory', 'directory_children'].includes(String(data.kind))) return;
  if (read.directoryReplay !== undefined && !validDirectoryReplay(read.directoryReplay)) return;
  if (read.directoryReplay && (read.directoryReplay.canvasId !== read.canvasId
    || read.directoryReplay.rootRefId !== data.scope || read.directoryReplay.mode !== 'children')) return;
  const budget = read.directoryReplay?.requestedBudget ?? read.pageBudget;
  if (!Number.isSafeInteger(budget) || Number(budget) <= 0) return;
  return directoryReplayRequest(read.canvasId, data.scope, 'children', Number(budget));
}

/** No prose parsing: only delivered business payload fields in known read result shapes count. */
export function graphReadUsage(index: CanvasIndex, tool: string, data: unknown, eventId: string): GraphUsageEvidence[] {
  if (GRAPH_USAGE_TOOLS[tool] !== 'read') return [];
  const found = new Set<string>(); let visited = 0;
  const visit = (value: unknown) => {
    if (++visited > GRAPH_READ_LIMITS.objects) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = record(value);
    if (!row || row.executed === false || row.status !== undefined && !['ok', 'partial'].includes(String(row.status))) return;
    if (tool === 'graph_read_subgraph' && row.kind === 'graph_read_subgraph') {
      const subgraph = record(row.subgraph), scope = subgraph?.refId;
      if (typeof scope === 'string' && index.rows.get(scope)?.readable) found.add(scope);
    }
    if(tool==='graph_read_design_references'&&['member','subject'].includes(String(row.kind)))for(const key of ['sourceNodeId','targetNodeId']){
      const node=typeof row[key]==='string'?index.rows.get(row[key] as string):undefined;if(node?.readable&&node.parentId)found.add(node.parentId);
    }
    const id = typeof row.refId === 'string' ? row.refId : undefined;
    // Names, paths and directory/version cards alone are navigation, not business use.
    const businessField = row.field === undefined || ['content', 'description', 'design', 'pros', 'cons'].includes(String(row.field));
    if (id && businessField && ('content' in row || 'description' in row || 'design' in row
      || row.field !== undefined && 'value' in row || tool === 'graph_read_node_edges' && 'relations' in row)) {
      const item = index.rows.get(id);
      if (item?.readable) { const subgraph = item.kind === 'node' ? item.parentId : item.id; if (subgraph) found.add(subgraph); }
    }
    // Only known structural containers: never interpret arbitrary JSON inside node content/design.
    for (const key of ['items', 'nodes', 'edges', 'data', 'results']) if (key in row) visit(row[key]);
  };
  visit(data);
  return boundedUsage([...found].sort().map(subgraphId => ({ canvasId: index.canvasId, subgraphId, eventId, kind: 'read' })));
}

/** Capture ownership at the actual write, including deletion and both sides of a move. */
export function graphWriteUsage(before: GraphState, after: GraphState, canvasId: string, refs: readonly string[], eventId: string): GraphUsageEvidence[] {
  const found = new Set<string>();
  const indices = [before, after].map(graph => graph.canvases.some(canvas => canvas.canvasId === canvasId)
    ? canvasIndex(graph, canvasId, canvasMemberIds(graph, canvasId)) : undefined);
  const changed = new Set(refs.slice(0, GRAPH_READ_LIMITS.objects));
  // Canvas-only membership/name patches need not occur in ChangeSet.affectedRefs.
  // Compare the actual committed structure, not the unexecuted command arguments.
  const structural = (index: CanvasIndex | undefined, id: string) => {
    const row = index?.rows.get(id);
    return row ? JSON.stringify([row.kind, row.parentId, row.segments.at(-1)?.name,
      row.kind === 'node' ? undefined : [...row.children].sort()]) : undefined;
  };
  for (const id of new Set(indices.flatMap(index => index ? [...index.rows.keys()] : []))) {
    if (changed.size >= GRAPH_READ_LIMITS.objects) break;
    if (structural(indices[0], id) !== structural(indices[1], id)) changed.add(id);
  }
  for (const index of indices) {
    if (!index) continue;
    const edges = new Map(index.edges.map(edge => [edge.edgeId, edge]));
    for (const ref of changed) {
      const row = index.rows.get(ref);
      if (row?.readable) { const parent = row.kind === 'node' ? row.parentId : row.id; if (parent) found.add(parent); }
      const edge = edges.get(ref);
      if (edge) for (const nodeId of [edge.sourceNodeId, edge.targetNodeId]) {
        const endpoint = index.rows.get(nodeId); if (endpoint?.readable && endpoint.parentId) found.add(endpoint.parentId);
      }
    }
  }
  return boundedUsage([...found].sort().map(subgraphId => ({ canvasId, subgraphId, eventId, kind: 'write' })));
}

/** Frozen ownership is reused, but delivery belongs to this call, never to the old call. */
export function attachFrozenDirectoryEvidence(call: ToolCallRecord, read: FrozenRead, page: number): void {
  if (DIRECTORY_REPLAY_TOOLS[call.name] === 'directory_page') {
    const replay = frozenDirectoryReplay(read, page); if (replay) call.directoryReplay = replay;
  } else if (DIRECTORY_REPLAY_TOOLS[call.name] === 'directory' && validDirectoryReplay(read.directoryReplay)) {
    call.directoryReplay = { ...read.directoryReplay };
  }
  const usage = read.pageGraphUsage?.[page - 1];
  if (usage?.length && ['read', 'page'].includes(GRAPH_USAGE_TOOLS[call.name]))
    call.graphUsage = boundedUsage(usage.slice(0, GRAPH_READ_LIMITS.objects).map(value => ({ ...value, eventId: call.id })));
}

function visibleCalls(state: AppSnapshot, task: Task): ToolCallRecord[] {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const history = selectHistory(state, task, workspace.contextStage?.residentRoots, false);
  const allowed = new Set(history.records.map(r => r.id));
  const taskIds = new Set([task.id, ...history.turns.map(t => t.taskId), ...history.roots.flatMap(s => s.coverage.map(c => c.taskId))]);
  return allRetainedCalls(state).filter(c => taskIds.has(c.taskId) && (c.taskId === task.id || allowed.has(c.id)));
}

/** Authorization is wider than the selected prompt window, but never includes other sessions' live calls. */
const USAGE_PATH_LIMIT = 32;
function usageAuthority(state: AppSnapshot, task: Task) {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId);
  const local = new Set(state.tasks.filter(owner => owner.sessionId === task.sessionId && owner.workspaceId === task.workspaceId).map(owner => owner.id));
  const selected = new Set(workspace?.snapshotIds ?? []), snapshots = new Map<string, MemorySnapshot>();
  for (const snapshot of state.snapshots) if (workspace && selected.has(snapshot.id) && !snapshot.revoked
    && sourceVisible(state, task, snapshot.sourceRefs)) snapshots.set(snapshot.id, snapshot);
  return { local, snapshots };
}
function* authorizedUsageCalls(state: AppSnapshot, task: Task, authority: ReturnType<typeof usageAuthority>) {
  for (const call of state.toolCalls) if (authority.local.has(call.taskId))
    yield { call, provenance: { version: 1 as const, localSessionId: task.sessionId } };
  for (const snapshot of authority.snapshots.values()) {
    const sourceTasks = new Set(snapshot.sourceTaskIds);
    for (const call of snapshot.toolCalls ?? []) if (sourceTasks.has(call.taskId))
      yield { call, provenance: { version: 1 as const, snapshotPaths: [{ id: snapshot.id, contentHash: snapshot.contentHash }] } };
  }
}

function retainedProvenance(task: Task, entry: GraphUsageEvidence, authority: ReturnType<typeof usageAuthority>): GraphUsageEvidence['provenance'] | undefined {
  const proof = entry.provenance;
  if (proof?.version !== 1 || !entry.originTaskId || !entry.originCallId) return;
  const localSessionId = proof.localSessionId === task.sessionId && authority.local.has(entry.originTaskId) ? task.sessionId : undefined;
  const snapshotPaths = (proof.snapshotPaths ?? []).slice(0, USAGE_PATH_LIMIT).filter(path => {
    const snapshot = authority.snapshots.get(path.id);
    return snapshot?.contentHash === path.contentHash && snapshot.sourceTaskIds.includes(entry.originTaskId!);
  });
  return localSessionId || snapshotPaths.length ? { version: 1, ...(localSessionId ? { localSessionId } : {}),
    ...(snapshotPaths.length ? { snapshotPaths } : {}) } : undefined;
}
function mergeProvenance(a: GraphUsageEvidence['provenance'], b: NonNullable<GraphUsageEvidence['provenance']>): NonNullable<GraphUsageEvidence['provenance']> {
  const paths = [...new Map([...(a?.snapshotPaths ?? []), ...(b.snapshotPaths ?? [])].map(path => [path.id, path])).values()]
    .sort((left, right) => left.id.localeCompare(right.id)).slice(0, USAGE_PATH_LIMIT);
  const localSessionId = a?.localSessionId ?? b.localSessionId;
  return { version: 1, ...(localSessionId ? { localSessionId } : {}), ...(paths.length ? { snapshotPaths: paths } : {}) };
}

function confirmedUsage(call: ToolCallRecord, evidence: GraphUsageEvidence): GraphUsageEvidence | undefined {
  if (call.status !== 'completed' || evidence.eventId !== call.id && evidence.eventId !== originResultId(call)) return;
  if (evidence.kind === 'read') {
    if (!call.firstDelivery || !['read', 'page'].includes(GRAPH_USAGE_TOOLS[call.name])) return;
  } else if (evidence.kind !== 'write' || GRAPH_USAGE_TOOLS[call.name] !== 'write') return;
  return { canvasId: evidence.canvasId, subgraphId: evidence.subgraphId, eventId: evidence.eventId, kind: evidence.kind,
    sequence: evidence.kind === 'read' ? call.firstDelivery!.sequence : call.sequence,
    originTaskId: call.taskId, originCallId: originResultId(call) };
}

/** Revalidate retained facts without requiring old bodies or keeping an unbounded path list.
 * Any current legal snapshot containing the exact event is sufficient. Old untagged evidence
 * is upgraded only when the original structured event metadata can still prove its scope. */
export function filterDirectoryUsageEvidence(state: AppSnapshot, task: Task, evidence: readonly GraphUsageEvidence[]): GraphUsageEvidence[] {
  const input = boundedUsage(evidence.slice(0, GRAPH_READ_LIMITS.objects)), wanted = new Map<string, number[]>();
  const authority = usageAuthority(state, task), result = new Map<number, GraphUsageEvidence>();
  input.forEach((entry, i) => {
    if (entry.canvasId !== task.canvasId || entry.provenance && entry.provenance.version !== 1) return;
    const proof = retainedProvenance(task, entry, authority);
    if (proof) result.set(i, { ...entry, provenance: proof });
    for (const key of new Set([entry.eventId, ...(entry.originCallId ? [entry.originCallId] : [])])) {
      const indices = wanted.get(key) ?? []; indices.push(i); wanted.set(key, indices);
    }
  });
  for (const { call, provenance } of authorizedUsageCalls(state, task, authority)) {
    const indices = new Set([...(wanted.get(call.id) ?? []), ...(wanted.get(originResultId(call)) ?? [])]);
    if (!indices.size) continue;
    const actual = new Map(boundedUsage(call.graphUsage ?? []).flatMap(value => {
      const confirmed = confirmedUsage(call, value);
      return confirmed ? [[JSON.stringify([value.canvasId, value.subgraphId, value.kind]), confirmed] as const] : [];
    }));
    for (const i of indices) {
      const prior = input[i];
      if (prior.eventId !== call.id && prior.eventId !== originResultId(call)
        || prior.originTaskId !== undefined && prior.originTaskId !== call.taskId
        || prior.originCallId !== undefined && prior.originCallId !== originResultId(call)) continue;
      const confirmed = actual.get(JSON.stringify([prior.canvasId, prior.subgraphId, prior.kind]));
      if (confirmed) result.set(i, { ...confirmed, provenance: mergeProvenance(result.get(i)?.provenance, provenance) });
    }
  }
  return boundedUsage([...result].sort(([a], [b]) => a - b).map(([, value]) => value));
}

function replayFromCall(state: AppSnapshot, task: Task, call: ToolCallRecord): DirectoryReplayRequest | undefined {
  if (!DIRECTORY_REPLAY_TOOLS[call.name] || call.status !== 'completed' || !call.firstDelivery || isReceipted(state, call)) return;
  const result = json(call.result); if (!successful(result)) return;
  if (call.directoryReplay !== undefined) return validDirectoryReplay(call.directoryReplay) && call.directoryReplay.canvasId === task.canvasId ? { ...call.directoryReplay } : undefined;
  // Upgrade old reads only from matching frozen metadata, never by interpreting an omitted refId against today's root.
  const pointerId = result!.pointerId;
  const frozen = state.workspaces.find(w => w.id === task.workspaceId)?.frozenReads?.find(r => r.id === pointerId && r.canvasId === task.canvasId);
  if (!frozen) return;
  if (call.name === 'context_read_pages') return frozenDirectoryReplay(frozen, Number(result!.page));
  if (frozen.kind !== 'graph_read_directory') return;
  const data = record(frozen.pages[0]), args = json(call.arguments);
  if (!data || !args || typeof data.scope !== 'string' || !Number.isSafeInteger(frozen.pageBudget) || Number(frozen.pageBudget) <= 0) return;
  const mode = args.mode ?? 'recursive';
  if (mode !== 'recursive' && mode !== 'children') return;
  if (args.refId !== undefined && args.refId !== data.scope) return;
  if (mode === 'recursive' && data.kind !== 'directory_tree' || mode === 'children' && data.listOnly !== true) return;
  return directoryReplayRequest(task.canvasId, data.scope, mode, Number(frozen.pageBudget));
}

export function collectDirectoryReplaySources(state: AppSnapshot, task: Task, receiptIds: readonly string[]): Array<{ request: DirectoryReplayRequest; originCallId: string }> {
  const selected = new Set(receiptIds), result: Array<{ request: DirectoryReplayRequest; originCallId: string }> = []; let bytes = 0;
  for (const call of visibleCalls(state, task)) if (selected.has(originResultId(call))) {
    const request = replayFromCall(state, task, call);
    if (request) { const source = { request, originCallId: originResultId(call) }; bytes += Buffer.byteLength(JSON.stringify(source));
      if (bytes > GRAPH_READ_LIMITS.sourceBytes) break; result.push(source); }
    if (result.length >= GRAPH_READ_LIMITS.objects) break;
  }
  return result;
}

/** One verifiable event per displayed subgraph is enough; summaries need no old body. */
export function collectDirectoryUsageEvidence(state: AppSnapshot, task: Task, displayedSubgraphIds?: ReadonlySet<string>): GraphUsageEvidence[] {
  const found = new Map<string, GraphUsageEvidence>(); let bytes = 0;
  for (const call of visibleCalls(state, task)) {
    if (call.status !== 'completed') continue;
    for (const evidence of call.graphUsage ?? []) {
      if (evidence.canvasId !== task.canvasId || displayedSubgraphIds && !displayedSubgraphIds.has(evidence.subgraphId)) continue;
      if (found.has(evidence.subgraphId)) continue;
      const confirmed = confirmedUsage(call, evidence); if (!confirmed) continue;
      bytes += Buffer.byteLength(JSON.stringify(confirmed)); if (bytes > GRAPH_READ_LIMITS.sourceBytes) return [...found.values()];
      found.set(evidence.subgraphId, confirmed);
      if (found.size >= GRAPH_READ_LIMITS.objects) return [...found.values()];
    }
  }
  return [...found.values()];
}
