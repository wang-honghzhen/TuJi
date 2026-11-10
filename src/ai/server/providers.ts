import { estimateTokens } from '../tokens';
import { CONTEXT_PRESETS, contextCapacity, type ContextPresetTokens } from '../contextCapacity';
import { officialDeepSeek } from '../webAccess';
/** Stateless model transports. Credentials are accepted only for the current call.
 * Protocol references: https://developers.openai.com/api/docs/guides/function-calling
 * https://developers.openai.com/api/docs/guides/streaming-responses
 * https://developers.openai.com/api/docs/guides/conversation-state
 */
export type ProviderProtocol = 'responses' | 'chat-completions';

export interface ProviderConfig {
  supportsVision?: boolean;
  visionModels?: string[];
  apiFamily?: 'deepseek';
  thinkingEffort?: 'none' | 'low' | 'high' | 'max';
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  contextWindow: number;
  contextPresetTokens?: ContextPresetTokens;
  maxInputTokens?: number;
  workNotesPercent?: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  webSearchEnabled?: boolean;
  webSearchProvider?: 'deepseek';
  /** Explicit capability declaration; do not guess capabilities from a model name. */
  toolCallProtocol?: ProviderProtocol;
  stream?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  chatTokenLimit?: 'max_tokens' | 'max_completion_tokens';
  includeUsage?: boolean;
  /** Keep compatibility with providers that do not accept Responses include. */
  includeEncryptedReasoning?: boolean;
  maxResponseBytes?: number;
}

export interface ModelToolCall { id: string; name: string; arguments: string }
export interface ModelMessage {
  images?: import('../attachments').ImageAssetRef[];
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  /** Completed Responses output, including opaque encrypted reasoning. Server only.
   * Replay it explicitly on the corresponding assistant turn; never put it in notes.
   */
  responseItems?: Record<string, unknown>[];
  /** Private DeepSeek continuation, excluded from public history and memory exports. */
  reasoningContent?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}
export interface ModelRequest { messages: ModelMessage[]; tools: ToolDefinition[] }
export interface ModelResponse {
  transport?: { requestBytes: number; imageTransportBytes: number; estimatedImageTokens: number };
  text: string;
  toolCalls: ModelToolCall[];
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  providerResponseId?: string;
  finishReason: string;
  responseItems?: Record<string, unknown>[];
  reasoningContent?: string;
}
export interface CallModelOptions {
  resolveImage?: (image: import('../attachments').ImageAssetRef) => Promise<string>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
}

export type ProviderErrorCode = 'invalid_config' | 'invalid_request' | 'authentication'
  | 'rate_limit' | 'server' | 'context_limit' | 'network' | 'timeout' | 'aborted'
  | 'truncated' | 'protocol' | 'tool_arguments' | 'provider' | 'callback';

export class ProviderError extends Error {
  readonly name = 'ProviderError';
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly parameter?: string;
  constructor(code: ProviderErrorCode, message: string, details: {
    status?: number; retryable?: boolean; retryAfterMs?: number;
    providerCode?: string; requestId?: string; parameter?: string;
  } = {}) {
    super(message);
    this.code = code;
    this.status = details.status;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
    this.providerCode = details.providerCode;
    this.requestId = details.requestId;
    this.parameter = details.parameter;
  }
  toJSON() {
    return { code: this.code, message: this.message, status: this.status,
      retryable: this.retryable, retryAfterMs: this.retryAfterMs,
      providerCode: this.providerCode, requestId: this.requestId, parameter: this.parameter };
  }
}

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const toolName = /^[a-zA-Z0-9_-]{1,64}$/;
const protocolError = () => new ProviderError('protocol', '模型提供方返回了无法验证的响应。');
const truncatedError = () => new ProviderError('truncated', '模型响应未完整结束，未完成的工具调用不会执行。', { retryable: true });
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const tokenCount = (value: unknown): number | undefined => integer(value, 0, Number.MAX_SAFE_INTEGER) ? value : undefined;

