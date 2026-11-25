// Optimize the local fan in a few fixed world bearings. These are comparison
// cameras only; rotating the user's camera never modifies any path.
const bearings=[[-.25,.85],[.8,.63],[-1.1,.98],[.38,1.22],[-1.85,.48]].map(([y,p])=>
  [Math.cos(y),Math.sin(y),Math.sin(p),Math.cos(p)]);
function project(poly,[c,s,i,r]){
  const p=poly.map(q=>[c*q.x-s*q.y,i*(s*q.x+c*q.y)-r*q.z]);
  const seg=[];
  for(let j=1;j<p.length;j++){
    const [x,y]=p[j-1],[u,v]=p[j];
    seg.push({x,y,dx:u-x,dy:v-y,l:Math.min(x,u),r:Math.max(x,u),t:Math.min(y,v),b:Math.max(y,v)});
  }
  seg.bounds={l:Math.min(...p.map(q=>q[0])),r:Math.max(...p.map(q=>q[0])),t:Math.min(...p.map(q=>q[1])),b:Math.max(...p.map(q=>q[1]))};
  return seg;
}
export const projectedFans=(p)=>bearings.map(v=>project(p,v));
function intersection(a,b){
  if(a.l>b.r||b.l>a.r||a.t>b.b||b.t>a.b)return false;
  const det=a.dx*b.dy-a.dy*b.dx;if(Math.abs(det)<1e-7)return false;
  const x=b.x-a.x,y=b.y-a.y,t=(x*b.dy-y*b.dx)/det,u=(x*a.dy-y*a.dx)/det;
  return t>1e-7&&t<1-1e-7&&u>1e-7&&u<1-1e-7;
}
export function pairPressure(a,b){
  let cost=0;
  for(let i=0;i<bearings.length;i++)
    if(overlaps(a[i].bounds,b[i].bounds)&&a[i].some(u=>b[i].some(v=>intersection(u,v))))cost+=i===0?1.4:1;
  return cost;
}
const overlaps=(a,b)=>a.l<=b.r&&b.l<=a.r&&a.t<=b.b&&b.t<=a.b;
export function nearViews(a,b){return a.some((v,i)=>overlaps(v.bounds,b[i].bounds));}
const crossXY=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
function pointGap(p,a,b){
  const x=b.x-a.x,y=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*x+(p.y-a.y)*y)/(x*x+y*y||1)));
  return Math.hypot(p.x-a.x-t*x,p.y-a.y-t*y);
}
function xyGap(a,b,c,d){
  const u=crossXY(a,b,c),v=crossXY(a,b,d),p=crossXY(c,d,a),q=crossXY(c,d,b);
  if(u*v<0&&p*q<0)return 0;
  return Math.min(pointGap(a,c,d),pointGap(b,c,d),pointGap(c,a,b),pointGap(d,a,b));
}
export function clearOfBanks(bodies,occupied,space){
  for(const bank of occupied)for(const a of bodies)for(const b of bank){
    const dz=Math.abs(a[0].z-b[0].z);if(dz>=space)continue;
    const lateral=Math.sqrt(space*space-dz*dz);
    for(let i=1;i<a.length;i++)for(let j=1;j<b.length;j++){
      if(xyGap(a[i-1],a[i],b[j-1],b[j])<lateral)return false;
    }
  }
  return true;
}
export function turnCost(points){
  let total=0;
  for(let i=1;i<points.length-1;i++){
    const a=points[i-1],b=points[i],c=points[i+1],x=b.x-a.x,y=b.y-a.y,z=b.z-a.z;
    const u=c.x-b.x,v=c.y-b.y,w=c.z-b.z,n=Math.hypot(x,y,z)*Math.hypot(u,v,w);
    if(n<1e-6)continue;
    const angle=Math.acos(Math.min(1,Math.max(-1,(x*u+y*v+z*w)/n)));
    total+=angle*angle;
    if(angle>Math.PI/3)total+=2*(angle-Math.PI/3);
  }
  return total;
}
export function fanPressure(a,b){return pairPressure(a.input,b.input)+pairPressure(a.exit,b.exit);}
