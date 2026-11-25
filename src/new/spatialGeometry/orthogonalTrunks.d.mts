import type {GranularityIndex,GranularityProjection} from '../canvasGranularity';
import type {SpatialLine,SpatialWorld} from '../granularSpatialGeometry';

interface RouteDirectory {
  relations:ReadonlyMap<string,{sourceSubgraphId:string;targetSubgraphId:string}>;
}
interface OccupiedTrunk {
  id:string;sourceSubgraphId:string;targetSubgraphId:string;points:Readonly<SpatialLine['points']>;
}
export function routeOrthogonalTrunks(world:SpatialWorld,index:RouteDirectory,lines:SpatialLine[],role?:'aggregate'|'original',occupiedSummary?:readonly OccupiedTrunk[]):SpatialLine[];
export function planLayeredLines(world:SpatialWorld,index:GranularityIndex,scene:GranularityProjection,lines:SpatialLine[]):SpatialLine[];
