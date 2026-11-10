import { randomUUID } from 'node:crypto';
import type { AppSnapshot, SourceRef, Task, ToolCallRecord } from '../domain';
import type { FrozenRead } from '../contextState';
import { graphIndex, observe } from './directGraph';
import { graphTables } from './graphReadTables';
import { graphPaginator } from './graphPagination';
import { graphQueryKey, graphQueryVersion, subgraphEdges } from './graphQueries';
import { directReadBudgets, readCapacityReceipt } from './directReadBudget';
import { readCoverage, readKind, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { GRAPH_READ_LIMITS, checkFrozenStorage, checkGraphReadSource } from './graphReadLimits';
import { estimateTokens } from '../tokens';
import { captureGraphReadHashes, GRAPH_READ_DEPENDENCIES_VERSION, rememberGraphReadHashes } from './graphReadDependencies';
import { rememberReadPage } from './readVisibility';
import { rememberCanvasRead, stampCanvasObservation } from './canvasReadEvidence';
import { attachFrozenDirectoryEvidence } from './directoryEvidence';

type Row = Record<string, unknown>;
export function readSubgraphEdges(state: AppSnapshot, task: Task, call: ToolCallRecord, args: Row): Row {
  const index = graphIndex(state, task.canvasId), tables = graphTables(index);
  const request = { tool: call.name, arguments: structuredClone(args) }, selection = subgraphEdges(index, request);
  const ids = selection.edges.map(e => e.edgeId), version = graphQueryVersion(index, request);
  checkGraphReadSource(index, [], ids);
  const limits = directReadBudgets(state, task, call, args.budget), pointerId = `read:${randomUUID()}`;
  const coverage = readCoverage(readKind(call.name));
  const sourcesFor = (page: Row): SourceRef[] => (page.edges as Row[] ?? []).flatMap(e => {
    const source = tables.source(String(e.edgeId));
    return source ? [{ ...source, ...(typeof e.start === 'number' && typeof e.end === 'number' ? { start: e.start, end: e.end } : {}) }] : [];
  });
  const frame = (data: Row): Row => ({ status: 'ok', pointerId, page: 99999999, totalPages: 99999999, hasMorePages: true, isLastPage: false,
    data: { ...data, kind: readKind(call.name) }, sources: sourcesFor(data), coverage: pageCoverage(coverage, 2), freshness: 'current', stale: false,
    nextCursor: { pointerId, page: 99999999 } });
  const size = (data: Row) => estimateTokens(JSON.stringify(frame(data)));
  const fits = (data: Row) => size(data) <= limits.pageBudget;
  const pages: Row[] = [], paginator = graphPaginator(index, pages, pointerId, limits.pageBudget, fits, size);
  const query = { kind: call.name === 'graph_read_subgraph_edges' ? 'subgraph_internal_edges' : 'between_subgraph_edges',
    sourceRefId: selection.left, targetRefId: selection.right, totalEdges: ids.length, version, recursive: false };
  pages.push(...paginator.edgePages(ids, selection.left, query));
  if (paginator.failed || !pages.length || pages.some(p => !fits(p))) return readCapacityReceipt(call, args, limits.availableTokens, undefined, { limits });
  for (const page of pages) page.kind = readKind(call.name);
  const pageSources = pages.map(sourcesFor), pageObservations = pages.map((page, i) => {
    const o = observe(state, task, index, [], [], false, undefined, undefined, request);
    o.refs = [selection.left, selection.right].filter((v, n, a) => a.indexOf(v) === n);
    o.objects = {}; o.paths = {}; o.directories = {}; o.directoryMembers = {}; o.sources = pageSources[i];
    o.provenEmpty = ids.length === 0;
    o.readHashes = { ...captureGraphReadHashes(index.graph, o.sources, [], task.canvasId), [graphQueryKey(task.canvasId, request)]: version };
    stampCanvasObservation(index, o, page); o.canvasPage = { pointerId, page: i + 1, totalPages: pages.length }; return o;
  });
  const result: Row = { status: 'ok', pointerId, page: 1, totalPages: pages.length, hasMorePages: pages.length > 1, isLastPage: pages.length === 1,
    data: pages[0], sources: pageSources[0], coverage: pageCoverage(coverage, pages.length), freshness: 'current', stale: false,
    ...(pages.length > 1 ? { nextCursor: { pointerId, page: 2 } } : {}) };
  const needed = estimateTokens(JSON.stringify(result));
  if (needed > limits.availableTokens) return readCapacityReceipt(call, args, limits.availableTokens, needed, { limits });
  const observation = pageObservations[0]; observation.callId = call.id;
  const snapshot: FrozenRead = { id: pointerId, taskId: task.id, callId: call.id, canvasId: task.canvasId, kind: call.name,
    pages, pageBudget: limits.pageBudget, pageSources, pageObservations, sources: pageSources.flat(), observation,
    snapshotObservation: { ...observation, sources: pageSources.flat(), readHashes: Object.assign({}, ...pageObservations.map(o => o.readHashes)) },
    canvasOrigin: { version: 1, ...request }, pageGraphUsage: pages.map(() => [...new Set([selection.left, selection.right])]
      .map(subgraphId => ({ canvasId: task.canvasId, subgraphId, eventId: call.id, kind: 'read' as const }))),
    graphReadDependenciesVersion: GRAPH_READ_DEPENDENCIES_VERSION, pageReadHashes: pageObservations.map(o => o.readHashes!),
    coverage, readFormatVersion: READ_FORMAT_VERSION, createdAt: new Date().toISOString(), expiresAt: Date.now() + GRAPH_READ_LIMITS.ttlMs };
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  checkFrozenStorage(workspace.frozenReads ?? [], [snapshot]);
  (workspace.frozenReads ??= []).push(snapshot); (workspace.observations ??= []).push(observation);
  call.resultSources = pageSources[0];
  attachFrozenDirectoryEvidence(call, snapshot, 1);
  rememberReadPage(call, pointerId, 1, observation.readHashes); rememberGraphReadHashes(task, observation.readHashes!);
  rememberCanvasRead(call, snapshot, 1);
  return result;
}
