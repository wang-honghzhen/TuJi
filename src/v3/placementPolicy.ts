import type { Placement } from './types';
export const MANUAL_POSITION_POLICY = { floor: 4, recentBonus: 40, halfLifeMs: 7 * 86400000 } as const;
export function manualProtection(p: Placement, solveTime: number): number {
  const policy = MANUAL_POSITION_POLICY;
  if (!p.manualAnchor) return p.source === 'manual' ? policy.floor : 0;
  return policy.floor + policy.recentBonus * 2 ** (-Math.max(0, solveTime - (p.lastManualAt ?? 0)) / policy.halfLifeMs);
}
