// XY are document coordinates; Z is floor height. A world owns the same
// passages for overview and detailed routes, independently of camera and LOD.
import { facingPassage, separatePassage } from './platformPassages.mjs';
const networks = new WeakMap();
const publishedFlows = new WeakMap();
const bearing = ([yaw,pitch]) => ({
  sin:Math.sin(yaw),cos:Math.cos(yaw),rise:Math.cos(pitch),incline:Math.sin(pitch),
  dx:Math.sin(yaw)/Math.tan(pitch),dy:Math.cos(yaw)/Math.tan(pitch),
});
const bearings = [[-.25,.85], [.8,.63], [-1.1,.98]].map(bearing);
const orbitBearing = bearing([-.922,.626]);
const auditBearings = [...bearings,bearing([.38,1.22]),bearing([-1.85,.48])];
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const length = p => p.slice(1).reduce((n,b,i)=>n+distance(p[i],b),0);
const half = (g,k) => k==='x'?g.halfWidth:g.halfHeight;
const side = k => k==='x'?'y':'x';

// Each platform proposes a parallel passage at each rim. Facing rims
// propose the same mid-gap passage. Cut it at any coplanar blocking slabs
// before a route can use it; finite longitudinal intervals can share lanes.
export function platformCorridors(shape) {
  if(networks.has(shape))return networks.get(shape);
  const groups=shape.groups.filter(g=>g.parent!=null), spacing=shape.spacing;
  const tracks=[],keys=new Set(),levels=new Map();
  for(const g of groups){
    if(!levels.has(g.center.z))levels.set(g.center.z,[]);
    levels.get(g.center.z).push(g);
  }
  for(const [floor,peers] of levels)for(const g of peers)for(const axis of ['x','y']){
    const cross=side(axis),a=g.center[axis],ha=half(g,axis);
    for(const sign of [-1,1]){
      const rim=g.center[cross]+sign*half(g,cross);
      let gap=Infinity;
      for(const other of peers){
        if(g===other||Math.abs(other.center[axis]-a)>ha+half(other,axis)+spacing*.25)continue;
        const clear=sign*(other.center[cross]-rim)-half(other,cross);
        if(clear>0)gap=Math.min(gap,clear);
      }
      const width=Math.min(spacing*.65,gap/2);
      if(width<spacing*.09)continue;
      const center=rim+sign*width;
      const key=[axis,floor,center].join('/');
      if(keys.has(key))continue;
      keys.add(key);
      const cuts=peers.filter(p=>Math.abs(p.center[cross]-center)<half(p,cross)+width*.48)
        .map(p=>[p.center[axis]-half(p,axis)-spacing*.04,p.center[axis]+half(p,axis)+spacing*.04])
        .sort((u,v)=>u[0]-v[0]);
      let start=-Infinity;
      for(const [lo,hi] of [...cuts,[Infinity,Infinity]]){
        if(lo-start>=spacing*.45)tracks.push({axis,cross,center,width,floor,lo:start,hi:lo});
        start=Math.max(start,hi);
      }
    }
  }
  const projected=[...auditBearings,orbitBearing].map(v=>groups.map(g=>({
    id:g.id,x:g.center.x-v.dx*g.center.z,y:g.center.y-v.dy*g.center.z,w:g.halfWidth,h:g.halfHeight,
  })));
  const data={tracks,projected,spacing,foreign:new WeakMap()};networks.set(shape,data);return data;
}

