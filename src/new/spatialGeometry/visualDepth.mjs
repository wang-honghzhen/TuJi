// The camera is orthographic. Screen x/y are pixels; depth grows toward
// the viewer in world units. These helpers emit drawing styles only.
const clamp01=n=>Math.max(0,Math.min(1,n));
const tolerance=1e-8;
export const shadowStrokeOpacity=.24;

// Parameter interval of a segment strictly inside a sphere. Setting both
// z terms to zero computes the interval inside its projected disk.
function interior(x,y,z,dx,dy,dz,radius){
  const a=dx*dx+dy*dy+dz*dz, b=x*dx+y*dy+z*dz;
  const c=x*x+y*y+z*z-radius*radius;
  if(a<tolerance)return c<0?[0,1]:null;
  const disc=b*b-a*c;
  if(disc<=0)return null;
  const root=Math.sqrt(disc),lo=Math.max(0,(-b-root)/a),hi=Math.min(1,(-b+root)/a);
  return hi-lo>tolerance?[lo,hi]:null;
}

// In the disk, only points behind the BACK surface see this entire sphere
// in front of them. A containing shell (including an ancestor) therefore
// never obscures its own contents.
function addShadow(intervals,start,end,shell,scale){
  const x=start.x-shell.x,y=start.y-shell.y,z=(start.depth-shell.depth)*scale;
  const dx=end.x-start.x,dy=end.y-start.y,dz=(end.depth-start.depth)*scale;
  if(z>=0&&z+dz>=0)return;
  const disk=interior(x,y,0,dx,dy,0,shell.radius);
  if(!disk)return;
  let [lo,hi]=disk;
  if(dz>0)hi=Math.min(hi,-z/dz);
  if(dz<0)lo=Math.max(lo,-z/dz);
  if(hi-lo<=tolerance)return;
  const inside=interior(x,y,z,dx,dy,dz,shell.radius);
  if(!inside||inside[1]<=lo||inside[0]>=hi){intervals.push([lo,hi]);return;}
  if(inside[0]-lo>tolerance)intervals.push([lo,inside[0]]);
  if(hi-inside[1]>tolerance)intervals.push([inside[1],hi]);
}

export function createShellOcclusion(shells,scale){
  // World-relative cells bound the index size even under large zoom.
  const size=shells.reduce((n,s)=>Math.max(n,s.radius/4),48);
  const cells=new Map();
  function visit(x0,y0,x1,y1,fn){
    for(let x=Math.floor(x0/size);x<=Math.floor(x1/size);x++)
      for(let y=Math.floor(y0/size);y<=Math.floor(y1/size);y++)fn(x+','+y);
  }
  for(const s of shells){
    visit(s.x-s.radius,s.y-s.radius,s.x+s.radius,s.y+s.radius,key=>{
      if(!cells.has(key))cells.set(key,[]);
      cells.get(key).push(s);
    });
  }
  function behind(p){
    const cell=cells.get(Math.floor(p.x/size)+','+Math.floor(p.y/size));
    if(!cell)return false;
    for(const s of cell){
      if(p.depth>=s.depth)continue;
      const x=p.x-s.x,y=p.y-s.y,z=(p.depth-s.depth)*scale;
      const chord=s.radius*s.radius-x*x-y*y;
      if(chord>0&&z*z>chord+tolerance)return true;
    }
    return false;
  }
  function coversShell(shell){
    const cell=cells.get(Math.floor(shell.x/size)+','+Math.floor(shell.y/size));
    if(!cell)return false;
    for(const other of cell){
      if(other.depth<=shell.depth||other.radius<shell.radius)continue;
      const dx=other.x-shell.x,dy=other.y-shell.y,dz=(other.depth-shell.depth)*scale;
      const lateral=dx*dx+dy*dy,clearance=other.radius-shell.radius,separation=other.radius+shell.radius;
      // Nested groups remain transparent to their contents. A whole shell
      // recedes only behind a disjoint sphere that covers its entire disk.
      if(lateral<=clearance*clearance&&lateral+dz*dz>=separation*separation)return true;
    }
    return false;
  }
  function shadows(a,b){
    const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
    const x0=Math.floor(left/size),x1=Math.floor(right/size),y0=Math.floor(top/size),y1=Math.floor(bottom/size);
    const intervals=[];
    const check=s=>{
      if(s.x+s.radius>=left&&s.x-s.radius<=right&&s.y+s.radius>=top&&s.y-s.radius<=bottom)
        addShadow(intervals,a,b,s,scale);
    };
    if(x0===x1&&y0===y1){
      const cell=cells.get(x0+','+y0);
      if(cell)for(const shell of cell)check(shell);
    }else if((x1-x0+1)*(y1-y0+1)>shells.length){
      // Long links between distant shells may span millions of empty cells.
      for(const shell of shells)check(shell);
    }else{
      const visited=new Set();
      visit(left,top,right,bottom,key=>{
        const cell=cells.get(key);
        if(cell)for(const s of cell){
          if(visited.has(s))continue;
          visited.add(s);check(s);
        }
      });
    }
    if(intervals.length>1){
      intervals.sort((u,v)=>u[0]-v[0]);
      let last=0;
      for(let i=1;i<intervals.length;i++){
        const previous=intervals[last],next=intervals[i];
        if(next[0]<=previous[1]+tolerance)previous[1]=Math.max(previous[1],next[1]);
        else intervals[++last]=next;
      }
      intervals.length=last+1;
    }
    return intervals;
  }
  return {behind,coversShell,shadows};
}

