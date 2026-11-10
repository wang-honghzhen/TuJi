import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { FrozenRead } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { estimateTokens } from '../tokens';
import { id, now } from './repository';
import { directReadBudgets, readCapacityReceipt } from './directReadBudget';
import { resultPages } from './resultPaging';
import { readCoverage, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { GRAPH_READ_LIMITS, checkFrozenStorage, resourceLimit } from './graphReadLimits';
import { rememberReadPage } from './readVisibility';
import { rememberPageOrigin } from './readPageEvidence';
import type { WebData } from './webTools';

export const WEB_MIN_READ_TOKENS = 1024;
/** Admission happens before I/O; this second check accounts for changes while awaiting it. */
export function freezeWebRead(state: AppSnapshot, task: Task, call: ToolCallRecord, data: WebData): Record<string, unknown> {
  const limits = directReadBudgets(state, task, call), budget = Math.min(limits.pageBudget, limits.availableTokens);
  const blocked = () => ({ ...readCapacityReceipt(call, JSON.parse(call.arguments), budget, WEB_MIN_READ_TOKENS,{limits,usePageBudget:true,minimumOnly:true}), executed: true,
    nextAction:'restore_capacity_then_reread_source',
    instruction: '已取得联网数据，但当前容量不足以保存和交付，正文未保留；整理上下文后如仍需此资料，重新联网读取会创建新记录。' });
  if (budget < WEB_MIN_READ_TOKENS) return blocked();
  resourceLimit(Buffer.byteLength(JSON.stringify(data)) <= GRAPH_READ_LIMITS.sourceBytes, 'sourceBytes');
  const pointerId = id('read:'), coverage = readCoverage(data.kind);
  const frame = (page: Record<string, unknown>, pageNumber: number, totalPages: number) => ({ status: 'ok', pointerId,
    page: pageNumber, totalPages, hasMorePages: pageNumber < totalPages, isLastPage: pageNumber === totalPages,
    data: page, sources: [], stale: false, coverage: pageCoverage(coverage, totalPages),
    ...(pageNumber < totalPages ? { nextCursor: { pointerId, page: pageNumber + 1 } } : {}) });
  // The metadata is an ordinary row, so very large URLs/titles are split losslessly too.
  // Keeping it out of the repeated header leaves room for actual text on every page.
  const { items, ...metadata } = data;
  const rows = [{ metadata }, ...items];
  const withLinks = (page: Record<string, unknown>) => {
    const links = new Map<string, { url: string; title: string }>();
    // JSON fragments can split a long search result's metadata as well as its text.
    // Carry small source labels beside those fragments, without declaring their body read.
    for (const part of (Array.isArray(page.items) ? page.items : [page]) as Record<string, unknown>[]) {
      const path = (part.resultFragment as { path?: unknown[] } | undefined)?.path;
      const row = path?.[0] === 'items' && Number.isSafeInteger(path[1]) ? rows[Number(path[1])] : undefined;
      if (!row || !('url' in row) || typeof row.url !== 'string') continue;
      const link = { url: row.url, title: typeof row.title === 'string' ? row.title.slice(0, 160) : row.url };
      if (estimateTokens(JSON.stringify([...links.values(), link])) <= 512) links.set(link.url, link);
    }
    return links.size ? { ...page, webLinks: [...links.values()] } : page;
  };
  let pageBudget = Math.floor(Math.min(AUTO_CONTEXT.pageTokens, budget - 300)), pages: Record<string, unknown>[] = [];
  while (pageBudget >= 128) {
    pages = resultPages({ items: rows }, pageBudget).map(withLinks);
    if (pages.every((page, index) => estimateTokens(JSON.stringify({ ...frame(page, index + 1, pages.length),
      originResultId: call.id, blockId: call.id })) <= budget)) break;
    pageBudget = Math.floor(pageBudget * .75);
  }
  if (pageBudget < 128) return blocked();
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const read: FrozenRead = { id: pointerId, taskId: task.id, callId: call.id, canvasId: task.canvasId,
    kind: data.kind, pages, pageBudget: budget, coverage, readFormatVersion: READ_FORMAT_VERSION,
    observation: { id: id('observation:'), callId: call.id, taskId: task.id, canvasId: task.canvasId,
      directories: {}, paths: {}, refs: [], completeDirectories: [], sources: [] },
    sources: [], createdAt: now(), expiresAt: Date.now() + GRAPH_READ_LIMITS.ttlMs };
  checkFrozenStorage(workspace.frozenReads ?? [], [read]);
  const result = frame(pages[0], 1, pages.length);
  (workspace.frozenReads ??= []).push(read);
  rememberReadPage(call, pointerId, 1); call.resultSources = [];
  rememberPageOrigin(call,read,1);
  return result;
}
