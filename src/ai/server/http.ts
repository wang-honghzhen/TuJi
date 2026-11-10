import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSnapshot } from '../domain';
import { Application } from './application';
import { ApiConfiguration } from './apiConfiguration';
import { publicRecord, Repository, type RepositoryUpdate } from './repository';
import { StructureConfirmationRequired } from '@/v3/structure';

export { Application, Repository };

export interface LocalApplication {
  snapshot(): AppSnapshot;
  dispatch(action: string, payload: unknown): Promise<unknown>;
}
export type Middleware = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
export interface HttpServerOptions {
  application: LocalApplication;
  subscribe: (listener: (update: RepositoryUpdate) => void) => (() => void);
  port?: number;
  distDirectory?: string;
  maxBodyBytes?: number;
}
export interface LocalHttpServer {
  server: Server;
  token: string;
  port: number;
  url: string;
  setMiddleware(middleware?: Middleware): void;
  beginShutdown(): void;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const text = JSON.stringify(body === undefined ? null : body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}
function sameToken(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function loopback(request: IncomingMessage, port: number): boolean {
  const address = request.socket.remoteAddress;
  const host = request.headers.host?.toLowerCase();
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) return false;
  return true;
}
function rejectCrossSite(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}
async function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) throw Object.assign(new Error('请求正文超过本地服务上限。'), { status: 413, code: 'BODY_TOO_LARGE' });
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw Object.assign(new Error('请求正文超过本地服务上限。'), { status: 413, code: 'BODY_TOO_LARGE' });
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw Object.assign(new Error('请求正文不是完整 JSON。'), { status: 400, code: 'INVALID_JSON' }); }
}
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

