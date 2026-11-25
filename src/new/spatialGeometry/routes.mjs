// XY is the horizontal canvas. Z is height. Projection and scoring cameras are
// identical for both organizations, and never depend on the live camera.
import { PortLedger } from './portLedger.mjs';
import { platformFlows, platformPassage, platformTransit } from './platformCorridors.mjs';

export const referenceAngles = [[-.25,.85],[.8,.63],[-1.1,.98]];
export const measurementAngles = [...referenceAngles,[.38,1.22],[-1.85,.48]];
const epsilon=1e-7;
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const mul=(a,n)=>({x:a.x*n,y:a.y*n,z:a.z*n});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const norm=a=>Math.hypot(a.x,a.y,a.z);
const unit=a=>mul(a,1/(norm(a)||1));
const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const distance=(a,b)=>norm(sub(a,b));
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mean=ps=>mul(ps.reduce(add,{x:0,y:0,z:0}),1/ps.length);
const clean=ps=>ps.filter((p,i)=>!i||distance(p,ps[i-1])>epsilon);
const length=ps=>ps.slice(1).reduce((n,p,i)=>n+distance(ps[i],p),0);
const axes=[{x:0,y:0,z:1},{x:1,y:0,z:0},{x:0,y:1,z:0}];
function tangentFrame(normal) {
  const anchor=axes.reduce((v,w)=>Math.abs(dot(w,normal))<Math.abs(dot(v,normal))?w:v);
  const t=unit(cross(normal,anchor));
  return [t,cross(normal,t)];
}
function chain(group,groups) {
  const ids=[];
  for(let g=group;g;g=groups.get(g.parent))ids.push(g.id);
  return ids;
}
function context(layout,a,b,groups) {
  const aa=chain(groups.get(a),groups), bb=chain(groups.get(b),groups);
  const lca=aa.find(id=>bb.includes(id)), family=new Set([...aa,...bb]);
  const exits=aa.slice(0,aa.indexOf(lca)), entries=bb.slice(0,bb.indexOf(lca));
  return {lca:groups.get(lca),exits,entries,obstacles:layout.groups.filter(g=>!family.has(g.id))};
}

