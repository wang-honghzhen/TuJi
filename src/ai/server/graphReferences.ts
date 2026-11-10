import type { AgentGraphReferences, AppSnapshot } from '../domain';
import type { GraphState } from '@/v3/types';
import { graphIdentities } from '@/v3/ids';
import { requireValue } from './errors';
import { canvasMemberIds } from '../canvasScope';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Canvas identities keep one table per canvas; every other kind lives in a per-session table. */
const CANVAS_PREFIXES = ['n', 'd', 'e', 'r'] as const;
const PREFIXES = ['n', 'd', 'e', 'r', 'f', 'w', 's', 'm', 't', 'c', 'p', 'g', 'o', 'h', 'k'] as const;
export type ReferencePrefix = typeof PREFIXES[number];
const pattern = new RegExp(`^[${PREFIXES.join('')}][1-9]\\d*$`);
const isCanvasPrefix = (prefix: string) => (CANVAS_PREFIXES as readonly string[]).includes(prefix);
const counters = () => ({ n: 1, d: 1, e: 1, r: 1, f: 1, w: 1, s: 1, m: 1, t: 1, c: 1, p: 1, g: 1, o: 1, h: 1, k: 1 });
export const emptyGraphReferences = (): AgentGraphReferences => ({ version: 1, aliases: {}, next: counters() });

/** Reserve short references for ids the model must hand back to a function, so it never
 *  has to copy a long raw id out of the prompt. Existing aliases are kept as they are. */
export function seedAddressableReferences(references: AgentGraphReferences, entries: Array<{ prefix: ReferencePrefix; id: string }>, taken = new Set(Object.values(references.aliases))) {
  for (const { prefix, id } of entries) {
    if (!id || taken.has(id) || isCanvasPrefix(prefix)) continue;
    let alias: string;
    do { alias = `${prefix}${references.next[prefix]++}`; } while (Object.hasOwn(references.aliases, alias));
    references.aliases[alias] = id; taken.add(id);
  }
}

export function canvasGraphReferences(state: AppSnapshot, canvasId: string, create = false): AgentGraphReferences | undefined {
  const tables = state.canvasGraphReferences;
  if (Object.hasOwn(tables, canvasId)) return tables[canvasId];
  if (!create) return undefined;
  requireValue(state.graph?.canvases.some(canvas => canvas.canvasId === canvasId), '短引用缺少所属画布', 'NOT_FOUND');
  const value = emptyGraphReferences();
  Object.defineProperty(tables, canvasId, { value, enumerable: true, configurable: true, writable: true });
  return value;
}

/** A single-source lineage shares allocation. Readers still enforce their own material scope. */
export function sessionGraphReferences(state: AppSnapshot, sessionId: string, create = false): AgentGraphReferences | undefined {
  state.sessionReferences ??= {};
  const tables = state.sessionReferences;
  const family = state.sessions.find(session => session.id === sessionId)?.referenceFamilyId ?? sessionId;
  if (Object.hasOwn(tables, family)) return tables[family];
  if (!create) return undefined;
  requireValue(state.sessions.some(session => session.id === sessionId), '短引用缺少所属会话', 'NOT_FOUND');
  const value = emptyGraphReferences();
  Object.defineProperty(tables, family, { value, enumerable: true, configurable: true, writable: true });
  return value;
}

/** The copy continues the visible object's handle, only on the canvas that was replaced. */
export function rebindCanvasReferences(state: AppSnapshot, canvasId: string, mapping: Record<string, string>) {
  const table = canvasGraphReferences(state, canvasId); if (!table || !state.graph) return 0;
  const members = canvasMemberIds(state.graph, canvasId), previous: Record<string, string> = {};
  for (const [alias, oldId] of Object.entries(table.aliases)) {
    const fresh = mapping[oldId];
    // If an original is still visible elsewhere here, the two objects must get distinct handles.
    if (!fresh || members.has(oldId) || !members.has(fresh)) continue;
    requireValue(!Object.values(table.aliases).includes(fresh), '副本短引用已经分配，请重新操作', 'REFERENCE_CONFLICT');
    previous[oldId] = alias; table.aliases[alias] = fresh;
  }
  if (Object.keys(previous).length) (table.history ??= []).push({ at: new Date().toISOString(), throughSequence: state.lastSeq, aliases: previous });
  return Object.keys(previous).length;
}

/** Re-render old structured records with their then-current handles, without rewriting evidence.
 * Re-importing the original allocates a new live handle; it cannot steal the copy's handle. */
export function historicalGraphEncoder(state: AppSnapshot, canvasId: string, createdAt: string,
  encode: (id: string) => string, sequence?: number): (id: string) => string {
  const history = state.canvasGraphReferences[canvasId]?.history;
  if (!history?.length) return encode;
  return id => {
    const binding = history.find(entry => Object.hasOwn(entry.aliases, id) &&
      (sequence !== undefined && sequence < 1e12 ? sequence <= entry.throughSequence : Date.parse(createdAt) <= Date.parse(entry.at)));
    return binding?.aliases[id] ?? encode(id);
  };
}

