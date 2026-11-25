import type { Point, Rect } from '../../v3/types';

// Offsets from the alphabetic baseline at text-anchor="start". The advance
// shifts that baseline for text-anchor="end", even for overhanging glyphs.
export interface CaptionMetrics {
  advance: number; left: number; right: number; top: number; bottom: number;
}

export function createCaptionMeasurer(font: string) {
  const cache = new Map<string, CaptionMetrics>();
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (ctx) {
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.direction = 'ltr';
  }
  return (caption: string) => {
    const cached = cache.get(caption);
    if (cached) return cached;
    const m = ctx?.measureText(caption);
    const advance = m?.width ?? caption.length * 13;
    // Two pixels cover the SVG's 3 px outline; reserve the larger of
    // the font box and actual ink (including fallback fonts and marks).
    const result = { advance,
      left: Math.floor(Math.min(0, -(m?.actualBoundingBoxLeft ?? 0))) - 2,
      right: Math.ceil(Math.max(advance, m?.actualBoundingBoxRight ?? advance)) + 2,
      top: -Math.ceil(Math.max(m?.actualBoundingBoxAscent ?? 12, m?.fontBoundingBoxAscent ?? 12)) - 2,
      bottom: Math.ceil(Math.max(m?.actualBoundingBoxDescent ?? 4, m?.fontBoundingBoxDescent ?? 4)) + 2 };
    cache.set(caption, result);
    return result;
  };
}

// Screen-space sites, in preference order. The original site is just inside
// the top rim. All alternatives remain attached to the same projected shell.
const rimSites = [
  [0, -1], [-.5, -Math.sqrt(.75)], [.5, -Math.sqrt(.75)],
  [0, 1], [-.5, Math.sqrt(.75)], [.5, Math.sqrt(.75)], [-1, 0], [1, 0],
];

export function placeShellTitle(center: Point, radius: number, ink: CaptionMetrics, viewport: Rect,
  reserve: (bounds: Rect) => boolean): Point | undefined {
  const left = Math.min(-3, ink.left), top = Math.min(-15, ink.top);
  const width = Math.max(ink.advance + 3, ink.right) - left, height = Math.max(8, ink.bottom) - top;
  if (width > viewport.width || height > viewport.height) return;
  const right = viewport.x + viewport.width, bottom = viewport.y + viewport.height;
  for (const [dx, dy] of rimSites) {
    const rimX = center.x + dx * radius, rimY = center.y + dy * radius;
    if (rimX < viewport.x || rimX > right || rimY < viewport.y - height || rimY > bottom + height) continue;
    for (const baseline of dy < 0 ? [rimY + 15, rimY - 6] : [rimY - 6, rimY + 15]) {
      const y = baseline + top;
      if (y < viewport.y || y + height > bottom) continue;
      for (const start of [rimX + 4, rimX - ink.advance / 2, rimX - ink.advance - 4]) {
        const x = Math.min(right - width, Math.max(viewport.x, start + left));
        if (reserve({ x, y, width, height })) return { x: x - left, y: baseline };
      }
    }
  }
}
