/** Application input presets are independent of the provider's physical window. */
export const CONTEXT_PRESETS = [200000, 500000, 1000000] as const;
export type ContextPresetTokens = typeof CONTEXT_PRESETS[number];
export const DEFAULT_CONTEXT_PRESET: ContextPresetTokens = 500000;

export function contextCapacity(provider: {
  contextWindow: number; maxOutputTokens: number; maxInputTokens?: number; contextPresetTokens?: ContextPresetTokens;
}) {
  const safetyReserve = Math.min(4096, Math.max(256, Math.ceil(provider.contextWindow * .04)));
  const apiInputCapacity = Math.max(0, Math.min(provider.maxInputTokens ?? Infinity,
    provider.contextWindow - provider.maxOutputTokens) - safetyReserve);
  const contextPresetTokens = provider.contextPresetTokens;
  return { contextPresetTokens, apiInputCapacity, inputCapacity: Math.min(contextPresetTokens ?? Infinity, apiInputCapacity),
    outputReserve: provider.maxOutputTokens, safetyReserve };
}
