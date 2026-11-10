import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from '../attachments';
import { imageHeader, validateImageDimensions } from './artifactImages';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Artifact, ArtifactChunk } from '../domain';
import { estimateTokens } from '../tokens';

type Format = 'text' | 'markdown' | 'json' | 'csv' | 'html' | 'pdf' | 'image';
export interface ParseProgress { completedPages: number; totalPages: number; page?: number; resumed: boolean; status: 'parsing' | 'partial' | 'ready' }
export interface ParseArtifactOptions {
  directory: string;
  signal?: AbortSignal;
  onProgress?: (progress: ParseProgress) => void | Promise<void>;
  maxBytes?: number;
  imagesOnly?: boolean;
  limits?: AttachmentLimits;
  /** OCR is local and opt-in. Trained data must already exist; no model download is performed. */
  ocr?: { dataPath: string; language?: string; pageTimeoutMs?: number };
}
interface ParsedPage { ocr?: boolean; page: number; text: string; status: 'ready' | 'blank' | 'failed'; error?: string; textHash?: string }
interface ParseCheckpoint {
  version: 1; sourceHash: string; parser: string; format: Format; totalPages: number;
  pages: ParsedPage[]; complete: boolean; error?: string; updatedAt: string;
}
export interface ArtifactReadOptions { startOrdinal?: number; startOffset?: number; count?: number; budget?: number; taskId?: string; expectedVersion?: number }
export interface ArtifactReadResult {
  artifactId: string; version: number; chunks: ArtifactChunk[];
  /** Repeated table headers have their own exact source ranges, not invented row offsets. */
  headers: ArtifactChunk[];
  nextCursor: { startOrdinal: number; startOffset: number } | null;
  totalChunks: number; truncated?: boolean; estimatedTokens: number; failedPages: number[];
  coverage: { taskId?: string; complete: boolean; readOrdinals: number[]; partiallyReadOrdinals: number[] };
}
export interface ArtifactSearchHit {
  searchOnly?: boolean;
  artifactId: string; version: number; chunkId: string; ordinal: number; page?: number;
  start: number; end: number; text: string; hash: string; score: number;
}

const MAX_BYTES = DEFAULT_ATTACHMENT_LIMITS.fileBytes;

const PARSER_VERSION = 'local-extraction-v3';
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const exists = async (file: string) => { try { await fs.access(file); return true; } catch { return false; } };

async function atomicWrite(file: string, contents: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
}

async function storeOriginal(directory: string, sourceHash: string, bytes: Uint8Array) {
  const file = path.join(directory, 'objects', sourceHash);
  if (await exists(file)) {
    if (sha(await fs.readFile(file)) !== sourceHash) throw new Error('已有原始资料对象校验失败，未覆盖损坏对象。');
    return;
  }
  await atomicWrite(file, bytes);
  if (sha(await fs.readFile(file)) !== sourceHash) throw new Error('原始资料落盘校验失败。');
}