/** Look up both tables, since only allocation is routed by kind. */
export function decodeGraphReference(state: AppSnapshot, canvasId: string | undefined, sessionId: string | undefined, ref: string) {
  const session = sessionId ? sessionGraphReferences(state, sessionId)?.aliases : undefined;
  if (session && Object.hasOwn(session, ref)) return session[ref] ?? ref;
  const canvas = canvasId && Object.hasOwn(state.canvasGraphReferences ?? {}, canvasId) ? state.canvasGraphReferences?.[canvasId]?.aliases : undefined;
  return canvas && Object.hasOwn(canvas, ref) ? canvas[ref] ?? ref : ref;
}

export function graphReferenceCodec(graph: GraphState, canvas: AgentGraphReferences, session: AgentGraphReferences = canvas) {
  const tables = [canvas, session];
  const reverse = new Map<string, string>();
  for (const table of tables) for (const [alias, raw] of Object.entries(table.aliases)) if (!reverse.has(raw)) reverse.set(raw, alias);
  const existing = new Set(graphIdentities(graph));
  const protectedIds = new Set(graph.canvases.flatMap(canvas => [canvas.canvasId]));
  const known = (id: string) => existing.has(id) || reverse.has(id);
  const prefixOf = (id: string, hint?: string): ReferencePrefix => {
    if (graph.nodes[id]) return 'n';
    if (graph.edges.some(edge => edge.edgeId === id)) return 'e';
    if (graph.documents[id] || graph.canvases.some(canvas => canvas.directories[id])) return 'd';
    if (hint === 'node') return 'n';
    if (hint === 'edge') return 'e';
    if (hint === 'document') return 'd';
    return (hint && hintPrefixes[hint]) || 'r';
  };
  const encode = (id: string, hint?: string, missing = false): string => {
    if (protectedIds.has(id)) return id;
    if (reverse.has(id)) return reverse.get(id)!;
    if (!known(id) && !missing) return id;
    const prefix = prefixOf(id, hint);
    // Canvas objects are numbered per canvas; every other kind is numbered inside the session.
    const table = isCanvasPrefix(prefix) ? canvas : session;
    let alias: string;
    do {
      requireValue(Number.isSafeInteger(table.next[prefix]) && table.next[prefix] < Number.MAX_SAFE_INTEGER, '短引用编号已耗尽');
      alias = prefix + table.next[prefix]++;
    } while (Object.hasOwn(table.aliases, alias) || existing.has(alias) && alias !== id);
    table.aliases[alias] = id; reverse.set(id, alias); return alias;
  };
  const decode = (id: string, _hint?: string, strict = true): string => {
    for (const table of tables) if (Object.hasOwn(table.aliases, id)) return table.aliases[id];
    requireValue(!strict || !pattern.test(id) || existing.has(id), '短引用不存在于当前画布或会话，请使用当前资料中的引用', 'UNKNOWN_REFERENCE');
    return id;
  };
  /** True when this id carries a seeded reference (attachments, notes, summaries, messages,
   *  tool calls, chunks): those are prompt-only and must never be written back to storage. */
  const isAddressable = (id: string) => { const alias = reverse.get(id); return alias !== undefined && !isCanvasPrefix(alias[0]); };
  return { encode, decode, known, isAddressable, canvas, session };
}

type Translate = (id: string, hint?: string, missing?: boolean) => string;
const scalarRefs = new Set(['subgraphRef', 'rootRefId', 'membershipFor', 'refId', 'edgeId', 'nodeId', 'parentId', 'sourceNodeId', 'targetNodeId',
  // Ids the model hands back to a function: attachments, summaries, work notes, receipts, change sets.
  'taskMessageId', 'messageId', 'chunkId', 'artifactId', 'summaryId', 'noteId', 'pointerId', 'treeId', 'scopeId', 'blockId', 'changeSetId', 'operationId',
  'sourceRefId', 'targetRefId', 'sessionId', 'sourceSessionId', 'taskRef', 'currentTask', 'recordId', 'callId', 'originResultId', 'archiveEntry', 'archiveRef', 'taskId', 'originTaskId', 'stepId', 'toolCallId', 'scope']);