export function validateProviderConfig(config: ProviderConfig): void {
  if (!config || !['responses', 'chat-completions'].includes(config.protocol)
    || typeof config.model !== 'string' || !config.model.trim() || config.model.length > 256
    || !integer(config.contextWindow, 2, 100_000_000)
    || !integer(config.maxOutputTokens, 1, config.contextWindow - 1)
    || (config.maxInputTokens !== undefined && !integer(config.maxInputTokens,1,config.contextWindow))
    || (config.contextPresetTokens !== undefined && !(CONTEXT_PRESETS as readonly unknown[]).includes(config.contextPresetTokens))
    || !(contextCapacity(config).inputCapacity > 0)
    || (config.workNotesPercent !== undefined && (!Number.isFinite(config.workNotesPercent) || config.workNotesPercent < 0 || config.workNotesPercent > 100))
    || typeof config.supportsTools !== 'boolean'
    || (config.supportsVision !== undefined && typeof config.supportsVision !== 'boolean')
    || (config.visionModels !== undefined && (!Array.isArray(config.visionModels) || config.visionModels.length>100 || config.visionModels.some(m=>typeof m!=='string'||!m.trim())))
    || (config.webSearchEnabled !== undefined && typeof config.webSearchEnabled !== 'boolean')
    || (config.webSearchProvider !== undefined && config.webSearchProvider !== 'deepseek')
    || (config.webSearchEnabled === true && !config.webSearchProvider && !officialDeepSeek(config))
    || (config.apiFamily !== undefined && config.apiFamily !== 'deepseek')
    || (config.thinkingEffort !== undefined && !['none', 'low', 'high', 'max'].includes(config.thinkingEffort))
    || (config.toolCallProtocol !== undefined && !['responses', 'chat-completions'].includes(config.toolCallProtocol))
    || (config.stream !== undefined && typeof config.stream !== 'boolean')
    || (config.includeUsage !== undefined && typeof config.includeUsage !== 'boolean')
    || (config.includeEncryptedReasoning !== undefined && typeof config.includeEncryptedReasoning !== 'boolean')
    || (config.timeoutMs !== undefined && !integer(config.timeoutMs, 1, 900_000))
    || (config.idleTimeoutMs !== undefined && !integer(config.idleTimeoutMs, 1, 900_000))
    || (config.maxResponseBytes !== undefined && !integer(config.maxResponseBytes, 1024, 64 * 1024 * 1024))
    || (config.chatTokenLimit !== undefined && !['max_tokens', 'max_completion_tokens'].includes(config.chatTokenLimit))) {
    throw new ProviderError('invalid_config', '请检查模型、协议、上下文上限和输出上限配置。');
  }
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new ProviderError('invalid_config', '提供方地址必须是 HTTP(S) 地址，且不含用户名、密码、查询参数或片段。');
  }
}

function validateArguments(value: unknown, retryable = false): string {
  if (typeof value !== 'string') throw new ProviderError('tool_arguments', '工具参数必须是完整的 JSON 对象。', { retryable });
  try { if (!record(JSON.parse(value))) throw new Error(); }
  catch { throw new ProviderError('tool_arguments', '工具参数不是完整的 JSON 对象，未执行该调用。', { retryable }); }
  return value;
}

/** Same call, allowing the argument text to be formatted differently (it may be re-serialized). */
function sameToolCall(item: ModelToolCall, call: ModelToolCall | undefined): boolean {
  if (!call || item.id !== call.id || item.name !== call.name) return false;
  if (item.arguments === call.arguments) return true;
  try { return JSON.stringify(JSON.parse(item.arguments)) === JSON.stringify(JSON.parse(call.arguments)); }
  catch { return false; }
}

