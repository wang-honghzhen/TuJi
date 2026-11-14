import type { UserNoteBlock, UserNoteImage } from '../userNotes';

export const blankCrop = { left: 0, top: 0, right: 0, bottom: 0 };
export function noteImageBounds(image: UserNoteImage) {
  const radians = image.rotation * Math.PI / 180;
  const width = Math.abs(Math.cos(radians)) * image.width + Math.abs(Math.sin(radians)) * image.height;
  const height = Math.abs(Math.sin(radians)) * image.width + Math.abs(Math.cos(radians)) * image.height;
  return { x: image.x + (image.width - width) / 2, y: image.y + (image.height - height) / 2, width, height };
}
export function fitNoteImage(image: UserNoteImage, available: number): UserNoteImage {
  let next = { ...image, width: Math.max(24, image.width), height: Math.max(24, image.height) };
  const initial = noteImageBounds(next), scale = Math.min(1, available / initial.width);
  next = { ...next, width: next.width * scale, height: next.height * scale };
  const bounds = noteImageBounds(next);
  next.x += Math.max(0, Math.min(available - bounds.width, bounds.x)) - bounds.x;
  next.y += Math.max(8, bounds.y) - bounds.y;
  return next;
}
export function noteRegionLayout(images: UserNoteImage[], available: number) {
  const bounds = images.map(noteImageBounds);
  const width = Math.max(1, available, ...bounds.map(item => item.x + item.width + 2));
  const height = Math.ceil(Math.max(48, ...bounds.map(item => item.y + item.height + 12)) / 32) * 32;
  return { width, height, scale: Math.min(1, available / width) };
}
export function insertNoteImages(blocks: UserNoteBlock[], blockId: string, images: UserNoteImage[], selection?: { start: number; end: number }, uid = () => crypto.randomUUID()): UserNoteBlock[] {
  return blocks.flatMap((block): UserNoteBlock[] => {
    if (block.id !== blockId) return [block];
    if (block.type === 'images') return [{ ...block, images: [...block.images, ...images] }];
    const start = Math.min(selection?.start ?? block.text.length, block.text.length);
    // Pasting an image separates text; a selected passage is retained below it.
    return [{ ...block, text: block.text.slice(0, start) }, { id: uid(), type: 'images', images }, { id: uid(), type: 'text', text: block.text.slice(start) }];
  });
}
export function deleteNoteImage(blocks: UserNoteBlock[], blockId: string, imageId: string): UserNoteBlock[] {
  const next = blocks.flatMap((block): UserNoteBlock[] => {
    if (block.id !== blockId || block.type !== 'images') return [block];
    const images = block.images.filter(image => image.id !== imageId);
    return images.length ? [{ ...block, images }] : [];
  });
  const merged: UserNoteBlock[] = [];
  for (const block of next) {
    const previous = merged.at(-1);
    if (previous?.type === 'text' && block.type === 'text') merged[merged.length - 1] = { ...previous, text: previous.text + block.text };
    else merged.push(block);
  }
  return merged.length ? merged : [{ id: crypto.randomUUID(), type: 'text', text: '' }];
}
