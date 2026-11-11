import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = await loadImage(path.join(root, 'desktop', 'assets', 'icon-source.jpg'));
// A square crop around the complete white tree. Preserve the original sky and ground.
const crop = { x: 300, y: 495, size: 680 };
if (original.width < crop.x + crop.size || original.height < crop.y + crop.size) throw new Error('图标原图尺寸与裁剪区域不符。');
const render = size => {
  const canvas = createCanvas(size, size), context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(original, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
  return canvas.toBuffer('image/png');
};
await fs.writeFile(path.join(root, 'public', 'brand', 'app-icon.png'), render(512));
const sizes = [16, 24, 32, 48, 64, 128, 256], frames = sizes.map(render);
const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
await fs.writeFile(path.join(root, 'desktop', 'assets', 'app-icon.ico'), Buffer.concat([header, ...frames]));
console.log('已生成保留背景的方形图标，以及 16–256 像素 Windows 图标。');