// Interior parameter interval along a segment. Tangency alone never counts.
// For a platform we test its finite horizontal surface (including a coplanar
// through-path), for a sphere its entire interior.
function hit(a,b,g) {
  const c=g.center;
  if(g.shape==='sphere') {
    const d=sub(b,a), v=sub(a,c), dd=dot(d,d);
    if(dd<epsilon)return;
    const k=dot(v,d), discriminant=k*k-dd*(dot(v,v)-g.radius*g.radius);
    if(discriminant<=epsilon*dd)return;
    const root=Math.sqrt(discriminant),lo=Math.max(0,(-k-root)/dd),hi=Math.min(1,(-k+root)/dd);
    if(hi-lo>epsilon)return [lo,hi];
    return;
  }
  const dz=b.z-a.z;
  if(Math.abs(dz)>epsilon) {
    const t=(c.z-a.z)/dz;
    if(t<0||t>1)return;
    const x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
    if(Math.abs(x-c.x)<g.halfWidth-epsilon && Math.abs(y-c.y)<g.halfHeight-epsilon)return [t,t];
    return;
  }
  if(Math.abs(a.z-c.z)>epsilon)return;
  let lo=0,hi=1;
  for(const [key,half] of [['x',g.halfWidth],['y',g.halfHeight]]) {
    const d=b[key]-a[key], v=a[key]-c[key];
    if(Math.abs(d)<epsilon){if(Math.abs(v)>=half-epsilon)return;continue;}
    const t=(-half-v)/d,s=(half-v)/d;
    lo=Math.max(lo,Math.min(t,s));hi=Math.min(hi,Math.max(t,s));
  }
  if(hi-lo>epsilon)return [lo,hi];
}
function entries(points,obstacles) {
  let count=0;
  for(const g of obstacles) {
    let previousExit=-Infinity;
    for(let i=1;i<points.length;i++){
      const interval=hit(points[i-1],points[i],g);
      if(!interval)continue;
      if(i-1+interval[0]>previousExit+epsilon)count++;
      previousExit=i-1+interval[1];
    }
  }
  return count;
}
function port(group,origin,aim,occupied) {
  const c=group.center, delta=sub(aim,origin);
  if(norm(delta)<epsilon)delta.x=1;
  const candidates=[];
  let scale;
  if(group.shape==='sphere') {
    const n=unit(delta), inside=sub(origin,c), radius=group.radius;
    const b=dot(inside,n), t=-b+Math.sqrt(Math.max(0,b*b+radius*radius-dot(inside,inside)));
    let bearing=unit(add(inside,mul(n,Math.max(0,t))));
    if(norm(bearing)<.5)bearing=n;
    const [u,v]=tangentFrame(bearing);
    for(const [x,y] of [[0,0],[.10,0],[-.10,0],[0,.10],[0,-.10],[.16,.12],[-.16,.12],[.16,-.12],[-.16,-.12]]) {
      candidates.push(add(c,mul(unit(add(bearing,add(mul(u,x),mul(v,y)))),radius)));
    }
    scale=radius;
  } else {
    const dx=delta.x,dy=delta.y;
    const x=clamp(origin.x,c.x-group.halfWidth,c.x+group.halfWidth),y=clamp(origin.y,c.y-group.halfHeight,c.y+group.halfHeight);
    const tx=Math.abs(dx)<epsilon?Infinity:(c.x+Math.sign(dx)*group.halfWidth-x)/dx;
    const ty=Math.abs(dy)<epsilon?Infinity:(c.y+Math.sign(dy)*group.halfHeight-y)/dy;
    const vertical=tx<=ty, along=vertical?'y':'x', half=vertical?group.halfHeight:group.halfWidth;
    const t=Math.min(tx,ty);
    const p={x:vertical?c.x+(Math.sign(dx)||1)*group.halfWidth:x+(Number.isFinite(t)?t*dx:0),
      y:vertical?y+(Number.isFinite(t)?t*dy:0):c.y+(Math.sign(dy)||1)*group.halfHeight,z:c.z};
    for(const offset of [0,.10,-.10,.20,-.20,.30,-.30,.42,-.42]) {
      candidates.push({...p,[along]:clamp(p[along]+half*offset,c[along]-.97*half,c[along]+.97*half)});
    }
    scale=half;
  }
  // Steer toward the other owner. Closely aligned connections compete for
  // seats only on this boundary. Denser traffic therefore fans out farther.
  const gap=.085*scale;
  const cost=p=>occupied.reduce((n,s)=>n+2*Math.max(0,1-distance(s.p,p)/gap),0)+distance(p,candidates[0])/scale;
  let best=candidates[0],bestCost=cost(best);
  for(const p of candidates.slice(1)){const score=cost(p);if(score<bestCost){best=p;bestCost=score;}}
  return best;
}

// Take the shorter tangent-arc-tangent path around a sphere (and try the
// opposite side if it is crowded). Sample the clearance shell finely enough
// that the straight chords between samples stay outside the actual obstacle.
function aroundSphere(a,b,g) {
  const ca=sub(a,g.center),cb=sub(b,g.center),ra=norm(ca),rb=norm(cb);
  const clearance=Math.min(.02*g.radius,(Math.min(ra,rb)-g.radius)/2);
  if(clearance<=epsilon)return [];
  const radius=g.radius+clearance, u=unit(ca), v=unit(cb), c=clamp(dot(u,v),-1,1);
  const side=sub(v,mul(u,c)), tangent=norm(side)>epsilon?unit(side):tangentFrame(u)[0];
  const angle=Math.acos(c),start=Math.acos(radius/ra),end=Math.acos(radius/rb);
  const maxStep=1.85*Math.acos(g.radius/radius), alternatives=[];
  for(const [sign,sweep] of [[1,angle],[-1,Math.PI*2-angle]]) {
    const arc=sweep-start-end;
    if(arc<=0)continue;
    const steps=Math.ceil(arc/maxStep);
    if(steps>96)continue;
    const path=[];
    for(let i=0;i<=steps;i++){
      const w=sign*(start+arc*i/steps);
      path.push(add(g.center,mul(add(mul(u,Math.cos(w)),mul(tangent,Math.sin(w))),radius)));
    }
    alternatives.push(path);
  }
  return alternatives;
}

