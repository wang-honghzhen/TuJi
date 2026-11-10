import type { AppSnapshot, ChatMessage } from '../domain';
import type { Evidence } from './historyRepresentations';
import { sliceReferenceEdits, type ReferenceEdit } from './referenceFragments';

export const HISTORY_VIEW_VERSION = 2;

/** Resolve a recorded UI reference only against evidence already allowed by the caller. */
export function viewedContent(state: AppSnapshot, view: ChatMessage['viewedPart'], records: Evidence[], source?: Evidence) {
  const root = view && [...state.messages, ...state.snapshots.filter(s => !s.revoked).flatMap(s => s.messages)]
    .find(m => m.id === view.taskMessageId);
  const matches = root && view ? records.filter(r => r.taskId === root.taskId
    && (view.recordIds ? view.recordIds.includes(r.id) : r.part === view.part)
    && (!source || r.id !== source.id && (r.taskId !== source.taskId || r.order < source.order))) : [];
  return { records: matches.map(r => ({ summaryId: r.id, readWith: 'context_read_children' })),
    ...(matches.length ? {} : { unavailable: true }) };
}

interface Span { text: string; start: number; end: number }

/** Model-facing text has no historical display coordinates. Archive text, hashes and
 * coverage remain immutable; the small span map keeps paginated reads in archive coordinates.
 * Only application-owned message metadata is projected. User text (including “第3段”)
 * and domain data are never searched or rewritten.
 */
export function historicalRecordView(state: AppSnapshot, record: Evidence, allowed: Evidence[],
  start = 0, end = record.text.length) {
  let value: Record<string, unknown> | undefined;
  try { value = JSON.parse(record.text); } catch { /* Source fragments may be plain text. */ }
  const spans: Span[] = [];
  let reference: ReturnType<typeof viewedContent> | undefined;
  if (value && typeof value.role === 'string' && typeof value.text === 'string'
    && ('viewedPart' in value || 'viewedPartUnavailable' in value) && JSON.stringify(value) === record.text) {
    spans.push({ text: '{', start: 0, end: 1 });
    let offset = 1, retained = 0;
    Object.entries(value).forEach(([key, item], i) => {
      const comma = offset;
      if (i) offset++;
      const original = JSON.stringify(key) + ':' + JSON.stringify(item);
      if (key === 'viewedPart' || key === 'viewedPartUnavailable') {
        // Every text fragment needs the referent, even when the stored metadata is in a later slice.
        reference = key === 'viewedPart' ? viewedContent(state, item as ChatMessage['viewedPart'], allowed, record)
          : reference ?? { records: [], unavailable: true };
      } else {
        if (retained++) spans.push({ text: ',', start: comma, end: comma + 1 });
        spans.push({ text: original, start: offset, end: offset + original.length });
      }
      offset += original.length;
    });
    spans.push({ text: '}', start: offset, end: offset + 1 });
  } else spans.push({ text: record.text, start: 0, end: record.text.length });
  // Even clipped metadata fields are removed. Reference entries live outside the source body.
  const selected = spans.flatMap(span => {
    const a = Math.max(start, span.start), b = Math.min(end, span.end);
    if (b <= a) return [];
    return [{ start: a, end: b, text: span.text.slice(a - span.start, b - span.start) }];
  });
  const text = selected.map(s => s.text).join('');
  return { text, ...(reference ? { viewedContent: reference } : {}), referenceEdits(edits:ReferenceEdit[]) {
    let offset=0;
    return selected.flatMap(span=>{
      const projected=sliceReferenceEdits(edits,span.start,span.end).map(edit=>({...edit,start:offset+edit.start,end:offset+edit.end}));
      offset+=span.text.length;return projected;
    });
  }, sourceRange(from: number, to: number) {
    let offset = 0;
    const covered = selected.flatMap(span => {
      const a = Math.max(from, offset), b = Math.min(to, offset + span.text.length), base = offset;
      offset += span.text.length;
      return b <= a ? [] : [{ start: span.start + a - base, end: span.start + b - base }];
    });
    return covered.length ? { start: covered[0].start, end: covered.at(-1)!.end } : { start, end: start };
  } };
}