function validateRequest(request: ModelRequest, config: ProviderConfig): void {
  const invalid = () => new ProviderError('invalid_request', '提示词或工具调用历史不完整，请重新构建上下文。');
  if (!request || !Array.isArray(request.messages) || !request.messages.length || !Array.isArray(request.tools)) throw invalid();
  if (request.tools.length && !config.supportsTools) throw new ProviderError('invalid_config', '当前模型配置未开启工具调用能力。');
  if (request.tools.length && config.toolCallProtocol && config.toolCallProtocol !== config.protocol) {
    throw new ProviderError('invalid_config', '当前模型的工具调用需要使用配置指定的协议。');
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (!tool || !toolName.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string'
      || !record(tool.parameters) || tool.parameters.type !== 'object'
      || (tool.strict !== undefined && typeof tool.strict !== 'boolean')) throw invalid();
    names.add(tool.name);
  }
  const pending = new Set<string>();
  const allIds = new Set<string>();
  for (const message of request.messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') throw invalid();
    if (message.images !== undefined && (message.role !== 'user' || !Array.isArray(message.images) || message.images.some(i=>!i || !/^[a-f0-9]{64}$/.test(i.assetId) || !Number.isSafeInteger(i.width) || !Number.isSafeInteger(i.height) || i.width<=0 || i.height<=0))) throw invalid();
    if (message.reasoningContent !== undefined && (message.role !== 'assistant' || typeof message.reasoningContent !== 'string')) throw invalid();
    if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) throw invalid();
    if (message.role === 'tool') {
      if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId) || message.toolCalls?.length || message.responseItems) throw invalid();
    } else {
      if (pending.size || message.toolCallId !== undefined) throw invalid();
      if (message.toolCalls?.length && message.role !== 'assistant') throw invalid();
      for (const call of message.toolCalls ?? []) {
        if (!call || typeof call.id !== 'string' || !call.id || allIds.has(call.id) || !toolName.test(call.name)) throw invalid();
        validateArguments(call.arguments);
        allIds.add(call.id); pending.add(call.id);
      }
      if (message.responseItems !== undefined) {
        if (message.role !== 'assistant' || !Array.isArray(message.responseItems)) throw invalid();
        const itemCalls: ModelToolCall[] = [];
        for (const item of message.responseItems) {
          if (!record(item) || !['reasoning', 'message', 'function_call'].includes(String(item.type))) throw invalid();
          if (item.type === 'message' && item.role !== 'assistant') throw invalid();
          if (item.type === 'reasoning' && typeof item.encrypted_content !== 'string') throw invalid();
          if (item.type === 'function_call') {
            if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw invalid();
            itemCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
          }
        }
        // The provider's own items are replayed verbatim while `toolCalls` may have been
        // re-serialized on the way here, so the two are compared as data, not as text.
        if (itemCalls.length !== (message.toolCalls ?? []).length
          || itemCalls.some((call, index) => !sameToolCall(call, (message.toolCalls ?? [])[index]))) throw invalid();
      }
    }
  }
  if (pending.size) throw invalid();
}

function makeBody(config: ProviderConfig, request: ModelRequest, urls?:Map<string,string>): JsonObject {
  const content=(message:ModelMessage)=>message.images?.length
    ? [{type:config.protocol==='responses'?'input_text':'text',text:message.content},...message.images.map(image=>config.protocol==='responses'
      ? {type:'input_image',image_url:urls?.get(image.assetId)??`qixue-asset:${image.assetId}`,detail:'high'}
      : {type:'image_url',image_url:{url:urls?.get(image.assetId)??`qixue-asset:${image.assetId}`,detail:'high'}})] : message.content;
  const common: JsonObject = { model: config.model, stream: config.stream !== false, store: false };
  const deepseek = config.apiFamily === 'deepseek';
  if (deepseek) delete common.store;
  if (config.protocol === 'chat-completions') {
    if (deepseek) {
      common.thinking = { type: config.thinkingEffort === 'none' ? 'disabled' : 'enabled' };
      if (config.thinkingEffort !== 'none') common.reasoning_effort = config.thinkingEffort ?? 'high';
    }
    common.messages = request.messages.map(message => message.role === 'tool'
      ? { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
      : { role: message.role, content: content(message) || (!deepseek && message.toolCalls?.length ? null : ''),
          ...(deepseek && message.role === 'assistant' && request.tools.length ? { reasoning_content: message.reasoningContent ?? '' } : {}),
          ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) });
    common[config.chatTokenLimit ?? (deepseek ? 'max_tokens' : 'max_completion_tokens')] = config.maxOutputTokens;
    if (common.stream && config.includeUsage !== false) common.stream_options = { include_usage: true };
    if (request.tools.length) common.tools = request.tools.map(tool => ({ type: 'function', function: { ...tool, strict: tool.strict ?? false } }));
    return common;
  }
  const input: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    else if (message.role === 'assistant' && message.responseItems?.length) input.push(...message.responseItems);
    else {
      if (message.content || message.images?.length || !message.toolCalls?.length) input.push({ role: message.role, content: content(message) });
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    }
  }
  common.input = input;
  if (deepseek) common.reasoning = { effort: config.thinkingEffort ?? 'high' };
  common.max_output_tokens = config.maxOutputTokens;
  if (config.includeEncryptedReasoning !== false) common.include = ['reasoning.encrypted_content'];
  if (request.tools.length) common.tools = request.tools.map(tool => ({ type: 'function', ...tool, strict: tool.strict ?? false }));
  return common;
}

