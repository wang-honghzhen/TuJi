import type { UserNoteImage } from '../userNotes';

/** Work in source pixels so copying a small notebook thumbnail retains its detail. */
export function noteImageGeometry(image: UserNoteImage, width: number, height: number, original = false) {
  const crop = original ? { left: 0, top: 0, right: 0, bottom: 0 } : image.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const source = { x: width * crop.left, y: height * crop.top, width: width * (1 - crop.left - crop.right), height: height * (1 - crop.top - crop.bottom) };
  const radians = original ? 0 : image.rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
  return { source, radians,
    width: Math.max(1, Math.ceil(source.width * cosine + source.height * sine - 1e-8)),
    height: Math.max(1, Math.ceil(source.width * sine + source.height * cosine - 1e-8)) };
}

export function drawNoteImage(canvas: HTMLCanvasElement, source: CanvasImageSource, image: UserNoteImage, width: number, height: number, original = false) {
  const geometry = noteImageGeometry(image, width, height, original), crop = geometry.source;
  canvas.width = geometry.width; canvas.height = geometry.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理图片，请关闭预览后重试');
  context.translate(geometry.width / 2, geometry.height / 2); context.rotate(geometry.radians);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, -crop.width / 2, -crop.height / 2, crop.width, crop.height);
  return geometry;
}

export async function renderNoteImage(image: UserNoteImage, original = false): Promise<Blob> {
  const source = new Image();
  const loaded = new Promise<void>((resolve, reject) => { source.onload = () => resolve(); source.onerror = () => reject(new Error('图片读取失败，请重新打开笔记后重试')); });
  source.src = image.src; await loaded;
  const canvas = document.createElement('canvas');
  drawNoteImage(canvas, source, image, source.naturalWidth, source.naturalHeight, original);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片处理失败，未写入剪贴板')), 'image/png'));
}

/** Start the clipboard write during the user gesture, before asynchronous image decoding. */
export async function writeNoteImage(image: UserNoteImage): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前环境无法复制图片，请在桌面应用中重试');
  const pixels = renderNoteImage(image);
  // The clipboard implementation can reject before consuming its image promise.
  void pixels.catch(() => undefined);
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': pixels })]); }
  catch { throw new Error('图片未能写入剪贴板，请重试；原图片已保留'); }
}

/** A failed write must never remove the original notebook image. */
export async function copyOrCutNoteImage(image: UserNoteImage, remove?: () => void, write = writeNoteImage): Promise<void> {
  await write(image);
  remove?.();
}