function detectFormat(name: string, declared: string, bytes: Uint8Array): { format: Format; mimeType: string; text?: string } {
  const mime = declared.split(';')[0].trim().toLowerCase();
  const extension = path.extname(name).toLowerCase();
  const image = imageHeader(bytes);
  if(image){
    if(mime && mime!=='application/octet-stream' && mime!==image.mimeType)throw new Error('图片实际格式与声明 MIME 不符');
    const extensions:Record<string,string[]>={'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'],'image/webp':['.webp'],'image/gif':['.gif']};
    if(extension&&!extensions[image.mimeType].includes(extension))throw new Error('图片实际格式与扩展名不符');
    return {format:'image',mimeType:image.mimeType};
  }
  if(mime.startsWith('image/')||['.png','.jpg','.jpeg','.webp','.gif'].includes(extension))throw new Error('图片签名或尺寸信息无效');
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const pdf = head.includes('%PDF-');
  if (pdf) {
    if (mime && !['application/pdf', 'application/octet-stream'].includes(mime)) throw new Error('实际内容是 PDF，与声明 MIME 不符。');
    if (extension && extension !== '.pdf') throw new Error('实际内容是 PDF，与文件扩展名不符。');
    return { format: 'pdf', mimeType: 'application/pdf' };
  }
  if (mime === 'application/pdf' || extension === '.pdf') throw new Error('文件声称是 PDF，但缺少有效 PDF 文件签名。');
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).some((value) => value === 0)) throw new Error('不支持的二进制资料，不能伪装为纯文本解析。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('文本不是有效 UTF-8，请先转换编码；未用替换字符损坏原文。'); }
  const formats: Record<string, Format> = { '.txt': 'text', '.md': 'markdown', '.markdown': 'markdown', '.json': 'json', '.csv': 'csv', '.html': 'html', '.htm': 'html' };
  const mimeFormats: Record<string, Format> = { 'text/plain': 'text', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown',
    'application/json': 'json', 'text/json': 'json', 'text/csv': 'csv', 'application/csv': 'csv', 'text/html': 'html' };
  if (mime && !mimeFormats[mime] && mime !== 'application/octet-stream') throw new Error(`不支持的资料 MIME：${mime}`);
  const fromExtension = formats[extension];
  const fromMime = mimeFormats[mime];
  if (extension && !fromExtension) throw new Error(`不支持的资料扩展名：${extension}`);
  if (fromExtension && fromMime && fromExtension !== fromMime && fromMime !== 'text') {
    throw new Error('文件扩展名与声明 MIME 不一致，未按伪装的格式解析。');
  }
  const format = fromExtension ?? fromMime ?? 'text';
  const actualMimes: Record<Format, string> = { text: 'text/plain', markdown: 'text/markdown', json: 'application/json',
    csv: 'text/csv', html: 'text/html', pdf: 'application/pdf', image:'image/png' };
  return { format, mimeType: actualMimes[format], text };
}

function htmlText(input: string): string {
  return input.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(?:p|div|section|article|h[1-6]|tr|table|ul|ol|li)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    }[entity.toLowerCase()] ?? entity))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_entity, value: string) => {
      const code = value.startsWith('x') ? Number.parseInt(value.slice(1), 16) : Number(value);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    }).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function csvRows(text: string): string[] {
  const rows: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (text[index] === '\n' && !quoted) { rows.push(text.slice(start, index)); start = index + 1; }
  }
  if (quoted) throw new Error('CSV 引号未闭合，无法可靠确定行边界。');
  if (start < text.length) rows.push(text.slice(start));
  return rows;
}

function tableBlocks(rows: string[], headers: string[], target: number): string[] {
  const blocks: string[] = [];
  let current = [...headers];
  for (const row of rows) {
    if (current.length > headers.length && current.join('\n').length + row.length + 1 > target) {
      blocks.push(current.join('\n')); current = [...headers];
    }
    current.push(row);
  }
  if (current.length > headers.length || !blocks.length) blocks.push(current.join('\n'));
  return blocks;
}

function textBlocks(text: string, format: Format, target: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (format === 'csv') {
    const rows = csvRows(normalized);
    return rows.length ? tableBlocks(rows.slice(1), [rows[0]], target) : [];
  }
  const paragraphs = normalized.split(/\n[ \t]*\n+/);
  const blocks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    const lines = paragraph.split('\n');
    const isMarkdownTable = format === 'markdown' && lines.length >= 2 && lines[0].includes('|')
      && /^\s*\|?\s*:?-{3,}/.test(lines[1]);
    if (isMarkdownTable) {
      if (current) { blocks.push(current); current = ''; }
      blocks.push(...tableBlocks(lines.slice(2), lines.slice(0, 2), target));
    } else if (current && current.length + paragraph.length + 2 > target) {
      blocks.push(current); current = paragraph;
    } else current += `${current ? '\n\n' : ''}${paragraph}`;
  }
  if (current) blocks.push(current);
  return blocks;
}