/** Counts the actual provider request shape, including tool schema and protocol envelopes. */
export function imageTokens(images:ReadonlyArray<import('../attachments').ImageAssetRef> = []):number {
  return images.reduce((n,i)=>n+1024+256*Math.ceil(i.width/512)*Math.ceil(i.height/512),0);
}
export function requestTokens(config:ProviderConfig,request:{messages:ReadonlyArray<Pick<ModelMessage,'role'|'content'|'toolCalls'|'toolCallId'|'images'>>;tools:ToolDefinition[]}):number {
  return estimateTokens(serializeRequest(config,request as ModelRequest))+imageTokens(request.messages.flatMap(m=>m.images??[]));
}

export function serializeRequest(config:ProviderConfig,request:ModelRequest){return JSON.stringify(makeBody(config,request));}

function endpoint(config: ProviderConfig): string {
  const suffix = config.protocol === 'responses' ? '/responses' : '/chat/completions';
  const url = new URL(config.baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : path + suffix;
  return url.toString();
}

function safeIdentifier(value: unknown, credential: string): string | undefined {
  return typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9_.:-]+$/.test(value) && !value.includes(credential) ? value : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(86_400_000, Math.max(0, Number(value) * 1000));
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.min(86_400_000, Math.max(0, time - Date.now())) : undefined;
}

