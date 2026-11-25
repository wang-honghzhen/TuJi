// A free gap between facing rims is itself a corridor, even when the
// layout contains only two platforms. Its two stations belong to the
// world; the positions of the mandatory ports need not be moved.
const passages = new WeakMap();
const half=(g,k)=>k==='x'?g.halfWidth:g.halfHeight;
const clamp=(x,l,r)=>Math.max(l,Math.min(r,x));
function findPassage(a,b,spacing){
  const options=[];
  for(const [axis,cross] of [['x','y'],['y','x']]){
    const first=a.center[axis]<=b.center[axis]?a:b,last=first===a?b:a;
    const from=first.center[axis]+half(first,axis),to=last.center[axis]-half(last,axis),gap=to-from;
    const lo=Math.max(a.center[cross]-half(a,cross),b.center[cross]-half(b,cross))+spacing*.05;
    const hi=Math.min(a.center[cross]+half(a,cross),b.center[cross]+half(b,cross))-spacing*.05;
    if(gap<spacing*.5||hi-lo<spacing*.5||a.center.z!==b.center.z)continue;
    options.push({axis,cross,lo,hi,start:from+.24*gap,end:to-.24*gap,pitch:Math.min(.32*spacing,(hi-lo)/15),gap});
  }
  return options.sort((u,v)=>v.gap-u.gap)[0]??null;
}
export function facingPassage(a,b,spacing){
  const first=a.id<b.id?a:b,last=first===a?b:a;
  let to=passages.get(first);
  if(!to){to=new WeakMap();passages.set(first,to);}
  if(!to.has(last))to.set(last,findPassage(first,last,spacing));
  return to.get(last);
}
export function separatePassage(a,b,passage,ledger,rawBed,valid) {
  const {axis,cross,start,end,lo,hi,pitch}=passage;
  const reverse=a[axis]>b[axis],first=reverse?b:a,last=reverse?a:b;
  if(first[axis]>=start||last[axis]<=end)return;
  const at=s=>first[cross]+(last[cross]-first[cross])*(s-first[axis])/(last[axis]-first[axis]);
  const u=at(start),v=at(end);
  if(u<lo||u>hi||v<lo||v>hi)return;
  let seats=ledger.get(passage);
  if(!seats){seats=[];ledger.set(passage,seats);}
  const room=(x,y,z)=>seats.every(({p})=>Math.abs(p.z-z)>=pitch||
    (x-p.x>=pitch-1e-6&&y-p.y>=pitch-1e-6)||(p.x-x>=pitch-1e-6&&p.y-y>=pitch-1e-6));
  if(!rawBed&&room(u,v,a.z)){
    seats.push({p:{x:u,y:v,z:a.z}});
    return;
  }
  const preferred=clamp((u+v)/2,lo,hi);
  // Place the nearest available pipe. Preserve order throughout the
  // shared run; only the feeders at either end may change relative order.
  for(const lift of [rawBed,rawBed+pitch*1.15,rawBed-pitch*1.15]){
    const z=a.z+lift;
    const radius=Math.min(16,Math.ceil((hi-lo)/pitch));
    for(let k=0;k<=radius;k++)for(const sign of k?[-1,1]:[1]){
      const pos=preferred+sign*k*pitch;
      if(pos<lo||pos>hi||!room(pos,pos,z))continue;
      const inside=(s)=>({[axis]:s,[cross]:pos,z});
      const pts=reverse?[a,inside(end),inside(start),b]:[a,inside(start),inside(end),b];
      if(!valid(pts))continue;
      seats.push({p:{x:pos,y:pos,z}});
      return pts;
    }
  }
}