export async function startHttpServer(options: HttpServerOptions): Promise<LocalHttpServer> {
  const token = randomBytes(32).toString('base64url');
  const clients = new Map<ServerResponse, { pending?: string[]; after: number }>();
  const upgradedSockets = new Set<import('node:stream').Duplex>();
  let port = 0;
  let middleware: Middleware | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let pendingUpdate: { seq: number; records: Map<string, { collection: string; id: string; record?: unknown }>; meta: Record<string, unknown> } | undefined;
  let publishScheduled = false;
  const writeSnapshot = (response: ServerResponse, snapshot: AppSnapshot, payload?: string) => {
    const client = clients.get(response);
    if (!client || response.destroyed || response.writableEnded) return;
    const frame = `id: ${snapshot.lastSeq}\nevent: snapshot\ndata: ${payload ?? JSON.stringify(snapshot)}\n\n`;
    // Deltas must never be dropped: while the socket is draining they queue, and a full snapshot
    // supersedes whatever is still queued because it already contains all of it.
    if (response.writableNeedDrain) (client.pending ??= []).push(frame);
    else { response.write(frame); client.after = snapshot.lastSeq; }
  };
  const writeUpdate = (response: ServerResponse, seq: number, payload: string) => {
    const client = clients.get(response);
    if (!client || response.destroyed || response.writableEnded) return;
    // One commit becomes one small frame: only the records it changed travel to the renderer.
    const frame = `id: ${seq}\nevent: update\ndata: ${payload}\n\n`;
    if (response.writableNeedDrain) (client.pending ??= []).push(frame);
    else { response.write(frame); client.after = seq; }
  };
  const unsubscribe = options.subscribe((update) => {
    // One commit becomes one small frame: only what it changed travels to the renderer, and
    // commits that changed nothing the renderer shows never leave this process.
    const pending = pendingUpdate ??= { seq: 0, records: new Map<string, { collection: string; id: string; record?: unknown }>(), meta: {} };
    pending.seq = Math.max(pending.seq, update.lastSeq);
    for (const record of update.records) pending.records.set(`${record.collection}:${record.id}`, record as { collection: string; id: string; record?: unknown });
    Object.assign(pending.meta, update.meta);
    if (publishScheduled) return;
    publishScheduled = true;
    setImmediate(() => {
      publishScheduled = false;
      const latest = pendingUpdate; pendingUpdate = undefined;
      if (!latest || closing) return;
      if (!latest.records.size && !Object.keys(latest.meta).length) return;
      const payload = JSON.stringify({ lastSeq: latest.seq,
        records: [...latest.records.values()].map(record => ({ ...record, record: publicRecord(record.collection, record.record) })), meta: latest.meta });
      for (const response of clients.keys()) writeUpdate(response, latest.seq, payload);
    });
  });
  const heartbeat = setInterval(() => {
    for (const response of clients.keys()) if (!response.writableNeedDrain && !response.writableEnded) response.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  const staticFile = async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    if (!options.distDirectory) { json(response, 404, { error: '页面尚未构建，请使用开发启动命令。', code: 'NO_RENDERER' }); return; }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { json(response, 405, { error: '方法不支持。', code: 'METHOD_NOT_ALLOWED' }); return; }
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { json(response, 400, { error: '页面路径编码无效。', code: 'INVALID_PATH' }); return; }
    if (decoded.includes('\0') || decoded.includes('\\')) { json(response, 403, { error: '页面路径无效。', code: 'INVALID_PATH' }); return; }
    const directory = path.resolve(options.distDirectory);
    let file = path.resolve(directory, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (file !== directory && !file.startsWith(`${directory}${path.sep}`)) { json(response, 403, { error: '页面路径越界。', code: 'INVALID_PATH' }); return; }
    try {
      let stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() && !path.extname(decoded)) { file = path.join(directory, 'index.html'); stat = await fs.stat(file).catch(() => null); }
      if (!stat?.isFile()) { json(response, 404, { error: '页面资源不存在。', code: 'NOT_FOUND' }); return; }
      const realDirectory = await fs.realpath(directory); const realFile = await fs.realpath(file);
      const relative = path.relative(realDirectory, realFile);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        json(response, 403, { error: '页面资源链接越界。', code: 'INVALID_PATH' }); return;
      }
      const contents = request.method === 'HEAD' ? undefined : await fs.readFile(file);
      const html = path.extname(file) === '.html';
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Cache-Control': html ? 'no-store' : 'public, max-age=3600',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(contents);
    } catch { json(response, 500, { error: '页面资源读取失败。', code: 'RENDERER_READ_FAILED' }); }
  };
  const server = createServer(async (request, response) => {
    if (!loopback(request, port)) { json(response, 403, { error: '仅接受本应用的本地同源请求。', code: 'ORIGIN_REJECTED' }); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${request.headers.host}`); }
    catch { json(response, 400, { error: '请求地址无效。', code: 'INVALID_URL' }); return; }
    if (url.origin !== `http://${request.headers.host}`) { json(response, 403, { error: '请求地址与本地来源不一致。', code: 'ORIGIN_REJECTED' }); return; }
    if (url.pathname.startsWith('/api/qixue/')) {
      if (rejectCrossSite(request)) { json(response, 403, { error: '拒绝跨站访问本地会话服务。', code: 'CROSS_SITE_REJECTED' }); return; }
      if (closing) { json(response, 503, { error: '本地服务正在关闭，任务状态正在保存。', code: 'SHUTTING_DOWN' }); return; }
      if (url.pathname === '/api/qixue/connection' && request.method === 'GET') { json(response, 200, { token }); return; }
      const suppliedToken = url.pathname === '/api/qixue/events' ? url.searchParams.get('token') ?? undefined
        : request.headers['x-qixue-token'];
      if (!sameToken(typeof suppliedToken === 'string' ? suppliedToken : undefined, token)) { json(response, 401, { error: '本地连接令牌无效，请重新连接。', code: 'UNAUTHORIZED' }); return; }
      try {
        if (url.pathname === '/api/qixue/snapshot' && request.method === 'GET') { json(response, 200, options.application.snapshot()); return; }
        if (url.pathname === '/api/qixue/events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) { json(response, 400, { error: '事件游标无效。', code: 'INVALID_CURSOR' }); return; }
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
          response.flushHeaders();
          response.write('retry: 1000\n\n');
          clients.set(response, { after });
          // The listener is already attached. This high-water snapshot includes every committed fact through lastSeq.
          writeSnapshot(response, options.application.snapshot());
          response.on('drain', () => { const client = clients.get(response); if (client?.pending) {
            const frames = client.pending; client.pending = undefined; for (const frame of frames) response.write(frame);
          } });
          response.on('close', () => { clients.delete(response); });
          return;
        }
        if (url.pathname === '/api/qixue/command' && request.method === 'POST') {
          if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            json(response, 415, { error: '命令请求必须使用 JSON。', code: 'CONTENT_TYPE_REQUIRED' }); return;
          }
          const command = await body(request, options.maxBodyBytes ?? 128 * 1024 * 1024) as { action?: unknown; payload?: unknown };
          if (!command || typeof command !== 'object' || typeof command.action !== 'string' || command.action.length > 200) {
            json(response, 400, { error: '命令名称无效。', code: 'INVALID_COMMAND' }); return;
          }
          const result = await options.application.dispatch(command.action, command.payload ?? {});
          json(response, 200, result); return;
        }
        json(response, 404, { error: '本地接口不存在或方法不支持。', code: 'NOT_FOUND' }); return;
      } catch (error) {
        if (error instanceof StructureConfirmationRequired) {
          json(response, 409, { error: error.message, code: 'STRUCTURE_CONFIRMATION_REQUIRED',
            details: { conflicts: error.conflicts, revision: error.revision } }); return;
        }
        const value = error as { message?: string; status?: number; code?: string; details?: unknown };
        const expected = typeof value.status === 'number' && value.status >= 400 && value.status < 600;
        json(response, expected ? value.status! : 500, { error: expected ? value.message ?? '请求未能完成。' : '本地服务处理失败，任务事实已保留。',
          code: value.code ?? 'INTERNAL_ERROR', ...(value.details === undefined ? {} : { details: value.details }) });
        return;
      }
    }
    if (middleware) {
      try { middleware(request, response, (error) => {
          if (error) json(response, 500, { error: '开发页面服务失败。', code: 'RENDERER_ERROR' });
          else void staticFile(request, response, url.pathname);
        });
      } catch { json(response, 500, { error: '开发页面服务失败。', code: 'RENDERER_ERROR' }); }
    } else await staticFile(request, response, url.pathname);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('upgrade', (request, socket) => {
    if (!middleware || !loopback(request, port) || rejectCrossSite(request)) { socket.destroy(); return; }
    upgradedSockets.add(socket); socket.once('close', () => upgradedSockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject); const address = server.address(); port = typeof address === 'object' && address ? address.port : 0; resolve();
    }); });
  } catch (error) { clearInterval(heartbeat); unsubscribe(); throw error; }
  return { server, token, port, url: `http://127.0.0.1:${port}`, setMiddleware(value) { middleware = value; },
    beginShutdown() { closing = true; },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearInterval(heartbeat); unsubscribe();
      for (const response of clients.keys()) response.end(); clients.clear();
      for (const socket of upgradedSockets) socket.destroy(); upgradedSockets.clear();
      closePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => server.closeAllConnections(), 2000); timeout.unref();
        server.close((error) => { clearTimeout(timeout); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      });
      return closePromise;
    } };
}

export async function startApplicationServer(options: {
  databasePath: string; artifactDirectory: string; port?: number; distDirectory?: string;
  credentialStorage?: { get(): string | null | Promise<string | null>; set(value: string): void | Promise<void>; clear(): void | Promise<void> };
}) {
  let repo: Repository | undefined;
  let application: Application | undefined;
  try {
    repo = new Repository(options.databasePath,{artifactDirectory:options.artifactDirectory});
    application = new Application(repo, { artifactDirectory: options.artifactDirectory, credentialStorage: options.credentialStorage,
      ...(options.databasePath === ':memory:' ? {} : { apiConfiguration: new ApiConfiguration(path.join(path.dirname(options.databasePath), 'api-config.json')) }) });
    await application.ready();
    const transport = await startHttpServer({ application, subscribe: listener => repo!.subscribe(listener),
      port: options.port, distDirectory: options.distDirectory });
    let closing: Promise<void> | undefined;
    return { ...transport, application, repo, close() {
      if (closing) return closing;
      transport.beginShutdown();
      closing = (async () => { try { await application!.close(); }
        finally { try { await transport.close(); } finally { repo!.close(); } } })();
      return closing;
    } };
  } catch (error) { try { await application?.close(); } finally { repo?.close(); } throw error; }
}