function httpError(status: number, body: unknown, headers: Headers, credential: string): ProviderError {
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  const providerCode = safeIdentifier(error.code ?? error.type, credential);
  const details = { status, providerCode, requestId: safeIdentifier(headers.get('x-request-id'), credential),
    retryAfterMs: parseRetryAfter(headers.get('retry-after')), parameter: safeIdentifier(error.param, credential) };
  if (status === 401 || status === 403) return new ProviderError('authentication', '提供方认证失败，请检查凭据和访问权限。', details);
  if (status === 429) return new ProviderError('rate_limit', '提供方暂时限制请求，或账户额度不足。', { ...details, retryable: providerCode !== 'insufficient_quota' });
  if (status >= 500) return new ProviderError('server', '模型提供方暂时不可用。', { ...details, retryable: true });
  if (providerCode === 'context_length_exceeded' || providerCode === 'context_window_exceeded') return new ProviderError('context_limit', '提示词超过提供方的上下文上限。', details);
  const diagnostic = `HTTP ${status}${providerCode ? '，' + providerCode : ''}${details.parameter ? '，参数 ' + details.parameter : ''}`;
  const schemaTool = typeof error.message === 'string'
    ? safeIdentifier(error.message.match(/Invalid schema for function ['"]([a-zA-Z0-9_-]{1,64})['"]/i)?.[1], credential) : undefined;
  if ((status === 400 || status === 422) && (providerCode === 'invalid_request_error' || schemaTool)) {
    return new ProviderError('invalid_request', schemaTool ? `提供方拒绝了工具 ${schemaTool} 的参数声明（${diagnostic}）。`
      : `提供方拒绝了请求格式（${diagnostic}），请检查提示词和工具声明。`, details);
  }
  return new ProviderError('provider', `模型提供方拒绝了该请求（${diagnostic}），请检查配置和能力支持。`, details);
}

function parseJson(text: string): JsonObject {
  try { const value: unknown = JSON.parse(text); if (record(value)) return value; }
  catch { /* Provider data is never included in an error or log. */ }
  throw protocolError();
}

function finalCalls(calls: ModelToolCall[], request: ModelRequest): ModelToolCall[] {
  const allowed = new Set(request.tools.map(tool => tool.name));
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || ids.has(call.id) || !allowed.has(call.name)) throw protocolError();
    ids.add(call.id);
    // Reject the whole response before dispatch; only newly generated arguments
    // can be retried. Invalid arguments in stored request history remain fatal.
    validateArguments(call.arguments, true);
  }
  return calls;
}

function responseResult(value: JsonObject, request: ModelRequest): ModelResponse {
  if (value.status !== 'completed') {
    if (value.status === 'failed' && record(value.error)) throw new ProviderError('provider', '提供方未能完成响应。', { retryable: true });
    throw truncatedError();
  }
  if (!Array.isArray(value.output)) throw protocolError();
  const calls: ModelToolCall[] = [];
  const items: JsonObject[] = [];
  const texts: string[] = [];
  for (const item of value.output) {
    if (!record(item)) throw protocolError();
    if (item.type === 'function_call') {
      if (item.status !== undefined && item.status !== 'completed') throw truncatedError();
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw protocolError();
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
      items.push(item);
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw protocolError();
      if (item.status !== undefined && item.status !== 'completed') throw truncatedError();
      for (const part of item.content) {
        if (!record(part)) throw protocolError();
        if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
        else if (part.type === 'refusal' && typeof part.refusal === 'string') texts.push(part.refusal);
        else throw protocolError();
      }
      items.push(item);
    } else if (item.type === 'reasoning') {
      // A reasoning item identified only by a server ID cannot be replayed with store:false.
      if (typeof item.encrypted_content !== 'string') throw protocolError();
      items.push(item);
    } else throw protocolError();
  }
  const usage = record(value.usage) ? value.usage : {};
  return { text: texts.join(''), toolCalls: finalCalls(calls, request), finishReason: calls.length ? 'tool_calls' : 'stop',
    inputTokens: tokenCount(usage.input_tokens), cachedInputTokens: tokenCount(record(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined), outputTokens: tokenCount(usage.output_tokens),
    providerResponseId: typeof value.id === 'string' ? value.id : undefined, responseItems: items };
}

function chatResult(value: JsonObject, request: ModelRequest): ModelResponse {
  if (!Array.isArray(value.choices) || value.choices.length !== 1 || !record(value.choices[0])) throw protocolError();
  const choice = value.choices[0];
  if (choice.finish_reason === 'length') throw truncatedError();
  if (!['stop', 'tool_calls', 'content_filter'].includes(String(choice.finish_reason)) || !record(choice.message)) throw protocolError();
  const message = choice.message;
  if (message.reasoning_content !== undefined && message.reasoning_content !== null && typeof message.reasoning_content !== 'string') throw protocolError();
  if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw protocolError();
  const calls: ModelToolCall[] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw protocolError();
    for (const call of message.tool_calls) {
      if (!record(call) || call.type !== 'function' || typeof call.id !== 'string' || !record(call.function)
        || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw protocolError();
      calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  if (calls.length && choice.finish_reason !== 'tool_calls') throw protocolError();
  if (!calls.length && choice.finish_reason === 'tool_calls') throw protocolError();
  const usage = record(value.usage) ? value.usage : {};
  return { text: String(message.content ?? message.refusal ?? ''), toolCalls: finalCalls(calls, request), finishReason: String(choice.finish_reason),
    inputTokens: tokenCount(usage.prompt_tokens), cachedInputTokens: tokenCount(usage.prompt_cache_hit_tokens) ?? tokenCount(record(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined), outputTokens: tokenCount(usage.completion_tokens), providerResponseId: typeof value.id === 'string' ? value.id : undefined,
    ...(typeof message.reasoning_content === 'string' ? { reasoningContent: message.reasoning_content } : {}) };
}

interface SseEvent { event: string; data: string }
/** Streaming decoder respects byte boundaries, CRLF split across chunks and data lines. */
async function* sseEvents(body: ReadableStream<Uint8Array>, pulse: () => void, limit: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let data: string[] = []; let event = ''; let bytes = 0; let frameLength = 0;
  const line = (value: string): SseEvent | undefined => {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      data = []; event = ''; frameLength = 0;
      return result;
    }
    frameLength += value.length;
    if (frameLength > Math.min(limit, 4 * 1024 * 1024)) throw protocolError();
    if (value.startsWith(':')) return undefined;
    const colon = value.indexOf(':');
    const name = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (name === 'data') data.push(content);
    else if (name === 'event') event = content;
    return undefined;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pulse(); bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('protocol', '模型响应超过配置的接收上限。');
      try { buffer += decoder.decode(chunk.value, { stream: true }); }
      catch { throw protocolError(); }
      while (true) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
        const item = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (item) yield item;
      }
      if (buffer.length > Math.min(limit, 4 * 1024 * 1024)) throw protocolError();
    }
    try { buffer += decoder.decode(); } catch { throw protocolError(); }
    // A frame without its terminating blank line is incomplete, even if its JSON parses.
    if (buffer.endsWith('\r')) {
      const item = line(buffer.slice(0, -1)); buffer = '';
      if (item) yield item;
    }
    if (buffer || data.length) throw truncatedError();
  } finally {
    try { await reader.cancel(); } catch { /* Closing an interrupted connection is best effort. */ }
    reader.releaseLock();
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, pulse: () => void, limit: number): Promise<string> {
  if (!body) throw protocolError();
  const reader = body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let text = '';
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      pulse(); bytes += chunk.value.byteLength;
      if (bytes > limit) throw protocolError();
      try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw protocolError(); }
    }
    try { return text + decoder.decode(); } catch { throw protocolError(); }
  } finally { try { await reader.cancel(); } catch { /* Best effort. */ } reader.releaseLock(); }
}

