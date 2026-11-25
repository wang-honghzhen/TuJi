import { NODE_WIDTH, type Placement, type Point } from './types';
export const MANUAL_POSITION_POLICY = { graceMs: 10 * 60000, floor: 4, recentBonus: 40, halfLifeMs: 7 * 86400000 } as const;
export const hasManualIntent = (p?: Placement) => Boolean(p && (p.source === 'manual' || p.manualAnchor));

/** An undated legacy placement gets the long-term preference. The timestamp
 * of the last real gesture is never refreshed by an automatic adjustment. */
export function manualProtection(p: Placement, solveTime: number): number {
  const policy = MANUAL_POSITION_POLICY;
  if (!hasManualIntent(p)) return 0;
  if (p.lastManualAt === undefined || !Number.isFinite(p.lastManualAt)) return policy.floor;
  return policy.floor + policy.recentBonus * 2 ** (-Math.max(0, solveTime - p.lastManualAt) / policy.halfLifeMs);
}

export function recentManualPlacement(p: Placement | undefined, now: number): boolean {
  return hasManualIntent(p) && p?.lastManualAt !== undefined && now - p.lastManualAt < MANUAL_POSITION_POLICY.graceMs;
}

/** In score units: an old placement still costs roughly one straight card
 * length per card moved. Crossings and obstructions can justify that cost. */
export function manualMovementCost(base: Placement, from: Point, to: Point, strength: number): number {
  if (!strength) return 0;
  const anchor = base.manualAnchor ?? base;
  const extra = Math.hypot(to.x - anchor.x, to.y - anchor.y) - Math.hypot(from.x - anchor.x, from.y - anchor.y);
  return strength * Math.max(0, extra) / (4 * NODE_WIDTH);
}

export function automaticPlacement(base: Placement, point: Point): Placement {
  // Older graphs may have only a manual flag. Preserve their original anchor
  // before marking the new position as automatically assigned.
  const manualAnchor = base.manualAnchor ?? (base.source === 'manual' ? { x: base.x, y: base.y } : undefined);
  return { ...base, x: point.x, y: point.y, source: 'auto', ...(manualAnchor ? { manualAnchor } : {}) };
}