// Under orthographic projection, shearing a segment down to floor zero
// turns the projected platform quadrilaterals back into axis-aligned boxes.
// Count length over each non-root platform; overlapping decks have independent ink.
function overlap(a,b,rects,v,exclude){
  const ax=a.x-v.dx*a.z,ay=a.y-v.dy*a.z,bx=b.x-v.dx*b.z,by=b.y-v.dy*b.z;
  const dx=bx-ax,dy=by-ay;
  const minX=Math.min(ax,bx),maxX=Math.max(ax,bx),minY=Math.min(ay,by),maxY=Math.max(ay,by);
  let span=0;
  const intervals=exclude?[]:undefined;
  for(const r of rects){
    if(maxX<=r.x-r.w||minX>=r.x+r.w||maxY<=r.y-r.h||minY>=r.y+r.h)continue;
    let lo=0,hi=1;
    if(Math.abs(dx)>1e-8){
      const p=(r.x-r.w-ax)/dx,q=(r.x+r.w-ax)/dx;
      lo=Math.max(lo,Math.min(p,q));hi=Math.min(hi,Math.max(p,q));
    }
    if(Math.abs(dy)>1e-8){
      const p=(r.y-r.h-ay)/dy,q=(r.y+r.h-ay)/dy;
      lo=Math.max(lo,Math.min(p,q));hi=Math.min(hi,Math.max(p,q));
    }
    if(hi>lo){if(intervals)intervals.push([lo,hi]);else span+=hi-lo;}
  }
  if(intervals){
    let end=0;
    for(const [lo,hi] of intervals.sort((a,b)=>a[0]-b[0])){span+=Math.max(0,hi-Math.max(end,lo));end=Math.max(end,hi);}
  }
  return span*Math.hypot(v.cos*dx-v.sin*dy,v.incline*(v.sin*dx+v.cos*dy));
}
function exposure(points,net,exclude,sideView=false){
  let rectangles=net.projected;
  if(exclude){
    rectangles=net.foreign.get(exclude);
    if(!rectangles){rectangles=net.projected.map(view=>view.filter(g=>!exclude.has(g.id)));net.foreign.set(exclude,rectangles);}
  }
  return (sideView?[bearings[0],orbitBearing]:exclude?auditBearings:bearings).map((v,j)=>{
    let amount=0;
    for(let i=1;i<points.length;i++)amount+=overlap(points[i-1],points[i],rectangles[sideView&&j?5:j],v,exclude);
    return amount;
  });
}
export function platformExposure(shape,points,exclude,sideView=false){return exposure(points,platformCorridors(shape),exclude,sideView);}
function makeBody(a,b,t,offset,lift){
  const {axis,cross}=t,z=t.floor+lift,across=t.center+offset;
  const dir=Math.sign(b[axis]-a[axis]),run=Math.abs(b[axis]-a[axis]);
  // Sloping feeders keep the common portion straight. Clamp entries to
  // the free longitudinal span, so a rail cannot run through a blocked rim.
  const along=p=>Math.min(t.hi,Math.max(t.lo,p));
  const lead=p=>Math.min(run*.34,Math.hypot(p[cross]-across,p.z-z)*.83);
  const start=along(a[axis]+dir*lead(a)),end=along(b[axis]-dir*lead(b));
  if(dir*(end-start)<run*.22)return;
  return [a,{[axis]:start,[cross]:across,z},{[axis]:end,[cross]:across,z},b];
}
function weighted(values){return .5*values[0]+.25*(values[1]+values[2]);}
const project=(p,v)=>({x:v.cos*p.x-v.sin*p.y,y:v.incline*(v.sin*p.x+v.cos*p.y)-v.rise*p.z});
function projectedSegments(points,v){
  const xy=points.map(p=>project(p,v));
  return xy.slice(1).map((b,i)=>{
    const a=xy[i];
    return {x:a.x,y:a.y,dx:b.x-a.x,dy:b.y-a.y,l:Math.min(a.x,b.x),r:Math.max(a.x,b.x),
      t:Math.min(a.y,b.y),b:Math.max(a.y,b.y)};
  });
}
export function platformFlows(shape,relations,groups){
  if(!relations||shape.groups[0]?.shape!=='plane')return;
  const chords=[],families=new Map();
  function rim(g,other){
    const dx=other.center.x-g.center.x,dy=other.center.y-g.center.y;
    const t=Math.min(dx?g.halfWidth/Math.abs(dx):Infinity,dy?g.halfHeight/Math.abs(dy):Infinity);
    return !Number.isFinite(t)?g.center:{x:g.center.x+t*dx,y:g.center.y+t*dy,z:g.center.z};
  }
  for(const r of relations){
    const a=groups.get(r.sourceSubgraphId),b=groups.get(r.targetSubgraphId);
    if(a&&b){
      chords.push({id:r.id,pts:[rim(a,b),rim(b,a)]});
      const key=JSON.stringify([a.id,b.id].sort());
      families.set(key,(families.get(key)??0)+(r.memberEdgeIds?.length??1));
    }
  }
  const flows=bearings.map(v=>chords.map(c=>({id:c.id,...projectedSegments(c.pts,v)[0]})));
  flows.families=families;
  publishedFlows.set(shape,flows);
  return flows;
}
function conflicts(points,flows,id){
  let count=0;
  for(let i=0;i<bearings.length;i++){
    const segments=projectedSegments(points,bearings[i]);
    for(const s of flows[i]){
      if(s.id===id)continue;
      for(const u of segments){
        if(u.l>s.r||s.l>u.r||u.t>s.b||s.t>u.b)continue;
        const det=u.dx*s.dy-u.dy*s.dx;
        if(Math.abs(det)<1e-7)continue;
        const x=s.x-u.x,y=s.y-u.y,k=(x*s.dy-y*s.dx)/det,h=(x*u.dy-y*u.dx)/det;
        if(k>1e-7&&k<1-1e-7&&h>1e-7&&h<1-1e-7){count+=i===0?2:1;break;}
      }
    }
  }
  return count;
}
function seats(ledger,key){
  let taken=ledger.get(key);
  if(!taken){taken=[];ledger.set(key,taken);}
  return taken;
}
function touches(points,p,r){
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(p.x<Math.min(a.x,b.x)-r||p.x>Math.max(a.x,b.x)+r||
      p.y<Math.min(a.y,b.y)-r||p.y>Math.max(a.y,b.y)+r||
      p.z<Math.min(a.z,b.z)-r||p.z>Math.max(a.z,b.z)+r)continue;
    const x=b.x-a.x,y=b.y-a.y,z=b.z-a.z;
    const t=Math.max(0,Math.min(1,((p.x-a.x)*x+(p.y-a.y)*y+(p.z-a.z)*z)/(x*x+y*y+z*z||1)));
    if((a.x+t*x-p.x)**2+(a.y+t*y-p.y)**2+(a.z+t*z-p.z)**2<r*r)return true;
  }
  return false;
}
export function platformPassage(shape,a,b,direct,ctx,ledger,kind,refs,owners,penetrations){
  if(direct.length!==2||a.z!==b.z||owners[0].center.z!==a.z||owners[1].center.z!==b.z)return direct;
  const passage=facingPassage(owners[0],owners[1],shape.spacing);
  if(!passage)return direct;
  const key=JSON.stringify(owners.map(g=>g.id).sort()),flows=refs??publishedFlows.get(shape);
  const rawBed=kind==='edge'&&flows?.families.get(key)>1 ? 0.18*shape.spacing : 0;
  const radius=shape.spacing*.045;
  return separatePassage(a,b,passage,ledger,rawBed,points=>length(points)<=length(direct)*1.33&&
    !penetrations(points,ctx.obstacles)&&!(shape.nodes??[]).some(n=>touches(points,n.p,radius)&&!touches(direct,n.p,radius)))??direct;
}