async function emitDelta(options: CallModelOptions, delta: string): Promise<void> {
  if (!delta) return;
  if (options.signal?.aborted) throw new ProviderError('aborted', '调用已停止。');
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => options.onDelta?.(delta)), new Promise<never>((_, reject) => {
      abortListener = () => reject(new ProviderError('aborted', '调用已停止。'));
      options.signal?.addEventListener('abort', abortListener, { once: true });
    })]);
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'aborted') throw error;
    throw new ProviderError('callback', '无法保存或显示流式回复，当前调用已停止。');
  } finally { if (abortListener) options.signal?.removeEventListener('abort', abortListener); }
}

function streamError(value: JsonObject, credential: string): ProviderError {
  const error = record(value.error) ? value.error : value;
  const code = error.code ?? error.type;
  const status = ['invalid_api_key', 'authentication_error', 'permission_denied'].includes(String(code)) ? 401
    : ['rate_limit_exceeded', 'rate_limit_error', 'insufficient_quota'].includes(String(code)) ? 429
    : ['context_length_exceeded', 'context_window_exceeded'].includes(String(code)) ? 400 : 502;
  return httpError(status, error, new Headers(), credential);
}

async function consumeResponses(body: ReadableStream<Uint8Array>, request: ModelRequest, options: CallModelOptions, pulse: () => void, limit: number, credential: string): Promise<ModelResponse> {
  let partialText = '';
  const items = new Map<number, { id: string; name: string; arguments: string; done: boolean }>();
  for await (const frame of sseEvents(body, pulse, limit)) {
    if (frame.data === '[DONE]') throw truncatedError();
    const value = parseJson(frame.data);
    const type = typeof value.type === 'string' ? value.type : frame.event;
    if (type === 'error' || type === 'response.failed') throw streamError(record(value.response) ? value.response : value, credential);
    if (type === 'response.incomplete') throw truncatedError();
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof value.delta !== 'string') throw protocolError();
      partialText += value.delta; await emitDelta(options, value.delta);
    } else if (type === 'response.output_item.added' && record(value.item) && value.item.type === 'function_call') {
      if (!integer(value.output_index, 0, 10000) || items.has(value.output_index)
        || typeof value.item.call_id !== 'string' || typeof value.item.name !== 'string') throw protocolError();
      items.set(value.output_index, { id: value.item.call_id, name: value.item.name, arguments: String(value.item.arguments ?? ''), done: false });
    } else if (type === 'response.function_call_arguments.delta') {
      const item = integer(value.output_index, 0, 10000) ? items.get(value.output_index) : undefined;
      if (!item || item.done || typeof value.delta !== 'string') throw protocolError();
      item.arguments += value.delta;
    } else if (type === 'response.function_call_arguments.done') {
      const item = integer(value.output_index, 0, 10000) ? items.get(value.output_index) : undefined;
      if (!item || typeof value.arguments !== 'string' || (item.arguments && item.arguments !== value.arguments)) throw protocolError();
      item.arguments = value.arguments; item.done = true;
    } else if (type === 'response.output_item.done' && record(value.item) && value.item.type === 'function_call') {
      const item = integer(value.output_index, 0, 10000) ? items.get(value.output_index) : undefined;
      if (item && (item.id !== value.item.call_id || item.name !== value.item.name || (item.arguments && item.arguments !== value.item.arguments))) throw protocolError();
      if (item) {
        if (typeof value.item.arguments !== 'string') throw protocolError();
        item.arguments = value.item.arguments; item.done = true;
      }
    } else if (type === 'response.completed') {
      if (!record(value.response)) throw protocolError();
      const result = responseResult(value.response, request);
      for (const item of items.values()) {
        if (!item.done || !result.toolCalls.some(call => call.id === item.id && call.name === item.name && call.arguments === item.arguments)) throw truncatedError();
      }
      if (partialText && partialText !== result.text) throw protocolError();
      if (!partialText && result.text) await emitDelta(options, result.text);
      return result;
    }
  }
  throw truncatedError();
}

