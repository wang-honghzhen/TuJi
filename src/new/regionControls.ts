import { regionContentOrigin, type RenderBlock } from '@/v3/layout';
import { RECORD_HEADER_HEIGHT, type Point, type Rect } from '@/v3/types';

/** Titles share the same world coordinates as their region and its contents. */
export function regionHeaderRect(block: RenderBlock): Rect {
  return { ...block.rect, height: block.collapsed ? block.rect.height : Math.min(block.headerHeight ?? RECORD_HEADER_HEIGHT, block.rect.height) };
}

/** Convert a canvas click before a graph command consumes it in saved-layout
 * world coordinates. Also accounts for a parent's expansion-only offset. */
export function canonicalRegionPoint(point: Point, displayed: RenderBlock, canonical: RenderBlock): Point {
  const from = regionContentOrigin(displayed), to = regionContentOrigin(canonical);
  return { x: point.x - from.x + to.x, y: point.y - from.y + to.y };
}
