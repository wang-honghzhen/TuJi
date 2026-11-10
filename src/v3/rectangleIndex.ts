import type { Rect } from './types';

export const intersects = (a: Rect, b: Rect, gap = 0) => a.x < b.x + b.width + gap &&
  a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

/** Large containers bypass the grid, so a sparse huge region does not allocate
 * millions of cells. The exact rectangle check remains the final authority. */
export class RectangleIndex {
  readonly rects: Rect[] = [];
  private cells = new Map<string, Rect[]>();
  private large: Rect[] = [];
  private range(rect: Rect, gap = 0) {
    return [Math.floor((rect.x - gap) / 256), Math.floor((rect.y - gap) / 256),
      Math.floor((rect.x + rect.width + gap) / 256), Math.floor((rect.y + rect.height + gap) / 256)];
  }
  constructor(rects: Rect[] = []) { rects.forEach(rect => this.add(rect)); }
  add(rect: Rect): void {
    this.rects.push(rect);
    const [x0, y0, x1, y1] = this.range(rect);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { this.large.push(rect); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x}/${y}`; const bucket = this.cells.get(key);
      if (bucket) bucket.push(rect); else this.cells.set(key, [rect]);
    }
  }
  collides(rect: Rect, gap = 0): boolean {
    const [x0, y0, x1, y1] = this.range(rect, gap);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return this.rects.some(other => intersects(rect, other, gap));
    if (this.large.some(other => intersects(rect, other, gap))) return true;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (this.cells.get(`${x}/${y}`)?.some(other => intersects(rect, other, gap))) return true;
    }
    return false;
  }
  query(rect: Rect, gap = 0): Rect[] {
    const [x0, y0, x1, y1] = this.range(rect, gap);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return this.rects.filter(other => intersects(rect, other, gap));
    const candidates = new Set(this.large);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.cells.get(`${x}/${y}`)?.forEach(item => candidates.add(item));
    return [...candidates].filter(other => intersects(rect, other, gap));
  }
}
