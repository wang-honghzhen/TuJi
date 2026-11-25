import type { WorldLayout, WorldPoint, WorldGroup, Link } from './layout.mjs';
export interface RelationEndpoints { id: string; from: string; to: string; fromPoints: WorldPoint[]; toPoints: WorldPoint[] }
export interface CoarseRoute {
  points: WorldPoint[]; commonAncestor: string; gates: {groupId:string; point:WorldPoint}[];
}
export function overviewRoutes(shape: WorldLayout, pairs: RelationEndpoints[]): Map<string, CoarseRoute>;
export function route(data: {edges:Link[]}, shape:WorldLayout, options:{aggregate:false}): {paths:Record<string, WorldPoint[]>};
export function createSpatialLineRouter(shape:WorldLayout,relations?:Iterable<{id:string;sourceSubgraphId:string;targetSubgraphId:string}>): {
  detailed(edges:Link[]):Record<string,WorldPoint[]>;
  overview(pairs:RelationEndpoints[]):Map<string,CoarseRoute>;
  rims(pairs:RelationEndpoints[]):Map<string,CoarseRoute>;
  independent(from:string,to:string,ports:WorldPoint[]):WorldPoint[];
  platformBranch(ownerId:string,node:WorldPoint,gate:WorldPoint):WorldPoint[];
};
export function routeIntersections(points:WorldPoint[],obstacles:WorldGroup[]):number;
export function routePlatformBranch(shape:WorldLayout,ownerId:string,nodePoint:WorldPoint,portPoint:WorldPoint):WorldPoint[];
