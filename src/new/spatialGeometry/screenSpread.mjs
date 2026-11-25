// Units are CSS pixels. A node moves at most 1.5 dot radii on screen;
// its projected center stays on its original side of every group outline.
export const maxSpreadPixels=6;
const normalDistance=9.5, importantDistance=11.5, focusDistance=13;
const searchRadius=focusDistance+2*maxSpreadPixels;

function distanceToSegment(p,a,b){
  const dx=b.x-a.x,dy=b.y-a.y;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}

function movementLimit(p,outlines){
  let limit=maxSpreadPixels;
  for(const shape of outlines){
    const reach=limit/.98;
    if(p.x<shape.left-reach||p.x>shape.right+reach||p.y<shape.top-reach||p.y>shape.bottom+reach)continue;
    if(shape.corners){
      for(let i=0;i<4;i++){
        limit=Math.min(limit,.98*distanceToSegment(p,shape.corners[i],shape.corners[(i+1)%4]));
      }
    }else{
      const radius=Math.hypot(p.x-shape.x,p.y-shape.y);
      limit=Math.min(limit,.98*Math.abs(radius-shape.radius));
    }
  }
  return limit;
}

// Fixed per-ID directions disambiguate exact coincidences without relying on
// the previous frame, random numbers, or a discontinuous unit vector at zero.
function direction(id){
  let hash=2166136261;
  for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),16777619);
  const angle=(hash>>>0)*2.399963229728653;
  return [Math.cos(angle),Math.sin(angle)];
}

export function spreadProjectedPoints(points,outlines,{preferred,important,pinned}){
  const bins=new Map(),pairs=[];
  const particles=points.map(p=>{
    const focus=preferred?.has(p.id),major=important?.has(p.id);
    const fixed=pinned?.has(p.id),limit=fixed?0:movementLimit(p,outlines);
    const [ux,uy]=direction(p.id);
    return {p,limit,ux,uy,dx:0,dy:0,spacing:focus?focusDistance:major?importantDistance:normalDistance,
      mobility:fixed?0:focus?.22:major?.6:1};
  });
  for(const particle of particles){
    const {p}=particle,bx=Math.floor(p.x/searchRadius),by=Math.floor(p.y/searchRadius);
    for(let x=bx-1;x<=bx+1;x++)for(let y=by-1;y<=by+1;y++){
      const nearby=bins.get(x+','+y);
      if(!nearby)continue;
      for(const other of nearby){
        const clearance=Math.max(particle.spacing,other.spacing);
        const dx=p.x-other.p.x,dy=p.y-other.p.y,distance=Math.hypot(dx,dy);
        if(distance>=clearance+particle.limit+other.limit)continue;
        // Hold the axis fixed during relaxation, relative to the unmodified
        // projection. Two neighbors cannot repeatedly exchange sides by feeding
        // last round's perturbed direction into the following round.
        const bias=2.4*Math.max(0,1-distance/6);
        const vx=dx+bias*(particle.ux-other.ux),vy=dy+bias*(particle.uy-other.uy);
        const scale=.72/(Math.hypot(vx,vy,2.8)*(particle.mobility+other.mobility+.001));
        pairs.push({a:particle,b:other,clearance,fx:vx*scale,fy:vy*scale});
      }
    }
    const key=bx+','+by;
    if(!bins.has(key))bins.set(key,[]);
    bins.get(key).push(particle);
  }
  // Simultaneous, damped relaxation from the true projection on every frame.
  // A pair entering or leaving the search neighborhood contributes zero force.
  for(let round=0;round<4;round++){
    for(const a of particles){a.dx=0;a.dy=0;}
    for(const {a,b,clearance,fx,fy} of pairs){
      const push=clearance-Math.hypot(a.p.x-b.p.x,a.p.y-b.p.y);
      if(push<=0)continue;
      a.dx+=fx*push*a.mobility;a.dy+=fy*push*a.mobility;
      b.dx-=fx*push*b.mobility;b.dy-=fy*push*b.mobility;
    }
    for(const a of particles){
      const dx=.95*(a.p.x-a.p.anchorX)+a.dx,dy=.95*(a.p.y-a.p.anchorY)+a.dy;
      const scale=Math.min(1,a.limit/(Math.hypot(dx,dy)||1));
      a.p.x=a.p.anchorX+dx*scale;
      a.p.y=a.p.anchorY+dy*scale;
    }
  }
}
