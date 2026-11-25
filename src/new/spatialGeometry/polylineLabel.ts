import type {Point,Rect} from '../../v3/types';
import {fitLabel} from '../planarRelationLabel';

function pad(rect:Rect,x:number,y=x):Rect {
  return {x:rect.x-x,y:rect.y-y,width:rect.width+2*x,height:rect.height+2*y};
}

// Slab clipping also finds a short visible segment when both ends lie outside.
function clip(a:Point,b:Point,rect:Rect) {
  if(rect.width<=0||rect.height<=0)return;
  let start=0,end=1;
  for(const axis of ['x','y'] as const){
    const min=rect[axis],max=min+(axis==='x'?rect.width:rect.height),d=b[axis]-a[axis];
    if(!d){if(a[axis]<min||a[axis]>max)return;continue;}
    const p=(min-a[axis])/d,q=(max-a[axis])/d;
    start=Math.max(start,Math.min(p,q));end=Math.min(end,Math.max(p,q));
    if(end<=start)return;
  }
  return {start,end};
}

function visibleMidpoint(points:readonly Point[],area:Rect,masks:readonly Rect[]) {
  const spans:{from:number;to:number}[]=[],lengths=[0];
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],offset=lengths[i-1],length=Math.hypot(b.x-a.x,b.y-a.y);
    lengths.push(offset+length);
    const visible=length&&clip(a,b,area);
    if(!visible)continue;
    const blocks=masks.flatMap(mask=>{
      const range=clip(a,b,mask);
      return range&&range.end>visible.start&&range.start<visible.end?[range]:[];
    }).sort((one,two)=>one.start-two.start);
    let cursor=visible.start;
    function add(end:number){
      if(end<=cursor)return;
      const from=offset+cursor*length,to=offset+end*length,last=spans.at(-1);
      if(last&&Math.abs(last.to-from)<1e-6)last.to=to;
      else spans.push({from,to});
    }
    for(const block of blocks){add(Math.min(block.start,visible.end));cursor=Math.max(cursor,block.end);}
    add(visible.end);
  }
  if(!spans.length)return;
  const longest=spans.reduce((a,b)=>a.to-a.from>=b.to-b.from?a:b);
  const distance=(longest.from+longest.to)/2,i=lengths.findIndex(x=>x>=distance);
  const a=points[i-1],b=points[i],t=(distance-lengths[i-1])/(lengths[i]-lengths[i-1]);
  const radians=Math.atan2(b.y-a.y,b.x-a.x);
  return {x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y),angle:((radians*180/Math.PI+270)%180)-90};
}

export function polylineLabel(points:readonly Point[],area:Rect,masks:readonly Rect[],width:number,height:number) {
  const radius=Math.hypot(width,height)/2;
  const padded=visibleMidpoint(points,pad(area,-radius),masks.map(mask=>pad(mask,radius)));
  if(padded)return padded;
  const visible=visibleMidpoint(points,area,masks);
  if(!visible)return;
  const radians=visible.angle*Math.PI/180,cos=Math.abs(Math.cos(radians)),sin=Math.abs(Math.sin(radians));
  const dx=(width*cos+height*sin)/2,dy=(height*cos+width*sin)/2;
  return {...fitLabel(visible,pad(area,-dx,-dy),masks.map(mask=>pad(mask,dx,dy))),angle:visible.angle};
}
