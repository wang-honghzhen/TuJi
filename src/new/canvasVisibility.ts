import { RectangleIndex } from '@/v3/rectangleIndex';
import type { Rect } from '@/v3/types';

/** Rendering follows the physical canvas, including translucent UI overlays. */
export function canvasViewportBounds(view: { x: number; y: number; zoom: number }, size: { width: number; height: number }): Rect {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom };
}

/** Separate block and route indexes so a routing refinement only replaces
 * the latter. The same route index handles small pointer hit queries. */
export function indexCanvasObjects<T>(items: T[], idOf: (item: T) => string, boundsOf: (item: T) => Rect) {
  const positions = new Map<string, number[]>();
  const index = new RectangleIndex(items.map((item, position) => {
    const id = idOf(item), previous = positions.get(id);
    if (previous) previous.push(position); else positions.set(id, [position]);
    return { ...boundsOf(item), position };
  }));
  return (area: Rect, margin: number, retained?: ReadonlySet<string>) => {
    const matches = new Set(index.query(area, margin).map(rect => (rect as Rect & { position: number }).position));
    retained?.forEach(id => positions.get(id)?.forEach(position => matches.add(position)));
    if (matches.size > items.length / 4) return items.filter((_, position) => matches.has(position));
    return [...matches].sort((a, b) => a - b).map(position => items[position]);
  };
}
