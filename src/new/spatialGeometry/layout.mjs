// XY is the document plane, Z is physical height. All lengths are in the
// original document's world units. Only these transient objects acquire Z.
const origin = () => ({x:0, y:0, z:0});
const plus = (a,b) => ({x:a.x+b.x, y:a.y+b.y, z:a.z+b.z});
const minus = (a,b) => ({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
const times = (a,s) => ({x:a.x*s, y:a.y*s, z:a.z*s});
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);
const midpoint = r => ({x:r.x+r.width/2,y:r.y+r.height/2});

function nodeSpacing(positions) {
  const nearest = [];
  for (const points of positions.values()) for (let i=0;i<points.length;i+=Math.max(1,Math.floor(points.length/256))) {
    const p=points[i];
    let length = Infinity;
    for (const q of points) if (p !== q) length = Math.min(length,dist(p,q));
    if (Number.isFinite(length) && length>0) nearest.push(length);
  }
  nearest.sort((a,b)=>a-b);
  const mid = Math.floor(nearest.length/2);
  return nearest.length ? (nearest[mid]+nearest[Math.floor((nearest.length-1)/2)])/2 : null;
}

function hierarchy(data) {
  const groups = new Map(data.groups.map(g=>[g.id,g]));
  const children = new Map(data.groups.map(g=>[g.id,[]]));
  const owned = new Map(data.groups.map(g=>[g.id,[]]));
  for (const g of data.groups) if (g.parent!=null) children.get(g.parent).push(g);
  for (const n of data.nodes) owned.get(n.owner).push(n);
  return {groups,children,owned};
}

// Longest directed distance to a sink after contracting each directed cycle.
// An undirected component or a pure cycle acquires no artificial height.
function localRanks(data,tree) {
  const node = new Map(data.nodes.map(n=>[n.id,n]));
  const outgoing = new Map(data.nodes.map(n=>[n.id,[]]));
  for (const e of data.edges) if (e.directed && node.get(e.source).owner===node.get(e.target).owner)
    outgoing.get(e.source).push(e.target);
  const height = new Map();
  for (const nodes of tree.owned.values()) {
    let next=0;
    const visitOrder=new Map(), low=new Map(), pending=[], active=new Set(), component=new Map(), parts=[];
    function visit(id) {
      visitOrder.set(id,next); low.set(id,next++); pending.push(id); active.add(id);
      for (const to of outgoing.get(id)) {
        if (!visitOrder.has(to)) {visit(to); low.set(id,Math.min(low.get(id),low.get(to)));}
        else if (active.has(to)) low.set(id,Math.min(low.get(id),visitOrder.get(to)));
      }
      if (low.get(id)!==visitOrder.get(id)) return;
      const members=[];
      do {const v=pending.pop(); active.delete(v); component.set(v,parts.length); members.push(v);} while(members.at(-1)!==id);
      parts.push(members);
    }
    nodes.forEach(n=>{if (!visitOrder.has(n.id)) visit(n.id);});
    const ranks=[];
    for (const members of parts) {
      let rank=0;
      for (const id of members) for (const to of outgoing.get(id)) {
        const target=component.get(to);
        if (target !== ranks.length) rank=Math.max(rank,1+ranks[target]);
      }
      ranks.push(rank);
    }
    const maxRank=ranks.reduce((a,b)=>Math.max(a,b),0);
    if (maxRank) for (const n of nodes) height.set(n.id, .36*(ranks[component.get(n.id)]/maxRank-.5));
  }
  return height;
}

function planar(data,tree,mode,spacing,layerGapMultiplier) {
  const layerGap=spacing*layerGapMultiplier;
  const ranks=mode==='offset'?localRanks(data,tree):new Map();
  const groups=data.groups.map(g=>{
    const halfWidth=g.rect.width/2,halfHeight=g.rect.height/2;
    return {...g,shape:'plane',center:{...midpoint(g.rect),z:g.depth*layerGap},halfWidth,halfHeight,radius:Math.hypot(halfWidth,halfHeight)};
  });
  const nodes=data.nodes.map(n=>{
    const depth=tree.groups.get(n.owner).depth;
    const baselineZ=(depth+(ranks.get(n.id)??0))*spacing;
    return {...n,p:{x:n.x,y:n.y,z:baselineZ+depth*(layerGap-spacing)}};
  });
  return {groups,nodes,spacing,layerGap};
}

// The two children of the lowest common owner are the objects to pull
// together in that owner's packing. Contributions are actual knowledge edges.
function branchLinks(data,tree) {
  const chains=new Map(data.nodes.map(n=>{
    const chain=[n.id];
    for(let id=n.owner;id!=null;id=tree.groups.get(id).parent) chain.push(id);
    return [n.id,chain.reverse()];
  }));
  const links=new Map([...tree.groups.keys()].map(id=>[id,new Map()]));
  for(const e of data.edges) {
    const a=chains.get(e.source),b=chains.get(e.target);
    let i=0;while(i<a.length && i<b.length && a[i]===b[i]) i++;
    if (!i || i===a.length || i===b.length) continue;
    const neighbors=links.get(a[i-1]);
    for(const [from,to] of [[a[i],b[i]],[b[i],a[i]]]) {
      if (!neighbors.has(from)) neighbors.set(from,new Map());
      const peers=neighbors.get(from);
      peers.set(to,(peers.get(to)??0)+1);
    }
  }
  return links;
}

const directions=Array.from({length:40},(_,i)=>{
  const z=1-2*(i+.5)/40, phi=i*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(1-z*z);
  return {x:r*Math.cos(phi),y:r*Math.sin(phi),z};
});

// Expand an enclosing sphere to include a newly placed solid ball. Previously
// placed balls retain their clearance, including nodes in mixed-depth parents.
function extend(bound,p,r) {
  const delta=minus(p,bound.p),d=dist(p,bound.p);
  if(d+r<=bound.r)return bound;
  if(d+bound.r<=r)return {p,r};
  const radius=(d+r+bound.r)/2;
  return {p:plus(bound.p,times(delta,(radius-bound.r)/d)),r:radius};
}

function pack(items,adjacency) {
  if (!items.length) return {center:origin(),r:.75,items:[]};
  // Dense imported directories can have hundreds of direct nodes. Pack
  // bounded neighborhoods first, then enclose their bodies; a coarse pass
  // tests disjoint enclosing balls instead of every possible point pair.
  if(items.length>64){
    const sorted=[...items].sort((a,b)=>b.r-a.r || a.source.y-b.source.y || a.source.x-b.source.x || a.id.localeCompare(b.id));
    const clusters=[];
    for(let i=0;i<sorted.length;i+=16){
      const chunk=sorted.slice(i,i+16),body=pack(chunk,adjacency);
      clusters.push({id:String(i),r:body.r,source:chunk[0].source,body});
    }
    const envelope=pack(clusters,new Map());
    const flattened=envelope.items.flatMap(c=>c.body.items.map(item=>({...item,p:plus(c.p,minus(item.p,c.body.center))})));
    return {center:envelope.center,r:envelope.r,items:flattened};
  }
  const degree=id=>Array.from(adjacency.get(id)?.values()??[]).reduce((a,b)=>a+b,0);
  const order=items.map(item=>({...item,degree:degree(item.id)})).sort((a,b)=>b.r-a.r || b.degree-a.degree || a.id.localeCompare(b.id));
  const placed=[{...order[0],p:origin()}];
  let bound={p:origin(),r:order[0].r};
  for (const item of order.slice(1)) {
    let best,score=Infinity;
    const adjacent=adjacency.get(item.id);
    for (const anchor of placed) {
      const clearance=item.r+anchor.r+.17;
      for (const dir of directions) {
        const p=plus(anchor.p,times(dir,clearance));
        if (placed.some(q=>q!==anchor && dist(q.p,p)<q.r+item.r+.1699)) continue;
        // Include branch connectivity and retain a weak preference for the
        // document bearing. Candidate directions span the entire unit sphere.
        const enclosing=extend(bound,p,item.r);
        let cost=0,weights=0;
        if (adjacent) for(const q of placed) {
          const weight=adjacent.get(q.id)??0;
          if(weight) {weights+=weight; cost+=weight*(dist(q.p,p)-q.r-item.r);}
        }
        const dx=item.source.x-anchor.source.x,dy=item.source.y-anchor.source.y;
        const bearing=(dx*dir.x+dy*dir.y)/(Math.hypot(dx,dy)||1);
        const value=enclosing.r+.20*cost/(weights||1)+.09*dist(p,bound.p)-.035*bearing;
        if(value<score) {score=value; best={p,enclosing};}
      }
    }
    // A free point on the positive X side always exists, even after all
    // sampled tangent seats are blocked in a dense heterogeneous group.
    if (!best) {
      const x=Math.max(...placed.map(q=>q.p.x+q.r))+item.r+.17,p={x,y:bound.p.y,z:bound.p.z};
      best={p,enclosing:extend(bound,p,item.r)};
    }
    placed.push({...item,p:best.p}); bound=best.enclosing;
  }
  return {center:bound.p,r:bound.r,items:placed};
}

function spherical(data,tree,spacing) {
  const links=branchLinks(data,tree), packed=new Map();
  for (const g of [...data.groups].sort((a,b)=>b.depth-a.depth)) {
    const children=tree.children.get(g.id),own=tree.owned.get(g.id),adj=links.get(g.id);
    const items=children.map(c=>({id:c.id,r:packed.get(c.id).r,source:midpoint(c.rect),isGroup:true}));
    for (const n of own) {
      const incident=Array.from(adj.get(n.id)?.values()??[]).reduce((a,b)=>a+b,0);
      items.push({id:n.id,r:.44+.035*Math.min(5,Math.sqrt(incident)),source:n,isGroup:false});
    }
    const result=pack(items,adj);
    // Leave a shell clearance for labels / routing. Its relative thickness
    // decreases on large parents instead of multiplying every nesting level.
    result.r+=.28+Math.min(.9,result.r*.07);
    packed.set(g.id,result);
  }
  const roots=data.groups.filter(g=>g.parent==null);
  const forest=pack(roots.map(g=>({id:g.id,r:packed.get(g.id).r,source:midpoint(g.rect)})),new Map());
  const positions=new Map(),centers=new Map();
  function place(id,center) {
    centers.set(id,center);
    const group=packed.get(id);
    for (const child of group.items) {
      const p=plus(center,minus(child.p,group.center));
      if(child.isGroup)place(child.id,p); else positions.set(child.id,p);
    }
  }
  for (const item of forest.items) place(item.id,minus(item.p,forest.center));
  const nearest=nodeSpacing(new Map([...tree.owned].map(([g,ns])=>[g,ns.map(n=>positions.get(n.id))])));
  const scale=spacing/(nearest??1);
  const groups=data.groups.map(g=>{
    const radius=scale*packed.get(g.id).r;
    return {...g,shape:'sphere',center:times(centers.get(g.id),scale),radius,halfWidth:radius,halfHeight:radius};
  });
  return {groups,nodes:data.nodes.map(n=>({...n,p:times(positions.get(n.id),scale)})),spacing,layerGap:spacing};
}

export function layout(data,mode,layerGapMultiplier=1) {
  if (!['plane','offset','sphere'].includes(mode)) throw new RangeError('Unknown layout: '+mode);
  const tree=hierarchy(data);
  const spacing=nodeSpacing(new Map([...tree.owned].map(([g,ns])=>[g,ns.map(n=>({x:n.x,y:n.y,z:0}))])))??140;
  return mode==='sphere'?spherical(data,tree,spacing):planar(data,tree,mode,spacing,layerGapMultiplier);
}
