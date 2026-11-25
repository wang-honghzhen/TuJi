import type {ScreenPoint} from './visualDepth.mjs';
export const maxSpreadPixels:number;
export type ScreenDot = ScreenPoint & {id:string;anchorX:number;anchorY:number};
export type Outline = {left:number;top:number;right:number;bottom:number} & (
  {x:number;y:number;radius:number} | {corners:ScreenPoint[]}
);
export function spreadProjectedPoints(points:ScreenDot[], outlines:Outline[], options:{
  preferred?:ReadonlySet<string>; important?:ReadonlySet<string>; pinned?:ReadonlySet<string>
}):void;
