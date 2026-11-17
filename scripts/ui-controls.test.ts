import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutRegionControls } from '../src/new/regionControls';
import { intersects } from '../src/v3/rectangleIndex';
import type { RenderBlock } from '../src/v3/layout';

const block = (id: string, x = 0, y = 0, depth = 0): RenderBlock => ({ id, kind: 'directory', name: id, content: '',
  rect: { x, y, width: 220, height: 110 }, anchor: { x, y }, parentId: 'canvas', depth, collapsed: true });
const area = { x: 230, y: 64, width: 700, height: 600 };
test('region controls stay usable across the full zoom range without modifying world geometry', () => {
  const blocks = [block('a')], before = structuredClone(blocks);
  for (const zoom of [.12, .25, .5, 1, 3]) {
    const controls = layoutRegionControls(blocks, { x: 300, y: 160, zoom }, area);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].rect.height, 32);
    assert.ok(controls[0].rect.width >= 64);
    assert.deepEqual(blocks, before);
  }
});
test('nested and adjacent headers do not cover each other at overview zoom', () => {
  const blocks = [block('parent'), block('child', 15, 15, 1), block('sibling', 230)];
  const controls = layoutRegionControls(blocks, { x: 300, y: 160, zoom: .12 }, area);
  assert.equal(controls.length, 3);
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    assert.equal(intersects(controls[i].rect, controls[j].rect), false);
  }
  assert.deepEqual(layoutRegionControls([...blocks].reverse(), { x: 300, y: 160, zoom: .12 }, area), controls);
});
test('partly visible regions retain reachable controls, offscreen regions do not create edge piles', () => {
  const big = { ...block('large'), rect: { x: -200, y: -100, width: 1000, height: 700 } };
  const controls = layoutRegionControls([big, block('outside', -2000, -2000)], { x: 0, y: 0, zoom: 1 }, area);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].block.id, 'large');
  for (const { rect } of controls) {
    assert.ok(rect.x >= area.x && rect.y >= area.y);
    assert.ok(rect.x + rect.width <= area.x + area.width);
    assert.ok(rect.y + rect.height <= area.y + area.height);
  }
});