function materializeChunks(pages: ParsedPage[], format: Format, target: number): ArtifactChunk[] {
  const chunks: ArtifactChunk[] = [];
  let offset = 0;
  for (const page of [...pages].sort((first, second) => first.page - second.page)) {
    if (page.status === 'failed') continue;
    for (const block of textBlocks(page.text, format, target)) {
      // Split oversized prose without losing characters or inserting fictitious source offsets.
      // Table blocks remain row-aligned and already repeat their headers.
      const table = format === 'csv' || format === 'markdown' && block.includes('|') && /\n\s*\|?\s*:?-{3,}/.test(block);
      for (let start = 0; start < block.length;) {
        let end = table ? block.length : Math.min(block.length, start + target);
        if(end<block.length&&/[\uD800-\uDBFF]/.test(block[end-1]))end--;
        if(end===start)end=Math.min(block.length,start+2);
        const text=block.slice(start,end),ordinal=chunks.length,contentHash=sha(text);
        chunks.push({id:`chunk:${page.page}:${ordinal}:${contentHash.slice(0,16)}`,ordinal,
          ...(format==='pdf'?{page:page.page}:{}),...(page.ocr?{searchOnly:true}:{}),start:offset+start,end:offset+end,text,hash:contentHash});
        start=end;
      }
      offset += block.length + 2;
    }
  }
  return chunks;
}

function pdfText(items: Array<{ str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }>): string {
  const lines: string[] = [];
  let current = '';
  let previousY: number | undefined;
  let previousEnd: number | undefined;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const x = item.transform?.[4]; const y = item.transform?.[5];
    if (previousY !== undefined && y !== undefined && Math.abs(y - previousY) > Math.max(2, (item.height ?? 10) * 0.3)) {
      if (current) lines.push(current); current = ''; previousEnd = undefined;
    }
    if (current && x !== undefined && previousEnd !== undefined && x - previousEnd > 2) current += ' ';
    current += item.str;
    previousY = y; previousEnd = x !== undefined ? x + (item.width ?? 0) : undefined;
    if (item.hasEOL) { lines.push(current); current = ''; previousEnd = undefined; previousY = undefined; }
  }
  if (current) lines.push(current);
  return lines.join('\n').trim();
}

async function ocrPdfPage(page: PDFPageProxy, options: ParseArtifactOptions): Promise<string> {
  const ocr = options.ocr!;
  const language = ocr.language ?? 'chi_sim+eng';
  if (!/^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(language)) throw new Error('OCR 语言配置无效。');
  const languageFormats = await Promise.all(language.split('+').map(async item => {
    if (await exists(path.join(ocr.dataPath, `${item}.traineddata`))) return false;
    if (await exists(path.join(ocr.dataPath, `${item}.traineddata.gz`))) return true;
    throw new Error(`本地 OCR 语言模型 ${item} 不存在；未进行网络下载。`);
  }));
  if (languageFormats.some(gzip => gzip !== languageFormats[0])) throw new Error('本地 OCR 语言模型须统一使用 traineddata 或 traineddata.gz 格式。');
  const canvasModule = '@napi-rs/canvas';
  const tesseractModule = 'tesseract.js';
  const { createCanvas } = await import(canvasModule);
  const { createWorker } = await import(tesseractModule);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.sqrt((options.limits??DEFAULT_ATTACHMENT_LIMITS).imagePixels / Math.max(1, baseViewport.width * baseViewport.height)));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ viewport, canvasContext: canvas.getContext('2d'), canvas } as Parameters<PDFPageProxy['render']>[0]).promise;
  if (options.signal?.aborted) throw new Error('资料解析已中断。');
  const worker = await createWorker(language, 1, { langPath: path.resolve(ocr.dataPath),
    cachePath: path.join(options.directory, 'ocr-cache'), gzip: languageFormats[0],
    // Tesseract rejects the job promise and otherwise also throws from its
    // worker callback. Handle that callback locally so a bad page stays partial.
    errorHandler: () => undefined });
  const abort = () => { void worker.terminate(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      worker.recognize(canvas.toBuffer('image/png')),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void worker.terminate(); reject(new Error('本地 OCR 页处理超时。')); }, ocr.pageTimeoutMs ?? 120000); }),
    ]);
    return String(result.data.text ?? '').trim();
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await worker.terminate().catch(() => undefined);
  }
}

const parseQueues = new Map<string, Promise<void>>();

