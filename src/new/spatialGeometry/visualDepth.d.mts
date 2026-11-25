import type {WorldGroup, WorldNode, WorldPoint} from './layout.mjs';

export interface ScreenPoint {x:number; y:number; depth:number}
export interface StrokeRun {points:ScreenPoint[]; alpha:number; width:number; dashed:boolean; occluded?:boolean}
export const shadowStrokeOpacity:number;
export function createShellOcclusion(shells:Array<ScreenPoint & {radius:number}>, scale:number):{
  behind:(point:ScreenPoint)=>boolean;
  coversShell:(shell:ScreenPoint & {radius:number})=>boolean;
  shadows:(a:ScreenPoint,b:ScreenPoint)=>Array<[number,number]>;
};
export function shellStrokeRuns(shells:ReturnType<typeof createShellOcclusion>,ink:StrokeRun,canonicalPoints:ScreenPoint[]):StrokeRun[];
export function createDepthView(layout:{groups:WorldGroup[];nodes:WorldNode[]}, frame:{
  scale:number; project:(p:WorldPoint)=>ScreenPoint
}):{
  nodeAlpha:(point:ScreenPoint, options?:{selected?:boolean})=>number;
  edgeRuns:(points:ScreenPoint[], options?:{selected?:boolean;canonicalPoints?:ScreenPoint[]})=>StrokeRun[];
};
