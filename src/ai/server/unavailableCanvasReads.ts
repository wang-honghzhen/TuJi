import type { AppSnapshot, ProtocolMessage, Task, ToolCallRecord } from '../domain';
import type { ContextStage, PromptEntry } from '../contextState';
import { digest, graphIndex } from './directGraph';
import { decodeGraphReference } from './graphReferences';
import { graphTables } from './graphReadTables';
import type { SourceChange } from './sourceFreshness';
import type { GraphReadContext } from './graphReadContext';

/** Called only when the scoped graph_read rejected these exact canonical arguments. */
export function unavailableReadReceipt(call: ToolCallRecord, canvasId: string): NonNullable<ToolCallRecord['unavailableRead']> {
  return { version: 1, canvasId, digest: digest([canvasId, call.taskId, call.id, call.arguments, call.result]) };
}

function failureRefs(text: string): string[] {
  const result = JSON.parse(text);
  const refs = result?.details?.failedRefs;
  return result?.code === 'OUT_OF_SCOPE' && result.status === 'error' && result.details.executed === false
    && Array.isArray(refs) && refs.every(id => typeof id === 'string') ? refs : [];
}

export function verifiedUnavailableReadRefs(call: ToolCallRecord, canvasId: string): string[] {
  const receipt = call.unavailableRead;
  if (call.name !== 'graph_read' || call.status !== 'rejected' || !call.result ||
      receipt?.version !== 1 || receipt.canvasId !== canvasId || receipt.digest !== unavailableReadReceipt(call, canvasId).digest) return [];
  try { return failureRefs(call.result); } catch { return []; }
}

function resultText(message: ProtocolMessage, call: ToolCallRecord, decode: (id: string) => string) {
  if (message.role === 'tool' && message.toolCallId === call.providerCallId) return message.content;
  if (message.role !== 'user') return;
  const material = JSON.parse(message.content)?.historical_material;
  if (typeof material?.recordId !== 'string' || decode(material.recordId) !== call.id || typeof material.content !== 'string') return;
  const record = JSON.parse(material.content);
  if (record?.function === call.name && record.bodyOmitted === false && typeof record.result === 'string') return record.result;
}

function deliveredRefs(entry: PromptEntry, call: ToolCallRecord, refs: string[], decode: (id: string) => string) {
  for (const [i, message] of entry.messages.entries()) {
    try {
      const body = resultText(message, call, id => id);
      if (!body || body !== call.result) continue;
      if (!entry.wireMessages) return refs;
      const projected = entry.wireMessages[i];
      if (!projected) continue;
      const shown = resultText(projected, call, decode);
      if (!shown) continue;
      // Historical execution records can retain their original raw result string.
      if (shown === body) return refs;
      const visible = new Set(failureRefs(shown).map(decode));
      return refs.filter(ref => visible.has(ref));
    } catch { /* Malformed archive/projection is not evidence. */ }
  }
  return [];
}

function visibleUnavailableRefs(state: AppSnapshot, task: Task, stage: ContextStage, context?: GraphReadContext): Set<string> {
  const refs = new Set<string>();
  const candidates = state.toolCalls.filter(call => call.taskId === task.id && call.name === 'graph_read'
    && call.status === 'rejected' && call.unavailableRead?.version === 1 && call.unavailableRead.canvasId === task.canvasId);
  if (!candidates.length || !state.graph?.canvases.some(c => c.canvasId === task.canvasId)) return refs;
  const calls = new Map(candidates.map(c => [c.id, c]));
  const index = graphIndex(state, task.canvasId, context), edges = graphTables(index).edges;
  const decode = (id: string) => decodeGraphReference(state, task.canvasId, task.sessionId, id);
  for (const entry of stage.entries) {
    if (entry.representation !== 'body') continue;
    for (const id of entry.readCallIds ?? []) {
      const call = calls.get(id);
      if (!call) continue;
      const failed = verifiedUnavailableReadRefs(call, task.canvasId);
      if (!failed.length) continue;
      for (const ref of deliveredRefs(entry, call, failed, decode))
        if (!index.rows.has(ref) && !edges.has(ref)) refs.add(ref);
    }
  }
  return refs;
}

function isAcknowledgedUnavailable(change: SourceChange, refs: ReadonlySet<string>): boolean {
  const { source } = change;
  return change.state === 'unavailable' && refs.has(source.id) && ['node', 'document', 'edge'].includes(source.kind)
    && source.tracking !== 'historical' && (!source.unavailableReason || source.unavailableReason === 'source_unavailable');
}

/** One prompt build shares these exact deliveries across canvas, notebook and summary notices. */
export function canvasAvailability(state: AppSnapshot, task: Task, stage: ContextStage, context?: GraphReadContext) {
  const refs = visibleUnavailableRefs(state, task, stage, context), settled = new Set<string>();
  function coversChange(canvasId: string, change: Record<string, unknown>) {
    return canvasId === task.canvasId && change.kind !== 'query' && change.kind !== 'unknown'
      && typeof change.refId === 'string' && refs.has(change.refId);
  }
  function settleSource(change: SourceChange) {
    if (!isAcknowledgedUnavailable(change, refs)) return false;
    settled.add(change.source.id);
    return true;
  }
  return { refs, settled, coversChange, settleSource };
}
