import type { GranularityIndex, GranularityProjection } from '../canvasGranularity';
import type { SpatialWorld, SpatialLine } from '../granularSpatialGeometry';
import type { WorldPoint } from './layout.mjs';

type CorridorMode='baseline'|'independent'|'bundle'|'lanes'|'junctions';
interface CorridorLane {
  id:string; slot:number; source:string; target:string;
  entry:WorldPoint; exit:WorldPoint; body:WorldPoint[];
}
export function planCorridorWorkspace(world:SpatialWorld,index:GranularityIndex,scene:GranularityProjection,
  lines:SpatialLine[],mode?:CorridorMode):{
    lines:SpatialLine[];
    channels:{id:string;spine:WorldPoint[];width:number;lanes:CorridorLane[]}[];
    stats:{channelCandidates:number;changed:number;recomputed:number;reused:number;neighborhoodChecks:number};
  };
