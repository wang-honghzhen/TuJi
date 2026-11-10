import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_BACKGROUND_BYTES } from '@/shared/canvasBackgrounds';
import { DomainError, requireValue } from './errors';

export { MAX_BACKGROUND_BYTES } from '@/shared/canvasBackgrounds';
const MAX_DIMENSION = 16384, MAX_PIXELS = 40_000_000;
const assetPattern = /^[a-f0-9]{64}$/;
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Check encoded dimensions before a native decoder allocates the pixel buffer. */
function imageHeader(bytes: Buffer): { mimeType: ImageMime; width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      requireValue(size <= bytes.length - start, 'WebP 图片不完整', 'INVALID_BACKGROUND_IMAGE');
      if (kind === 'VP8X' && size >= 10) return { mimeType: 'image/webp', width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3) };
      if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8 ' && size >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a)
        return { mimeType: 'image/webp', width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
      offset = start + size + (size % 2);
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 1 < bytes.length;) {
      requireValue(bytes[offset++] === 0xff, 'JPEG 图片结构无效', 'INVALID_BACKGROUND_IMAGE');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      requireValue(offset + 2 <= bytes.length, 'JPEG 图片不完整', 'INVALID_BACKGROUND_IMAGE');
      const length = bytes.readUInt16BE(offset);
      requireValue(length >= 2 && offset + length <= bytes.length, 'JPEG 图片不完整', 'INVALID_BACKGROUND_IMAGE');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  throw new DomainError('请选择完整的 PNG、JPEG 或 WebP 图片', 'INVALID_BACKGROUND_IMAGE');
}

export class BackgroundAssets {
  private readonly directory: string;
  constructor(artifactDirectory: string) { this.directory = path.resolve(artifactDirectory, 'personalization-backgrounds'); }
  private filename(assetId: string) {
    requireValue(assetPattern.test(assetId), '背景图片编号无效', 'INVALID_BACKGROUND_ASSET');
    return path.join(this.directory, `${assetId}.image`);
  }
  async save(bytes: Uint8Array, declaredMime: unknown): Promise<string> {
    requireValue(bytes.byteLength > 0 && bytes.byteLength <= MAX_BACKGROUND_BYTES, '背景图片不能超过 12 MiB', 'BACKGROUND_TOO_LARGE');
    const buffer = Buffer.from(bytes), header = imageHeader(buffer);
    requireValue(declaredMime === header.mimeType, '图片类型与文件内容不一致', 'INVALID_BACKGROUND_IMAGE');
    requireValue(header.width > 0 && header.height > 0 && Math.max(header.width, header.height) <= MAX_DIMENSION
      && header.width * header.height <= MAX_PIXELS, '背景图片最长边不能超过 16384 像素，总像素不能超过 4000 万', 'BACKGROUND_DIMENSIONS');
    try {
      // Keep the optional native decoder external to browser/test bundles, as PDF rendering does.
      const packageName = '@napi-rs/canvas';
      const { loadImage } = await import(packageName) as typeof import('@napi-rs/canvas');
      const image = await loadImage(buffer);
      requireValue(image.width > 0 && image.height > 0 && Math.max(image.width, image.height) <= MAX_DIMENSION
        && image.width * image.height <= MAX_PIXELS, '背景图片尺寸无效', 'BACKGROUND_DIMENSIONS');
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('背景图片无法解码，请选择完整的 PNG、JPEG 或 WebP 图片', 'INVALID_BACKGROUND_IMAGE');
    }
    const assetId = createHash('sha256').update(buffer).digest('hex');
    await fs.mkdir(this.directory, { recursive: true });
    const filename = this.filename(assetId);
    try { await fs.writeFile(filename, buffer, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await fs.unlink(filename).catch(() => undefined); throw error; }
      const stat = await fs.lstat(filename);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BACKGROUND_BYTES, '背景图片文件无效', 'INVALID_BACKGROUND_ASSET');
      const existing = await fs.readFile(filename);
      requireValue(existing.equals(buffer), '已保存的背景图片损坏，请先移除后重新上传', 'BACKGROUND_ASSET_CORRUPTED');
    }
    return assetId;
  }
  async read(assetId: string): Promise<{ mimeType: ImageMime; dataBase64: string }> {
    const filename = this.filename(assetId);
    try {
      const stat = await fs.lstat(filename);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BACKGROUND_BYTES, '背景图片文件无效', 'INVALID_BACKGROUND_ASSET');
      const bytes = await fs.readFile(filename);
      requireValue(createHash('sha256').update(bytes).digest('hex') === assetId, '背景图片校验失败，请重新上传', 'BACKGROUND_ASSET_CORRUPTED');
      return { mimeType: imageHeader(bytes).mimeType, dataBase64: bytes.toString('base64') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('背景图片不存在，请重新上传', 'BACKGROUND_ASSET_MISSING', 404);
      throw error;
    }
  }
  async remove(assetId: string): Promise<void> {
    try { await fs.unlink(this.filename(assetId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /** Retry leftover uploads/replacements at boot without touching unrelated files. */
  async cleanup(currentAssetId?: string): Promise<void> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.image$/.test(entry.name) || entry.name === `${currentAssetId}.image`) continue;
      // Windows may still hold an old image open. Leave it for the next startup.
      await fs.unlink(path.join(this.directory, entry.name)).catch(() => undefined);
    }
  }
}