const arrayRefs = new Set(['addMemberIds','removeMemberIds','addSubjectIds','removeSubjectIds', 'dependencyRefs', 'memberIds', 'subjectIds', 'targets', 'missingIds', 'refs', 'requestedRefs', 'displayedRefs', 'notDisplayedRefs', 'remainingRefs', 'selectedRefs', 'selectedIds', 'targetRefs', 'targetIds', 'explicitReadRefs', 'affectedRefs', 'childIds', 'childNodeIds', 'childDocumentIds', 'ids', 'recordIds', 'summaryIds', 'displayedSummaries', 'remainingSummaries', 'alreadyDisplayed', 'changeSetIds', 'operationIds', 'relatedOperationIds', 'callIds', 'taskIds', 'stepIds', 'toolCallIds', 'children', 'sourceTasks', 'boundaries', 'failedRefs']);
export const isReferenceField=(key:string,array=false)=>array?arrayRefs.has(key):key==='id'||scalarRefs.has(key);
arrayRefs.add('unavailableRefs');
const graphKinds = ['node', 'document', 'edge'];
/** Objects whose own `id` names a record of a known series, so an unseeded id still gets the right prefix. */
const identityKinds = [...graphKinds, 'note', 'artifact', 'summary', 'result', 'graph_result', 'message', 'tool_call', 'toolCall', 'chunk', 'snapshot', 'session', 'task'];
/** Which number series an identity belongs to; anything unlisted falls back to the canvas one. */
const hintPrefixes: Record<string, ReferencePrefix> = { node: 'n', document: 'd', edge: 'e', artifact: 'f', note: 'w',
  summary: 's', result: 's', graph_result: 's', snapshot: 's', message: 'm', tool_call: 't', toolCall: 't', chunk: 'c', page:'p', change: 'g', operation: 'o', session:'h', task:'k' };
const fieldHints:Record<string,string>={taskMessageId:'message',messageId:'message',artifactId:'artifact',chunkId:'chunk',noteId:'note',
  callId:'tool_call',originResultId:'tool_call',archiveEntry:'tool_call',toolCallId:'tool_call',callIds:'tool_call',toolCallIds:'tool_call',
  sessionId:'session',sourceSessionId:'session',taskRef:'task',taskId:'task',originTaskId:'task',taskIds:'task',sourceTasks:'task',stepId:'operation',stepIds:'operation',
  summaryId:'summary',pointerId:'result',treeId:'summary',scopeId:'summary',
  displayedSummaries:'summary',remainingSummaries:'summary',alreadyDisplayed:'summary',
  changeSetId:'change',operationId:'operation',summaryIds:'summary',changeSetIds:'change',operationIds:'operation',relatedOperationIds:'operation'};
/** Translate structural references only. Never rewrite user text, names or JSON inside a node body. */
export function translateGraphPayload(value: unknown, translate: Translate, missingSources = false): unknown {
  if (Array.isArray(value)) return value.map(item => translateGraphPayload(item, translate, missingSources));
  if (!object(value)) return value;
  const result: Record<string, unknown> = {};
  const kind = String(value.kind);
  const source = graphKinds.includes(kind);
  // A rendered chat message carries its own id; it belongs to the same series as other messages.
  const message = typeof value.role === 'string';
  const hint = source || identityKinds.includes(kind) ? kind : message ? 'message'
    : kind === 'nodes' ? 'node' : kind === 'documents' ? 'document' : kind === 'edges' ? 'edge' : undefined;
  for (const [key, item] of Object.entries(value)) {
    // coverage.scope is an enum, unlike graph query scope (an object identity).
    if(key==='scope'&&item==='page'&&['full','partial','none'].includes(String(value.extent))&&Array.isArray(value.reasons)){
      result[key]=item;continue;
    }
    if(key==='__proto__') { Object.defineProperty(result,key,{value:translateGraphPayload(item,translate,missingSources),enumerable:true,writable:true,configurable:true});continue; }
    if (key === 'id' && value.kind === 'canvases') continue;
    // Any id that already carries a reference is shown as that reference — wherever it appears,
    // so a reference description never repeats its raw identity. A bare id never allocates one.
    if (typeof item === 'string' && (scalarRefs.has(key) || key === 'id')) result[key] = translate(item, fieldHints[key]??(key==='blockId'?'tool_call':hint), key === 'id' ? false : missingSources);
    else if (Array.isArray(item) && arrayRefs.has(key)) result[key] = item.map(ref => typeof ref === 'string' ? translate(ref, fieldHints[key], missingSources) : translateGraphPayload(ref, translate, missingSources));
    else if (key === 'temporaryRefs' && object(item)) result[key] = Object.fromEntries(Object.entries(item).map(([temp, ref]) => [temp, typeof ref === 'string' ? translate(ref, undefined, missingSources) : ref]));
    else result[key] = translateGraphPayload(item, translate, missingSources);
  }
  return result;
}

/** Old receipts can still name retired records. Reserve their display identities without
 * granting access, and never mistake an already-encoded argument for a new raw identity. */
export function seedPayloadReferences(references:AgentGraphReferences,value:unknown,taken?:Set<string>) {
  const entries:Array<{prefix:ReferencePrefix;id:string}>=[];
  translateGraphPayload(value,(id,hint)=>{
    const prefix=hint&&hintPrefixes[hint];
    if(prefix&&!isCanvasPrefix(prefix)&&!Object.hasOwn(references.aliases,id))entries.push({prefix,id});
    return id;
  });
  seedAddressableReferences(references,entries,taken);
}
