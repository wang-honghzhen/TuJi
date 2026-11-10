import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROVIDER, type ProviderConfig } from '../domain';
import { validateProviderConfig } from './providers';
import { DomainError } from './errors';
import type { Repository } from './repository';
import { officialDeepSeek } from '../webAccess';
import type { WebConnection } from './webTools';
import { parseAttachmentLimits, type AttachmentLimits } from '../attachments';

type Connection = Omit<Partial<ProviderConfig>, 'apiFamily'> & { apiFamily?: ProviderConfig['apiFamily'] | null; apiKey?: string };
interface WebConfiguration { enabled: boolean; provider?: 'deepseek'; baseUrl?: string; apiKey?: string; timeoutMs?: number }
interface Configuration { version: 1; execution: Connection; summary: Connection | null; webSearch: WebConfiguration; attachments?: AttachmentLimits }
const fields = ['protocol','baseUrl','model','contextWindow','maxInputTokens','maxOutputTokens','supportsTools','timeoutMs','apiFamily','thinkingEffort',
  'idleTimeoutMs','chatTokenLimit','includeUsage','includeEncryptedReasoning','toolCallProtocol','stream','maxResponseBytes','apiKey','supportsVision','visionModels'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new DomainError('API 配置文件格式无效，请检查 execution、summary 和 webSearch；密钥不会显示在错误中。', 'API_CONFIG_INVALID');
function key(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length >= 20000 || /[\r\n]/.test(value)) throw invalid();
  return value;
}
/** Section proportions and warning lines are application policy, not API settings. */
export function managedProvider(value: ProviderConfig): ProviderConfig {
  const { workNotesPercent: _notes, contextPresetTokens: _preset, ...provider } = value;
  return provider;
}
function connection(value: unknown): Connection {
  if (!object(value) || Object.keys(value).some(field => !fields.includes(field))) throw invalid();
  key(value.apiKey);
  return value as Connection;
}
function provider(value: Connection): ProviderConfig {
  const { apiKey: _key, ...settings } = value;
  const baseUrl = settings.baseUrl ?? DEFAULT_PROVIDER.baseUrl;
  const apiFamily = settings.apiFamily === null ? undefined : settings.apiFamily
    ?? (officialDeepSeek({ baseUrl, apiFamily: 'deepseek' }) ? 'deepseek' : undefined);
  const config = managedProvider({ ...DEFAULT_PROVIDER, ...settings,
    apiFamily, thinkingEffort: settings.thinkingEffort ?? (apiFamily ? DEFAULT_PROVIDER.thinkingEffort : undefined), webSearchEnabled: false });
  validateProviderConfig(config); return config;
}