// Repair a physical penetration by comparing short detours on opposite sides
// of the first obstacle. Never trade one original entry for more new entries.
function clearSegment(a,b,ctx) {
  const initial=[a,b], initialEntries=entries(initial,ctx.obstacles);
  if(!initialEntries)return initial;
  let best=initial,remaining=initialEntries;
  for(let pass=0;pass<3&&remaining;pass++) {
    let chosen=best, bestCount=remaining, bestLength=Infinity;
    for(let i=1;i<best.length;i++) {
      const start=best[i-1],end=best[i];
      const intersections=ctx.obstacles.map(g=>[g,hit(start,end,g)]).filter(([,v])=>v).sort((p,q)=>p[1][0]-q[1][0]);
      if(!intersections.length)continue;
      const [g,span]=intersections[0], d=sub(end,start), direction=unit(d);
      const u=add(start,mul(d,span[0])),v=add(start,mul(d,span[1]));
      const dirs=g.shape==='sphere'?tangentFrame(direction):axes;
      const detours=g.shape==='sphere'?aroundSphere(start,end,g):[];
      for(const dir of dirs)for(const sign of [1,-1]) {
        const size=g.shape==='sphere'?g.radius:Math.abs(dir.z)>.5?Math.min(g.halfWidth,g.halfHeight)*.14:
          Math.abs(dir.x)*g.halfWidth+Math.abs(dir.y)*g.halfHeight;
        const side=mul(dir,sign),clearance=1.10*size;
        const outside=p=>add(p,mul(side,Math.max(0,clearance-dot(sub(p,g.center),side))));
        detours.push(clean([outside(u),outside(v)]));
      }
      for(const detour of detours) {
        if(ctx.lca?.shape==='sphere'&&detour.some(p=>distance(p,ctx.lca.center)>ctx.lca.radius+epsilon))continue;
        const candidate=clean([...best.slice(0,i),...detour,...best.slice(i)]);
        const count=entries(candidate,ctx.obstacles), len=length(candidate);
        if(count<remaining && (count<bestCount||count===bestCount&&len<bestLength)){
          chosen=candidate;bestCount=count;bestLength=len;
        }
      }
    }
    if(chosen===best)break;
    best=chosen;remaining=bestCount;
  }
  return best;
}
function clearPath(points,ctx) {
  const result=[points[0]];
  for(let i=1;i<points.length;i++)result.push(...clearSegment(points[i-1],points[i],ctx).slice(1));
  return clean(result);
}

function platformPath(points,ctx,shape,ledger,kind,id,flows,pair,central) {
  const output=[points[0]];
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],direct=clearSegment(a,b,ctx);
    // Preserve the local connection between a knowledge point and its own
    // deck rim. Transit begins after that gate or across an actual level gap.
    const insideLead=kind==='edge'&&(i===1||i===points.length-1)&&a.z===b.z;
    let segment=insideLead||!ctx.obstacles.length?direct:platformTransit(shape,a,b,direct,ctx,ledger,kind,entries,id,flows);
    if(i===central&&segment===direct&&pair)segment=platformPassage(shape,a,b,direct,ctx,ledger,kind,flows,pair,entries);
    output.push(...segment.slice(1));
  }
  return clean(output);
}