// Port allocation and route order are unchanged. Only the open span between
// two mandatory waypoints may enter a pre-planned shared passage.
export function platformTransit(shape,a,b,direct,ctx,ledger,kind,penetrations,id,references){
  const spacing=shape.spacing,run=distance(a,b);
  if(run<spacing*1.1)return direct;
  const net=platformCorridors(shape);
  if(!net.tracks.length)return direct;
  const original=exposure(direct,net),before=weighted(original),oldLength=length(direct);
  if(before<spacing*.18)return direct;
  const shortlist=[];
  for(const t of net.tracks){
    const span=Math.abs(b[t.axis]-a[t.axis]),spread=Math.abs(b[t.cross]-a[t.cross]);
    if(span<Math.max(spacing*.65,spread*.68)||Math.max(a[t.axis],b[t.axis])<t.lo||Math.min(a[t.axis],b[t.axis])>t.hi)continue;
    if(Math.min(Math.abs(t.floor-a.z),Math.abs(t.floor-b.z))>spacing*.9)continue;
    const lateral=Math.abs(a[t.cross]-t.center)+Math.abs(b[t.cross]-t.center);
    if(lateral>span*.85+spacing*.3)continue;
    const body=makeBody(a,b,t,0,(kind==='trunk'?-.08:.08)*spacing);
    if(!body)continue;
    const cost=length(body);
    if(cost>oldLength*1.33||cost<spacing*.5)continue;
    shortlist.push({t,body,cost});
  }
  shortlist.sort((p,q)=>p.cost-q.cost);
  const baseCost=before+.52*oldLength,limit=baseCost-spacing*.055;
  const flows=kind==='trunk'&&(references??publishedFlows.get(shape));
  let oldCross;
  let best,bestCost=limit;
  const bed=(kind==='trunk'?-.08:.08)*spacing;
  for(const item of shortlist.slice(0,8))for(const level of [0,-1,1]){
    const lift=bed+level*spacing*.8;
    const body=level?makeBody(a,b,item.t,0,lift):item.body;
    if(!body)continue;
    const len=level?length(body):item.cost;
    if(len>oldLength*1.33)continue;
    const values=exposure(body,net);
    let cost=weighted(values)+.52*len+spacing*.12;
    if(cost>=bestCost||values[0]>original[0]+spacing*.03)continue;
    if(penetrations(body,ctx.obstacles))continue;
    if(flows){
      oldCross??=conflicts(direct,flows,id);
      const extra=conflicts(body,flows,id)-oldCross;
      if(extra>3)continue;
      cost+=Math.max(0,extra)*spacing*.27;
      if(cost>=bestCost)continue;
    }
    bestCost=cost;best={t:item.t,lift,level};
  }
  if(!best)return direct;
  const {t}=best,occupied=seats(ledger,t),pitch=Math.min(spacing*.16,t.width*.34);
  // Two bed heights separate residual trunks from detailed originals. Within
  // each bed assign different slots to pipes whose longitudinal runs overlap.
  for(const slot of [0,-1,1,-2,2]){
    const body=makeBody(a,b,t,slot*pitch,best.lift);
    if(!body)continue;
    const start=Math.min(body[1][t.axis],body[2][t.axis]),end=Math.max(body[1][t.axis],body[2][t.axis]);
    const seat=best.level*5+slot;
    if(occupied.some(s=>s.p.z===seat&&s.p.x<end&&s.p.y>start))continue;
    if(slot){
      const values=exposure(body,net);
      if(values[0]>original[0]+spacing*.03||weighted(values)+.52*length(body)+spacing*.12>=limit||
        length(body)>1.33*oldLength||penetrations(body,ctx.obstacles)||
        flows&&conflicts(body,flows,id)>oldCross+3)continue;
    }
    const radius=spacing*.045;
    if(shape.nodes?.some(n=>touches(body,n.p,radius)&&!touches(direct,n.p,radius)))continue;
    occupied.push({p:{x:start,y:end,z:seat}});
    return body;
  }
  return direct;
}
