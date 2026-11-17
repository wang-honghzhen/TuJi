import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { Coverage, SummarySnapshot } from '../contextState';
import { selectedMessages } from '../memory';
import { digest } from './directGraph';
import { inheritedReadScope } from './inheritedReadScope';
import { verifiedDeliveryPage, type PageDeliveryEvidence } from './readDeliveryEvidence';
import { isDataRead } from './toolContextKinds';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const successful = (value: unknown): value is Row => object(value) && ['ok', 'partial'].includes(String(value.status))
  && value.executed !== false && value.bodyOmitted !== true;

/** These are historical receipts within one summary, never a current read ledger. */
export interface SummaryPageFact {
  callId: string;
  pointerId: string;
  page: number;
  totalPages: number;
  representation: 'body' | 'summary' | 'index' | 'mixed' | 'image' | 'unknown';
  freshnessAtDelivery: 'current' | 'stale' | 'unknown';
}

export const SUMMARY_PAGE_FACTS_INSTRUCTION = '仅记录本摘要完整覆盖且已交付的历史页；freshnessAtDelivery是交付当时的状态，unknown不等于stale；representation=unknown仅表示内容类型缺证。页码属于各自冻结指针，未列出不代表未读，末页不代表已读全量；这些回执不提供当前正文或写入权限。';

/** Frozen storage is temporary. A verified historical page must not acquire a
 * stronger content type merely because its live snapshot has been reclaimed. */
function receiptRepresentation(call: ToolCallRecord, page: PageDeliveryEvidence, result: Row): SummaryPageFact['representation'] {
  // This pointer-specific metadata is stamped only for pure summary deliveries.
  if (call.summaryOrigins?.some(origin => origin.pointerId === page.pointerId)
    || page.kind === 'summary_tree' || page.kind === 'summary_children') return 'summary';
  const data = result.data;
  if (page.kind === 'attachment_local') {
    const explicit = object(data) ? data.representation : undefined;
    if (explicit === 'index' || explicit === 'image') return explicit;
    if (explicit === 'text') return 'body';
    // attachmentRead is per call, unlike summaryOrigins. Do not apply the last
    // child's metadata across a batch containing several different pointers.
    const origins = call.readPageOrigins ?? [];
    const saved = origins.length && origins.every(origin => origin.pointerId === page.pointerId && origin.kind === page.kind)
      ? call.attachmentRead?.representation : undefined;
    if (saved === 'index' || saved === 'image') return saved;
    if (saved === 'text') return 'body';
    return page.representation === 'body' ? 'unknown' : page.representation;
  }
  const fragment = (value: unknown) => object(value) && typeof value.serializedResult === 'string' && object(value.resultFragment);
  const opaque = fragment(data) || object(data) && Object.values(data).some(value => Array.isArray(value) && value.some(fragment));
  // A record directory can accompany fragments of original or summary bodies;
  // its presence cannot determine the type of the opaque payload itself.
  if (opaque && page.representation !== 'summary' && page.kind !== 'graph_read_directory') return 'unknown';
  return page.representation;
}

/** Derive from immutable native results and their page proofs, never from summary prose.
 * No size cap: the entire projection participates in the final request benefit check. */
export function summaryReceiptFacts(state: AppSnapshot, task: Task, summary: SummarySnapshot): SummaryPageFact[] {
  state = inheritedReadScope(state, task);
  const workspace = state.workspaces.find(w => w.id === task.workspaceId);
  if (!workspace) return [];
  const tasks = new Set(state.tasks.filter(t => t.sessionId === task.sessionId).map(t => t.id));
  const visibleTasks = new Set([...tasks, ...selectedMessages(state, task).map(m => m.taskId)]);
  const memories = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
  // Match the existing prompt reference scope, including inherited record handles.
  const calls = new Map([...state.toolCalls.filter(c => tasks.has(c.taskId)),
    ...memories.flatMap(s => s.toolCalls ?? []).filter(c => visibleTasks.has(c.taskId))].map(c => [c.id, c]));
  const covered = new Map<string, Coverage[]>();
  for (const part of summary.coverage) {
    const parts = covered.get(part.recordId) ?? [];
    parts.push(part); covered.set(part.recordId, parts);
  }
  const facts = new Map<string, SummaryPageFact>();
  for (const [id, parts] of covered) {
    const call = calls.get(id);
    if (!call || call.status !== 'completed' || call.presentedAt === undefined || !isDataRead(call.name) || call.result === undefined) continue;
    // A fragment of a wrapper cannot prove that its result was included. The same
    // canonical bytes and digest are used by historyRepresentations.allEvidence.
    const text = JSON.stringify({ function: call.name, arguments: call.arguments, result: call.result, operationId: call.operationId });
    const version = digest(text);
    if (!parts.some(c => c.taskId === call.taskId && c.version === version && c.start === 0 && c.end === text.length)) continue;
    const visit = (value: unknown): void => {
      if (!successful(value)) return;
      // Do not visit data, note text, requestedCursor, or nextCursor: none proves delivery.
      if (typeof value.pointerId === 'string' && value.data !== undefined) {
        try {
          const page = verifiedDeliveryPage(state, call, value);
          if (page) {
            const freshnessAtDelivery = value.freshness === 'current' && value.stale === false ? 'current'
              : value.freshness === 'stale' && value.stale === true ? 'stale' : 'unknown';
            const fact: SummaryPageFact = { callId: call.id, pointerId: page.pointerId, page: page.page, totalPages: page.totalPages,
              representation: receiptRepresentation(call, page, value), freshnessAtDelivery };
            facts.set(JSON.stringify(fact), fact);
          }
        } catch { /* Malformed or no longer decodable provenance supplies no fact. */ }
      }
      if (Array.isArray(value.results)) value.results.forEach(visit);
    };
    try { visit(JSON.parse(call.result)); } catch { /* Legacy non-JSON results supply no page facts. */ }
  }
  return [...facts.values()];
}
