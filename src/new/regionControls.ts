import type { RenderBlock } from '@/v3/layout';
import type { Rect } from '@/v3/types';
import { intersects, RectangleIndex } from '@/v3/rectangleIndex';

export const REGION_CONTROL_WIDTH = 64, REGION_CONTROL_HEIGHT = 32;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Screen-space chrome does not participate in document geometry or zoom.
 * Parents are placed first; crowded headers drop their text before moving by
 * one row. Only visible regions receive controls, including clipped headers. */
export function layoutRegionControls(blocks: RenderBlock[], view: { x: number; y: number; zoom: number }, area: Rect) {
  const occupied = new RectangleIndex();
  const result: { block: RenderBlock; rect: Rect; anchor: { x: number; y: number }; displaced: boolean }[] = [];
  if (area.width < REGION_CONTROL_WIDTH || area.height < REGION_CONTROL_HEIGHT) return result;
  for (const block of blocks.filter(b => b.kind !== 'node').sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))) {
    const projected = { x: view.x + block.rect.x * view.zoom, y: view.y + block.rect.y * view.zoom,
      width: block.rect.width * view.zoom, height: block.rect.height * view.zoom };
    if (!intersects(projected, area)) continue;
    const anchor = { x: clamp(projected.x + 6, area.x, area.x + area.width - REGION_CONTROL_WIDTH),
      y: clamp(projected.y + 6, area.y, area.y + area.height - REGION_CONTROL_HEIGHT) };
    const available = Math.min(260, projected.width - 12, area.x + area.width - anchor.x);
    let rect = { ...anchor, width: available >= 128 ? available : REGION_CONTROL_WIDTH, height: REGION_CONTROL_HEIGHT };
    if (occupied.collides(rect, 3)) rect = { ...rect, width: REGION_CONTROL_WIDTH };
    // Try nearby rows first, then neighbouring columns for very dense overviews.
    if (occupied.collides(rect, 3)) {
      const rows = Math.ceil(area.height / 36), columns = Math.ceil(area.width / 68);
      search: for (let column = 0; column < columns; column++) {
        for (let row = 0; row < rows; row++) {
          for (const direction of [1, -1]) {
            const x = clamp(anchor.x + (column % 2 ? 1 : -1) * Math.ceil(column / 2) * 68, area.x, area.x + area.width - rect.width);
            const y = anchor.y + direction * row * 36;
            if (y < area.y || y + rect.height > area.y + area.height) continue;
            const candidate = { ...rect, x, y };
            if (!occupied.collides(candidate, 3)) { rect = candidate; break search; }
          }
        }
      }
    }
    occupied.add(rect);
    result.push({ block, rect, anchor, displaced: rect.x !== anchor.x || rect.y !== anchor.y });
  }
  return result;
}
