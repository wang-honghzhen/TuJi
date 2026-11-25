import { createSpatialLineRouter,routeIntersections } from './routes.mjs';
import { platformExposure } from './platformCorridors.mjs';
import { actualWaypoints,along,cohorts,crossAt,demandFor,distance3,inFrame,lateral,lerp,pathLength } from './corridorDemand.mjs';
import { clearOfBanks,fanPressure,nearViews,pairPressure,projectedFans,turnCost } from './corridorJunctions.mjs';

const caches=new WeakMap();
const median=xs=>{const a=[...xs].sort((p,q)=>p-q),i=Math.floor(a.length/2);return (a[i]+a[a.length-1-i])/2;};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const createWorldPlan=(world,index)=>({world,index,types:new Map(),recent:new Map(),demand:new Map(),views:new WeakMap(),seen:new WeakMap()});
const exposure=(shape,p,ids)=>platformExposure(shape,p,ids).reduce((a,b)=>a+b,0)/5;
function typeCache(cache,type){
  if(cache.types.has(type))return cache.types.get(type);
  const {world,index}=cache,items=type==='relation'?index.relations.values():index.edgesById.values(),all=[];
  for(const item of items){
    if(type!=='relation'&&index.edgeScopes.get(item.edgeId)!=='cross')continue;
    const r=demandFor(world,index,item,type);if(!r)continue;
    cache.demand.set(r.id,r);all.push(r);
  }
  const result=cohorts(all,world.shape.spacing);cache.types.set(type,result);return result;
}
function evidence(cache,line){
  const known=cache.seen.get(line.points);
  if(known?.id===line.id)return known;
  const r=cache.demand.get(line.id);
  if(!r)return;
  const way=actualWaypoints(line,r);if(!way)return;
  const a=line.points.indexOf(way[r.leg]),b=line.points.lastIndexOf(way[r.leg+1]);
  if(a<0||b<=a)return;
  const out={id:r.id,r,way,a,b,base:line.points.slice(a,b+1)};
  cache.seen.set(line.points,out);return out;
}
function taper(a,b,tangent,exit,lift,strength){
  const len=distance3(a,b),vlen=Math.hypot(tangent.x,tangent.y,tangent.z)||1,sign=exit?1:-1;
  const control={x:(exit?a.x:b.x)+sign*strength*len*tangent.x/vlen,y:(exit?a.y:b.y)+sign*strength*len*tangent.y/vlen,
    z:(exit?a.z:b.z)+sign*strength*len*tangent.z/vlen};
  const direct=lerp(a,b,exit?.78:.22),p=exit?control:direct,q=exit?direct:control;
  const pts=[];
  for(const t of [.25,.5,.75]){
    const u=1-t,w=[u*u*u,3*u*u*t,3*u*t*t,t*t*t];
    pts.push({x:w[0]*a.x+w[1]*p.x+w[2]*q.x+w[3]*b.x,y:w[0]*a.y+w[1]*p.y+w[2]*q.y+w[3]*b.y,
      z:w[0]*a.z+w[1]*p.z+w[2]*q.z+w[3]*b.z+lift*16*t*t*u*u});
  }
  return pts;
}
const diff=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
function pipe(start,end,body,smooth,fromLift=0,toLift=0,strength=.37){
  if(!smooth)return [start,...body,end];
  return [start,...taper(start,body[0],diff(body[1],body[0]),false,fromLift,strength),...body,
    ...taper(body.at(-1),end,diff(body.at(-1),body.at(-2)),true,toLift,strength),end];
}
function nearNode(points,node,r){
  const p=node.p;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(p.x<Math.min(a.x,b.x)-r||p.x>Math.max(a.x,b.x)+r||p.y<Math.min(a.y,b.y)-r||p.y>Math.max(a.y,b.y)+r||
      p.z<Math.min(a.z,b.z)-r||p.z>Math.max(a.z,b.z)+r)continue;
    const x=b.x-a.x,y=b.y-a.y,z=b.z-a.z,t=clamp(((p.x-a.x)*x+(p.y-a.y)*y+(p.z-a.z)*z)/(x*x+y*y+z*z||1),0,1);
    if((a.x+t*x-p.x)**2+(a.y+t*y-p.y)**2+(a.z+t*z-p.z)**2<r*r)return true;
  }
  return false;
}
function physical(shape,r,points,base){
  r.obstacles??=shape.groups.filter(g=>!r.family.has(g));
  let x=Infinity,y=Infinity,z=Infinity,X=-Infinity,Y=-Infinity,Z=-Infinity;
  for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);z=Math.min(z,p.z);
    X=Math.max(X,p.x);Y=Math.max(Y,p.y);Z=Math.max(Z,p.z);}
  const nearby=r.obstacles.filter(g=>g.center.z>=z&&g.center.z<=Z&&g.center.x+g.halfWidth>=x&&
    g.center.x-g.halfWidth<=X&&g.center.y+g.halfHeight>=y&&g.center.y-g.halfHeight<=Y);
  if(routeIntersections(points,nearby))return false;
  const radius=shape.spacing*.045;
  return !shape.nodes.some(n=>n.p.x>=x-radius&&n.p.x<=X+radius&&n.p.y>=y-radius&&n.p.y<=Y+radius&&
    n.p.z>=z-radius&&n.p.z<=Z+radius&&n.id!==r.source&&n.id!==r.target&&nearNode(points,n,radius)&&!nearNode(base,n,radius));
}
function shapePoints(plan,offset){
  const {u0,u1,v0,v1,z,bend,d}=plan,result=[];
  const fractions=bend?[0,.25,.5,.75,1]:[0,1];
  for(const t of fractions){const u=(1-t)*u0+t*u1,v=(1-t)*v0+t*v1+bend*4*t*(1-t)+offset;
    result.push(inFrame(u,v,z,d));}
  return result;
}
function order(frames){
  // Rank aggregation minimizes disagreements at the two ends. For a pair
  // ordered alike on both sides, their order can never be reversed here.
  const rank=key=>new Map([...frames].sort((a,b)=>a[key]-b[key]||a.r.id.localeCompare(b.r.id)).map((f,i)=>[f.r.id,i]));
  const left=rank('start'),right=rank('end');
  return [...frames].sort((a,b)=>left.get(a.r.id)+right.get(a.r.id)-left.get(b.r.id)-right.get(b.r.id)||
    left.get(a.r.id)-left.get(b.r.id)||a.r.id.localeCompare(b.r.id));
}
function candidates(group,shape){
  const {frames,d,begin,end,spacing}=group,span=end-begin,pitch=Math.min(spacing*.39,span*.09);
  const u0=begin+span*.18,u1=end-span*.18;
  const start=median(frames.map(f=>crossAt(f,u0))),finish=median(frames.map(f=>crossAt(f,u1)));
  const z0=median(frames.map(f=>(f.a.z+f.b.z)/2)),center=(start+finish)/2,mid=(u0+u1)/2;
  const shifts=new Set([0,-spacing*.65,spacing*.65]),bends=new Set([0]);
  for(const g of shape.groups){
    if(g.parent===null||Math.abs(g.center.z-z0)>spacing*1.5)continue;
    const gu=along(g.center,d),gv=lateral(g.center,d),du=Math.abs(d.x)*g.halfWidth+Math.abs(d.y)*g.halfHeight;
    if(gu+du<u0||gu-du>u1)continue;
    const dv=Math.abs(d.y)*g.halfWidth+Math.abs(d.x)*g.halfHeight,clearance=(frames.length*.5)*pitch+spacing*.12;
    for(const s of [gv-dv-clearance-center,gv+dv+clearance-center]){
      if(Math.abs(s)>span*.28||Math.abs(s)>spacing*4)continue;
      shifts.add(s);if(Math.abs(gu-mid)<.23*span)bends.add(s);
    }
  }
  const plans=[];
  for(const shift of [...shifts].sort((a,b)=>Math.abs(a)-Math.abs(b)).slice(0,6))for(const h of [0,-.66,.66,-1.32,1.32]){
    plans.push({u0,u1,v0:start+shift,v1:finish+shift,z:z0+h*spacing,d,pitch,bend:0});
  }
  for(const bend of [...bends].filter(v=>v!==0).sort((a,b)=>Math.abs(a)-Math.abs(b)).slice(0,3))
    for(const h of [0,-.5,.5])plans.push({u0,u1,v0:start,v1:finish,z:z0+h*spacing,d,pitch,bend});
  return plans;
}
function choose(group,shape){
  const ordered=order(group.frames),n=ordered.length;
  const originals=ordered.map(f=>[f.a,f.b]),oldLength=originals.reduce((s,p)=>s+pathLength(p),0);
  const oldCoverage=originals.reduce((s,p,i)=>s+exposure(shape,p,ordered[i].r.familyIds),0);
  // Score the entire bank together, with all canonical endpoints attached
  // and the two outer rails in their true positions. No single member can
  // choose a private trunk and call the result a common passage.
  const offers=[];
  for(const plan of candidates(group,shape)){
    let len=0,cover=0,valid=true;
    for(let i=0;i<n;i++){
      const f=ordered[i],body=shapePoints(plan,(i-(n-1)/2)*plan.pitch),points=pipe(f.a,f.b,body,false);
      const length=pathLength(points);
      if(length>pathLength(originals[i])*1.3||!physical(shape,f.r,points,originals[i])){valid=false;break;}
      len+=length;cover+=exposure(shape,points,f.r.familyIds);
    }
    if(!valid||cover>oldCoverage*1.09+shape.spacing*n*.16)continue;
    const value=cover+.88*len+Math.abs(plan.bend)*n*.12;
    offers.push({...plan,ordered,score:value});
  }
  return offers.sort((a,b)=>a.score-b.score);
}
function drawMember(shape,plan,f,index,record,line,mode,options={}){
  const n=plan.ordered.length,slot=index-(n-1)/2,offset=mode==='bundle'?0:slot*plan.pitch;
  const orig=record.base,reverse=f.reverse;
  const a=orig[reverse?orig.length-1:0],b=orig[reverse?0:orig.length-1];
  const body=shapePoints(plan,offset);
  if(along(a,plan.d)>plan.u0||along(b,plan.d)<plan.u1)return;
  record.baseLength??=pathLength(orig);record.oldCover??=exposure(shape,orig,f.r.familyIds);
  const path=pipe(a,b,body,mode==='junctions',options.from,options.to,options.strength);
  const len=pathLength(path),cover=exposure(shape,path,f.r.familyIds);
  if(len>record.baseLength*1.3||!physical(shape,f.r,path,orig)||cover>record.oldCover*1.13+shape.spacing*.42)return;
  const traversal=reverse?[...path].reverse():path,realBody=reverse?[...body].reverse():body;
  return {gain:record.oldCover-cover,points:[...line.points.slice(0,record.a),...traversal,...line.points.slice(record.b+1)],len,cover,path,
    input:projectedFans(path.slice(0,path.indexOf(body[0])+1)),exit:projectedFans(path.slice(path.lastIndexOf(body.at(-1)))),
    lane:{id:line.id,slot,source:f.r.source,target:f.r.target,entry:realBody[0],exit:realBody.at(-1),body:realBody}};
}
function jointJunctions(cache,p,visible,byId,stats){
  const {world}=cache,refs=visible.map(f=>byId.get(f.r.id).points);
  const saved=p.last?.find(s=>s.refs.length===refs.length&&refs.every((v,i)=>v===s.refs[i]));
  if(saved){stats.reused+=refs.length;return saved.drawn;}
  stats.recomputed+=refs.length;
  // Slots of invisible relatives are retained. Optimize the assignment within
  // the active slot set; a changed cohort cannot reorder a remote corridor.
  const slots=p.ordered.map((f,i)=>visible.includes(f)?i:-1).filter(i=>i>=0);
  const data=slots.map(i=>{const f=p.ordered[i],line=byId.get(f.r.id);return {f,line,rec:evidence(cache,line)};});
  const staged=data.map(q=>slots.map(slot=>q.rec&&drawMember(world.shape,p,q.f,slot,q.rec,q.line,'junctions')));
  const s=world.shape.spacing;
  const self=v=>v?2.5*v.cover/s+.8*v.len/s+.55*turnCost(v.path):1e5;
  const quality=perm=>{
    let val=0;
    for(let i=0;i<perm.length;i++){
      const v=staged[i][perm[i]];val+=self(v);if(!v)continue;
      for(let j=0;j<i;j++){const w=staged[j][perm[j]];if(w)val+=4*fanPressure(v,w);}
    }
    return val;
  };
  let perm=slots.map((_,i)=>i),score=quality(perm);
  for(let pass=0;pass<2;pass++){
    let improved=false;
    for(let i=0;i<perm.length;i++)for(let j=i+1;j<perm.length;j++){
      const trial=[...perm];[trial[i],trial[j]]=[trial[j],trial[i]];
      // Keep every unambiguous pair in the same order on both sides.
      if(trial.some((v,k)=>trial.some((w,h)=>k<h&&v>w&&data[k].f.start<=data[h].f.start&&data[k].f.end<=data[h].f.end)))continue;
      const candidate=quality(trial);if(candidate>=score-1e-7)continue;
      perm=trial;score=candidate;improved=true;
    }
    if(!improved)break;
  }
  const picked=perm.map((j,i)=>staged[i][j]);
  for(let i=0;i<picked.length;i++){
    const q=data[i],current=picked[i];if(!current)continue;
    const peers=picked.filter((v,j)=>j!==i&&v),traffic=v=>peers.reduce((n,w)=>n+fanPressure(v,w),0);
    const pre=traffic(current);if(!pre)continue;
    let best=self(current)+4*pre;
    for(const cfg of [{strength:.17},{strength:.58},{from:.45*s},{from:-.45*s},{to:.45*s},{to:-.45*s}]){
      const v=drawMember(world.shape,p,q.f,slots[perm[i]],q.rec,q.line,'junctions',cfg);if(!v)continue;
      const now=traffic(v),cost=self(v)+4*now;
      if(now<=pre&&cost<best-1e-7){best=cost;picked[i]=v;}
    }
  }
  const drawn=picked.filter(Boolean);
  // A group with substantially worse visibility or extra projected crossings
  // need not join a corridor merely because its directions are similar.
  if(drawn.length>1){
    let oldPressure=0,newPressure=0,oldCover=0,newCover=0;
    const existing=[],proposed=[];
    for(let i=0;i<picked.length;i++)if(picked[i]){
      const rec=data[i].rec;
      existing.push(projectedFans(rec.base));proposed.push(projectedFans(picked[i].path));
      oldCover+=rec.oldCover;newCover+=picked[i].cover;
    }
    for(let i=0;i<existing.length;i++)for(let j=0;j<i;j++){
      oldPressure+=pairPressure(existing[i],existing[j]);newPressure+=pairPressure(proposed[i],proposed[j]);
    }
    if(newCover>oldCover+s*.025*drawn.length||newPressure>oldPressure+2.1*drawn.length)drawn.length=0;
  }
  p.last=[{refs,drawn},...(p.last??[]).slice(0,1)];
  return drawn;
}
function view(cache,points){
  let p=cache.views.get(points);if(!p){p=projectedFans(points);cache.views.set(points,p);}return p;
}
function screenableLanes(cache,plan,drawn,lines,activePaths,stats){
  const own=new Set(drawn.map(v=>v.lane.id)),old=[],next=[],near=[];
  for(const v of drawn){old.push(view(cache,activePaths.get(v.lane.id)));next.push(view(cache,v.points));}
  for(const l of lines){
    if(own.has(l.id))continue;
    const p=activePaths.get(l.id),v=view(cache,p);
    if(old.some(o=>nearViews(o,v))||next.some(n=>nearViews(n,v)))near.push(p);
  }
  const saved=plan.guard;
  if(saved?.drawn===drawn&&near.length===saved.near.length&&near.every((p,i)=>p===saved.near[i]))return saved.lanes;
  stats.neighborhoodChecks++;
  // A single diverging request can spoil a useful trunk. Compare the entire
  // visible neighbourhood, removing only the most expensive participant; a
  // removed line retains its original geometry in every subsequent comparison.
  const external=drawn.map((v,i)=>near.reduce((n,points)=>{
    const other=view(cache,points);return n+pairPressure(next[i],other)-pairPressure(old[i],other);
  },0));
  const delta=drawn.map((v,i)=>drawn.map((w,j)=>{
    if(i===j)return [0,0];
    const baseline=pairPressure(old[i],old[j]);
    return [pairPressure(next[i],old[j])-baseline,pairPressure(next[i],next[j])-baseline];
  }));
  const indices=drawn.map((_,i)=>i);
  function cost(kept){
    const mask=new Set(kept);let extra=0,gain=0;
    for(const i of kept){
      extra+=external[i];gain+=drawn[i].gain;
      for(let j=0;j<drawn.length;j++){
        if(!mask.has(j))extra+=delta[i][j][0];
        else if(i<j)extra+=delta[i][j][1];
      }
    }
    const sideGain=plan.sideView?Math.min(...[0,1].map(k=>kept.reduce((s,i)=>s+drawn[i].sideGain[k],0))):0;
    const allowance=plan.sideView?Math.min(4.2*kept.length,Math.max(0,gain,sideGain)/cache.world.shape.spacing*4.5):
      Math.min(2.25*kept.length,Math.max(0,gain)/cache.world.shape.spacing*1.4);
    return Math.max(extra-allowance-2.1,-gain/cache.world.shape.spacing-.03*kept.length);
  }
  let kept=indices;
  while(kept.length>=2&&cost(kept)>0){
    let best,score=Infinity;
    for(const remove of kept){
      const subset=kept.filter(i=>i!==remove),value=cost(subset);
      if(value<score){best=subset;score=value;}
    }
    kept=best;
  }
  const lanes=kept.length>=2?kept.map(i=>drawn[i]):[];
  plan.guard={drawn,near,lanes};return lanes;
}
// For a small shared bank only, two fixed operational bearings can reveal a
// large near-side obstruction hidden by an improvement at grazing bearings.
// Search alternative entry/exit depths only when the current plan regresses.
function sideGains(shape,members,records){
  return members.reduce((total,m)=>{
    const rec=records.get(m.lane.id);
    rec.sideCover??=platformExposure(shape,rec.base,rec.r.familyIds,true);
    const cover=platformExposure(shape,m.path,rec.r.familyIds,true);
    m.sideGain=cover.map((v,k)=>rec.sideCover[k]-v);
    return total.map((v,k)=>v+m.sideGain[k]);
  },[0,0]);
}
function refinePassage(cache,p,members,group,byId,background,activePaths,occupied,stats){
  if(p.ordered.length!==2||members.length!==2)return;
  const shape=cache.world.shape,s=shape.spacing;
  const records=new Map(members.map(m=>[m.lane.id,evidence(cache,byId.get(m.lane.id))]));
  if(Math.min(...sideGains(shape,members,records))>=-s*.23)return;
  if(!group.sidePlans){
    const plans=[],span=group.end-group.begin;
    for(const [front,back] of [[.18,.18],[.10,.27],[.27,.10],[.12,.12],[.25,.25]]){
      const u0=group.begin+span*front,u1=group.end-span*back;
      const start=median(group.frames.map(f=>crossAt(f,u0))),end=median(group.frames.map(f=>crossAt(f,u1)));
      const z=median(group.frames.map(f=>(f.a.z+f.b.z)/2));
      const shifts=front===.18?[[0,0],[-.7,0],[.7,0],[0,-.7]]:[[0,0]];
      for(const [left,right] of shifts)
        for(const lift of [0,-.85,.85,1.8,-1.8]){
          plans.push({u0,u1,v0:start+left*s,v1:end+right*s,z:z+lift*s,d:group.d,pitch:p.pitch,bend:0,ordered:p.ordered,sideView:true});
        }
    }
    group.sidePlans=plans;
  }
  let best;
  let checked=0;
  for(const candidate of group.sidePlans){
    candidate.bodies??=candidate.ordered.map((_,i)=>shapePoints(candidate,(i-.5)*candidate.pitch));
    if(!clearOfBanks(candidate.bodies,occupied,s*.27))continue;
    checked++;
    const drawn=jointJunctions(cache,candidate,group.frames,byId,stats);
    if(drawn.length!==2)continue;
    const gains=sideGains(shape,drawn,records);
    if(Math.min(...gains)<-s*.04)continue;
    const score=Math.min(...gains)+.3*Math.max(...gains)-.06*(drawn[0].len+drawn[1].len);
    if(best&&score<=best.score)continue;
    const accepted=screenableLanes(cache,candidate,drawn,background,activePaths,stats);
    if(accepted.length===2)best={p:candidate,lanes:accepted,score};
    if(best&&(checked>=16||Math.min(...gains)>s*1.2))break;
  }
  return best;
}
const versionsByMode=['baseline','independent','bundle','lanes','junctions'];
export function planCorridorWorkspace(world,index,scene,baselineLines,mode='junctions'){
  if(!versionsByMode.includes(mode))throw Error('Unknown corridor mode '+mode);
  const stats={channelCandidates:0,changed:0,recomputed:0,reused:0,neighborhoodChecks:0};
  if(mode==='baseline'||world.shape.groups[0]?.shape!=='plane')return {lines:baselineLines,channels:[],stats};
  let cache=caches.get(world);
  if(cache?.index!==index){cache=createWorldPlan(world,index);caches.set(world,cache);}
  const replacement=new Map(),channels=[],occupied=[];
  for(const type of ['relation','edge']){
    const background=baselineLines.filter(l=>l.kind===type&&(type==='relation'||index.relationOfEdge.has(l.id)));
    if(!background.length)continue;
    if(mode!=='independent'&&background.length<2)continue;
    // When just one relation is disclosed there is no call for a global
    // cross-platform corridor. The existing local router already separates
    // parallel members of the same two owners.
    if(type==='edge'&&mode!=='independent'){
      const first=index.relationOfEdge.get(background[0].id);
      if(background.every(l=>index.relationOfEdge.get(l.id)===first))continue;
    }
    const byId=new Map(background.map(l=>[l.id,l]));
    const key=type+'/'+mode,history=cache.recent.get(key)??[];
    const previous=history.find(v=>v.refs.length===background.length&&v.prior.length===occupied.length&&
      v.prior.every((bank,i)=>bank===occupied[i])&&v.refs.every(([id,points],i)=>id===background[i].id&&points===background[i].points));
    if(previous){
      for(const [id,points] of previous.replacements)replacement.set(id,points);
      channels.push(...previous.channels);occupied.push(...previous.banks);
      stats.reused+=previous.replacements.length;continue;
    }
    const start=channels.length,prior=[...occupied];
    const groups=typeCache(cache,type);
    if(mode==='independent'){
      for(const line of baselineLines){
        if(line.kind!==type)continue;
        const rec=evidence(cache,line);if(!rec)continue;
        cache.router??=createSpatialLineRouter(world.shape);
        rec.independent??=cache.router.independent(rec.r.from,rec.r.to,rec.way);
        replacement.set(line.id,rec.independent);
      }
      continue;
    }
    const activePaths=new Map(background.map(l=>[l.id,l.points]));
    for(const group of groups){
      const actual=group.frames.filter(f=>byId.has(f.r.id));if(actual.length<2)continue;
      stats.channelCandidates++;
      group.plans??=choose(group,world.shape);
      let attempts=0;
      for(let p of group.plans){
        p.bodies??=p.ordered.map((_,i)=>shapePoints(p,(i-(p.ordered.length-1)/2)*p.pitch));
        if(mode!=='bundle'&&!clearOfBanks(p.bodies,occupied,world.shape.spacing*.27))continue;
        if(++attempts>8)break;
        let lanes=mode==='junctions'?jointJunctions(cache,p,actual,byId,stats):[];
        if(mode!=='junctions')for(let i=0;i<p.ordered.length;i++){
          const f=p.ordered[i],line=byId.get(f.r.id);if(!line)continue;
          const rec=evidence(cache,line);if(!rec)continue;
          rec.plans??=new WeakMap();if(!rec.plans.has(p))rec.plans.set(p,new Map());const modes=rec.plans.get(p);
          if(!modes.has(mode)){modes.set(mode,drawMember(world.shape,p,f,i,rec,line,mode)??null);stats.recomputed++;}
          else stats.reused++;
          const draw=modes.get(mode);if(draw)lanes.push(draw);
        }
        if(lanes.length<2)continue;
        if(mode==='junctions')lanes=screenableLanes(cache,p,lanes,background,activePaths,stats);
        if(lanes.length<2)continue;
        if(mode==='junctions'){
          const improved=refinePassage(cache,p,lanes,group,byId,background,activePaths,occupied,stats);
          if(improved){p=improved.p;lanes=improved.lanes;}
        }
        if(mode!=='bundle')occupied.push(p.bodies);
        lanes.forEach(v=>replacement.set(v.lane.id,v.points));
        lanes.forEach(v=>activePaths.set(v.lane.id,v.points));
        channels.push({id:group.id,spine:shapePoints(p,0),width:p.pitch*p.ordered.length,
          lanes:lanes.map(v=>v.lane)});
        break;
      }
    }
    if(mode==='junctions'){
      const delta=channels.slice(start);
      cache.recent.set(key,[{refs:background.map(l=>[l.id,l.points]),prior,banks:occupied.slice(prior.length),channels:delta,
        replacements:delta.flatMap(c=>c.lanes.map(l=>[l.id,replacement.get(l.id)]))},...history.slice(0,2)]);
    }
  }
  stats.changed=replacement.size;
  const lines=replacement.size?baselineLines.map(l=>replacement.has(l.id)?{...l,points:replacement.get(l.id)}:l):baselineLines;
  return {lines,channels,stats};
}
