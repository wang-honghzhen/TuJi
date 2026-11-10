export type CanvasBackgroundId = 'starry-sky' | 'white-grid' | 'custom';
export const DEFAULT_BACKGROUND: CanvasBackgroundId = 'starry-sky';
export const BUILTIN_BACKGROUND_URL = '/backgrounds/starry-sky.png';
export const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024;
export interface PersonalizationSettings {
  canvasBackgroundId: CanvasBackgroundId;
  customBackgroundAssetId?: string;
}
export const DEFAULT_PERSONALIZATION: PersonalizationSettings = { canvasBackgroundId: DEFAULT_BACKGROUND };
export const isCanvasBackgroundId = (value: unknown): value is CanvasBackgroundId =>
  value === 'starry-sky' || value === 'white-grid' || value === 'custom';

/** Drop retired per-canvas settings and recover safely from incomplete older data. */
export function normalizePersonalizationSettings(value: unknown): PersonalizationSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const customBackgroundAssetId = typeof input.customBackgroundAssetId === 'string' && /^[a-f0-9]{64}$/.test(input.customBackgroundAssetId)
    ? input.customBackgroundAssetId : undefined;
  const canvasBackgroundId = isCanvasBackgroundId(input.canvasBackgroundId)
    && (input.canvasBackgroundId !== 'custom' || customBackgroundAssetId) ? input.canvasBackgroundId : DEFAULT_BACKGROUND;
  return { canvasBackgroundId, ...(customBackgroundAssetId ? { customBackgroundAssetId } : {}) };
}
