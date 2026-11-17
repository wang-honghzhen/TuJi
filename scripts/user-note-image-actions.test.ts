import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { copyOrCutNoteImage, drawNoteImage, noteImageGeometry } from '../src/ai/ui/userNoteImageActions';
import { deleteNoteImage } from '../src/ai/ui/userNoteLayout';
import type { UserNoteBlock, UserNoteImage } from '../src/ai/userNotes';

const picture: UserNoteImage = { id: 'picture', src: '/saved.png', x: 0, y: 8, width: 80, height: 40, rotation: 90, crop: { left: .5, top: 0, right: 0, bottom: 0 } };

test('saved image exports crop and rotation at source resolution, without mutating its edits', () => {
  const source = createCanvas(400, 200), context = source.getContext('2d'), before = structuredClone(picture);
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 200, 200);
  context.fillStyle = '#0000ff'; context.fillRect(200, 0, 200, 100);
  context.fillStyle = '#00ff00'; context.fillRect(200, 100, 200, 100);
  const output = createCanvas(1, 1);
  drawNoteImage(output as unknown as HTMLCanvasElement, source as unknown as CanvasImageSource, picture, 400, 200);
  assert.equal(output.width, 200); assert.equal(output.height, 200);
  const pixels = output.getContext('2d');
  assert.deepEqual([...pixels.getImageData(50, 100, 1, 1).data], [0, 255, 0, 255]);
  assert.deepEqual([...pixels.getImageData(150, 100, 1, 1).data], [0, 0, 255, 255]);
  assert.deepEqual(picture, before);
});

test('original preview ignores crop and rotation; quarter turns have exact dimensions', () => {
  const original = noteImageGeometry(picture, 400, 200, true);
  assert.deepEqual(original, { source: { x: 0, y: 0, width: 400, height: 200 }, radians: 0, width: 400, height: 200 });
  for (const rotation of [90, -90, 270]) {
    const result = noteImageGeometry({ ...picture, crop: undefined, rotation }, 400, 200);
    assert.equal(result.width, 200); assert.equal(result.height, 400);
  }
  const diagonal = noteImageGeometry({ ...picture, crop: undefined, rotation: 45 }, 400, 200);
  assert.equal(diagonal.width, 425); assert.equal(diagonal.height, 425);
});

test('cut waits for successful clipboard write, then deletes only the image reference', async () => {
  const blocks: UserNoteBlock[] = [{ id: 'before', type: 'text', text: '前' }, { id: 'region', type: 'images', images: [picture] }, { id: 'after', type: 'text', text: '后' }];
  let next = blocks, finish!: () => void;
  const task = copyOrCutNoteImage(picture, () => { next = deleteNoteImage(blocks, 'region', picture.id); }, () => new Promise<void>(resolve => { finish = resolve; }));
  assert.equal(next, blocks);
  finish(); await task;
  assert.deepEqual(next, [{ id: 'before', type: 'text', text: '前后' }]);
  assert.equal(blocks[1].type, 'images');
  assert.equal((blocks[1] as Extract<UserNoteBlock, { type: 'images' }>).images[0].src, '/saved.png');
});

test('failed clipboard write does not cut; copy never asks to remove an image', async () => {
  let removed = false, copied = false;
  await assert.rejects(copyOrCutNoteImage(picture, () => { removed = true; }, async () => { throw new Error('permission denied'); }), /permission denied/);
  assert.equal(removed, false);
  await copyOrCutNoteImage(picture, undefined, async image => { assert.equal(image, picture); copied = true; });
  assert.equal(copied, true); assert.equal(removed, false);
});
