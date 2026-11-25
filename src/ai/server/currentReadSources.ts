import type { Observation } from '../contextState';
import type { SourcePrecondition, SourceRef } from '../domain';
import type { CanvasIndex } from './canvasView';
import { canvasFactCovered, canvasField, canvasKey, deliveredCanvasFacts, fullyObservedNodeIds } from './canvasReadEvidence';
import { graphTables } from './graphReadTables';
import { equivalentSubgraphVersion, subgraphDependency, subgraphKey, subgraphVersion } from './subgraphVersions';
import type { Coverage } from '../contextState';
import type { Evidence } from './historyRepresentations';

type DocumentRead = NonNullable<SourcePrecondition['documentRead']>;
const documentSourceKey = (s: SourceRef) => JSON.stringify([s.id, s.version, s.start, s.end]);

/** An independently cited whole record must not be narrowed by a coincidental read of the same ID. */
export function archivedDocumentReads(coverage: Coverage[], records: Map<string, Evidence>, observations: Observation[]) {
  const byCall = new Map<string, Observation[]>();
  for (const observation of observations) if (observation.callId) {
    const group = byCall.get(observation.callId) ?? [];
    group.push(observation); byCall.set(observation.callId, group);
  }
  const proof = new Map<string, Observation[] | null>();
  for (const span of coverage) {
    const record = records.get(span.recordId);
    if (!record) continue;
    const complete = record.version === span.version && record.taskId === span.taskId && span.start === 0 && span.end === record.text.length;
    for (const source of record.sources) if (source.kind === 'document') {
      const key = documentSourceKey(source);
      if (proof.get(key) === null) continue;
      const matching = byCall.get(record.id)?.filter(o => o.sources.some(s =>
        s.kind === 'document' && documentSourceKey(s) === key));
      if (!complete || !matching?.length || matching.some(o => o.evidenceUnknown)) proof.set(key, null);
      else proof.set(key, [...proof.get(key) ?? [], ...matching]);
    }
  }
  return (source: SourceRef) => proof.get(documentSourceKey(source)) ?? [];
}

/** Confine all replacements to one candidate's verified, actually displayed deliveries. */
export function currentGraphReadSources(index: CanvasIndex, observations: Observation[]) {
  const visible = observations.filter(o => !o.evidenceUnknown && o.canvasId === index.canvasId);
  let facts: ReturnType<typeof deliveredCanvasFacts> | undefined;
  let fullNodes: Set<string> | undefined;
  const tables = graphTables(index);
  function body(source: SourceRef): SourceRef | undefined {
    if (source.unavailableReason || source.tracking === 'historical') return;
    if (source.kind !== 'edge' && source.kind !== 'node') return;
    const fresh = tables.source(source.id);
    if (fresh?.kind !== source.kind) return;
    if (source.kind === 'node') {
      fullNodes ??= new Set(fullyObservedNodeIds(index, visible));
      if (!fullNodes.has(source.id)) return;
    } else {
      const field = 'edge', version = canvasKey(canvasField(index, source.id, field));
      const origins = visible.filter(o => o.sources.some(s =>
        s.kind === 'edge' && s.id === source.id && s.version === fresh.version));
      const edgeFacts = deliveredCanvasFacts(index, origins).filter(f => f.refId === source.id && f.field === field && f.version === version);
      if (!canvasFactCovered({ refId: source.id, field, version }, edgeFacts)) return;
    }
    return { ...source, version: fresh.version };
  }

  function document(source: SourceRef, archived: Observation[]): SourcePrecondition {
    if (source.kind !== 'document' || source.tracking === 'historical' || source.unavailableReason) return source;
    if (!archived.length || archived.some(o => o.canvasId !== index.canvasId || o.evidenceUnknown || !o.canvasFacts?.length)) return source;
    facts ??= deliveredCanvasFacts(index, visible);
    const fields: DocumentRead['fields'] = [], parts: DocumentRead['parts'] = [];
    for (const origin of archived) {
      for (const old of origin.canvasFacts ?? []) {
        if (old.refId !== source.id) continue;
        const {field, start, end, total} = old, current = canvasKey(canvasField(index, source.id, field));
        const newer = facts.filter(f => f.refId === source.id && f.field === field && f.version === current);
        const version = current === old.version || canvasFactCovered(old, newer) ? current : old.version;
        fields.push({ field, version, ...(start !== undefined ? { start, end, total } : {}) });
      }
      for (const [key, old] of Object.entries(origin.readHashes ?? {})) {
        const dependency = subgraphDependency(key);
        if (dependency?.canvasId !== index.canvasId || dependency.refId !== source.id) continue;
        const part = dependency.part, current = subgraphVersion(index, source.id, part);
        const refreshed = current !== undefined && visible.some(o => equivalentSubgraphVersion(o.readHashes?.[key], current));
        parts.push({ part, version: refreshed ? current : old });
      }
    }
    if (!fields.some(f => f.field !== 'existence') || !parts.length) return source;
    const distinct = <T>(values: T[]) => [...new Map(values.map(v => [canvasKey(v), v])).values()];
    return { ...source, documentRead: { protocol: 1, canvasId: index.canvasId, fields: distinct(fields), parts: distinct(parts) } };
  }
  return { body, document };
}

/** Layout and revision counters are independent from the fields and subgraph domains seen by this read. */
export function currentDocumentRead(index: CanvasIndex, source: SourcePrecondition): boolean {
  const read = source.documentRead;
  const row = index.rows.get(source.id);
  if (read?.protocol !== 1 || read.canvasId !== index.canvasId || !row?.readable || !['document','subgraph'].includes(row.kind) ||
      !Array.isArray(read.fields) || !read.fields.length || !Array.isArray(read.parts) || !read.parts.length) return false;
  return read.fields.every(f => canvasKey(canvasField(index, source.id, f.field)) === f.version) &&
    read.parts.every(p => subgraphDependency(subgraphKey(index.canvasId, source.id, p.part)) &&
      equivalentSubgraphVersion(p.version, subgraphVersion(index, source.id, p.part)));
}