async function consumeChat(body: ReadableStream<Uint8Array>, request: ModelRequest, options: CallModelOptions, pulse: () => void, limit: number, credential: string): Promise<ModelResponse> {
  let text = ''; let finishReason: string | undefined; let id: string | undefined;
  let reasoningContent = '';
  let usage: JsonObject = {};
  const calls = new Map<number, ModelToolCall>();
  for await (const frame of sseEvents(body, pulse, limit)) {
    if (frame.data === '[DONE]') {
      if (!finishReason) throw truncatedError();
      return chatResult({ id, usage, choices: [{ finish_reason: finishReason, message: { content: text, reasoning_content: reasoningContent,
        tool_calls: [...calls].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } }] }, request);
    }
    const value = parseJson(frame.data);
    if (value.error) throw streamError(value, credential);
    if (typeof value.id === 'string') { if (id && id !== value.id) throw protocolError(); id = value.id; }
    if (record(value.usage)) usage = value.usage;
    if (!Array.isArray(value.choices)) throw protocolError();
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw protocolError();
      const delta = choice.delta;
      if (finishReason && (delta.content || delta.refusal || delta.tool_calls || delta.reasoning_content)) throw protocolError();
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
        if (typeof delta.reasoning_content !== 'string') throw protocolError();
        reasoningContent += delta.reasoning_content;
      }
      const content = delta.content ?? delta.refusal;
      if (content !== undefined && content !== null) {
        if (typeof content !== 'string') throw protocolError();
        text += content; await emitDelta(options, content);
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw protocolError();
        for (const chunk of delta.tool_calls) {
          if (!record(chunk) || !integer(chunk.index, 0, 10000) || (chunk.type !== undefined && chunk.type !== 'function')) throw protocolError();
          let call = calls.get(chunk.index);
          if (!call) { call = { id: '', name: '', arguments: '' }; calls.set(chunk.index, call); }
          if (chunk.id !== undefined && chunk.id !== null) { if (typeof chunk.id !== 'string' || (call.id && call.id !== chunk.id)) throw protocolError(); call.id = chunk.id; }
          if (chunk.function !== undefined) {
            if (!record(chunk.function)) throw protocolError();
            for (const field of ['name', 'arguments'] as const) {
              const value = chunk.function[field]; if (value === undefined || value === null) continue;
              if (typeof value !== 'string') throw protocolError(); call[field] += value;
            }
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || finishReason) throw protocolError();
        finishReason = choice.finish_reason;
        if (finishReason === 'length') throw truncatedError();
      }
    }
  }
  throw truncatedError();
}

