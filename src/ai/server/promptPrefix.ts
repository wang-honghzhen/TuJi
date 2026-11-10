import type { ContextManifest } from '../domain';
import type { PrefixResetReason } from '../contextState';
import { digest } from './directGraph';
import { serializeRequest, type ModelRequest, type ProviderConfig } from './providers';

/** Cache-affecting route identity, excluding output budgets and transport timeouts. */
export function promptRouteSignature(config: ProviderConfig): string {
  return digest([config.baseUrl.replace(/\/+$/, ''), config.protocol, config.apiFamily, config.model,
    config.thinkingEffort, config.includeEncryptedReasoning, config.supportsVision]);
}

export interface WirePrefixSnapshot {
  generation: number; route: string; tools: string; toolItems: string[]; items: string[]; tail: string; serialized: string;
}

/** Compare provider-facing items, not application messages or JSON envelope punctuation.
 * Responses can expand one assistant message into several output items. */
export function wirePrefixSnapshot(config: ProviderConfig, request: ModelRequest, stableMessages: number, generation: number): WirePrefixSnapshot {
  const serialized = serializeRequest(config, request);
  const body = JSON.parse(serialized);
  const stable = JSON.parse(serializeRequest(config, { ...request, messages: request.messages.slice(0, stableMessages) }));
  const field = config.protocol === 'responses' ? 'input' : 'messages';
  const items = (stable[field] as unknown[]).map(item => digest(item));
  return { generation, route: promptRouteSignature(config), tools: digest(body.tools ?? []), toolItems: (body.tools ?? []).map(digest), items,
    tail: digest((body[field] as unknown[]).slice(items.length)), serialized };
}

export function prefixMetrics(current: WirePrefixSnapshot, previous?: WirePrefixSnapshot, reset?: PrefixResetReason): Partial<NonNullable<ContextManifest['contextMetrics']>> {
  let common = 0;
  const prior = previous?.serialized ?? '';
  while (common < Math.min(prior.length, current.serialized.length) && prior[common] === current.serialized[common]) common++;
  if (!previous) return { commonPrefixCharacters: common, stableWireItemCount: current.items.length,
    prefixBreakReason: reset ?? 'initial' };
  let index = 0;
  while (index < previous.items.length && previous.items[index] === current.items[index]) index++;
  const toolsUnchanged = previous.tools === current.tools;
  let toolIndex = 0;
  while (toolIndex < previous.toolItems.length && previous.toolItems[toolIndex] === current.toolItems[toolIndex]) toolIndex++;
  const prefixPreserved = index === previous.items.length && toolsUnchanged && previous.route === current.route;
  const reason = reset ?? (previous.route !== current.route ? 'route_changed' : !toolsUnchanged ? 'tools_changed'
    : current.generation !== previous.generation ? 'compaction' : 'unexpected_mutation');
  return { commonPrefixCharacters: common, stableWireItemCount: current.items.length, prefixPreserved, toolsUnchanged,
    temporaryTailChanged: current.tail !== previous.tail,
    ...(!toolsUnchanged ? { firstChangedToolIndex: toolIndex } : {}),
    ...(!prefixPreserved ? { prefixBreakReason: reason, ...(index < previous.items.length ? { firstChangedMessageIndex: index } : {}) } : {}) };
}