/** File values stay on the host. Only the sanitized execution provider enters SQLite/SSE. */
export class ApiConfiguration {
  private raw = '';
  private value!: Configuration;
  constructor(readonly file: string) {}
  private write(raw: string) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, raw, { mode: 0o600 }); renameSync(temporary, this.file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  load(previous: ProviderConfig, storedCredential: string) {
    if (!existsSync(this.file)) this.write(JSON.stringify({ version: 1, execution: { ...managedProvider({ ...previous, webSearchEnabled: undefined, webSearchProvider: undefined }), apiFamily: previous.apiFamily ?? null },
      summary: null, webSearch: { enabled: previous.webSearchEnabled ?? false } }, null, 2) + '\n');
    this.raw = readFileSync(this.file, 'utf8');
    let data: unknown; try { data = JSON.parse(this.raw); } catch { throw invalid(); }
    if (!object(data) || data.version !== 1 || Object.keys(data).some(k => !['version','execution','summary','webSearch','attachments'].includes(k))) throw invalid();
    const attachments = parseAttachmentLimits(data.attachments);
    const execution = connection(data.execution), summary = data.summary == null ? null : connection(data.summary);
    const web = data.webSearch ?? { enabled: false };
    if (!object(web) || typeof web.enabled !== 'boolean' || Object.keys(web).some(k => !['enabled', 'provider', 'baseUrl', 'apiKey', 'timeoutMs'].includes(k))
      || (web.provider !== undefined && web.provider !== 'deepseek')
      || (web.timeoutMs !== undefined && (!Number.isSafeInteger(web.timeoutMs) || Number(web.timeoutMs) < 1 || Number(web.timeoutMs) > 60000))) throw invalid();
    key(web.apiKey);
    const webBaseUrl = web.baseUrl ?? 'https://api.deepseek.com/v1/tools';
    try {
      if (typeof webBaseUrl !== 'string') throw invalid();
      const url = new URL(webBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
    } catch { throw invalid(); }
    const selected = { ...provider(execution), webSearchEnabled: web.enabled,
      webSearchProvider: web.enabled ? 'deepseek' as const : undefined };
    validateProviderConfig(selected);
    const sameEndpoint = selected.baseUrl.replace(/\/+$/, '') === previous.baseUrl.replace(/\/+$/, '');
    const credential = key(execution.apiKey) ?? (sameEndpoint ? storedCredential : '');
    const inheritWebKey = officialDeepSeek(selected) && webBaseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com/v1/tools';
    if (web.enabled && !key(web.apiKey) && !inheritWebKey)
      throw new DomainError('联网 API 需要在 webSearch.apiKey 中单独填写密钥。', 'WEB_CREDENTIAL_REQUIRED');
    const webConnection: WebConnection | undefined = web.enabled ? { baseUrl: webBaseUrl,
      credential: key(web.apiKey), timeoutMs: Number(web.timeoutMs ?? 60000) } : undefined;
    let summaryConnection: Repository['summaryConnection'];
    if (summary) {
      // An independent connection must name its destination; never inherit credentials across endpoints.
      if (!summary.baseUrl || !summary.model || !summary.protocol) throw invalid();
      const summaryProvider = provider(summary);
      const same = summaryProvider.baseUrl.replace(/\/+$/, '') === selected.baseUrl.replace(/\/+$/, '');
      const apiKey = key(summary.apiKey);
      if (!apiKey && !same) throw new DomainError('独立摘要 API 地址需要单独填写 apiKey。', 'SUMMARY_CREDENTIAL_REQUIRED');
      summaryConnection = { provider: summaryProvider, credential: apiKey };
    }
    this.value = { version: 1, execution, summary, webSearch: web as unknown as WebConfiguration, attachments };
    return { provider: selected, credential, summaryConnection, webConnection, attachments };
  }
  executionSettings(basic: Partial<ProviderConfig>): ProviderConfig {
    if (readFileSync(this.file, 'utf8') !== this.raw)
      throw new DomainError('API 配置文件已在外部修改，请重启应用读取后再保存界面设置。', 'API_CONFIG_CHANGED');
    const execution = { ...this.value.execution };
    for (const field of ['protocol', 'baseUrl', 'model'] as const) {
      if (basic[field] !== undefined) Object.assign(execution, { [field]: basic[field] });
    }
    // Re-detect provider-specific defaults when the user changes the destination/protocol.
    if (execution.baseUrl !== this.value.execution.baseUrl || execution.protocol !== this.value.execution.protocol) {
      delete execution.apiFamily;
      if (this.value.webSearch.enabled && !key(this.value.webSearch.apiKey) && !officialDeepSeek(provider(execution)))
        throw new DomainError('切换模型前，请先在配置文件中填写独立的 webSearch.apiKey 或关闭联网。', 'WEB_CREDENTIAL_REQUIRED');
    }
    const summary = this.value.summary;
    if (summary && !key(summary.apiKey) && summary.baseUrl?.replace(/\/+$/, '') !== execution.baseUrl?.replace(/\/+$/, ''))
      throw new DomainError('切换模型前，请先在配置文件中填写独立的 summary.apiKey。', 'SUMMARY_CREDENTIAL_REQUIRED');
    return { ...provider(execution), webSearchEnabled: this.value.webSearch.enabled,
      webSearchProvider: this.value.webSearch.enabled ? 'deepseek' : undefined };
  }
  saveExecution(selected: ProviderConfig, credential?: string, forget = false): () => void {
    if (readFileSync(this.file, 'utf8') !== this.raw)
      throw new DomainError('API 配置文件已在外部修改，请重启应用读取后再保存界面设置。', 'API_CONFIG_CHANGED');
    const previous = this.raw, oldValue = this.value;
    const { webSearchEnabled: _web, webSearchProvider: _webProvider, ...settings } = managedProvider(selected);
    const execution: Connection = { ...settings, apiFamily: settings.apiFamily ?? null };
    // UI-entered keys use encrypted storage. Preserve a file key only when the user put one there.
    if (!forget && this.value.execution.apiKey) execution.apiKey = credential ?? this.value.execution.apiKey;
    const next = { ...this.value, execution };
    const raw = JSON.stringify(next, null, 2) + '\n';
    this.write(raw); this.raw = raw; this.value = next;
    return () => { this.write(previous); this.raw = previous; this.value = oldValue; };
  }
}

export function summaryConnection(repo: Repository, selection?: { model?: string; thinkingEffort?: ProviderConfig['thinkingEffort'] }) {
  const independent = repo.summaryConnection;
  if (!independent) return { provider: { ...repo.state.provider, ...selection }, credential: repo.credential };
  const same = independent.provider.baseUrl.replace(/\/+$/, '') === repo.state.provider.baseUrl.replace(/\/+$/, '');
  if (!independent.credential && !same) throw new DomainError('摘要模型需要独立 API 密钥，请更新配置文件。', 'SUMMARY_CREDENTIAL_REQUIRED');
  return { provider: independent.provider, credential: independent.credential ?? repo.credential };
}
