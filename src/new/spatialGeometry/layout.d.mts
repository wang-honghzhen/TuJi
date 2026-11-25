import type { Point, Rect } from '../../v3/types';
export interface WorldPoint extends Point { z: number }
export interface Group { id: string; name: string; parent: string | null; depth: number; rect: Rect }
export interface Node extends Point { id: string; name: string; owner: string }
export interface Link { id: string; source: string; target: string; directed: boolean }
export interface SpatialData { groups: Group[]; nodes: Node[]; edges: Link[] }
export interface WorldGroup extends Group {
  shape: 'sphere' | 'plane'; center: WorldPoint; radius: number; halfWidth: number; halfHeight: number;
}
export interface WorldNode extends Node { p: WorldPoint }
export interface WorldLayout { groups: WorldGroup[]; nodes: WorldNode[]; spacing: number; layerGap: number }
export function layout(data: SpatialData, mode: 'plane' | 'sphere' | 'offset', layerGapMultiplier?: number): WorldLayout;
