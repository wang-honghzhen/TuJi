import type { AppSnapshot, Artifact, Session } from './domain';
import { isMinimalSession } from './temporaryModes';
export const attachmentVision = (provider: AppSnapshot['provider'], model = provider.model): boolean =>
  model === provider.model ? provider.supportsVision === true : provider.visionModels?.includes(model) === true;

/** Public, credential-free policy shared by the host and composer. */
export const DEFAULT_ATTACHMENT_LIMITS = Object.freeze({
  perMessage: 8, fileBytes: 30 * 1024 * 1024, messageBytes: 100 * 1024 * 1024,
  chunkCharacters: 4000, inlineTokens: 4096, regionShare: .05, regionTokens: 16384, catalogTokens: 2048, catalogEntries: 32,
  readTokens: 4000, maxReadTokens: 8000, textPages: 20, imagePages: 4,
  pdfPages: 1000, extractedBytes: 64 * 1024 * 1024, imagePixels: 40_000_000,
  previewEdge: 1600, cropEdge: 2048,
});
export type AttachmentLimits = { -readonly [K in keyof typeof DEFAULT_ATTACHMENT_LIMITS]: number };
export const attachmentLimits = (state?: Pick<AppSnapshot, 'attachmentLimits'>): AttachmentLimits =>
  ({ ...DEFAULT_ATTACHMENT_LIMITS, ...state?.attachmentLimits });
export function parseAttachmentLimits(value: unknown): AttachmentLimits {
  if (value === undefined) return { ...DEFAULT_ATTACHMENT_LIMITS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attachments 必须是配置对象');
  const result = { ...DEFAULT_ATTACHMENT_LIMITS } as AttachmentLimits;
  for (const [key, item] of Object.entries(value)) {
    if (!(key in result) || typeof item !== 'number' || !Number.isFinite(item) || item <= 0
      || (key === 'regionShare' ? item > 1 : !Number.isSafeInteger(item))) throw new Error('attachments 配置项或数值无效');
    result[key as keyof AttachmentLimits] = item;
  }
  if (result.fileBytes > result.messageBytes || result.readTokens > result.maxReadTokens
    || result.catalogTokens > result.regionTokens) throw new Error('attachments 容量配置矛盾');
  return result;
}
export function attachmentBatchError(files: ReadonlyArray<{ size: number; mimeType?: string; type?: string; name?: string }>, limits: AttachmentLimits, session?: Session): string | undefined {
  if (files.length > limits.perMessage) return `每条消息最多 ${limits.perMessage} 个附件`;
  if (files.some(f => !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > limits.fileBytes))
    return `单文件须非空且不超过 ${limits.fileBytes / 1048576} MiB`;
  if (isMinimalSession(session) && files.some(f => {
    const mime=f.mimeType??f.type;
    return !(mime?.startsWith('image/') || (!mime || mime==='application/octet-stream') && /\.(png|jpe?g|webp|gif)$/i.test(f.name??''));
  })) return '极简模式仅支持上传图片（PNG、JPEG、WebP、GIF）';
  if (files.reduce((n, f) => n + f.size, 0) > limits.messageBytes) return `每条消息附件合计不能超过 ${limits.messageBytes / 1048576} MiB`;
}
export interface AttachmentCatalogEntry {
  artifactId: string; version: number | string; name?: string; mimeType?: string; size?: number;
  pages?: number; ocrPages?: number[]; chunks?: number; status: Artifact['status'] | 'unavailable';
  owners: Array<{ taskId: string; messageId?: string }>;
  readWith: { tool: 'workspace_read_artifact' | 'workspace_view_artifact'; arguments: { artifactId: string; version: number | string } };
  viewWith?: { tool: 'workspace_view_artifact'; arguments: { artifactId: string; version: number | string } };
  visualState?: Artifact['visualState']; error?: string;
}
export interface AttachmentProtection {
  ownerTaskId: string; entries: AttachmentCatalogEntry[]; pointerId: string; page: number; payloadHash: string;
}
/** Immutable image identity. Bytes are loaded only by the host transport. */
export interface ImageAssetRef {
  assetId: string; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number;
  artifactId: string; version: number; page?: number; crop?: { x: number; y: number; width: number; height: number };
}
