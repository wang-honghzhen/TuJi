import type { Placement } from '@/v3/types';
import type { LayoutStats } from '@/v3/relationshipLayout';
export interface LayoutGeometryReply {
  documents: Array<{ id: string; placements: Record<string, Placement>; rev: number; updatedAt: string }>;
  canvases: Array<{ id: string; placements: Record<string, Placement>; updatedAt: string }>;
  layoutVersion?: number;
  stats: LayoutStats;
}