export async function parseArtifact(workspaceId: string, name: string, mimeType: string, bytes: Uint8Array,
  options: ParseArtifactOptions): Promise<Artifact> {
  const sourceHash = sha(bytes);
  const directory = path.resolve(options.directory || '.');
  const key = JSON.stringify([process.platform === 'win32' ? directory.toLowerCase() : directory, sourceHash]);
  const previous = parseQueues.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  parseQueues.set(key, current);
  // Original bytes and parse checkpoints are shared across workspaces. Serialize
  // the same object so one reader never blocks another writer's rename on Windows.
  try {
    await previous;
    return await parseArtifactExclusive(workspaceId, name, mimeType, bytes, sourceHash, options);
  } finally {
    release();
    if (parseQueues.get(key) === current) parseQueues.delete(key);
  }
}

async function parseArtifactExclusive(workspaceId: string, name: string, mimeType: string, bytes: Uint8Array,
  sourceHash: string, options: ParseArtifactOptions): Promise<Artifact> {
  const artifact: Artifact = { id: `artifact:${randomUUID()}`, workspaceId, name: path.basename(name).slice(0, 255),
    mimeType, version: 1, createdAt: new Date().toISOString(), status: 'failed', size: bytes.byteLength,
    hash: sourceHash, chunks: [] };
  let detected: ReturnType<typeof detectFormat>;
  let checkpoint: ParseCheckpoint | undefined;
  let checkpointFile = '';
  const persist = async () => {
    if (!checkpoint) return;
    checkpoint.updatedAt = new Date().toISOString();
    const storedPages: ParsedPage[] = [];
    for (const page of checkpoint.pages) {
      const textHash = sha(page.text);
      const object = path.join(options.directory, 'parse', 'pages', sourceHash, `${page.page}.${textHash}.txt`);
      if (!await exists(object)) await atomicWrite(object, page.text);
      storedPages.push({ ...page, text: '', textHash });
    }
    // Page text is immutable and written once. The small checkpoint only contains references.
    await atomicWrite(checkpointFile, JSON.stringify({ ...checkpoint, pages: storedPages }));
  };
  try {
    if (!workspaceId || !artifact.name) throw new Error('资料缺少工作区或文件名称。');
    if (!bytes.byteLength) throw new Error('上传资料为空，未创建空引用。');
    if (bytes.byteLength > (options.maxBytes ?? MAX_BYTES)) throw new Error('上传资料超过本地解析大小上限，请拆分文档。');
    if (!options.directory) throw new Error('资料对象存储目录未配置。');
    detected = detectFormat(artifact.name, mimeType, bytes);
    artifact.mimeType = detected.mimeType;
    if(options.imagesOnly&&detected.format!=='image') throw new Error('极简模式仅支持上传图片（PNG、JPEG、WebP、GIF）');
    await storeOriginal(options.directory, sourceHash, bytes);
    const limits=options.limits??DEFAULT_ATTACHMENT_LIMITS;
    if(detected.format==='image'){
      const dimensions=validateImageDimensions(imageHeader(bytes),limits);
      const canvasModule='@napi-rs/canvas';const {loadImage}=await import(canvasModule);
      if(options.signal?.aborted)throw new Error('资料解析已中断');
      const decoded=await loadImage(bytes);
      if(decoded.width*decoded.height>limits.imagePixels)throw new Error('图片解码像素超过上限');
      Object.assign(artifact,{status:'ready',visualState:'available',width:dimensions.width,height:dimensions.height,firstFrameOnly:dimensions.firstFrameOnly});
      await options.onProgress?.({completedPages:1,totalPages:1,resumed:false,status:'ready'});return artifact;
    }
    const parser = `${PARSER_VERSION}:${detected.format}:${sha(JSON.stringify(limits))}:${options.ocr ? sha(JSON.stringify(options.ocr)) : 'text-only'}`;
    checkpointFile = path.join(options.directory, 'parse', `${sourceHash}.json`);
    if (await exists(checkpointFile)) {
      const existing = JSON.parse(await fs.readFile(checkpointFile, 'utf8')) as ParseCheckpoint;
      if (existing.version === 1 && existing.sourceHash === sourceHash && existing.parser === parser
        && Array.isArray(existing.pages) && Number.isSafeInteger(existing.totalPages)) {
        const pages: ParsedPage[] = [];
        for (const page of existing.pages) {
          if (!Number.isSafeInteger(page.page) || page.page < 1 || !['ready', 'blank', 'failed'].includes(page.status)) continue;
          if (page.textHash) {
            if (!/^[a-f0-9]{64}$/.test(page.textHash)) continue;
            try {
              const text = await fs.readFile(path.join(options.directory, 'parse', 'pages', sourceHash,
                `${page.page}.${page.textHash}.txt`), 'utf8');
              if (sha(text) !== page.textHash) continue;
              pages.push({ ...page, text });
            } catch { /* Missing/corrupt page objects are re-extracted from the original. */ }
          } else if (typeof page.text === 'string') pages.push(page);
        }
        checkpoint = { ...existing, pages, complete: existing.complete && pages.length === existing.totalPages
          && pages.every(page => page.status !== 'failed') };
      }
    }
    const resumed = Boolean(checkpoint?.pages.length);
    checkpoint ??= { version: 1, sourceHash, parser, format: detected.format, totalPages: detected.format === 'pdf' ? 0 : 1,
      pages: [], complete: false, updatedAt: new Date().toISOString() };
    if (detected.format !== 'pdf') {
      if (options.signal?.aborted) { checkpoint.error = '资料解析已中断，可从本地原件继续。'; await persist(); }
      else if (!checkpoint.complete) {
        let text = detected.text!;
        if (detected.format === 'json') JSON.parse(text);
        if (detected.format === 'html') text = htmlText(text);
        if (detected.format === 'csv') csvRows(text);
        if(Buffer.byteLength(text)>limits.extractedBytes)throw new Error('提取文本超过本地规模上限');
        checkpoint.pages = [{ page: 1, text, status: 'ready' }];
        checkpoint.complete = true; delete checkpoint.error;
        await persist();
        await options.onProgress?.({ completedPages: 1, totalPages: 1, page: 1, resumed, status: 'ready' });
      }
    } else if (!checkpoint.complete && !options.signal?.aborted) {
      const pdfModule = 'pdfjs-dist/legacy/build/pdf.mjs';
      const pdfjs = await import(pdfModule) as typeof import('pdfjs-dist');
      const loading = pdfjs.getDocument({ data: new Uint8Array(bytes),
        useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0, maxImageSize: limits.imagePixels });
      let document: PDFDocumentProxy | undefined;
      try {
        document = await loading.promise;
        if(document.numPages>limits.pdfPages){artifact.visualState='unavailable';throw new Error(`PDF超过 ${limits.pdfPages} 页上限`);}
        artifact.visualState='available';
        checkpoint.totalPages = document.numPages;
        artifact.pages = document.numPages;
        await persist();
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          if (options.signal?.aborted) { checkpoint.error = '资料解析已中断，可从已完成页面继续。'; break; }
          const prior = checkpoint.pages.find(page => page.page === pageNumber);
          if (prior && prior.status !== 'failed') continue;
          // A timeout or missing local OCR model may later be resolved. Successful
          // pages are immutable checkpoints; failed pages remain retryable.
          checkpoint.pages = checkpoint.pages.filter(page => page.page !== pageNumber);
          let parsed: ParsedPage;
          let page: PDFPageProxy | undefined;
          try {
            page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            let text = pdfText(content.items as Parameters<typeof pdfText>[0]);
            if (!text) {
              const operators = await page.getOperatorList();
              if (!operators.fnArray.length) parsed = { page: pageNumber, text: '', status: 'blank' };
              else if (options.ocr) {
                text = await ocrPdfPage(page, options);
                parsed = text ? { page: pageNumber, text, status: 'ready', ocr:true }
                  : { page: pageNumber, text: '', status: 'failed', error: '本地 OCR 未识别出可靠文字，此页未被当作空白或已覆盖。' };
              } else parsed = { page: pageNumber, text: '', status: 'failed',
                error: '此页含绘制内容但没有可提取文本，需要启用本地 OCR；未被当作空白或已覆盖。' };
            } else parsed = { page: pageNumber, text, status: 'ready' };
          } catch (error) {
            parsed = { page: pageNumber, text: '', status: 'failed', error: error instanceof Error ? error.message : '页解析失败。' };
          } finally { page?.cleanup(); }
          if(checkpoint.pages.reduce((n,p)=>n+Buffer.byteLength(p.text),0)+Buffer.byteLength(parsed.text)>limits.extractedBytes)throw new Error('提取文本超过本地规模上限；未读取剩余页面');
          checkpoint.pages.push(parsed);
          await persist();
          await options.onProgress?.({ completedPages: checkpoint.pages.length, totalPages: document.numPages,
            page: pageNumber, resumed, status: 'parsing' });
        }
        checkpoint.complete = checkpoint.pages.length === document.numPages;
        if (checkpoint.complete) delete checkpoint.error;
        await persist();
      } finally { await loading.destroy(); }
    }
    artifact.pages = detected.format === 'pdf' && checkpoint.totalPages > 0 ? checkpoint.totalPages : undefined;
    if(artifact.pages)artifact.visualState='available';
    artifact.chunks = materializeChunks(checkpoint.pages, detected.format, limits.chunkCharacters);
    artifact.failedPages = checkpoint.pages.filter(page=>page.status==='failed'||page.ocr).map(page=>page.page);
    artifact.ocrPages = checkpoint.pages.filter(page=>page.ocr).map(page=>page.page);
    const parseErrors = checkpoint.pages.filter((page) => page.error).map((page) => `第 ${page.page} 页：${page.error}`);
    if (!checkpoint.complete) {
      const completed = new Set(checkpoint.pages.map((page) => page.page));
      const unread = Array.from({ length: checkpoint.totalPages }, (_, index) => index + 1).filter((page) => !completed.has(page));
      artifact.failedPages = [...new Set([...artifact.failedPages, ...unread])];
      parseErrors.push(checkpoint.error ?? '解析未完成；未读取页面保留为未覆盖。');
    }
    artifact.status = checkpoint.complete && !artifact.failedPages.length ? 'ready'
      : artifact.chunks.length || artifact.visualState==='available' ? 'partial' : 'failed';
    if (parseErrors.length) artifact.error = parseErrors.join('\n');
    await atomicWrite(path.join(options.directory, 'extracted', `${sourceHash}.${sha(parser).slice(0, 16)}.json`),
      JSON.stringify({ sourceHash, parser, offsetSpace: 'normalized_extracted_text', chunks: artifact.chunks,
        pages: checkpoint.pages.map(({ page, status, error, ocr }) => ({ page, status, error, ocr })), complete: checkpoint.complete }));
    await options.onProgress?.({ completedPages: checkpoint.pages.length, totalPages: checkpoint.totalPages,
      resumed, status: artifact.status === 'ready' ? 'ready' : 'partial' });
    return artifact;
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : '资料解析失败。';
    if (checkpoint) {
      checkpoint.error = artifact.error;
      await persist().catch(() => undefined);
      artifact.chunks = materializeChunks(checkpoint.pages, checkpoint.format, (options.limits ?? DEFAULT_ATTACHMENT_LIMITS).chunkCharacters);
      artifact.pages = checkpoint.format === 'pdf' && checkpoint.totalPages > 0 ? checkpoint.totalPages : undefined;
      artifact.ocrPages=checkpoint.pages.filter(page=>page.ocr).map(page=>page.page);
      const completed = new Set(checkpoint.pages.filter(page=>page.status!=='failed'&&!page.ocr).map(page=>page.page));
      artifact.failedPages = Array.from({ length: checkpoint.totalPages }, (_, index) => index + 1).filter((page) => !completed.has(page));
      artifact.status = artifact.chunks.length || artifact.visualState==='available' ? 'partial' : 'failed';
    }
    return artifact;
  }
}

