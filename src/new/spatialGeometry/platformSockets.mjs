const eps=1e-7;
const across=k=>k==='x'?'y':'x';
const half=(g,k)=>k==='x'?g.halfWidth:g.halfHeight;
const run=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+Math.abs(a.z-b.z);
function ancestor(world,child,parent){
  for(let g=child;g;g=world.groups.get(g.parent))if(g===parent)return true;
  return false;
}
function rimInterval(g,axis,s){
  const v=across(axis),h=half(g,v),inset=Math.min(h*.14,s*.14);
  return [g.center[v]-h+inset,g.center[v]+h-inset];
}
function sockets(g,legacy,peer,s,phase){
  const rows=[];
  for(const axis of ['x','y'])for(const sign of [-1,1]){
    const v=across(axis),center=g.center[v],at=g.center[axis]+sign*half(g,axis);
    const [lo,hi]=rimInterval(g,axis,s);
    const clamp=x=>Math.max(lo,Math.min(hi,x));
    const offset=s*(.12+.15*phase);
    const values=new Set([clamp(center),clamp(center-offset),clamp(center+offset),clamp(peer[v]),
      lo+Math.min(offset,(hi-lo)*.15),hi-Math.min(offset,(hi-lo)*.15)]);
    if(Math.abs(legacy[axis]-at)<eps)values.add(legacy[v]);
    for(const pos of values)rows.push({point:{...g.center,[axis]:at,[v]:pos},axis,sign});
  }
  return rows;
}
// Intersect the two usable rims first. Choosing their tangent coordinates
// independently creates a two-elbow step even across an empty strip.
function straightSockets(ctx,row,s,seats,emit){
  for(const k of ['x','y']){
    const v=across(k),a=ctx.a,b=ctx.b,sign=Math.sign(b.center[k]-a.center[k]);
    const depart=a.center[k]+sign*half(a,k),arrive=b.center[k]-sign*half(b,k);
    if((arrive-depart)*sign<=eps)continue;
    const [a0,a1]=rimInterval(a,k,s),[b0,b1]=rimInterval(b,k,s);
    const lo=Math.max(a0,b0),hi=Math.min(a1,b1);
    if(lo>hi)continue;
    const mid=(lo+hi)/2,offset=Math.min((hi-lo)/4,s*.26);
    const values=new Set([mid,mid+offset,mid-offset,lo,hi,lo+(hi-lo)*ctx.phase,row.start[v],row.end[v]]);
    const occupied=[...seats.tangents(a.id,row.id,k,depart,lo,hi),...seats.tangents(b.id,row.id,k,arrive,lo,hi)];
    if(occupied.length){
      const stops=[lo,...new Set(occupied),hi].sort((u,v)=>u-v);
      for(let i=1;i<stops.length;i++)if(stops[i]-stops[i-1]>eps)values.add((stops[i]+stops[i-1])/2);
    }
    const shadows=[];
    for(const g of ctx.obstacles){
      if(g.center[k]+half(g,k)<=Math.min(depart,arrive)||g.center[k]-half(g,k)>=Math.max(depart,arrive))continue;
      const left=g.center[v]-half(g,v),right=g.center[v]+half(g,v);
      values.add(left-s*.12);values.add(right+s*.12);
      if(left<hi&&right>lo)shadows.push([Math.max(lo,left),Math.min(hi,right)]);
    }
    // A fixed safety offset can jump over an entire narrow free window.
    // Keep the normal clearances when they fit; otherwise try its midpoint.
    if(shadows.length){
      const tested=[...values].sort((a,b)=>a-b);
      let cursor=lo,i=0;
      function openWindow(end){
        if(end<=cursor+2*eps)return;
        while(i<tested.length&&tested[i]<=cursor+eps)i++;
        if(i===tested.length||tested[i]>=end-eps)values.add((cursor+end)/2);
      }
      for(const [left,right] of shadows.sort((a,b)=>a[0]-b[0])){
        openWindow(left);cursor=Math.max(cursor,right);
      }
      openWindow(hi);
    }
    for(const t of values)if(t>=lo&&t<=hi)
      emit({axis:k,sign,point:{...a.center,[k]:depart,[v]:t}},{axis:k,sign:-sign,point:{...b.center,[k]:arrive,[v]:t}});
  }
}
export function planarTurns(points){
  let prev,turns=0;
  for(let i=1;i<points.length;i++){
    const dx=points[i].x-points[i-1].x,dy=points[i].y-points[i-1].y;
    if(Math.abs(dx)+Math.abs(dy)<eps)continue;
    const heading=Math.abs(dx)>Math.abs(dy)?Math.sign(dx):2*Math.sign(dy);
    if(prev&&prev!==heading)turns++;
    prev=heading;
  }
  return turns;
}
export function sharedSockets(rows,index,occupied){
  if(!occupied?.length)return [];
  const owners=new Set();
  for(const row of rows){
    const r=index.relations.get(row.id);owners.add(r.sourceSubgraphId);owners.add(r.targetSubgraphId);
  }
  const kept=[];
  for(const r of occupied){
    if(!r.points.length)continue;
    if(owners.has(r.sourceSubgraphId))kept.push({owner:r.sourceSubgraphId,p:r.points[0]});
    if(owners.has(r.targetSubgraphId))kept.push({owner:r.targetSubgraphId,p:r.points.at(-1)});
  }
  return kept.sort((a,b)=>a.owner.localeCompare(b.owner)||a.p.x-b.p.x||a.p.y-b.p.y||a.p.z-b.p.z);
}
export function socketOccupancy(rows,index,reserved){
  const byOwner=new Map();
  function set(owner,id,p){
    if(!byOwner.has(owner))byOwner.set(owner,new Map());
    byOwner.get(owner).set(id,p);
  }
  function publish(row,start,end){
    const r=index.relations.get(row.id);
    set(r.sourceSubgraphId,row.id,start);set(r.targetSubgraphId,row.id,end);
  }
  for(const r of rows)publish(r,r.start,r.end);
  for(const gate of reserved)set(gate.owner,Symbol(),gate.p);
  function price(owner,id,p,s){
    let cost=0;
    for(const [peer,q] of byOwner.get(owner)??[]){
      if(peer===id)continue;
      const d=Math.abs(p.x-q.x)+Math.abs(p.y-q.y);
      if(d<s*.23)cost+=(1-d/(s*.23))*s*(d<eps?24:5.5);
    }
    return cost;
  }
  function tangents(owner,id,axis,at,lo,hi){
    const values=[],v=across(axis);
    for(const [peer,p] of byOwner.get(owner)??[]){
      if(peer!==id&&Math.abs(p[axis]-at)<eps&&p[v]>lo&&p[v]<hi)values.push(p[v]);
    }
    return values;
  }
  return {price,publish,tangents};
}
function corridors(a,b,s,consider){
  const p=a.point,q=b.point,k=a.axis,j=b.axis,at=(x,y)=>({x,y,z:p.z});
  function path(mid){
    const points=[p,...mid,q];
    // Floor transitions occur over an already reachable orthogonal elbow.
    if(p.z!==q.z){
      if(!mid.length)return;
      const i=Math.ceil(mid.length/2),hinge=points[i];
      points.splice(i+1,0,{...hinge,z:q.z});
      for(let t=i+2;t<points.length-1;t++)points[t]={...points[t],z:q.z};
    }
    consider(points);
  }
  if(k!==j){
    if((q[k]-p[k])*a.sign>eps&&(p[j]-q[j])*b.sign>eps)
      path([k==='x'?at(q.x,p.y):at(p.x,q.y)]);
    return;
  }
  const t=across(k);
  if(Math.abs(p[t]-q[t])<eps){
    if((q[k]-p[k])*a.sign>0&&(p[k]-q[k])*b.sign>0){
      if(p.z===q.z)path([]);
      else path([at((p.x+q.x)/2,(p.y+q.y)/2)]);
    }
    return;
  }
  const mid=(p[k]+q[k])/2;
  for(const track of [mid,p[k]+a.sign*s*.3,q[k]+b.sign*s*.3]){
    if((track-p[k])*a.sign<=eps||(track-q[k])*b.sign<=eps)continue;
    path([{...p,[k]:track},{...q,[k]:track,z:p.z}]);
  }
}
export function selectPlatformSockets(world,index,ctx,row,offer,seats,plan,measureSegment,trafficPrice){
  const s=world.shape.spacing;
  function cost(g,p){return seats.price(g.id,row.id,p,s);}
  if(ancestor(world,ctx.a,ctx.b)||ancestor(world,ctx.b,ctx.a)){
    // Preserve the established corresponding rims of nested decks. A
    // disclosed original can move tangentially off an occupied summary seat.
    if(plan.role!=='original')return;
    const rim=(g,p)=>Math.abs(Math.abs(p.x-g.center.x)-g.halfWidth)<eps?'x':'y';
    const k=rim(ctx.a,row.start);if(k!==rim(ctx.b,row.end))return;
    const v=across(k),misalignment=Math.abs(row.start[v]-row.end[v]);
    const oldCost=cost(ctx.a,row.start)+cost(ctx.b,row.end);
    if(misalignment<eps&&oldCost<eps)return;
    const [a0,a1]=rimInterval(ctx.a,k,s),[b0,b1]=rimInterval(ctx.b,k,s);
    const lo=Math.max(a0,b0),hi=Math.min(a1,b1);
    if(lo>hi)return;
    const occupied=[lo,hi,...seats.tangents(ctx.a.id,row.id,k,row.start[k],lo,hi),
      ...seats.tangents(ctx.b.id,row.id,k,row.end[k],lo,hi)].sort((a,b)=>a-b);
    let best=oldCost+(misalignment>eps?s*.55+misalignment*.65:0),pick;
    for(let i=1;i<occupied.length;i++){
      const t=(occupied[i]+occupied[i-1])/2;
      const start={...row.start,[v]:t},end={...row.end,[v]:t};
      const price=cost(ctx.a,start)+cost(ctx.b,end)+(.06*Math.abs(t-row.start[v])+.06*Math.abs(t-row.end[v]));
      if(price<best){best=price;pick={start,end};}
    }
    return pick;
  }
  function options(g,legacy,peer){
    const all=sockets(g,legacy,peer,s,ctx.phase);
    for(const p of all)p.cost=cost(g,p.point);
    const ranked=all.sort((a,b)=>(a.cost+run(a.point,peer)*.62)-(b.cost+run(b.point,peer)*.62));
    const selected=[],count=new Map();
    for(const o of ranked){
      const side=o.axis+o.sign,used=count.get(side)??0;
      if(used>=(plan.dense?2:4))continue;
      count.set(side,used+1);selected.push(o);
    }
    return selected;
  }
  const a=options(ctx.a,row.start,ctx.b.center),b=options(ctx.b,row.end,ctx.a.center);
  const base=offer.paths[0],oldSeats=cost(ctx.a,row.start)+cost(ctx.b,row.end);
  // Clear, separated straight and one-elbow routes take precedence. Traffic
  // and title costs choose among equally simple routes.
  const tier=(turns,cover,seats)=>cover<eps&&seats<s*6?Math.min(2,turns):2;
  let bestCost=Infinity,bestTier=2,chosen;
  for(const o of offer.paths){
    const n=planarTurns(o.p),rank=tier(n,o.topCover,oldSeats);
    if(rank>bestTier)continue;
    const value=o.score+oldSeats-s*.09+trafficPrice(o,true);
    if(rank<bestTier||value<bestCost){bestCost=value;bestTier=rank;}
  }
  const viable=new Map();
  function pair(u,v){
    const seatsCost=u.cost+v.cost;
    corridors(u,v,s,points=>{
      const n=planarTurns(points),lowest=tier(n,0,seatsCost);
      if(lowest>bestTier)return;
      let score=seatsCost+s*3.4*n+s*.45*(points.length-2),cover=0;
      for(let i=1;i<points.length;i++){
        const p=points[i-1],q=points[i];score+=run(p,q);
        if(lowest===bestTier&&score>=bestCost)return;
        const k=p.x!==q.x?'x':p.y!==q.y?'y':'z';
        cover+=measureSegment(p,q,k,ctx);
        if(!Number.isFinite(cover)||cover>base.topCover+eps)return;
      }
      score+=cover*3.4;
      const rank=tier(n,cover,seatsCost);
      if(rank>bestTier||(rank===bestTier&&score>=bestCost))return;
      const key=rank+u.axis+u.sign+v.axis+v.sign;
      const list=viable.get(key)??[];
      if(list.length>=4&&list[3].score<=score)return;
      list.push({start:u.point,end:v.point,points,score,rank});
      list.sort((a,b)=>a.score-b.score);if(list.length>4)list.pop();
      viable.set(key,list);
    });
  }
  straightSockets(ctx,row,s,seats,(u,v)=>{
    u.cost=cost(ctx.a,u.point);v.cost=cost(ctx.b,v.point);pair(u,v);
  });
  for(const u of a)for(const v of b)pair(u,v);
  for(const candidate of [...viable.values()].flat().sort((a,b)=>a.rank-b.rank||a.score-b.score)){
    if(candidate.rank>bestTier||(candidate.rank===bestTier&&candidate.score>=bestCost))break;
    const price=candidate.score+trafficPrice({p:candidate.points},false);
    if(candidate.rank<bestTier||price<bestCost){bestTier=candidate.rank;bestCost=price;chosen=candidate;}
  }
  return chosen;
}
