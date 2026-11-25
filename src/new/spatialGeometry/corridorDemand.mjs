// Structural demand is independent of expansion, camera and occupied ports.
// Approximate ports serve only to find whole-route companions. Actual
// published gate coordinates are recovered before any geometry is replaced.
const norm=(x,y)=>Math.hypot(x,y);
export const distance3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
export const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
export const pathLength=p=>p.slice(1).reduce((n,b,i)=>n+distance3(p[i],b),0);
const axisDot=(p,d)=>p.x*d.x+p.y*d.y;
export const along=axisDot;
export const lateral=(p,d)=>-p.x*d.y+p.y*d.x;
export const inFrame=(u,v,z,d)=>({x:u*d.x-v*d.y,y:u*d.y+v*d.x,z});
function rim(g,from,to){
  const x=Math.max(g.center.x-g.halfWidth,Math.min(g.center.x+g.halfWidth,from.x));
  const y=Math.max(g.center.y-g.halfHeight,Math.min(g.center.y+g.halfHeight,from.y));
  let dx=to.x-from.x,dy=to.y-from.y;
  if(Math.abs(dx)+Math.abs(dy)<1e-7)dx=1;
  const t=Math.min(dx?(g.center.x+Math.sign(dx)*g.halfWidth-x)/dx:Infinity,dy?(g.center.y+Math.sign(dy)*g.halfHeight-y)/dy:Infinity);
  return {x:x+dx*t,y:y+dy*t,z:g.center.z};
}
function ancestors(world,id){const ids=[];for(let g=world.groups.get(id);g;g=world.groups.get(g.parent))ids.push(g);return ids;}
function atFraction(points,f){
  const total=pathLength(points);let remaining=total*f;
  for(let i=1;i<points.length;i++){const len=distance3(points[i-1],points[i]);if(len>0&&remaining<=len)return lerp(points[i-1],points[i],remaining/len);remaining-=len;}
  return points.at(-1);
}
export function demandFor(world,index,item,kind){
  const pair=kind==='relation',source=pair?item.sourceSubgraphId:item.sourceNodeId,target=pair?item.targetSubgraphId:item.targetNodeId;
  const from=world.nodes.get(source)?.owner??source,to=world.nodes.get(target)?.owner??target;
  if(from===to||!world.groups.has(from)||!world.groups.has(to))return;
  const ownerA=world.groups.get(from),ownerB=world.groups.get(to);
  const s=world.nodes.get(source)?.p??ownerA.center,t=world.nodes.get(target)?.p??ownerB.center;
  const aa=ancestors(world,from),bb=ancestors(world,to),common=aa.find(g=>bb.includes(g));
  if(!common)return;
  const exits=aa.slice(0,aa.indexOf(common)),entries=bb.slice(0,bb.indexOf(common)).reverse();
  const gates=pair?[]:[...exits,...entries];
  const route=pair?[rim(ownerA,s,t),rim(ownerB,t,s)]:[s,...exits.map(g=>rim(g,s,t)),...entries.map(g=>rim(g,t,s)),t];
  // Preserve every required gate. For an original that traverses several
  // owners only the segment between the two LCA branches can be shared.
  const leg=pair?0:exits.length;
  const a=route[leg],b=route[leg+1],len=norm(b.x-a.x,b.y-a.y);
  const d=len?{x:(b.x-a.x)/len,y:(b.y-a.y)/len}:{x:1,y:0};
  const family=new Set([...aa,...bb]);
  return {id:pair?item.id:item.edgeId,kind,source,target,from,to,key:JSON.stringify([from,to].sort()),s,t,route,
    gates,leg,a,b,len,d,mid:lerp(a,b,.5),course:[.2,.5,.8].map(f=>atFraction(route,f)),family,
    familyIds:new Set([...family].map(g=>g.id))};
}
const onRim=(p,g)=>Math.abs(p.z-g.center.z)<1e-6&&Math.abs(p.x-g.center.x)<=g.halfWidth+1e-6&&
  Math.abs(p.y-g.center.y)<=g.halfHeight+1e-6&&Math.min(Math.abs(Math.abs(p.x-g.center.x)-g.halfWidth),Math.abs(Math.abs(p.y-g.center.y)-g.halfHeight))<1e-6;