const branchContexts=new WeakMap();
export function routePlatformBranch(shape,ownerId,nodePoint,portPoint){
  let owners=branchContexts.get(shape);
  if(!owners){owners=new Map();branchContexts.set(shape,owners);}
  if(!owners.has(ownerId)){
    const groups=new Map(shape.groups.map(g=>[g.id,g]));
    const owner=groups.get(ownerId),ctx=context(shape,ownerId,ownerId,groups);
    // A chord between two points on a rectangular deck stays inside its
    // convex footprint. Only coplanar decks actually overlapping it can obstruct it.
    const coplanar=ctx.obstacles.filter(g=>g.center.z===owner.center.z&&
      Math.abs(g.center.x-owner.center.x)<g.halfWidth+owner.halfWidth&&
      Math.abs(g.center.y-owner.center.y)<g.halfHeight+owner.halfHeight);
    owners.set(ownerId,{ctx,owner,local:{...ctx,obstacles:coplanar}});
  }
  const {ctx,owner,local}=owners.get(ownerId);
  const inside=p=>p.z===owner.center.z&&Math.abs(p.x-owner.center.x)<=owner.halfWidth+epsilon&&
    Math.abs(p.y-owner.center.y)<=owner.halfHeight+epsilon;
  return clearSegment(nodePoint,portPoint,inside(nodePoint)&&inside(portPoint)?local:ctx);
}
function projected(stroke,[yaw,pitch]) {
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const points=stroke.points.map(p=>({x:cy*p.x-sy*p.y,y:sp*(sy*p.x+cy*p.y)-cp*p.z}));
  const box=(a,b)=>[Math.min(a.x,b.x),Math.min(a.y,b.y),Math.max(a.x,b.x),Math.max(a.y,b.y)];
  const segments=points.slice(1).map((b,i)=>({a:points[i],b,box:box(points[i],b)}));
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
  return {segments,box:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],id:stroke.id,kind:stroke.kind};
}
const overlaps=(a,b)=>!(a[0]>b[2]||a[1]>b[3]||b[0]>a[2]||b[1]>a[3]);
function intersects(a,b) {
  if(!overlaps(a.box,b.box))return false;
  for(const s of a.segments)for(const t of b.segments) {
    if(!overlaps(s.box,t.box))continue;
    const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y,ex=t.b.x-t.a.x,ey=t.b.y-t.a.y,det=dx*ey-dy*ex;
    if(Math.abs(det)<epsilon)continue;
    const x=t.a.x-s.a.x,y=t.a.y-s.a.y;
    const k=(x*ey-y*ex)/det,h=(x*dy-y*dx)/det;
    if(k>epsilon && k<1-epsilon && h>epsilon && h<1-epsilon)return true;
  }
  return false;
}
function marginalCrossings(local,background) {
  let count=0;
  for(let i=0;i<local.length;i++) {
    for(const other of background)if(intersects(local[i],other))count++;
    for(let j=0;j<i;j++)if(intersects(local[i],local[j]))count++;
  }
  return count;
}
function crossingStats(strokes,angle) {
  const projectedStrokes=strokes.map(s=>projected(s,angle));
  const stats={yaw:angle[0],pitch:angle[1],crossings:0,trunkTrunk:0,trunkBranch:0,branchBranch:0,other:0,crossGroupCrossings:0};
  for(let i=0;i<projectedStrokes.length;i++)for(let j=0;j<i;j++) {
    const a=projectedStrokes[i],b=projectedStrokes[j];
    if(!intersects(a,b))continue;
    stats.crossings++;
    if(a.kind!=='internal'||b.kind!=='internal')stats.crossGroupCrossings++;
    if(a.kind==='trunk'&&b.kind==='trunk')stats.trunkTrunk++;
    else if(a.kind==='branch'&&b.kind==='branch')stats.branchBranch++;
    else if(a.kind==='trunk'&&b.kind==='branch'||a.kind==='branch'&&b.kind==='trunk')stats.trunkBranch++;
    else stats.other++;
  }
  return stats;
}

