import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteNoteImage, fitNoteImage, insertNoteImages, noteImageBounds, noteRegionLayout } from '../src/ai/ui/userNoteLayout';
import type { UserNoteBlock, UserNoteImage } from '../src/ai/userNotes';

const picture: UserNoteImage = { id: 'image', src: '/api/qixue/user-note-images/test.png', x: 0, y: 8, width: 180, height: 100, rotation: 0 };

test('paste between characters preserves both sides including selected text and whitespace', () => {
  let sequence = 0;
  const result = insertNoteImages([{ id: 'text', type: 'text', text: '前半段\n\t后半段  ' }], 'text', [picture], { start: 4, end: 8 }, () => 'block' + sequence++);
  assert.deepEqual(result, [{ id: 'text', type: 'text', text: '前半段\n' }, { id: 'block0', type: 'images', images: [picture] }, { id: 'block1', type: 'text', text: '\t后半段  ' }]);
  const restored = deleteNoteImage(result, 'block0', 'image');
  assert.deepEqual(restored, [{ id: 'text', type: 'text', text: '前半段\n\t后半段  ' }]);
});

test('additional pasted pictures share a region and removing one preserves its siblings', () => {
  const blocks: UserNoteBlock[] = [{ id: 'before', type: 'text', text: '上方' }, { id: 'region', type: 'images', images: [picture] }, { id: 'after', type: 'text', text: '下方' }];
  const next = insertNoteImages(blocks, 'region', [{ ...picture, id: 'second', x: 20, y: 40 }]);
  assert.equal(next.length, 3);
  const region = next[1]; assert.equal(region.type, 'images');
  if (region.type === 'images') assert.equal(region.images.length, 2);
  const removed = deleteNoteImage(next, 'region', 'image');
  assert.equal(removed.length, 3);
  assert.deepEqual(removed[0], blocks[0]); assert.deepEqual(removed[2], blocks[2]);
});

test('rotated image bounds reserve the full height so text cannot overlap the picture', () => {
  const rotated = fitNoteImage({ ...picture, width: 300, height: 60, rotation: 90 }, 360);
  const bounds = noteImageBounds(rotated), layout = noteRegionLayout([rotated], 360);
  assert.ok(Math.abs(bounds.width - 60) < .0001);
  assert.ok(Math.abs(bounds.height - 300) < .0001);
  assert.ok(bounds.x >= -.001 && bounds.y >= 7.999);
  assert.ok(layout.height >= bounds.y + bounds.height + 12);
});

test('fit respects the page width for arbitrary rotations and images cannot move above text', () => {
  for (const rotation of [-179, -90, -35, 0, 31, 90, 140, 270]) {
    const fitted = fitNoteImage({ ...picture, width: 1200, height: 900, x: -300, y: -200, rotation }, 280);
    const bounds = noteImageBounds(fitted);
    assert.ok(bounds.x >= -.001, String(rotation));
    assert.ok(bounds.y >= 7.999, String(rotation));
    assert.ok(bounds.x + bounds.width <= 280.001, String(rotation));
  }
});

test('narrow panels scale the complete image area without rewriting stored positions', () => {
  const images = [picture, { ...picture, id: 'second', x: 250, y: 400 }], before = structuredClone(images);
  const wide = noteRegionLayout(images, 600), narrow = noteRegionLayout(images, 260);
  assert.equal(wide.scale, 1); assert.ok(narrow.scale < 1);
  assert.equal(narrow.height, wide.height);
  assert.deepEqual(images, before);
  assert.ok(narrow.width * narrow.scale <= 260.001);
});
