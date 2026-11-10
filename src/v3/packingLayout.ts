import type { Point, Rect } from './types';
import { BLOCK_GAP } from './types';
import { intersects } from './rectangleIndex';

/**
 * Deterministic tidying for a region whose children carry no relations.
 *
 * A directory of loose notes has nothing for the relation solver to optimise:
 * every child is equally unrelated. This module arranges those children as a
 * shelf — rows filled left to right — in the reading order the author already
 * sees, and never invents a semantic order it cannot justify. The column count
 * comes from the children's own sizes, never from their current positions, so
 * running the pass twice reproduces exactly the same shelf.
 */

export interface PackingMember {
  id: string;
  size: { width: number; height: number };
  /** Current position; used only to keep the author's reading order. */
  position: Point;
}

export interface PackingOptions {
  gap?: number;
  origin?: Point;
  /** Override the natural column count; otherwise derived from the sizes. */
  columns?: number;
  /** Rectangles the shelf must not overlap (hand-placed children, containers). */
  fixed?: readonly Rect[];
}

export interface PackingResult {
  positions: Map<string, Point>;
  columns: number;
  /** Members whose position actually changed, in reading order. */
  moved: string[];
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** Top-to-bottom bands, left to right inside a band; id breaks exact ties so the
 *  order is total and the pass is idempotent. */
export function readingOrder(members: readonly PackingMember[]): PackingMember[] {
  return [...members].sort((a, b) =>
    a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
}

/** A shelf reads best slightly wider than tall, not square: a wide row stays
 *  scannable at one zoom level, while a tall column needs scrolling. The count
 *  minimises the log deviation from that shape and depends on sizes alone. */
const SHELF_ASPECT = 1.3;

export function packedColumns(members: readonly PackingMember[], gap = BLOCK_GAP): number {
  if (members.length <= 1) return Math.max(1, members.length);
  const width = mean(members.map(member => member.size.width)) + gap;
  const height = mean(members.map(member => member.size.height)) + gap;
  let best = 1, bestError = Infinity;
  for (let columns = 1; columns <= members.length; columns++) {
    const rows = Math.ceil(members.length / columns);
    const error = Math.abs(Math.log(((columns * width - gap) / (rows * height - gap)) / SHELF_ASPECT));
    if (error < bestError) { bestError = error; best = columns; }
  }
  return clamp(best, 1, members.length);
}

export function packMembers(members: readonly PackingMember[], options: PackingOptions = {}): PackingResult {
  const gap = options.gap ?? BLOCK_GAP;
  const fixed = options.fixed ?? [];
  const origin = options.origin ?? { x: 0, y: 0 };
  const ordered = readingOrder(members);
  const positions = new Map<string, Point>();
  if (!ordered.length) return { positions, columns: 0, moved: [] };
  const columns = clamp(options.columns ?? packedColumns(ordered, gap), 1, ordered.length);
  let y = origin.y;
  for (let start = 0; start < ordered.length; start += columns) {
    const row = ordered.slice(start, start + columns);
    const rowHeight = Math.max(...row.map(member => member.size.height));
    // A hand-placed child keeps its rectangle; the whole row steps below it
    // instead of squeezing past, which keeps the row's internal order intact.
    // Each step clears at least one fixed rectangle, so the loop is short.
    for (let guard = 0; guard <= fixed.length + 4; guard++) {
      const band = row.map((member, index) => memberRect(member, rowX(row, index, origin.x, gap), y));
      const blocker = highestBottom(band, fixed);
      if (blocker === undefined) break;
      y = blocker + gap;
    }
    row.forEach((member, index) => positions.set(member.id, { x: rowX(row, index, origin.x, gap), y }));
    y += rowHeight + gap;
  }
  const moved = ordered.filter(member => {
    const point = positions.get(member.id)!;
    return member.position.x !== point.x || member.position.y !== point.y;
  }).map(member => member.id);
  return { positions, columns, moved };
}

const rowX = (row: readonly PackingMember[], index: number, originX: number, gap: number): number =>
  row.slice(0, index).reduce((x, member) => x + member.size.width + gap, originX);

const memberRect = (member: PackingMember, x: number, y: number): Rect =>
  ({ x, y, width: member.size.width, height: member.size.height });

/** Lowest edge among the fixed rectangles this row would overlap, if any. */
function highestBottom(band: readonly Rect[], fixed: readonly Rect[]): number | undefined {
  let bottom: number | undefined;
  for (const rect of band) for (const obstacle of fixed) {
    if (!intersects(rect, obstacle)) continue;
    const edge = obstacle.y + obstacle.height;
    if (bottom === undefined || edge > bottom) bottom = edge;
  }
  return bottom;
}