export function actualWaypoints(line,r){
  if(r.kind==='relation')return [line.points[0],line.points.at(-1)];
  const points=[line.points[0]];let next=0;
  for(const g of r.gates){const at=line.points.findIndex((p,i)=>i>=next&&onRim(p,g));if(at<0)return;
    points.push(line.points[at]);next=at;}
  points.push(line.points.at(-1));return points;
}
export function framed(r,d){
  const reverse=along(r.d,d)<0,a=reverse?r.b:r.a,b=reverse?r.a:r.b;
  return {r,a,b,reverse,lo:along(a,d),hi:along(b,d),start:lateral(a,d),end:lateral(b,d)};
}
export function crossAt(f,u){const t=Math.max(0,Math.min(1,(u-f.lo)/(f.hi-f.lo||1)));return f.start+t*(f.end-f.start);}
function affinity(seed,other,s){
  const cos=along(seed.d,other.d),short=Math.min(seed.len,other.len);
  if(Math.abs(cos)<.83||short<Math.max(seed.len,other.len)*.38)return 0;
  const a=framed(seed,seed.d),b=framed(other,seed.d),lo=Math.max(a.lo,b.lo),hi=Math.min(a.hi,b.hi);
  if(hi-lo<Math.max(s*1.25,short*.46))return 0;
  const separation=Math.max(...[.12,.5,.88].map(t=>Math.abs(crossAt(a,lo+t*(hi-lo))-crossAt(b,lo+t*(hi-lo)))));
  if(separation>Math.min(short*.45+1.4*s,7*s))return 0;
  const course=cos>0?other.course:[...other.course].reverse();
  const difference=seed.course.reduce((n,p,i)=>n+Math.abs(lateral(p,seed.d)-lateral(course[i],seed.d)),0)/3;
  if(difference>Math.min(.55*short+1.25*s,8*s)||Math.abs(seed.mid.z-other.mid.z)>2.25*s)return 0;
  return (hi-lo)*Math.abs(cos)/(1+(difference+separation)/(4*s));
}
export function cohorts(records,spacing){
  const items=records.filter(r=>r.len>spacing*2.5),cell=spacing*7,bins=new Map(),key=(x,y)=>x+'/'+y;
  for(const r of items){
    const k=key(Math.floor(r.mid.x/cell),Math.floor(r.mid.y/cell));if(!bins.has(k))bins.set(k,[]);bins.get(k).push(r);
  }
  const offers=[];
  for(const seed of items){
    const bx=Math.floor(seed.mid.x/cell),by=Math.floor(seed.mid.y/cell),reach=Math.min(3,Math.max(1,Math.ceil(.32*seed.len/cell)));
    const peers=[];
    for(let x=bx-reach;x<=bx+reach;x++)for(let y=by-reach;y<=by+reach;y++)for(const r of bins.get(key(x,y))??[]){
      if(r===seed)continue;const score=affinity(seed,r,spacing);if(score)peers.push({r,score});
    }
    if(!peers.length)continue;
    peers.sort((a,b)=>b.score-a.score||a.r.id.localeCompare(b.r.id));
    offers.push({seed,peers:peers.slice(0,12),score:peers.slice(0,4).reduce((n,p)=>n+p.score,0)});
  }
  const used=new Set(),out=[];
  for(const offer of offers.sort((a,b)=>b.score-a.score||a.seed.id.localeCompare(b.seed.id))){
    if(used.has(offer.seed))continue;
    const members=[offer.seed];
    for(const {r} of offer.peers){
      if(used.has(r)||members.length>=8||!members.every(q=>affinity(q,r,spacing)))continue;
      members.push(r);
    }
    if(members.length<2||new Set(members.map(r=>r.source+'\0'+r.target)).size<2)continue;
    const d0=offer.seed.d;
    const dx=members.reduce((n,r)=>n+(along(r.d,d0)<0?-1:1)*r.d.x,0),dy=members.reduce((n,r)=>n+(along(r.d,d0)<0?-1:1)*r.d.y,0),len=norm(dx,dy);
    const d={x:dx/len,y:dy/len};
    if(d.x<-.001||(Math.abs(d.x)<=.001&&d.y<0)){d.x*=-1;d.y*=-1;}
    const frames=members.map(r=>framed(r,d)),begin=Math.max(...frames.map(f=>f.lo)),end=Math.min(...frames.map(f=>f.hi));
    if(end-begin<Math.max(spacing*1.35,.34*Math.min(...members.map(r=>r.len))))continue;
    members.forEach(r=>used.add(r));
    out.push({id:'channel-'+offer.seed.kind+'-'+offer.seed.id,d,frames,begin,end,spacing});
  }
  return out;
}
