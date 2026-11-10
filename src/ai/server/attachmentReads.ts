import { randomUUID } from 'node:crypto';
import type { AppSnapshot, Artifact, Task, ToolCallRecord, SourceRef } from '../domain';
import type { FrozenRead } from '../contextState';
import { attachmentLimits, attachmentVision, type AttachmentCatalogEntry, type ImageAssetRef } from '../attachments';
import { authorizedAttachments, assertProtectionCapacity, resolveAttachment, residentAttachmentTasks, protectedAttachmentEntries, attachmentKey } from './attachmentCatalog';
import { requireValue } from './errors';
import { readArtifact, searchArtifacts } from './artifacts';
import { directReadBudgets, readCapacityReceipt, frozenPageCapacityReceipt } from './directReadBudget';
import { estimateTokens } from '../tokens';
import { digest } from './directGraph';
import { readCoverage, pageCoverage, READ_FORMAT_VERSION } from './readCoverage';
import { resultPages } from './resultPaging';
import { rememberReadPage } from './readVisibility';
import { rememberPageOrigin } from './readPageEvidence';
import { checkFrozenStorage, GRAPH_READ_LIMITS } from './graphReadLimits';
import { imageTokens } from './providers';

type Row = Record<string, unknown>;
export const ATTACHMENT_TOOLS = new Set(['context_read_task_attachments', 'workspace_search_artifacts', 'workspace_read_artifact', 'workspace_view_artifact']);
const int = (value: unknown, fallback: number, minimum = 1) => {
  const n = value === undefined ? fallback : Number(value);
  requireValue(Number.isSafeInteger(n) && n >= minimum, '附件读取范围或数量无效', 'INVALID_ARGUMENT'); return n;
};
export function attachmentTaskCatalog(state: AppSnapshot, task: Task, taskId: string, budget = 1024) {
  const rows = authorizedAttachments(state, task, [taskId]).map(f => f.entry), items: AttachmentCatalogEntry[] = [];
  for (const row of rows) { if (estimateTokens(JSON.stringify([...items, row])) > budget) break; items.push(row); }
  return { items, total: rows.length, listed: items.length, complete: items.length === rows.length,
    readWith: { tool: 'context_read_task_attachments', arguments: { taskId } } };
}
/** Catalog entries are indivisible; protection never promises an unread fragment. */
function catalogPages(items: AttachmentCatalogEntry[], budget: number): Row[] {
  const pages: Row[] = [], header = { kind: 'attachment_catalog', total: items.length, representation: 'index' };
  let current: AttachmentCatalogEntry[] = [];
  for (const row of items) {
    requireValue(estimateTokens(JSON.stringify({ ...header, items: [row] })) <= budget,
      '清单单项超过读取预算，请提高 budget', 'READ_PAGE_CAPACITY');
    if (current.length && estimateTokens(JSON.stringify({ ...header, items: [...current, row] })) > budget) {
      pages.push({ ...header, items: current }); current = [];
    }
    current.push(row);
  }
  if (current.length || !pages.length) pages.push({ ...header, items: current });
  return pages;
}
type Selection = { artifact: Artifact; range: Row; next?: Row; whole: boolean };
function selectArtifact(state: AppSnapshot, task: Task, args: Row, forSearch=false): Selection {
  const artifact = resolveAttachment(state, task, args.artifactId, args.version), limits = attachmentLimits(state);
  const pageRange = args.startPage !== undefined || args.endPage !== undefined;
  const lineRange = args.startLine !== undefined || args.endLine !== undefined;
  const chunkRange = args.chunkIds !== undefined, ordinalRange = args.startOrdinal !== undefined || args.count !== undefined;
  requireValue([pageRange, lineRange, chunkRange, ordinalRange].filter(Boolean).length <= 1,
    '页码、分片、行范围不能混合使用', 'INVALID_ARGUMENT');
  const readableChunks=artifact.chunks.filter(c=>forSearch||!c.searchOnly);
  let chunks = readableChunks, range: Row, next: Row | undefined, whole = false;
  if (pageRange || artifact.mimeType === 'application/pdf' && !lineRange && !chunkRange && !ordinalRange) {
    requireValue(artifact.mimeType === 'application/pdf', '页码读取只适用于 PDF', 'INVALID_ARGUMENT');
    const start = int(args.startPage, 1), end = int(args.endPage, Math.min(artifact.pages ?? start, start + limits.textPages - 1));
    requireValue(end >= start && end <= (artifact.pages ?? 0) && end - start + 1 <= limits.textPages,
      `一次最多读取 ${limits.textPages} 个 PDF 物理页`, 'INVALID_ARGUMENT');
    chunks = chunks.filter(c => c.page! >= start && c.page! <= end);
    range = { kind: 'physical_pages', startPage: start, endPage: end, totalPages: artifact.pages };
    next = end < artifact.pages! ? { startPage: end + 1 } : undefined;
    whole = start === 1 && end === artifact.pages;
    return { artifact: { ...artifact, chunks, failedPages: artifact.failedPages?.filter(p => p >= start && p <= end) }, range, next, whole };
  }
  if (chunkRange) {
    requireValue(Array.isArray(args.chunkIds) && args.chunkIds.length > 0 && args.chunkIds.length <= 100
      && args.chunkIds.every(id => chunks.some(c => c.id === id)), '附件分片不存在或超过100个', 'OUT_OF_SCOPE');
    chunks = chunks.filter(c => (args.chunkIds as string[]).includes(c.id));
    range = { kind: 'chunks', chunkIds: chunks.map(c => c.id), totalChunks: artifact.chunks.length };
    whole = chunks.length === artifact.chunks.length;
  } else if (lineRange) {
    // Adjacent pieces of one paragraph keep their line; paragraph/table blocks have a two-newline source gap.
    let line=1,previous:Artifact['chunks'][number]|undefined;
    const positions=readableChunks.map(c=>{if(previous&&c.start>previous.end)line+=Math.min(2,c.start-previous.end);
      const first=line;line+=c.text.split('\n').length-1;previous=c;return first;});
    const totalLines=readableChunks.length?line:0;
    const start = int(args.startLine, 1), requestedEnd = int(args.endLine, start + 199), end = Math.min(totalLines, requestedEnd);
    requireValue(end >= start, '行范围超出提取文本', 'INVALID_ARGUMENT');
    chunks = chunks.flatMap((c,index) => {
      const lines = c.text.split('\n'), first = positions[index];
      const from = Math.max(0, start - first), to = Math.min(lines.length, end - first + 1);
      if (from >= to) return [];
      const offset = lines.slice(0, from).reduce((n, s) => n + s.length + 1, 0), text = lines.slice(from, to).join('\n');
      return [{ ...c, start: c.start + offset, end: c.start + offset + text.length, text }];
    });
    range = { kind: 'extracted_lines', startLine: start, endLine: end, totalLines };
    next = end < totalLines ? { startLine: end + 1 } : undefined;
    whole = start === 1 && end === totalLines;
  } else {
    const start = int(args.startOrdinal, 0, 0), count = int(args.count, 4);
    requireValue(count <= 100 && (start === 0 || chunks.some(c => c.ordinal >= start)), '分片范围无效，一次最多100个分片', 'INVALID_ARGUMENT');
    chunks = chunks.filter(c => c.ordinal >= start).slice(0, count);
    const end = chunks.at(-1)?.ordinal;
    range = { kind: 'ordinals', startOrdinal: start, endOrdinal: end, totalChunks: artifact.chunks.length };
    next = end !== undefined && artifact.chunks.some(c => c.ordinal > end) ? { startOrdinal: end + 1 } : undefined;
    whole = chunks.length === artifact.chunks.length;
  }
  if(artifact.mimeType==='application/pdf')requireValue(new Set(chunks.map(c=>c.page)).size<=limits.textPages,`一次最多读取 ${limits.textPages} 个 PDF 物理页`,'INVALID_ARGUMENT');
  return { artifact: { ...artifact, chunks }, range, next, whole };
}
export function selectedArtifact(state: AppSnapshot, task: Task, args: Row): Artifact {
  return selectArtifact(state, task, args, true).artifact;
}
export function attachmentRead(state: AppSnapshot, task: Task, call: ToolCallRecord, args: Row, images?: ImageAssetRef[]): Row {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!, policy = attachmentLimits(state);
  let read: FrozenRead, page = 1, created = false;
  if (call.name === 'context_read_pages') {
    const found = workspace.frozenReads?.find(r => r.id === args.pointerId && r.attachmentRead);
    requireValue(found && found.expiresAt > Date.now(), '附件分页已过期，请从任务清单或原文入口重新读取', 'CURSOR_EXPIRED');
    read = found;
    if (read.attachmentRead!.representation === 'image') requireValue(attachmentVision(state.provider,task.modelSelection?.model), '当前执行模型未声明视觉能力', 'VISION_UNSUPPORTED');
    if (read.attachmentRead!.protect) requireValue(read.taskId === task.id, '清单保护不跨任务继承，请重新读取清单', 'OUT_OF_SCOPE');
    const available = authorizedAttachments(state, task, read.attachmentRead!.taskIds);
    requireValue(Object.entries(read.attachmentRead!.versions).every(([id, version]) => available.some(f => f.ref.id === id && f.ref.version === version && f.artifact)),
      '附件来源已撤销或原版本不可用', 'OUT_OF_SCOPE');
    page = int(args.page, 1); requireValue(page <= read.pages.length, '分页页码无效', 'INVALID_ARGUMENT');
  } else {
    const requested = Math.min(int(args.budget, policy.readTokens), policy.maxReadTokens);
    const limits = directReadBudgets(state, task, call, requested), budget = Math.min(limits.pageBudget, limits.availableTokens) - 400;
    if (budget < 256) return {...readCapacityReceipt(call, args, limits.availableTokens, 656, { limits, minimumOnly: true }),
      ...(call.name==='context_read_task_attachments'&&args.protect===true?{protection:{accepted:false,reason:'READ_CAPACITY'}}:{})};
    let pages: Row[], files: Artifact[] = [], searchHits: ReturnType<typeof searchArtifacts> | undefined, taskIds: string[] | undefined, representation: 'index' | 'text' | 'image' = 'text';
    let coverage = readCoverage('artifact');
    if (call.name === 'context_read_task_attachments') {
      taskIds = args.taskId === undefined ? residentAttachmentTasks(state, task) : [String(args.taskId)];
      let catalog = authorizedAttachments(state, task, taskIds);
      if (Array.isArray(args.artifactIds)) catalog = catalog.filter(f => (args.artifactIds as string[]).includes(f.ref.id));
      files = catalog.flatMap(f => f.artifact ?? []); representation = 'index';
      let pageBudget=budget;
      do {
        pages=catalogPages(catalog.map(f=>f.entry),pageBudget);
        const largest=Math.max(...pages.map(data=>estimateTokens(JSON.stringify({status:'ok',pointerId:'read:00000000-0000-4000-8000-000000000000',page:9999,totalPages:9999,data,
          sources:(data.items as AttachmentCatalogEntry[]).filter(i=>i.status!=='unavailable').map(i=>({kind:'artifact',id:i.artifactId,version:i.version,tracking:'historical'})),
          protection:{accepted:true,untilTaskEnd:task.id},coverage:pageCoverage(coverage,2),nextCursor:{pointerId:'read:00000000-0000-4000-8000-000000000000',page:9999}}))+160));
        if(largest<=limits.availableTokens)break;
        pageBudget=Math.floor(pageBudget*.75);
        requireValue(pageBudget>=256,'清单读取预算不足，请提高 budget','READ_PAGE_CAPACITY');
      }while(true);
    } else if (call.name === 'workspace_view_artifact') {
      requireValue(attachmentVision(state.provider,task.modelSelection?.model), '当前执行模型未声明视觉能力，请在 execution.supportsVision 配置；可继续读取可提取文本', 'VISION_UNSUPPORTED');
      const artifact = resolveAttachment(state, task, args.artifactId, args.version); files = [artifact]; representation = 'image';
      requireValue(images?.length && images.every(i => i.artifactId === artifact.id && i.version === artifact.version), '页面图像尚未准备或来源已变化', 'IMAGE_UNAVAILABLE');
      pages = images.map(image => ({ kind: 'attachment_images', representation, items: [image], firstFrameOnly: artifact.firstFrameOnly ?? false,
        ...(artifact.mimeType==='application/pdf'?{rendering:{maxEmbeddedImagePixels:policy.imagePixels,oversizedEmbeddedImages:'omitted'}}:{}) }));
    } else if (call.name === 'workspace_search_artifacts') {
      taskIds = args.taskId === undefined ? undefined : [String(args.taskId)];
      const catalog = authorizedAttachments(state, task, taskIds), resident = new Set(residentAttachmentTasks(state, task));
      const protectedKeys = new Set(protectedAttachmentEntries(state, task, false).map(attachmentKey));
      files = catalog.filter(f => args.artifactId !== undefined ? f.ref.id === args.artifactId && (args.version === undefined || f.ref.version === args.version)
        : taskIds || f.entry.owners.some(o => resident.has(o.taskId)) || protectedKeys.has(attachmentKey(f.entry))).flatMap(f => f.artifact ?? []);
      if (args.artifactId !== undefined) requireValue(files.length > 0, '附件不在授权范围', 'OUT_OF_SCOPE');
      if (args.startPage !== undefined || args.endPage !== undefined) files = files.filter(f => f.mimeType === 'application/pdf').map(f => selectedArtifact(state, task, { ...args, artifactId: f.id, version: f.version }));
      requireValue(typeof args.query === 'string' && args.query.trim(), '检索关键词不能为空', 'INVALID_ARGUMENT');
      const limit = int(args.limit, 8); requireValue(limit <= 100, '检索最多返回100项', 'INVALID_ARGUMENT');
      const hits = searchArtifacts(files, args.query, { limit, budget: policy.maxReadTokens });searchHits=hits;
      files=files.filter(file=>hits.some(hit=>hit.artifactId===file.id&&hit.version===file.version));
      pages = resultPages({ kind: 'attachment_search', representation, query: args.query, items: hits, searchIsNotFullRead: true, ocrPolicy:'searchOnly条目仅用于定位，使用workspace_view_artifact查看原页确认' }, budget);
      coverage = readCoverage('artifact', ['search_limit']);
    } else {
      const original = resolveAttachment(state, task, args.artifactId, args.version), selection = selectArtifact(state, task, args), selected = selection.artifact; files = [original];
      requireValue(!original.mimeType.startsWith('image/'), '图片没有文本正文，请使用 workspace_view_artifact', 'IMAGE_REQUIRES_VIEW');
      requireValue(selected.status !== 'failed' || selected.chunks.length, '没有可靠的可提取文本，请查看页面图像', 'TEXT_UNAVAILABLE');
      let startOrdinal = selected.chunks[0]?.ordinal ?? 0, startOffset = 0; pages = [];
      do {
        const portion = readArtifact({ ...selected, status: selected.status === 'failed' ? 'partial' : selected.status },
          { startOrdinal, startOffset, count: Math.max(1, selected.chunks.length), budget: Math.max(128, budget - 250) });
        const data: Row = { kind: 'attachment_text', representation, artifactId: original.id, version: original.version,
          chunks: portion.chunks, headers: portion.headers, failedPages: selected.failedPages ?? [], selectedWholeFile: selection.whole,
          visualContentIncluded: false, ocrSearchPages:original.ocrPages?.filter(p=>selected.failedPages?.includes(p)),
          ...(selected.failedPages?.length?{viewWith:{tool:'workspace_view_artifact',arguments:{artifactId:original.id,version:original.version,pages:selected.failedPages.slice(0,policy.imagePages)}}}:{}),
          range: { selection: selection.range,
            chunks: portion.chunks.map(({id,ordinal,page,start,end})=>({id,ordinal,page,start,end})) },
          nextRead: selection.next && !portion.nextCursor ? { tool: 'workspace_read_artifact',
            arguments: { artifactId: original.id, version: original.version, ...selection.next } } : undefined };
        requireValue(portion.chunks.length || !selected.chunks.length, '预算不足以读取附件片段，请提高 budget', 'READ_PAGE_CAPACITY');
        pages.push(...resultPages(data, budget));
        if (!portion.nextCursor) break;
        ({ startOrdinal, startOffset } = portion.nextCursor);
      } while (true);
      coverage = readCoverage('artifact', selected.failedPages?.length ? ['source_partial'] : [],!selected.chunks.length&&!!selected.failedPages?.length);
    }
    const sources: SourceRef[] = files.map(f => ({ kind: 'artifact', id: f.id, version: f.version, tracking: 'historical' }));
    const searchPageSources=(data:Row)=>{
      if(data.resultFragment)return sources;
      const hits=(Array.isArray(data.items)?data.items as Row[]:[]).map(item=>{
        const fragment=item.resultFragment as {path?:unknown[]}|undefined;
        return fragment?.path?.[0]==='items'&&typeof fragment.path[1]==='number'?searchHits![fragment.path[1]]:item;
      });
      return sources.filter(source=>hits.some(hit=>hit?.artifactId===source.id&&hit.version===source.version));
    };
    read = { id: `read:${randomUUID()}`, taskId: task.id, callId: call.id, canvasId: task.canvasId, kind: 'attachment_local',
      pages, sources, pageSources: pages.map(data => representation==='index'
        ? sources.filter(s=>(data.items as AttachmentCatalogEntry[]).some(i=>i.artifactId===s.id&&i.version===s.version))
        : searchHits ? searchPageSources(data) : sources),
      pageBudget: representation === 'image' ? policy.maxReadTokens : requested, readFormatVersion: READ_FORMAT_VERSION, coverage,
      attachmentRead: { taskIds, protect: call.name === 'context_read_task_attachments' && args.protect === true, representation,
        versions: Object.fromEntries(files.map(f => [f.id, f.version])) },
      observation: { id: `observation:${randomUUID()}`, taskId: task.id, canvasId: task.canvasId, refs: [], sources: [], directories: {}, paths: {}, completeDirectories: [] },
      createdAt: new Date().toISOString(), expiresAt: Date.now() + GRAPH_READ_LIMITS.ttlMs };
    created = true;
  }
  const data = structuredClone(read.pages[page - 1]), protectedRead = read.attachmentRead!.protect;
  const result: Row = { status: read.coverage?.reasons.includes('source_partial')?'partial':'ok', pointerId: read.id, page, totalPages: read.pages.length, data,
    hasMorePages: page < read.pages.length, isLastPage: page === read.pages.length, sources: read.pageSources?.[page - 1] ?? [],
    coverage: pageCoverage(read.coverage!, read.pages.length,read.coverage?.extent==='none'), ...(page < read.pages.length ? { nextCursor: { pointerId: read.id, page: page + 1 } } : {}),
    ...(protectedRead ? { protection: { accepted: true, untilTaskEnd: task.id } } : {}) };
  const limits = directReadBudgets(state, task, call, Math.min(int(args.budget,read.pageBudget??policy.readTokens),policy.maxReadTokens)), needed = estimateTokens(JSON.stringify(result)) + 100
    + (read.attachmentRead!.representation === 'image' ? imageTokens(data.items as ImageAssetRef[]) : 0);
  const refusedProtection=protectedRead?{protection:{accepted:false,reason:'READ_CAPACITY'}}:{};
  if (needed > limits.maximumTokens) return {...frozenPageCapacityReceipt(call, args, limits.availableTokens, needed, limits.maximumTokens),...refusedProtection};
  if (needed > limits.availableTokens) return {...readCapacityReceipt(call, args, limits.availableTokens, needed, { limits }),...refusedProtection};
  const protection = protectedRead ? { ownerTaskId: task.id, entries: data.items as AttachmentCatalogEntry[], pointerId: read.id, page, payloadHash: digest(data) } : undefined;
  if (protection) assertProtectionCapacity(state, task, protection);
  if (created) { checkFrozenStorage(workspace.frozenReads ?? [], [read]); (workspace.frozenReads ??= []).push(read); }
  if (protection) call.attachmentProtection = protection;
  const deliveredVersions=Object.fromEntries((read.pageSources?.[page-1]??[]).map(source=>[source.id,source.version]));
  call.attachmentRead = { artifactIds: Object.keys(deliveredVersions), versions: deliveredVersions,
    representation: read.attachmentRead!.representation, ranges: data.range };
  if (read.attachmentRead!.representation === 'image') call.resultImages = data.items as ImageAssetRef[];
  call.resultSources = read.pageSources?.[page - 1] ?? [];
  rememberReadPage(call, read.id, page); rememberPageOrigin(call, read, page);
  return result;
}