/** A complete transport response is required before any returned tool call may execute.
 * The caller owns retry policy and must retain task operation IDs across retries.
 */
export async function callModel(config: ProviderConfig, credential: string, request: ModelRequest, options: CallModelOptions = {}): Promise<ModelResponse> {
  validateProviderConfig(config); validateRequest(request, config);
  if (typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential)) throw new ProviderError('authentication', '请先为提供方设置调用凭据。');
  let payload: string;
  const images=request.messages.flatMap(m=>m.images??[]),urls=new Map<string,string>();
  if(images.length){
    if(config.supportsVision!==true||!options.resolveImage)throw new ProviderError('invalid_config','当前模型未配置视觉能力或图像加载器。');
    for(const image of images)if(!urls.has(image.assetId))urls.set(image.assetId,await options.resolveImage(image));
  }
  try { payload = JSON.stringify(makeBody(config, request,urls)); } catch { throw new ProviderError('invalid_request', '提示词或工具定义无法序列化。'); }
  const controller = new AbortController();
  let timeout = false; let externallyAborted = false;
  const abort = () => { externallyAborted = true; controller.abort(); };
  if (options.signal?.aborted) throw new ProviderError('aborted', '调用已停止。');
  options.signal?.addEventListener('abort', abort, { once: true });
  const expire = () => { timeout = true; controller.abort(); };
  const overallTimer = setTimeout(expire, config.timeoutMs ?? 120_000);
  let idleTimer = setTimeout(expire, config.idleTimeoutMs ?? 60_000);
  const pulse = () => { clearTimeout(idleTimer); idleTimer = setTimeout(expire, config.idleTimeoutMs ?? 60_000); };
  try {
    const response = await fetch(endpoint(config), { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: config.stream === false ? 'application/json' : 'text/event-stream',
      Authorization: `Bearer ${credential}`,
    }, body: payload, signal: controller.signal, redirect: 'error' });
    pulse();
    if (!response.ok) {
      let value: unknown = {};
      try { value = parseJson(await readLimited(response.body, pulse, 64 * 1024)); }
      catch (error) { if (controller.signal.aborted) throw error; }
      throw httpError(response.status, value, response.headers, credential);
    }
    const limit = config.maxResponseBytes ?? 16 * 1024 * 1024;
    const streamOptions: CallModelOptions = { onDelta: options.onDelta, signal: controller.signal };
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    let result: ModelResponse;
    if (contentType.includes('text/event-stream')) {
      if (!response.body) throw protocolError();
      result = config.protocol === 'responses'
        ? await consumeResponses(response.body, request, streamOptions, pulse, limit, credential)
        : await consumeChat(response.body, request, streamOptions, pulse, limit, credential);
    } else if (contentType.includes('application/json')) {
      const value = parseJson(await readLimited(response.body, pulse, limit));
      result = config.protocol === 'responses' ? responseResult(value, request) : chatResult(value, request);
      await emitDelta(streamOptions, result.text);
    } else throw protocolError();
    if (controller.signal.aborted) throw new Error();
    if(images.length)result.transport={requestBytes:Buffer.byteLength(payload),imageTransportBytes:images.reduce((n,i)=>n+Buffer.byteLength(urls.get(i.assetId)!),0),estimatedImageTokens:imageTokens(images)};
    return result;
  } catch (error) {
    if (externallyAborted) throw new ProviderError('aborted', '调用已停止。');
    if (timeout) throw new ProviderError('timeout', '模型调用超时，可从已提交的任务记录继续。', { retryable: true });
    if (error instanceof ProviderError) throw error;
    // Never surface fetch errors: they can include the request URL or provider payload.
    throw new ProviderError('network', '模型连接中断，请检查提供方连接。', { retryable: true });
  } finally {
    clearTimeout(overallTimer); clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', abort);
  }
}