export function route(data,layout,{threshold=3,aggregate=true,direct=false}={},memo) {
  const groups=memo?.groups??new Map(layout.groups.map(g=>[g.id,g]));
  const nodes=memo?.nodes??new Map(layout.nodes.map(n=>[n.id,n]));
  const contexts=new Map();
  const replay=memo && !aggregate && !direct ? new PortLedger(memo.edges) : null;
  const ledger=replay??new Map(layout.groups.map(g=>[g.id,[]]));
  const batches=new Map(), strokes=new Map(), paths=Object.create(null), bundles=[];
  // Stored/imported edges can address a directory itself. Its center is a
  // geometric anchor only; it must never become a visible knowledge point.
  const endpoint=id=>{
    const group=groups.get(id);
    return nodes.get(id)??(group&&{id,owner:id,p:group.center});
  };
  const gatesFor=(ctx,a,b,ignored=new Set())=>{
    const gates=[];
    const side=(ids,start,end)=>ids.map(id=>{
      const p=port(groups.get(id),start,end,ledger.get(id).filter(seat=>!ignored.has(seat.id)));
      gates.push({id,p});return p;
    });
    const exits=side(ctx.exits,a,b),enters=side(ctx.entries,b,a).reverse();
    return {gates,points:[...exits,...enters]};
  };
  for(const edge of [...data.edges].sort((a,b)=>a.id.localeCompare(b.id))) {
    const s=endpoint(edge.source),t=endpoint(edge.target),internal=s.owner===t.owner;
    function calculate() {
      if(direct || internal)return [s.p,t.p];
      const reverse=!edge.directed && s.owner>t.owner, a=reverse?t:s,b=reverse?s:t;
      const key=JSON.stringify([a.owner,b.owner,edge.directed]);
      if(!contexts.has(key))contexts.set(key,context(layout,a.owner,b.owner,groups));
      const ctx=contexts.get(key), {points:between,gates}=gatesFor(ctx,a.p,b.p);
      const required=[a.p,...between,b.p];
      const central=ctx.exits.length&&ctx.entries.length?ctx.exits.length+1:0;
      const facing=central?[groups.get(ctx.exits.at(-1)),groups.get(ctx.entries.at(-1))]:null;
      const points=!aggregate&&ctx.lca.shape==='plane'?platformPath(required,ctx,layout,ledger,'edge',edge.id,memo?.flows,facing,central):clearPath(required,ctx);
      if(reverse)points.reverse();
      for(const g of gates)ledger.get(g.id).push({id:edge.id,p:g.p});
      if(aggregate && groups.get(a.owner).parent!==b.owner && groups.get(b.owner).parent!==a.owner) {
        if(!batches.has(key))batches.set(key,[]);
        batches.get(key).push({edge,a,b,reverse});
      }
      return points;
    }
    const points=replay?replay.solve(edge,calculate):calculate();
    paths[edge.id]=points;
    strokes.set(edge.id,{id:edge.id,kind:internal?'internal':'single',members:[edge.id],directed:edge.directed,points});
  }
  const candidates=[...batches].filter(([,members])=>members.length>=Math.max(2,threshold)).sort(([a],[b])=>a.localeCompare(b));
  const views=candidates.length?referenceAngles.map(angle=>new Map([...strokes].map(([id,s])=>[id,projected(s,angle)]))):[];
  for(const [key,records] of candidates) {
    const ids=records.map(r=>r.edge.id),ignored=new Set(ids),ctx=contexts.get(key);
    const a=mean(records.map(r=>r.a.p)),b=mean(records.map(r=>r.b.p));
    const {gates,points:waypoints}=gatesFor(ctx,a,b,ignored);
    if(!ctx.exits.length)waypoints.unshift(a);
    if(!ctx.entries.length)waypoints.push(b);
    const trunk=clearPath(waypoints,ctx);
    if(trunk.length<2||length(trunk)<epsilon)continue;
    const uniqueId=base=>{let id=base;while(strokes.has(id))id+='#';return id;};
    const bundleId=uniqueId('bundle:'+key), directed=records[0].edge.directed;
    const trunkStroke={id:bundleId,kind:'trunk',points:trunk,members:ids,directed};
    const branches=[new Map(),new Map()], rebuilt=new Map();
    let newEntries=0,oldEntries=0,newLength=0,oldLength=0;
    for(const {edge,a:source,b:target,reverse} of records) {
      function branch(side,node,start,end) {
        const pool=branches[side];
        if(!pool.has(node.id))pool.set(node.id,{
          id:uniqueId('branch:'+JSON.stringify([key,side,node.id])),kind:'branch',
          bundle:bundleId,end:side?'target':'source',node:node.id,directed,members:[],points:clearSegment(start,end,ctx),
        });
        const s=pool.get(node.id);s.members.push(edge.id);return s.points;
      }
      const from=branch(0,source,source.p,trunk[0]),to=branch(1,target,trunk.at(-1),target.p);
      const path=clean([...from,...trunk,...to]);
      rebuilt.set(edge.id,reverse?path.reverse():path);
      newEntries+=entries(path,ctx.obstacles);oldEntries+=entries(paths[edge.id],ctx.obstacles);
      newLength+=length(path);oldLength+=length(paths[edge.id]);
    }
    const replacement=[trunkStroke,...branches.flatMap(pool=>[...pool.values()].filter(s=>length(s.points)>epsilon))];
    const newInk=replacement.reduce((n,s)=>n+length(s.points),0);
    if(newEntries>oldEntries || newLength>1.25*oldLength || newInk>=.98*oldLength)continue;
    const additions=referenceAngles.map(angle=>replacement.map(s=>projected(s,angle)));
    let crosses=0,disqualify=false;
    views.forEach((view,i)=>{
      const background=[...view.values()].filter(s=>!ignored.has(s.id));
      const before=marginalCrossings(ids.map(id=>view.get(id)),background);
      const after=marginalCrossings(additions[i],background);
      crosses+=after-before;
      if(after>before+Math.floor(.08*before))disqualify=true;
    });
    if(disqualify||crosses>0)continue;
    for(const id of ids)strokes.delete(id);
    for(const [id,path] of rebuilt)paths[id]=path;
    for(const s of replacement)strokes.set(s.id,s);
    for(const [id,seats] of ledger)ledger.set(id,seats.filter(s=>!ignored.has(s.id)));
    for(const gate of gates)ledger.get(gate.id).push({id:bundleId,p:gate.p});
    views.forEach((view,i)=>{ids.forEach(id=>view.delete(id));additions[i].forEach(s=>view.set(s.id,s));});
    bundles.push({id:bundleId,members:ids,from:records[0].a.owner,to:records[0].b.owner,directed});
  }
  return {strokes:[...strokes.values()],paths,bundles,candidates:candidates.length};
}

