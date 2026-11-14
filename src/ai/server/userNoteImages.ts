import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { imageHeader } from './artifactImages';
import { requireValue, DomainError } from './errors';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

/** Notebook pictures are local assets, separate from chat attachments and OCR. */
export class UserNoteImages {
  private readonly directory: string;
  constructor(artifactDirectory: string) { this.directory = path.join(artifactDirectory, 'user-notes'); }

  async upload(dataUrl: unknown): Promise<{ src: string; width: number; height: number }> {
    requireValue(typeof dataUrl === 'string' && dataUrl.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100, '图片超过 32 MB，请缩小后粘贴');
    const comma = dataUrl.indexOf(','), prefix = dataUrl.slice(0, comma);
    requireValue(/^data:image\/(png|jpeg|webp|gif);base64$/.test(prefix), '请粘贴 PNG、JPEG、WebP 或 GIF 图片');
    const encoded = dataUrl.slice(comma + 1);
    requireValue(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), '图片编码无效');
    const bytes = Buffer.from(encoded, 'base64');
    requireValue(bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && bytes.toString('base64') === encoded, '图片编码无效');
    const header = imageHeader(bytes);
    requireValue(header && header.width > 0 && header.height > 0 && header.width * header.height <= MAX_IMAGE_PIXELS, '图片尺寸无效或超过 4000 万像素');
    requireValue(prefix === `data:${header.mimeType};base64`, '图片格式与编码内容不符');
    // Decode once and store a normalized PNG. This also rejects truncated files
    // whose headers alone would appear valid. The original visible pixels survive edits.
    const moduleName = '@napi-rs/canvas';
    const { createCanvas, loadImage } = await import(moduleName) as typeof import('@napi-rs/canvas');
    let pixels: Buffer, width: number, height: number;
    try {
      const image = await loadImage(bytes); width = image.width; height = image.height;
      requireValue(width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS, '图片尺寸无效');
      const canvas = createCanvas(width, height); canvas.getContext('2d').drawImage(image, 0, 0);
      pixels = await canvas.encode('png');
    } catch { throw new DomainError('无法读取这张图片，请重新复制后粘贴', 'INVALID_IMAGE'); }
    const filename = createHash('sha256').update(pixels).digest('hex') + '.png';
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, randomUUID() + '.tmp'), target = path.join(this.directory, filename);
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(pixels); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, target); }
    catch (cause) { await fs.unlink(temporary).catch(() => undefined); throw cause; }
    return { src: `/api/qixue/user-note-images/${filename}`, width, height };
  }

  async read(filename: string): Promise<{ bytes: Buffer; mimeType: string }> {
    requireValue(/^[a-f0-9]{64}\.png$/.test(filename), '图片地址无效', 'IMAGE_UNAVAILABLE');
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(this.directory, filename)); }
    catch { throw new DomainError('笔记图片不存在', 'IMAGE_UNAVAILABLE', 404); }
    requireValue(createHash('sha256').update(bytes).digest('hex') + '.png' === filename, '图片文件校验失败', 'IMAGE_UNAVAILABLE');
    return { bytes, mimeType: 'image/png' };
  }
}
