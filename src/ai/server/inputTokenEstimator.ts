import { estimateTokens } from '../tokens';
import { digest } from './directGraph';
import { promptRouteSignature } from './promptPrefix';
import { imageTokens, serializeRequest, type ModelRequest, type ProviderConfig } from './providers';

/** Fingerprints and counts only: provider-private continuations are never retained here. */
export interface InputTokenSample {
  route: string; tools: string; rawTokens: number;
  items: Array<{ hash: string; tokens: number }>;
}
export interface InputTokenEstimate {
  tokens: number; rawTokens: number;
  method: 'local' | 'usage-prefix' | 'usage-subset' | 'usage-inflated';
  matchedInputTokens?: number;
}
interface Observation extends InputTokenSample { inputTokens: number }

export function inputTokenSample(config: ProviderConfig, request: ModelRequest): InputTokenSample {
  const serialized = serializeRequest(config, request), body = JSON.parse(serialized);
  const items = body[config.protocol === 'responses' ? 'input' : 'messages'] as unknown[];
  const images = request.messages.flatMap(message => message.images ?? []);
  return { route: promptRouteSignature(config), tools: digest(body.tools ?? []), rawTokens: estimateTokens(serialized) + imageTokens(images),
    items: items.map(item => {
      const text = JSON.stringify(item);
      return { hash: digest(item), tokens: estimateTokens(text) + imageTokens(images.filter(image => text.includes(`qixue-asset:${image.assetId}`))) };
    }) };
}

/** Added to observed input, in addition to the existing context/output reserves. */
export const observedInputUpperBound = (tokens: number) => Math.ceil(tokens * 1.05) + 128;

/** Reuse observed input only for identical provider items and identical route/tools.
 * Removed items are never subtracted from the observed total. A subset therefore
 * keeps a conservative upper bound until the replacement request reports usage.
 * Novel items always pay their full local estimate; no learned discount applies.
 */
export class InputTokenEstimator {
  private observations: Observation[] = [];
  private rejected = new Set<string>();
  private key(sample: InputTokenSample) { return `${sample.route}:${sample.tools}`; }

  accepts(sample: InputTokenSample, inputTokens: unknown): inputTokens is number {
    // Missing, impossible or implausibly tiny totals must not grant extra space.
    return !this.rejected.has(this.key(sample)) && typeof inputTokens === 'number'
      && Number.isSafeInteger(inputTokens) && inputTokens > 0 && inputTokens >= sample.rawTokens * .1;
  }

  observe(sample: InputTokenSample, inputTokens: unknown): boolean {
    if (!this.accepts(sample, inputTokens)) return false;
    const same = this.observations.find(o => o.route === sample.route && o.tools === sample.tools
      && o.items.length === sample.items.length && o.items.every((item, i) => item.hash === sample.items[i].hash));
    if (same) same.inputTokens = Math.max(same.inputTokens, inputTokens);
    else this.observations.push({ ...sample, items: sample.items.map(item => ({ ...item })), inputTokens });
    // Retain the initial small baseline as well as recent requests across compaction.
    if (this.observations.length > 16) this.observations.splice(1, this.observations.length - 16);
    return true;
  }

  reject(sample: InputTokenSample): void {
    this.rejected.add(this.key(sample));
    this.observations = this.observations.filter(o => this.key(o) !== this.key(sample));
  }

  estimate(sample: InputTokenSample): InputTokenEstimate {
    const compatible = this.observations.filter(o => o.route === sample.route && o.tools === sample.tools);
    // Observed underestimation can only increase the cost of unseen material.
    const inflation = Math.max(1, ...compatible.map(o => o.inputTokens / o.rawTokens));
    let best: InputTokenEstimate = { tokens: Math.ceil(sample.rawTokens * inflation), rawTokens: sample.rawTokens,
      method: inflation > 1 ? 'usage-inflated' : 'local' };
    let measuredFloor = 0;
    for (const observation of compatible) {
      const counts = new Map<string, number>();
      for (const item of observation.items) counts.set(item.hash, (counts.get(item.hash) ?? 0) + 1);
      let matched = 0, novel = 0;
      for (const item of sample.items) {
        const available = counts.get(item.hash) ?? 0;
        if (available) { matched++; counts.set(item.hash, available - 1); }
        else novel += item.tokens + 16; // Include new message/protocol boundaries.
      }
      if (!matched) continue;
      const prefix = observation.items.length <= sample.items.length
        && observation.items.every((item, i) => item.hash === sample.items[i].hash);
      const observed = observedInputUpperBound(observation.inputTokens);
      if (prefix) measuredFloor = Math.max(measuredFloor, observed);
      const tokens = observed + Math.ceil(novel * inflation);
      if (tokens < best.tokens) best = { tokens, rawTokens: sample.rawTokens,
        method: prefix ? 'usage-prefix' : 'usage-subset', matchedInputTokens: observation.inputTokens };
    }
    if (measuredFloor > best.tokens) best = { ...best, tokens: measuredFloor, method: 'usage-prefix' };
    return best;
  }
}
