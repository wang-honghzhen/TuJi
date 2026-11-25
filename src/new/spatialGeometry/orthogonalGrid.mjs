const epsilon=1e-7;
function push(heap,e){
  let i=heap.length;heap.push(e);
  while(i){const j=(i-1)>>1;if(heap[j][0]<=e[0])break;heap[i]=heap[j];i=j;}heap[i]=e;
}
function pop(heap){
  const top=heap[0],last=heap.pop();
  if(heap.length){let i=0;
    while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][0]<heap[j][0])j++;
      if(heap[j][0]>=last[0])break;heap[i]=heap[j];i=j;}heap[i]=last;
  }
  return top;
}
function coords(a,b,rects,k,pad,space,traffic){
  const lo=Math.min(a[k],b[k])-space*5.8,hi=Math.max(a[k],b[k])+space*5.8;
  const keys=new Set([a[k],b[k],lo,hi]);
  for(const r of rects)for(const x of k==='x'?[r.left-pad,r.right+pad]:[r.top-pad,r.bottom+pad])
    if(x>lo&&x<hi)keys.add(x);
  const endpoints=new Set();
  for(const line of traffic)for(const p of [line.p[0],line.p.at(-1)]){
    if(p[k]>lo&&p[k]<hi)endpoints.add(p[k]);
  }
  const center=(a[k]+b[k])/2,close=[...endpoints].sort((p,q)=>Math.abs(p-center)-Math.abs(q-center)).slice(0,8);
  for(const v of close){keys.add(v-pad);keys.add(v+pad);}
  return [...keys].sort((u,v)=>u-v);
}
function obstaclesAt(coordinate,k,rects){
  return rects.filter(r=>k===0?coordinate>r.top+epsilon&&coordinate<r.bottom-epsilon:
    coordinate>r.left+epsilon&&coordinate<r.right-epsilon)
    .map(r=>k===0?[r.left,r.right]:[r.top,r.bottom]);
}
function trafficAt(value,k,placed,spacing){
  const crossings=[],parallel=[];
  for(const o of placed)for(const s of o.sheet){
    if(k===0&&Math.abs(s.dx)<epsilon&&value>s.t+epsilon&&value<s.b-epsilon)crossings.push(s.x);
    if(k===1&&Math.abs(s.dy)<epsilon&&value>s.l+epsilon&&value<s.r-epsilon)crossings.push(s.y);
    if(k===0&&Math.abs(s.dy)<epsilon&&Math.abs(value-s.y)<spacing*.12)parallel.push([s.l,s.r]);
    if(k===1&&Math.abs(s.dx)<epsilon&&Math.abs(value-s.x)<spacing*.12)parallel.push([s.t,s.b]);
  }
  return {crossings,parallel};
}
// Compressed orthogonal visibility grid. Only crossings between actual obstacle
// rim tracks or the two endpoint stubs can be bends. A* retains incoming axis.
export function gridPassage(a,b,sa,sb,rects,placed,spacing,phase){
  const bounded=rects.filter(r=>r.right>=Math.min(a.x,b.x)-spacing*5.8&&r.left<=Math.max(a.x,b.x)+spacing*5.8&&
    r.bottom>=Math.min(a.y,b.y)-spacing*5.8&&r.top<=Math.max(a.y,b.y)+spacing*5.8);
  const pad=spacing*(.13+.20*phase),xs=coords(a,b,bounded,'x',pad,spacing,placed),ys=coords(a,b,bounded,'y',pad,spacing,placed);
  const nx=xs.length,ny=ys.length;
  if(nx*ny>6500)return;
  const source=ys.indexOf(a.y)*nx+xs.indexOf(a.x),target=ys.indexOf(b.y)*nx+xs.indexOf(b.x);
  const dist=new Float64Array(nx*ny*2).fill(Infinity),parent=new Int32Array(dist.length).fill(-1);
  const horiz=[],vert=[],costs=new Float64Array(nx*ny*2).fill(-1);
  function cost(i,j,k){
    const index=2*(j*nx+i)+k;
    if(costs[index]!==-1)return costs[index];
    const values=k===0?xs:ys,sub=k===0?i:j,t=k===0?ys[j]:xs[i];
    const caches=k===0?horiz:vert,pos=k===0?j:i;
    const lane=caches[pos]??={blocks:obstaclesAt(t,k,bounded),...trafficAt(t,k,placed,spacing)};
    const low=values[sub],high=values[sub+1];let value=high-low;
    if(lane.blocks.some(([a,b])=>low<b-epsilon&&high>a+epsilon))value=Infinity;
    else{
      for(const cross of lane.crossings)if(cross>low+epsilon&&cross<=high+epsilon)value+=spacing*8;
      for(const [a,b] of lane.parallel){const common=Math.min(high,b)-Math.max(low,a);
        if(common>epsilon)value+=common*3+spacing*.6;}
    }
    return costs[index]=value;
  }
  const direct=sa.axis==='x'?0:1,seed=2*source+direct,heap=[];
  const estimate=(i,j)=>Math.abs(xs[i]-b.x)+Math.abs(ys[j]-b.y);
  dist[seed]=0;push(heap,[0,seed,0]);
  while(heap.length){
    const [,state,current]=pop(heap);if(dist[state]!==current)continue;
    const cell=state>>1,i=cell%nx,j=(cell/nx)|0,axis=state&1;
    if(cell===target){
      const points=[];let at=state;
      while(at!==-1){const n=at>>1;points.push({x:xs[n%nx],y:ys[(n/nx)|0]});at=parent[at];}
      return points.reverse();
    }
    for(let k=0;k<2;k++)for(const sign of [-1,1]){
      const x=i+(k===0?sign:0),y=j+(k===1?sign:0);if(x<0||x>=nx||y<0||y>=ny)continue;
      const next=y*nx+x;
      if(cell===source&&k===direct&&sign!==sa.sign)continue;
      const arrive=sb.axis==='x'?0:1;
      if(next===target&&k===arrive&&sign===sb.sign)continue;
      const toll=cost(Math.min(i,x),Math.min(j,y),k);
      const value=current+toll+(axis===k?0:spacing*.88)+(next===target&&k!==arrive?spacing*.88:0);
      const id=2*next+k;
      if(value>=dist[id])continue;
      dist[id]=value;parent[id]=state;push(heap,[value+estimate(x,y),id,value]);
    }
  }
}