// A child footprint can sit directly above its ancestor. Match the 2D
// containment rule: align the two sockets on the nearest parallel rims.
// The usual port allocator still separates lanes and avoids the corners.
function nestedPlatformAim(outer,inner) {
  const dx=inner.center.x-outer.center.x,dy=inner.center.y-outer.center.y;
  const spareX=outer.halfWidth-inner.halfWidth,spareY=outer.halfHeight-inner.halfHeight;
  const left=spareX+dx,right=spareX-dx,top=spareY+dy,bottom=spareY-dy;
  const gap=Math.min(left,right,top,bottom);
  if(gap<0)return;
  if(gap===left)return {...inner.center,x:inner.center.x-1};
  if(gap===right)return {...inner.center,x:inner.center.x+1};
  if(gap===top)return {...inner.center,y:inner.center.y-1};
  return {...inner.center,y:inner.center.y+1};
}

// Each record is already a semantic subgraph pair. Its route costs one path
// irrespective of how many original relationships it represents.
export function overviewRoutes(shape,pairs,memo,rimsOnly=false){
  const groups=memo?.groups??new Map(shape.groups.map(g=>[g.id,g]));
  const replay=memo?new PortLedger(rimsOnly?memo.rims:memo.pairs):null;
  const ledger=replay??new Map(shape.groups.map(g=>[g.id,[]]));
  const result=new Map();
  function anchor(group,refs,aim){
    const preferred=refs.length?mean(refs):group.center;
    const children=shape.groups.filter(g=>g.parent===group.id);
    const free=p=>distance(p,group.center)<group.radius &&
      children.every(c=>distance(p,c.center)>c.radius+epsilon);
    const seats=ledger.get(group.id);
    const gap=Math.min(group.radius*.12,shape.spacing*.3);
    const sources=[preferred,...refs];
    // In a parent that also owns children, a centroid can land inside a
    // child shell. Actual directly owned nodes provide feasible fallbacks.
    let base=sources.find(free)??group.center;
    let choices;
    if(base===group.center && !free(base)){
      // A relationship can name the parent directory itself. Its geometric
      // center can then be inside a child, especially for concentric shells.
      // The layout leaves a positive radial gap around every packed child.
      const extent=children.reduce((r,c)=>Math.max(r,distance(c.center,group.center)+c.radius),0);
      const clearance=group.radius-extent;
      const radius=extent+(clearance+(clearance>epsilon?epsilon:0))/2;
      const towards=sub(aim,group.center);
      const bearing=norm(towards)>epsilon?unit(towards):axes[1];
      base=add(group.center,mul(bearing,radius));
      // Keep alternative seats at the same radius even in a thin annulus.
      choices=[base,...tangentFrame(bearing).flatMap(dir=>[-1,1].map(sign=>
        add(group.center,mul(unit(add(bearing,mul(dir,sign*gap/radius))),radius))))];
    }else{
      const uv=tangentFrame(unit(sub(aim,preferred)));
      choices=[base,...uv.flatMap(dir=>[-1,1].map(sign=>add(base,mul(dir,sign*gap))))].filter(free);
    }
    const score=p=>distance(p,base)+seats.reduce((n,s)=>n+2*Math.max(0,gap-distance(p,s.p)),0);
    const point=choices.reduce((best,p)=>score(p)<score(best)?p:best,base);
    seats.push({p:point});
    return point;
  }
  function calculate(pair,a,b){
    const ctx=context(shape,a.id,b.id,groups),gates=[];
    function socket(id,origin,aim){
      const seats=ledger.get(id),p=port(groups.get(id),origin,aim,seats);
      seats.push({p});
      return {groupId:id,point:p};
    }
    let waypoints;
    if(a.shape==='plane'){
      const inner=ctx.lca===a?b:ctx.lca===b?a:undefined;
      const aim=inner&&nestedPlatformAim(ctx.lca,inner);
      if(aim)gates.push(socket(a.id,inner.center,aim),socket(b.id,inner.center,aim));
      else gates.push(socket(a.id,a.center,b.center),socket(b.id,b.center,a.center));
      waypoints=gates.map(g=>g.point);
      // The layered orthogonal planner needs only the two boundary seeds.
      // Avoid solving a complete legacy route that it would immediately discard.
      if(rimsOnly)return {points:waypoints,commonAncestor:ctx.lca.id,gates};
    }else{
      const start=ctx.exits.length?a.center:anchor(a,pair.fromPoints,b.center);
      const end=ctx.entries.length?b.center:anchor(b,pair.toPoints,a.center);
      gates.push(...ctx.exits.map(id=>socket(id,start,end)),
        ...ctx.entries.map(id=>socket(id,end,start)).reverse());
      waypoints=gates.map(g=>g.point);
      if(!ctx.exits.length)waypoints.unshift(start);
      if(!ctx.entries.length)waypoints.push(end);
    }
    const points=a.shape==='plane'?platformPath(waypoints,ctx,shape,ledger,'trunk',pair.id,memo?.flows,[a,b],1):clearPath(waypoints,ctx);
    return {points,commonAncestor:ctx.lca.id,gates};
  }
  for(const pair of [...pairs].sort((a,b)=>a.id.localeCompare(b.id))){
    const a=groups.get(pair.from),b=groups.get(pair.to);
    if(!a||!b||a===b)continue;
    result.set(pair.id,replay?replay.solve(pair,()=>calculate(pair,a,b)):calculate(pair,a,b));
  }
  return result;
}