function boundedEnd(text: string, start: number, budget: number): number {
  let low = start;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(start, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low < text.length && low > start) {
    const piece = text.slice(start, low);
    const boundary = Math.max(piece.lastIndexOf('\n'), piece.lastIndexOf('。'), piece.lastIndexOf('；'), piece.lastIndexOf('. '));
    if (boundary >= piece.length / 2) low = start + boundary + 1;
    if (low > start && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  }
  return low;
}

export function readArtifact(artifact: Artifact, options: ArtifactReadOptions = {}): ArtifactReadResult {
  if (artifact.status === 'deleted') throw new Error('资料已删除，不能读取旧内容。');
  if (artifact.status === 'failed') throw new Error(artifact.error ?? '资料解析失败，不能把空结果当作已覆盖全文。');
  if (options.expectedVersion !== undefined && options.expectedVersion !== artifact.version) throw new Error('资料版本已变化，不能把新版本冒充发送时绑定的原件。');
  const ordinal = options.startOrdinal ?? 0;
  const offset = options.startOffset ?? 0;
  const count = options.count ?? 4;
  const budget = options.budget ?? 4000;
  if (![ordinal, offset, count, budget].every(Number.isSafeInteger) || ordinal < 0 || offset < 0 || count <= 0 || budget <= 0) throw new Error('资料读取游标、数量或预算无效。');
  const sorted = artifact.chunks.filter(c=>!c.searchOnly).sort((first, second) => first.ordinal - second.ordinal);
  let firstIndex = sorted.findIndex((chunk) => chunk.ordinal >= ordinal);
  if (offset && (firstIndex < 0 || sorted[firstIndex].ordinal !== ordinal || offset > sorted[firstIndex].text.length)) throw new Error('资料片段游标超出原文范围。');
  let firstOffset = offset;
  if (firstIndex >= 0 && offset === sorted[firstIndex].text.length) { firstIndex += 1; firstOffset = 0; }
  const result: ArtifactReadResult = { artifactId: artifact.id, version: artifact.version, chunks: [], headers: [], nextCursor: null,
    totalChunks: sorted.length, estimatedTokens: 0, failedPages: [...(artifact.failedPages ?? [])],
    coverage: { taskId: options.taskId, complete: false, readOrdinals: [], partiallyReadOrdinals: [] } };
  if (firstIndex < 0 || firstIndex >= sorted.length) { result.coverage.complete = !artifact.failedPages?.length && !sorted.length; return result; }
  for (let index = firstIndex; index < sorted.length; index += 1) {
    const chunk = sorted[index];
    const start = index === firstIndex ? firstOffset : 0;
    if (result.chunks.length >= count) { result.nextCursor = { startOrdinal: chunk.ordinal, startOffset: 0 }; break; }
    const metadataCost = estimateTokens(JSON.stringify({ id: chunk.id, page: chunk.page, start: chunk.start + start, end: chunk.end, hash: chunk.hash })) + 16;
    let headerText = '';
    if (start && artifact.mimeType === 'text/csv') headerText = csvRows(chunk.text)[0] ?? '';
    else if (start && artifact.mimeType === 'text/markdown') {
      const lines = chunk.text.split('\n');
      if (lines.length > 1 && lines[0].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[1])) headerText = lines.slice(0, 2).join('\n');
    }
    const headerCost = headerText ? estimateTokens(headerText) + metadataCost : 0;
    const remaining = budget - result.estimatedTokens - metadataCost - headerCost;
    if (remaining <= 0) { result.nextCursor = { startOrdinal: chunk.ordinal, startOffset: start }; break; }
    const end = boundedEnd(chunk.text, start, remaining);
    if (end <= start) { result.nextCursor = { startOrdinal: chunk.ordinal, startOffset: start }; break; }
    const selected = chunk.text.slice(start, end);
    if (headerText) result.headers.push({ ...chunk, end: chunk.start + headerText.length, text: headerText, hash: sha(headerText) });
    result.chunks.push({ ...chunk, start: chunk.start + start, end: chunk.start + end, text: selected, hash: sha(selected) });
    result.estimatedTokens += estimateTokens(selected) + metadataCost + headerCost;
    if (!start && end === chunk.text.length) result.coverage.readOrdinals.push(chunk.ordinal);
    else result.coverage.partiallyReadOrdinals.push(chunk.ordinal);
    if (end < chunk.text.length) { result.nextCursor = { startOrdinal: chunk.ordinal, startOffset: end }; break; }
  }
  if (result.nextCursor) result.truncated = true;
  // This describes only this response; no shared reading ledger or completion gate is maintained.
  result.coverage.complete = !result.nextCursor && !artifact.failedPages?.length && firstIndex === 0 && !offset
    && result.coverage.readOrdinals.length === sorted.length;
  return result;
}

function searchTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase().normalize('NFKC');
  const terms: string[] = normalized.match(/[a-z0-9_]+/g) ?? [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...run];
    if (characters.length === 1) terms.push(characters[0]);
    else for (let index = 0; index < characters.length - 1; index += 1) terms.push(characters.slice(index, index + 2).join(''));
  }
  return [...new Set(terms)];
}

function normalizeWithOffsets(text: string): { text: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  let original = 0;
  for (const character of text) {
    const replacement = character.toLocaleLowerCase().normalize('NFKC');
    normalized += replacement;
    for (let index = 0; index < replacement.length; index += 1) offsets.push(original);
    original += character.length;
  }
  return { text: normalized, offsets };
}

export function searchArtifacts(artifacts: Artifact[], query: string,
  options: { budget?: number; limit?: number } = {}): ArtifactSearchHit[] {
  const terms = searchTerms(query);
  const budget = options.budget ?? 4000;
  const limit = options.limit ?? 8;
  if (!query.trim() || !terms.length) return [];
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('检索预算或数量无效。');
  const newest = new Map<string, Artifact>();
  for (const artifact of artifacts) if (!newest.has(artifact.id) || newest.get(artifact.id)!.version < artifact.version) newest.set(artifact.id, artifact);
  const candidates: Array<{ artifact: Artifact; chunk: ArtifactChunk; score: number; firstMatch: number }> = [];
  for (const artifact of newest.values()) {
    if (!['ready', 'partial'].includes(artifact.status)) continue;
    for (const chunk of artifact.chunks) {
      const normalized = normalizeWithOffsets(chunk.text);
      let score = 0; let firstMatch = -1;
      for (const term of terms) {
        const match = normalized.text.indexOf(term);
        if (match >= 0) { score += 1; if (firstMatch < 0 || match < firstMatch) firstMatch = match; }
      }
      if (score) candidates.push({ artifact, chunk, score: score / terms.length, firstMatch: normalized.offsets[firstMatch] ?? 0 });
    }
  }
  candidates.sort((first, second) => second.score - first.score || first.artifact.id.localeCompare(second.artifact.id) || first.chunk.ordinal - second.chunk.ordinal);
  const hits: ArtifactSearchHit[] = [];
  let used = 0;
  for (const { artifact, chunk, score, firstMatch } of candidates) {
    if (hits.length >= limit) break;
    const overhead = estimateTokens(JSON.stringify({ artifactId: artifact.id, version: artifact.version, page: chunk.page,
      start: chunk.start, end: chunk.end, hash: chunk.hash, score })) + 24;
    const remaining = budget - used - overhead;
    if (remaining <= 0) break;
    // Use the original offset space. Normalization is only a matching aid; never cite normalized string offsets.
    let start = Math.max(0, Math.min(chunk.text.length - 1, firstMatch - 120));
    if (start && /[\uDC00-\uDFFF]/.test(chunk.text[start])) start -= 1;
    const end = boundedEnd(chunk.text, start, Math.min(remaining, 800));
    if (end <= start) continue;
    const excerpt = chunk.text.slice(start, end);
    const hit: ArtifactSearchHit = { artifactId: artifact.id, version: artifact.version, chunkId: chunk.id, ordinal: chunk.ordinal,
      ...(chunk.page ? { page: chunk.page } : {}), start: chunk.start + start, end: chunk.start + end,
      text: excerpt, hash: sha(excerpt), score, ...(chunk.searchOnly?{searchOnly:true}:{}) };
    hits.push(hit); used += overhead + estimateTokens(excerpt);
  }
  return hits;
}

