import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderConfig } from './providers';
import { officialDeepSeek, webAccessEnabled, webUrl } from '../webAccess';
import { DomainError, requireValue } from './errors';

// https://api-docs.deepseek.com/guides/search/
export const WEB_RESPONSE_BYTES = 16 * 1024 * 1024;
export const isWebTool = (name: string): name is 'web_search' | 'web_fetch' => name === 'web_search' || name === 'web_fetch';
export interface WebData extends Record<string, unknown> {
  provider: 'deepseek'; kind: 'web_search' | 'web_fetch'; fetchedAt: string; contentVersion: string;
  contentTrust: 'external_untrusted'; coverageScope: 'returned_data'; items: Record<string, unknown>[];
}
export interface WebConnection { baseUrl: string; credential?: string; timeoutMs: number }
export interface WebCallOptions { signal: AbortSignal; timeoutMs: number; fetcher?: typeof fetch; connection?: WebConnection }

export function webRequest(name: string, args: Record<string, unknown>): Record<string, unknown> {
  requireValue(isWebTool(name), '未知联网函数', 'TOOL_NOT_ALLOWED');
  if (name === 'web_search') {
    requireValue(Object.keys(args).every(key => ['query', 'count'].includes(key)) && typeof args.query === 'string'
      && args.query.trim().length > 0 && Array.from(args.query).length <= 128, '搜索词须为 1～128 个 Unicode 字符', 'INVALID_ARGUMENT');
    const count = args.count ?? 5;
    requireValue(Number.isSafeInteger(count) && Number(count) >= 1 && Number(count) <= 50, '搜索结果数须为 1～50 的整数', 'INVALID_ARGUMENT');
    return { query: args.query, count, need_content: false };
  }
  requireValue(Object.keys(args).every(key => key === 'url') && webUrl(args.url), '网页地址须为有效 HTTP(S) 地址，不含用户名或密码，最长 8192 字符', 'INVALID_ARGUMENT');
  return { url: args.url };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const malformed = () => new DomainError('DeepSeek 返回了无效的联网数据', 'WEB_INVALID_RESPONSE');
function normalize(name: 'web_search' | 'web_fetch', request: Record<string, unknown>, raw: unknown): WebData {
  if (!object(raw)) throw malformed();
  let items: Record<string, unknown>[];
  if (name === 'web_search') {
    if (!Array.isArray(raw.results) || raw.results.length > Number(request.count)) throw malformed();
    items = raw.results.map(row => {
      if (!object(row) || typeof row.title !== 'string' || !webUrl(row.url)
        || typeof row.snippet !== 'string' || typeof row.summary !== 'string') throw malformed();
      // Keep actual result metadata, never arbitrary top-level transport/error fields.
      const item: Record<string, unknown> = { title: row.title, url: row.url, snippet: row.snippet, summary: row.summary };
      for (const key of ['date', 'site_name', 'site_icon']) if (row[key] === null || typeof row[key] === 'string') item[key] = row[key];
      for (const key of ['rerank_score', 'authority']) if (typeof row[key] === 'number' && Number.isFinite(row[key])) item[key] = row[key];
      return item;
    });
  } else {
    if (typeof raw.title !== 'string' || typeof raw.content !== 'string') throw malformed();
    items = [{ url: request.url, title: raw.title, content: raw.content, start: 0, end: raw.content.length }];
  }
  return { provider: 'deepseek', kind: name, fetchedAt: new Date().toISOString(),
    contentVersion: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    contentTrust: 'external_untrusted', coverageScope: 'returned_data',
    ...(name === 'web_search' ? { query: request.query, count: request.count, contentType: 'search_summary' } : { url: request.url, contentType: 'page_markdown' }), items };
}
const httpMessages: Record<number, string> = { 400: '联网请求参数无效', 401: 'DeepSeek 密钥无效', 402: 'DeepSeek 账户余额不足',
  403: '网页读取被服务方策略拒绝', 404: '网页不可用或没有可提取的正文', 408: '联网请求超时', 413: '联网请求过大', 429: '联网请求频率超限' };
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw malformed();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > WEB_RESPONSE_BYTES) throw new DomainError('联网响应超过 16 MiB 上限', 'WEB_RESPONSE_TOO_LARGE');
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > WEB_RESPONSE_BYTES) throw new DomainError('联网响应超过 16 MiB 上限', 'WEB_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw malformed(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One deadline spans the request, body download and at most one transient retry. */
export async function callWeb(config: ProviderConfig, credential: string, name: string, args: Record<string, unknown>, options: WebCallOptions): Promise<WebData> {
  requireValue(webAccessEnabled(config), '请在 api-config.json 中配置并开启联网 API', 'TOOL_NOT_ALLOWED');
  const baseUrl = options.connection?.baseUrl ?? 'https://api.deepseek.com/v1/tools';
  requireValue(!!options.connection?.credential || officialDeepSeek(config) && baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com/v1/tools',
    '请在配置文件中填写独立的联网 API 密钥', 'WEB_AUTH_REQUIRED');
  credential = options.connection?.credential ?? credential;
  requireValue(!!credential, '尚未配置 DeepSeek 密钥', 'WEB_AUTH_REQUIRED');
  const request = webRequest(name, args);
  requireValue(options.timeoutMs > 0, '任务已达到运行时间预算', 'WEB_TIMEOUT');
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, Math.min(options.connection?.timeoutMs ?? 60000, options.timeoutMs));
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        controller.signal.throwIfAborted();
        const response = await (options.fetcher ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/${name === 'web_search' ? 'search' : 'fetch'}`, {
          method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify(request), redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new DomainError(httpMessages[response.status] ?? 'DeepSeek 联网服务暂不可用', `WEB_HTTP_${response.status}`);
        }
        const raw = await boundedJson(response); controller.signal.throwIfAborted();
        return normalize(name as 'web_search' | 'web_fetch', request, raw);
      } catch (error) {
        if (controller.signal.aborted) throw new DomainError(options.signal.aborted ? '联网读取已中断' : '联网读取超过时限', options.signal.aborted ? 'WEB_INTERRUPTED' : 'WEB_TIMEOUT');
        const transient = error instanceof TypeError || error instanceof DomainError && /^WEB_HTTP_(408|429|5\d\d)$/.test(error.code);
        if (attempt === 0 && transient) { await delay(250, undefined, { signal: controller.signal }); continue; }
        if (error instanceof DomainError) throw error;
        // Transport errors may contain request headers. Never persist their raw message/cause.
        throw new DomainError('无法连接 DeepSeek 联网服务', 'WEB_NETWORK_ERROR');
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new DomainError(options.signal.aborted ? '联网读取已中断' : '联网读取超过时限', options.signal.aborted ? 'WEB_INTERRUPTED' : 'WEB_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); }
}