// Keep descriptors immutable for the lifetime of this world. Detailed paths
// and overview trunks have independent port competitions in each pass.
export function createSpatialLineRouter(shape,relations){
  const memo={groups:new Map(shape.groups.map(g=>[g.id,g])),nodes:new Map(shape.nodes.map(n=>[n.id,n])),
    edges:new WeakMap(),pairs:new WeakMap(),rims:new WeakMap()};
  memo.flows=platformFlows(shape,relations,memo.groups);
  return {
    detailed:edges=>route({edges},shape,{aggregate:false},memo).paths,
    overview:pairs=>overviewRoutes(shape,pairs,memo),
    rims:pairs=>overviewRoutes(shape,pairs,memo,true),
    independent:(from,to,points)=>clearPath(points,context(shape,from,to,memo.groups)),
    platformBranch:(owner,node,gate)=>routePlatformBranch(shape,owner,node,gate),
  };
}
export {entries as routeIntersections};

export function routeMetrics(data,layout,plan,angles=measurementAngles) {
  const groups=new Map(layout.groups.map(g=>[g.id,g])),nodes=new Map(layout.nodes.map(n=>[n.id,n]));
  const cache=new Map();
  let memberLength=0,regionEntries=0;
  for(const edge of data.edges) {
    const a=nodes.get(edge.source).owner,b=nodes.get(edge.target).owner;
    if(a===b)continue;
    const key=JSON.stringify([a,b].sort());
    if(!cache.has(key))cache.set(key,context(layout,a,b,groups).obstacles);
    memberLength+=length(plan.paths[edge.id]);regionEntries+=entries(plan.paths[edge.id],cache.get(key));
  }
  return {views:angles.map(angle=>crossingStats(plan.strokes,angle)),length:memberLength,entries:regionEntries,
    inkLength:plan.strokes.filter(s=>s.kind!=='internal').reduce((n,s)=>n+length(s.points),0)};
}