// Split where a canonical segment enters or exits a shell's shadow. Emit
// the cut on the displayed polyline so spread endpoints remain attached.
export function shellStrokeRuns(shells,ink,canonicalPoints){
  const points=ink.points,runs=[];
  function append(a,b,lo,hi,occluded){
    if(hi-lo<=tolerance)return;
    const end=interpolate(a,b,hi),previous=runs.at(-1);
    if(previous?.occluded===occluded)previous.points.push(end);
    else runs.push({...ink,points:[interpolate(a,b,lo),end],occluded,alpha:occluded?shadowStrokeOpacity:ink.alpha});
  }
  for(let i=1;i<points.length;i++){
    const intervals=shells.shadows(canonicalPoints[i-1],canonicalPoints[i]);
    if(!runs.length){
      if(!intervals.length)continue;
      if(i>1)runs.push({...ink,points:points.slice(0,i),occluded:false});
    }
    let at=0;
    const a=points[i-1],b=points[i];
    for(const [lo,hi] of intervals){
      append(a,b,at,lo,false);append(a,b,lo,hi,true);at=hi;
    }
    append(a,b,at,1,false);
  }
  return runs.length?runs:[ink];
}

function interpolate(a,b,t){
  if(t===0)return a;
  if(t===1)return b;
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,depth:a.depth+(b.depth-a.depth)*t};
}

export function createDepthView(layout,frame){
  const spherical=layout.groups.some(g=>g.shape==='sphere');
  const roots=layout.groups.filter(g=>g.parent==null);
  const shells=spherical?createShellOcclusion(layout.groups.filter(g=>g.shape==='sphere'&&(roots.length!==1||g!==roots[0]))
    .map(g=>({...frame.project(g.center),radius:g.radius*frame.scale})),frame.scale):null;
  let far=Infinity,near=-Infinity;
  if(spherical)for(const node of layout.nodes){
    const d=frame.project(node.p).depth;
    far=Math.min(far,d);near=Math.max(near,d);
  }
  const range=near-far;
  const proximity=d=>range>tolerance?clamp01((d-far)/range):.5;

  function nodeAlpha(point,{selected=false}={}){
    if(selected)return 1;
    let alpha=spherical?.65+.34*proximity(point.depth):.97;
    if(shells?.behind(point))alpha*=.80;
    return alpha;
  }

  // Pass the displayed polyline. Optional canonicalPoints allow collision
  // tests on its original projection when drawing offset endpoints.
  function edgeRuns(points,{selected=false,canonicalPoints=points}={}){
    if(points.length<2)return [];
    if(selected)return [{points,width:2.2,alpha:1,dashed:false}];
    const width=1.25, alpha=.74;
    if(!shells)return [{points,width,alpha,dashed:false}];
    const runs=[];
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],rawA=canonicalPoints[i-1],rawB=canonicalPoints[i];
      const intervals=shells.shadows(rawA,rawB);
      function emit(lo,hi,dashed){
        if(hi-lo<=tolerance)return;
        const rawMid=(rawA.depth+((lo+hi)/2)*(rawB.depth-rawA.depth));
        const weight=Math.max(.22,alpha*(.67+.33*proximity(rawMid))*(dashed?.78:1));
        const start=interpolate(a,b,lo),end=interpolate(a,b,hi),previous=runs.at(-1);
        if(previous&&previous.dashed===dashed&&Math.abs(previous.alpha-weight)<.045)previous.points.push(end);
        else runs.push({points:[start,end],width,alpha:weight,dashed});
      }
      function span(lo,hi,dashed){
        // Depth gradient on long straight connections, with a small bounded
        // number of samples independent of zoom or frame rate.
        const steps=Math.max(1,Math.ceil(Math.abs(proximity(rawB.depth)-proximity(rawA.depth))*(hi-lo)*4));
        for(let j=0;j<steps;j++)emit(lo+(hi-lo)*j/steps,j+1===steps?hi:lo+(hi-lo)*(j+1)/steps,dashed);
      }
      let at=0;
      for(const [lo,hi] of intervals){
        span(at,lo,false);span(lo,hi,true);at=hi;
      }
      span(at,1,false);
    }
    return runs;
  }
  return {nodeAlpha,edgeRuns};
}
