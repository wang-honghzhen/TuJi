import {trunkFrame} from './trunkFrame.mjs';
import {planarTurns,selectPlatformSockets,sharedSockets,socketOccupancy} from './platformSockets.mjs';
import {denseDemands,solveDenseBanks} from './denseOrthogonalBanks.mjs';
import {gridPassage} from './orthogonalGrid.mjs';
import {planCorridorWorkspace} from './globalCorridors.mjs';
import {platformExposure} from './platformCorridors.mjs';

// Start from the overview sockets and compare alternative rim/orthogonal-route
// pairs for unrelated decks. Geometric offers and prior disclosures belong
// to this exact published world/index; rotations never reach this module.
const aggregateWorlds=new WeakMap(),originalWorlds=new WeakMap();
const eps=1e-7;
const keys=['x','y','z'];
const other=k=>k==='x'?'y':'x';
const axis=(a,b)=>keys.find(k=>Math.abs(a[k]-b[k])>eps);
const length=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+Math.abs(a.z-b.z);
const keyPoint=p=>[p.x,p.y,p.z].join(',');
const same=(a,b)=>length(a,b)<eps;
const views=[[-.25,.85],[-.922,.626]].map(([yaw,pitch])=>[Math.cos(yaw),Math.sin(yaw),Math.sin(pitch),Math.cos(pitch)]);
const captionBearings=[[1,0,1,0],...views];
const project=(p,[c,s,i,h])=>({x:c*p.x-s*p.y,y:i*(s*p.x+c*p.y)-h*p.z});
function face(g,p){
  const x=p.x-g.center.x,y=p.y-g.center.y;
  const k=Math.abs(Math.abs(x)-g.halfWidth)<=Math.abs(Math.abs(y)-g.halfHeight)?'x':'y';
  return {axis:k,sign:Math.sign(k==='x'?x:y)||1};
}
function compact(points){
  const out=[];
  for(const p of points){
    const last=out.at(-1);
    if(last&&same(last,p))continue;
    if(out.length>=2){
      const a=out.at(-2),k=axis(a,last);
      if(k===axis(last,p)){
        if((last[k]-a[k])*(p[k]-last[k])<0)return;
        out.pop();
      }
    }
    out.push(p);
  }
  return out;
}
function box(g,margin=0){
  return {id:g.id,left:g.center.x-g.halfWidth-margin,right:g.center.x+g.halfWidth+margin,
    top:g.center.y-g.halfHeight-margin,bottom:g.center.y+g.halfHeight+margin};
}
function captionViews(shape){
  return captionBearings.map(view=>{
    const tips=[];let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
    for(const g of shape.groups){
      let tip;
      for(const [dx,dy] of [[-1,-1],[1,-1],[1,1],[-1,1]]){
        const p=project({x:g.center.x+dx*g.halfWidth,y:g.center.y+dy*g.halfHeight,z:g.center.z},view);
        left=Math.min(left,p.x);right=Math.max(right,p.x);top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);
        if(!tip||p.y<=tip.y)tip=p;
      }
      tips.push({g,tip});
    }
    // Fixed comparison viewport. The live camera does not enter world routing.
    const zoom=Math.min(2,1090/Math.max(1,right-left),710/Math.max(1,bottom-top));
    return tips.map(({g,tip})=>{
      const name=Array.from(g.name??g.id).slice(0,24);
      const width=name.reduce((n,ch)=>n+(ch.codePointAt(0)>255?12:7),0);
      return {left:tip.x+3/zoom,right:tip.x+(5+width)/zoom,top:tip.y-11/zoom,bottom:tip.y+4/zoom};
    });
  });
}
function clipped(a,b,rect){
  let lo=0,hi=1;
  for(const [k,low,high] of [['x',rect.left,rect.right],['y',rect.top,rect.bottom]]){
    const v=b[k]-a[k];
    if(Math.abs(v)<eps){if(a[k]<=low+eps||a[k]>=high-eps)return 0;continue;}
    const s=(low-a[k])/v,t=(high-a[k])/v;
    lo=Math.max(lo,Math.min(s,t));hi=Math.min(hi,Math.max(s,t));if(hi<=lo)return 0;
  }
  return hi-lo;
}
function titleCost(points,worldPlan){
  let amount=0;
  for(let i=0;i<captionBearings.length;i++){
    const q=points.map(p=>project(p,captionBearings[i]));
    for(let j=1;j<q.length;j++){
      const a=q[j-1],b=q[j],len=Math.hypot(a.x-b.x,a.y-b.y);
      for(const rect of worldPlan.captions[i]){
        if(Math.max(a.x,b.x)<=rect.left||Math.min(a.x,b.x)>=rect.right||
           Math.max(a.y,b.y)<=rect.top||Math.min(a.y,b.y)>=rect.bottom)continue;
        const cut=clipped(a,b,rect);if(cut)amount+=cut*len+worldPlan.shape.spacing*.22;
      }
    }
  }
  return amount/captionBearings.length;
}
function family(world,a,b){
  const ids=new Set();
  for(const owner of [a,b])for(let g=owner;g&&!ids.has(g.id);g=world.groups.get(g.parent))ids.add(g.id);
  return ids;
}
function context(world,record){
  const a=world.groups.get(record.sourceSubgraphId),b=world.groups.get(record.targetSubgraphId);
  const related=family(world,a,b);
  const obstacles=world.shape.groups.filter(g=>!related.has(g.id));
  const parents=new Set();
  for(let g=a;g;g=world.groups.get(g.parent))parents.add(g);
  let common=b;while(common&&!parents.has(common))common=world.groups.get(common.parent);
  const intermediate=[];
  for(const end of [a,b]){
    if(end===common)continue;
    for(let g=world.groups.get(end.parent);g&&g!==common;g=world.groups.get(g.parent))intermediate.push(g);
  }
  return {a,b,related,obstacles,rects:obstacles.map(g=>box(g)),solid:[...obstacles,...intermediate,a,b]};
}
function stub(point,side,size,opposite,ctx,owner,phase){
  let space=Math.min(size*(.12+.46*phase),Math.max(size*.012,length(point,opposite)*(.12+.16*phase)));
  const k=side.axis,v=other(k);
  for(const g of ctx.solid){
    if(g===owner||Math.abs(g.center.z-point.z)>eps)continue;
    const half=k==='x'?g.halfWidth:g.halfHeight,cross=k==='x'?g.halfHeight:g.halfWidth;
    if(Math.abs(point[v]-g.center[v])>=cross-eps)continue;
    const run=side.sign*(g.center[k]-point[k])-half;
    if(run>eps)space=Math.min(space,run*(.16+.25*phase));
  }
  return {...point,[k]:point[k]+side.sign*space};
}
function trackValues(a,b,ctx,spacing,k){
  const u=other(k),min=Math.min(a[k],b[k]),max=Math.max(a[k],b[k]),mid=(min+max)/2;
  const values=new Set([a[k],b[k],mid,mid-spacing*.24,mid+spacing*.24]);
  const lo=k==='x'?'left':'top',hi=k==='x'?'right':'bottom',crossLo=k==='x'?'top':'left',crossHi=k==='x'?'bottom':'right';
  for(const g of [ctx.a,ctx.b,...ctx.obstacles]){
    const r=box(g);
    if(r[crossHi]<Math.min(a[u],b[u])-spacing||r[crossLo]>Math.max(a[u],b[u])+spacing)continue;
    if(r[hi]<min-spacing*2||r[lo]>max+spacing*2)continue;
    for(const pad of [.16,.40]){values.add(r[lo]-spacing*pad);values.add(r[hi]+spacing*pad);}
  }
  return [...values];
}
function middleShapes(a,b,ctx,s){
  const xy=(x,y)=>({x,y}),out=[];
  if(a.x===b.x||a.y===b.y)out.push([]);
  out.push([xy(a.x,b.y)],[xy(b.x,a.y)]);
  for(const x of trackValues(a,b,ctx,s,'x'))out.push([xy(x,a.y),xy(x,b.y)]);
  for(const y of trackValues(a,b,ctx,s,'y'))out.push([xy(a.x,y),xy(b.x,y)]);
  return out;
}
function originalAxes(points,start,end){
  if(points.length<2)return false;
  const a=points[0],b=points.at(-1),first=points.find(p=>p.x!==a.x||p.y!==a.y),last=points.findLast(p=>p.x!==b.x||p.y!==b.y);
  return first&&last&&axis(a,first)===start.axis&&axis(b,last)===end.axis&&
    (first[start.axis]-a[start.axis])*start.sign>0&&(last[end.axis]-b[end.axis])*end.sign>0;
}
function measureSegment(a,b,k,ctx){
  const low=Math.min(a[k],b[k]),high=Math.max(a[k],b[k]);
  let cover=0;
  if(k==='z'){
    for(const g of ctx.solid){
      if(g.center.z>=low-eps&&g.center.z<=high+eps&&Math.abs(a.x-g.center.x)<g.halfWidth-eps&&Math.abs(a.y-g.center.y)<g.halfHeight-eps)return Infinity;
    }
    return 0;
  }
  // A rim coordinate is reused by many L and Z candidates. Only decks
  // spanning that coordinate can contribute a contact or footprint.
  const cross=other(k),fixed=a[cross];
  ctx.cuts??={x:new Map(),y:new Map()};
  const rows=ctx.cuts[k];
  let spans=rows.get(fixed);
  if(!spans){
    spans=[];
    for(const g of ctx.solid){
      const h=k==='x'?g.halfWidth:g.halfHeight,w=k==='x'?g.halfHeight:g.halfWidth;
      if(Math.abs(fixed-g.center[cross])<w-eps)
        spans.push({low:g.center[k]-h,high:g.center[k]+h,z:g.center.z,foreign:!ctx.related.has(g.id)});
    }
    if(rows.size>=192)rows.delete(rows.keys().next().value);
    rows.set(fixed,spans);
  }
  for(const band of spans){
    const span=Math.min(high,band.high)-Math.max(low,band.low);
    if(span<=eps)continue;
    if(Math.abs(a.z-band.z)<eps)return Infinity;
    if(band.foreign)cover+=span;
  }
  return cover;
}
// Last resort for manually coincident sockets. Between consecutive deck
// heights every horizontal segment is physically clear. The turn between
// escape elevations is outside the bounding rectangle of the published world.
function exteriorPassage(shape,start,end,sa,sb){
  const s=shape.spacing,levels=[...new Set(shape.groups.map(g=>g.center.z))].sort((a,b)=>a-b);
  function gap(z,sign){
    const next=sign>0?levels.find(h=>h>z+eps):levels.findLast(h=>h<z-eps);
    return z+sign*Math.min(s*.33,next===undefined?s:Math.abs(next-z)/2);
  }
  const outer={
    x:[Math.min(...shape.groups.map(g=>g.center.x-g.halfWidth))-s,Math.max(...shape.groups.map(g=>g.center.x+g.halfWidth))+s],
    y:[Math.min(...shape.groups.map(g=>g.center.y-g.halfHeight))-s,Math.max(...shape.groups.map(g=>g.center.y+g.halfHeight))+s],
  };
  const z1=gap(start.z,1);
  let z2=gap(end.z,-1);if(Math.abs(z2-z1)<eps)z2=gap(end.z,1);
  const a={...start,z:z1},b={...end,z:z2};
  const u={...a,[sa.axis]:outer[sa.axis][Number(sa.sign>0)]},v={...b,[sb.axis]:outer[sb.axis][Number(sb.sign>0)]};
  const top=levels.at(-1)+s;
  if(u.x===v.x&&u.y===v.y&&z1!==z2)return [start,a,u,v,b,end];
  // Walk on the outside from one exterior coordinate to the other. Both
  // available elbows are axis-aligned even when both sockets share a face.
  const corner=sa.axis==='x'?{x:u.x,y:v.y,z:top}:{x:v.x,y:u.y,z:top};
  return [start,a,u,{...u,z:top},corner,{...v,z:top},v,b,end];
}
function planOffers(worldPlan,ctx,start,end,store,expand=false){
  const {shape}=worldPlan,s=shape.spacing,sa=face(ctx.a,start),sb=face(ctx.b,end);
  const fan=(a,b,g,face,phase)=>{
    const k=other(face.axis),h=k==='x'?g.halfWidth:g.halfHeight;
    const fraction=Math.max(0,Math.min(1,(a[k]-g.center[k]+h)/(2*h)));
    return .85*(b[k]<a[k]?fraction:1-fraction)+.15*phase;
  };
  const a=stub(start,sa,s,end,ctx,ctx.a,fan(start,end,ctx.a,sa,ctx.phase));
  const b=stub(end,sb,s,start,ctx,ctx.b,fan(end,start,ctx.b,sb,1-ctx.phase));
  const offers=[],seen=new Set(),levels=new Set([a.z,b.z]);
  if(a.z!==b.z)levels.add((a.z+b.z)/2);
  function measure(points){
    const p=compact(points);if(!p||!originalAxes(p,sa,sb))return;
    const key=p.map(keyPoint).join('/');
    let len=0,topCover=0;
    for(let i=1;i<p.length;i++){
      const u=p[i-1],v=p[i],k=axis(u,v);if(keys.some(d=>d!==k&&Math.abs(u[d]-v[d])>eps))return;len+=length(u,v);
      const cut=measureSegment(u,v,k,ctx);
      if(cut===Infinity)return;
      topCover+=cut;
    }
    const bends=p.length-2;
    return {p,key,score:len+s*(3.4*planarTurns(p)+.45*bends)+3.4*topCover,len,topCover};
  }
  function consider(points){
    const o=measure(points);
    if(o&&!seen.has(o.key)){seen.add(o.key);offers.push(o);}
  }
  if(!expand&&start.z===end.z&&(start.x===end.x||start.y===end.y)){
    const straight=measure([start,end]);
    if(straight&&straight.topCover===0){
      store.expand=()=>store.fullPaths??=planOffers(worldPlan,ctx,start,end,store,true);
      return [screenCost(straight)];
    }
  }
  const middles=middleShapes(a,b,ctx,s);
  function level(z){
    for(const mid of middles)consider([start,a,{...a,z},...mid.map(p=>({...p,z})),{...b,z},b,end]);
  }
  for(const z of levels)level(z);
  if(!offers.some(o=>o.topCover<eps)){
    // Go over a finite barrier only if a simple same-floor channel cannot
    // clear its footprint. Escape and arrival remain normal to the real rims.
    for(const z of [Math.max(a.z,b.z)+s*.72,Math.min(a.z,b.z)-s*.72])level(z);
  }
  if(!offers.length){
    // Touching or nested slabs can leave no open horizontal distance at an
    // existing socket. Lift vertically there before the normal XY departure.
    const floors=[...new Set(ctx.solid.map(g=>g.center.z))].sort((u,v)=>u-v);
    const detours=[Math.min(a.z,b.z)-s*.34,Math.max(a.z,b.z)+s*.34,floors[0]-s,floors.at(-1)+s];
    floors.slice(1).forEach((h,i)=>detours.push((h+floors[i])/2));
    for(const z of detours){
      for(const mid of middles)consider([start,{...start,z},{...a,z},...mid.map(p=>({...p,z})),{...b,z},{...end,z},end]);
      if(offers.length)break;
    }
  }
  if(!offers.length){
    // Enclosed sockets at different elevations may have disjoint escape
    // levels. Reach free XY space before changing between the two levels.
    const floors=[...new Set(ctx.solid.map(g=>g.center.z))].sort((u,v)=>u-v);
    function escapes(z){
      const below=floors.findLast(h=>h<z-eps),above=floors.find(h=>h>z+eps);
      return [z-Math.min(s*.35,below===undefined?s:(z-below)/2),z+Math.min(s*.35,above===undefined?s:(above-z)/2)];
    }
    for(const z1 of escapes(start.z))for(const z2 of escapes(end.z))for(const mid of middles){
      const trail=[a,...mid,b];
      for(let split=1;split<trail.length;split++){
        const u=trail[split-1],v=trail[split],hinge={x:(u.x+v.x)/2,y:(u.y+v.y)/2};
        consider([start,{...start,z:z1},...trail.slice(0,split).map(p=>({...p,z:z1})),{...hinge,z:z1},
          {...hinge,z:z2},...trail.slice(split).map(p=>({...p,z:z2})),{...end,z:z2},end]);
      }
      if(offers.length)break;
    }
  }
  if(!offers.length){
    const trail=exteriorPassage(shape,start,end,sa,sb);
    const p=compact(trail)??trail.filter((v,i)=>!i||!same(v,trail[i-1]));
    const len=p.slice(1).reduce((sum,v,i)=>sum+length(v,p[i]),0);
    offers.push({p,key:p.map(keyPoint).join('/'),len,topCover:0,score:len+s*(p.length-2)});
  }
  offers.sort((a,b)=>a.score-b.score);
  const best=offers.filter(o=>o.topCover<=offers[0].topCover+s*.15).slice(0,16);
  function screenCost(o){
    const [fit,orbit]=platformExposure(shape,o.p,ctx.related,true);
    o.score+=1.2*(fit+orbit)/2+3.8*titleCost(o.p,worldPlan);
    return o;
  }
  best.forEach(screenCost);
  store.bare=measure;
  if(worldPlan.dense){
    store.surfaces=[...ctx.rects,...[ctx.a,ctx.b].map(g=>({...box(g),onlyZ:g.center.z}))];store.phase=ctx.phase;
  }
  const dynamic=new Map();
  store.measure=points=>{
    const o=measure(points);if(!o||o.topCover>(best[0]?.topCover??0)+eps)return;
    if(dynamic.has(o.key))return dynamic.get(o.key);
    if(dynamic.size>=96)dynamic.delete(dynamic.keys().next().value);
    dynamic.set(o.key,screenCost(o));return o;
  };
  store.grid=(traffic)=>{
    const z=(a.z+b.z)/2;
    const rects=[...ctx.rects,...[ctx.a,ctx.b].filter(g=>Math.abs(g.center.z-z)<eps).map(g=>box(g))];
    const mid=gridPassage(a,b,sa,sb,rects,traffic,s,ctx.phase);
    if(!mid)return;
    return store.measure([start,a,...mid.map(p=>({...p,z})),b,end]);
  };
  return best.sort((a,b)=>a.score-b.score);
}
function projectedSegments(points,projector){
  const ps=projector?points.map(p=>project(p,projector)):points;
  const segments=[];
  for(let i=1;i<ps.length;i++){
    const a=ps[i-1],b=ps[i],dx=b.x-a.x,dy=b.y-a.y;if(Math.abs(dx)+Math.abs(dy)<eps)continue;
    segments.push({x:a.x,y:a.y,dx,dy,l:Math.min(a.x,b.x),r:Math.max(a.x,b.x),t:Math.min(a.y,b.y),b:Math.max(a.y,b.y)});
  }
  return segments;
}
function contact(a,b,overlap){
  let crossing=false,shared=0;
  for(const u of a)for(const v of b){
    if(u.l>v.r+eps||u.r<v.l-eps||u.t>v.b+eps||u.b<v.t-eps)continue;
    const det=u.dx*v.dy-u.dy*v.dx;
    if(Math.abs(det)>eps){
      const dx=v.x-u.x,dy=v.y-u.y,t=(dx*v.dy-dy*v.dx)/det,h=(dx*u.dy-dy*u.dx)/det;
      if(t>eps&&t<1-eps&&h>eps&&h<1-eps){if(!overlap)return [true,0];crossing=true;}
    }else if(overlap){
      if(Math.abs(u.dy)<eps&&Math.abs(u.y-v.y)<eps)shared+=Math.max(0,Math.min(u.r,v.r)-Math.max(u.l,v.l));
      if(Math.abs(u.dx)<eps&&Math.abs(u.x-v.x)<eps)shared+=Math.max(0,Math.min(u.b,v.b)-Math.max(u.t,v.t));
    }
  }
  return [crossing,shared];
}
function congestion(a,b,s){
  const gap=s*.16;
  if(a.maxX+gap<b.minX||b.maxX+gap<a.minX||a.maxY+gap<b.minY||b.maxY+gap<a.minY)return 0;
  a.prices??=new WeakMap();
  const old=a.prices.get(b);if(old!==undefined)return old;
  const [cross,shared]=contact(a.sheet,b.sheet,true);
  let cost=Number(cross)*s*7;
  if(shared>eps)cost+=s*10+shared*6;
  let near=0;
  for(const u of a.sheet)for(const v of b.sheet){
    if(Math.abs(u.dy)<eps&&Math.abs(v.dy)<eps&&Math.abs(u.y-v.y)<gap)
      near=Math.max(near,Math.min(u.r,v.r)-Math.max(u.l,v.l));
    if(Math.abs(u.dx)<eps&&Math.abs(v.dx)<eps&&Math.abs(u.x-v.x)<gap)
      near=Math.max(near,Math.min(u.b,v.b)-Math.max(u.t,v.t));
  }
  if(near>s*.27)cost+=s*2.7+near*.38;
  for(let i=0;i<views.length;i++)if(contact(a.screens[i],b.screens[i],false)[0])cost+=s*.75;
  a.prices.set(b,cost);
  b.prices??=new WeakMap();b.prices.set(a,cost);
  return cost;
}
function prepare(o){
  if(o.sheet)return;
  o.sheet=projectedSegments(o.p);
  o.screens=views.map(v=>projectedSegments(o.p,v));
  o.minX=Math.min(...o.p.map(p=>p.x));o.maxX=Math.max(...o.p.map(p=>p.x));
  o.minY=Math.min(...o.p.map(p=>p.y));o.maxY=Math.max(...o.p.map(p=>p.y));
}
function choose(choices,placed,id,spacing){
  let best,score=Infinity;
  for(const o of choices){
    if(o.score>=score)break;
    let cost=o.score;
    prepare(o);
    for(const [other,p] of placed){
      if(other!==id)cost+=congestion(o,p,spacing);
      if(cost>=score)break;
    }
    if(cost<score){best=o;score=cost;}
  }
  return best;
}
function shiftTracks(current,record,placed,id,s){
  const base=current.p;
  for(let i=1;i<base.length-2;i++){
    const a=base[i],b=base[i+1],k=axis(a,b);
    if(k==='z'||axis(base[i-1],a)==='z'||axis(b,base[i+2])==='z')continue;
    const across=other(k),options=[current],points=current.p;
    if(points.length!==base.length||axis(points[i],points[i+1])!==k)continue;
    for(const width of [-1.2,-.56,-.24,.24,.56,1.2]){
      const shifted=points.slice();
      shifted[i]={...points[i],[across]:points[i][across]+s*width};
      shifted[i+1]={...points[i+1],[across]:points[i+1][across]+s*width};
      const o=record.measure(shifted);if(o)options.push(o);
    }
    current=choose(options.sort((a,b)=>a.score-b.score),placed,id,s);
  }
  return current;
}
export function routeOrthogonalTrunks(publishedWorld,index,lines,role='aggregate',occupiedSummary){
  const worlds=role==='original'?originalWorlds:aggregateWorlds;
  const relations=lines.filter(l=>role==='original'?index.relations.has(l.id):l.kind==='relation');if(!relations.length)return lines;
  const frame=trunkFrame(publishedWorld),world=frame?.plan??publishedWorld;
  let cache=worlds.get(world);
  if(cache?.index!==index){
    cache={index,role,shape:world.shape,captions:captionViews(world.shape),families:new Map(),recent:[],paths:new Map()};
    cache.dense=denseDemands(world,index);
    cache.phases=new Map([...index.relations.keys()].map(id=>{
      let value=2166136261;
      for(let i=0;i<id.length;i++)value=Math.imul(value^id.charCodeAt(i),16777619);
      return [id,(value>>>0)/4294967296];
    }));
    worlds.set(world,cache);
  }
  const rows=relations.map(l=>{
    const a=l.points[0],b=l.points.at(-1);
    return {id:l.id,start:frame?frame.normalize(a):a,end:frame?frame.normalize(b):b};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const reserved=sharedSockets(rows,index,occupiedSummary);
  if(frame)for(const gate of reserved)gate.p=frame.normalize(gate.p);
  const sameRows=(old)=>reserved.length===old.reserved.length&&reserved.every((v,i)=>v.owner===old.reserved[i].owner&&same(v.p,old.reserved[i].p))&&rows.length===old.rows.length&&rows.every((r,i)=>r.id===old.rows[i].id&&same(r.start,old.rows[i].start)&&same(r.end,old.rows[i].end));
  let solved=cache.recent.find(sameRows)?.solved;
  if(!solved){
    solved=new Map();const placed=new Map(),sets=new Map(),seats=socketOccupancy(rows,index,reserved);
    for(const r of rows){
      let ctx=cache.families.get(r.id);
      if(!ctx){ctx=context(world,index.relations.get(r.id));ctx.phase=cache.phases.get(r.id);cache.families.set(r.id,ctx);}
      function record(start,end){
        const variants=cache.paths.get(r.id)??[],old=variants.find(v=>same(v.start,start)&&same(v.end,end));
        if(old)return old;
        const next={id:r.id,start,end};
        next.paths=planOffers(cache,ctx,start,end,next);
        cache.paths.set(r.id,[next,...variants.slice(0,3)]);
        return next;
      }
      let offer=record(r.start,r.end);
      const trafficPrice=(o,priced)=>{
        let cost=0;
        if(!priced){
          const [fit,orbit]=platformExposure(cache.shape,o.p,ctx.related,true);
          cost=1.2*(fit+orbit)/2+3.8*titleCost(o.p,cache);
        }
        if(!cache.dense){
          prepare(o);
          for(const peer of placed.values())cost+=congestion(o,peer,cache.shape.spacing);
        }
        return cost;
      };
      const pick=selectPlatformSockets(world,index,ctx,r,offer,seats,cache,measureSegment,trafficPrice);
      if(pick){
        offer=record(pick.start,pick.end);
        const sketch=pick.points&&offer.measure?.(pick.points);
        if(sketch&&!offer.paths.some(p=>p.key===sketch.key))
          offer={...offer,paths:[...offer.paths,sketch].sort((a,b)=>a.score-b.score)};
      }
      const simple=offer.paths.filter(o=>o.topCover<eps&&planarTurns(o.p)<=1);
      if(simple.length){
        const least=Math.min(...simple.map(o=>planarTurns(o.p)));
        offer={...offer,paths:simple.filter(o=>planarTurns(o.p)===least),expand:undefined,grid:undefined,measure:undefined,bare:undefined};
      }
      seats.publish(r,offer.start,offer.end);
      sets.set(r.id,offer);
      if(!cache.dense){
        const chosen=choose(offer.paths,placed,r.id,world.shape.spacing);
        placed.set(r.id,chosen);
      }
    }
    // Revisit earlier commitments once the later traffic is known. Each move
    // must lower the combined static and pairwise costs of the whole drawing.
    if(cache.dense)solved=solveDenseBanks(rows,sets,world.shape.spacing);
    else{
      const loads=[];
      for(const [id,p] of placed){
        const count=[...placed].reduce((n,[peer,q])=>n+Number(peer!==id&&congestion(p,q,world.shape.spacing)>0),0);
        if(count>=3||p.len>1.3*length(sets.get(id).start,sets.get(id).end))loads.push([id,count]);
      }
      const gridIds=new Set(loads.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,Math.ceil(10+Math.sqrt(rows.length))).map(t=>t[0]));
      for(const [id,record] of [...sets].reverse()){
        const current=placed.get(id),space=world.shape.spacing;
        let alternatives=record.paths;
        if(current){
          const traffic=[...placed].filter(([peer])=>peer!==id).map(e=>e[1]);
          const conflicts=traffic.reduce((sum,p)=>sum+Number(congestion(current,p,space)>0),0);
          if(record.expand&&conflicts)alternatives=record.expand();
          if(record.grid&&gridIds.has(id)){
            const extra=record.grid(traffic);
            if(extra){
              const short=[];
              if(extra.p.length<=8)short.push(extra);
              else for(let i=1;i<extra.p.length-4;i++)for(let j=i+3;j<extra.p.length-1;j++){
                const a=extra.p[i],b=extra.p[j];if(a.z!==b.z)continue;
                for(const elbow of [{x:a.x,y:b.y,z:a.z},{x:b.x,y:a.y,z:a.z}]){
                  const o=record.measure([...extra.p.slice(0,i+1),elbow,...extra.p.slice(j)]);
                  if(o&&o.p.length<=8)short.push(o);
                }
              }
              const shortest=Math.min(...alternatives.map(o=>o.len));
              alternatives=[...alternatives,...short.filter(o=>o.len<=1.52*shortest)].sort((a,b)=>a.score-b.score);
            }
          }
        }
        let chosen=choose(alternatives,placed,id,world.shape.spacing);
        if(record.measure&&[...placed].some(([peer,p])=>peer!==id&&congestion(chosen,p,space)>0))
          chosen=shiftTracks(chosen,record,placed,id,space);
        placed.set(id,chosen);
      }
      for(const [id,p] of placed)solved.set(id,p.p);
    }
    cache.recent=[{rows,reserved,solved},...cache.recent.slice(0,2)];
  }
  return lines.map(l=>{
    const path=solved.get(l.id);
    return path?{...l,points:frame?frame.restore(path):path}:l;
  });
}
export function planLayeredLines(world,index,scene,lines){
  if(!lines.some(l=>l.kind==='edge'))return routeOrthogonalTrunks(world,index,lines);
  let first;
  for(const e of scene.edges){
    const r=index.relationOfEdge.get(e.edgeId);if(r===undefined)continue;
    if(first!==undefined&&r!==first){
      lines=planCorridorWorkspace(world,index,scene,lines).lines;
      break;
    }
    first=r;
  }
  return routeOrthogonalTrunks(world,index,lines);
}
