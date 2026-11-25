const frames=new WeakMap();

// The display's floor gap follows local node density. Solve cross-deck routes
// in a frame determined solely by deck footprints and depth, then put their
// heights back on the actual published floors. Hand-positioned decks retain
// their measured geometry (and all physical clearances).
export function trunkFrame(world){
  if(!world.steppedDecks)return;
  if(frames.has(world))return frames.get(world);
  const {groups,layerGap}=world.shape;
  if(!(layerGap>0)||!groups.length||!groups.every(g=>g.shape==='plane'&&Number.isInteger(g.depth)&&
      Number.isFinite(g.center.z)&&Math.abs(g.center.z-g.depth*layerGap)<1e-7)){
    frames.set(world,undefined);return;
  }
  const widths=groups.filter(g=>g.parent!=null).map(g=>2*Math.min(g.halfWidth,g.halfHeight))
    .filter(w=>w>0&&Number.isFinite(w)).sort((a,b)=>a-b);
  if(!widths.length){frames.set(world,undefined);return;}
  // A quarter of a typical deck's short side leaves room for a lane and its
  // two terminal approaches. The median is insensitive to the root extent.
  const mid=(widths.length-1)/2,spacing=(widths[Math.floor(mid)]+widths[Math.ceil(mid)])/8;
  const nominalGap=2*spacing;
  const toFloor=new Map(),fromFloor=new Map();
  const decks=groups.map(g=>{
    const z=g.depth*nominalGap;
    toFloor.set(g.center.z,z);fromFloor.set(z,g.center.z);
    return {...g,center:{...g.center,z}};
  });
  const plan={shape:{...world.shape,groups:decks,nodes:[],spacing,layerGap:nominalGap},
    groups:new Map(decks.map(g=>[g.id,g]))};
  const inputPoints=new WeakMap(),outputPaths=new WeakMap();
  function normalize(p){
    let value=inputPoints.get(p);
    if(!value){value={...p,z:toFloor.get(p.z)??(p.z/layerGap*nominalGap)};inputPoints.set(p,value);}
    return value;
  }
  function restore(points){
    let value=outputPaths.get(points);
    if(!value){
      value=points.map(p=>({...p,z:fromFloor.get(p.z)??(p.z/nominalGap*layerGap)}));
      outputPaths.set(points,value);
    }
    return value;
  }
  const frame={plan,normalize,restore};
  frames.set(world,frame);return frame;
}
