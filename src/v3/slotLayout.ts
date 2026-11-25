import type { LayeredLayout } from './layeredSeed';
import { RectangleIndex } from './rectangleIndex';
import type { GrowthDirection } from './insertionPlacement';
import { BLOCK_GAP, type Placement, type Rect } from './types';

/** Transfer a layered drawing's order to the slots the user already sees.
 * This can repair a few misplaced branches without shrinking a whole diagram.
 * The slots' original spacing competes with the compact structural drawing. */
export function slotCandidates(layout: LayeredLayout, positions: Readonly<Record<string, Placement>>,
  sizes: ReadonlyMap<string, Rect>, fixed: readonly Rect[], flow: GrowthDirection, root: boolean) {
  const horizontal = flow === 'right' || flow === 'left';
  const main = horizontal ? 'x' : 'y', cross = horizontal ? 'y' : 'x';
  const mainSize = horizontal ? 'width' : 'height', crossSize = horizontal ? 'height' : 'width';
  const ids = [...layout.positions.keys()];
  const ranks: string[][] = [];
  let end = -Infinity;
  for (const id of ids.sort((a, b) => layout.positions.get(a)![main] - layout.positions.get(b)![main] || a.localeCompare(b))) {
    const start = layout.positions.get(id)![main];
    if (start >= end) ranks.push([]);
    ranks[ranks.length - 1].push(id);
    end = Math.max(end, start + sizes.get(id)![mainSize]);
  }
  const mainCentre = (id: string) => positions[id][main] + sizes.get(id)![mainSize] / 2;
  const crossCentre = (id: string) => positions[id][cross] + sizes.get(id)![crossSize] / 2;
  const seedCross = (id: string) => layout.positions.get(id)![cross] + sizes.get(id)![crossSize] / 2;
  const slots = ids.slice().sort((a, b) => mainCentre(a) - mainCentre(b) || crossCentre(a) - crossCentre(b) || a.localeCompare(b));
  const assigned = new Map<string, string>();
  let offset = 0;
  for (const rank of ranks) {
    const band = slots.slice(offset, offset + rank.length).sort((a, b) => crossCentre(a) - crossCentre(b) || a.localeCompare(b));
    rank.sort((a, b) => seedCross(a) - seedCross(b) || a.localeCompare(b)).forEach((id, i) => assigned.set(id, band[i]));
    offset += rank.length;
  }
  const levels = ids.map(crossCentre).sort((a, b) => a - b);
  const middle = (levels[Math.floor(levels.length / 2)] + levels[Math.floor((levels.length - 1) / 2)]) / 2;
  const candidates: Record<string, Placement>[] = [];
  // Single-node ranks may also share a centre line. Branching ranks need
  // separate lanes for their siblings.
  for (const straighten of ranks.length === ids.length ? [false, true] : [false]) {
    const candidate = { ...positions }, occupied = new RectangleIndex([...fixed]);
    let clear = true;
    for (const [id, slot] of assigned) {
      const size = sizes.get(id)!;
      const point = { ...positions[id], [main]: Math.round(mainCentre(slot) - size[mainSize] / 2),
        [cross]: Math.round((straighten ? middle : crossCentre(slot)) - size[crossSize] / 2) };
      if ((!root && (point.x < 0 || point.y < 0)) || occupied.collides({ ...size, ...point }, BLOCK_GAP - .01)) {
        clear = false; break;
      }
      candidate[id] = point; occupied.add({ ...size, ...point });
    }
    if (clear) candidates.push(candidate);
  }
  return candidates;
}
