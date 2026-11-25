const eps=1e-7,axes=['x','y','z'];
const axis=(a,b)=>axes.find(k=>Math.abs(a[k]-b[k])>eps);
const cross=k=>k==='x'?'y':'x';
const floor=(number,size)=>Math.floor(number/size);

// Density is a property of the published geometry. Disclosing a member cannot
// switch the solver just because one summary disappears from the display.
export function denseDemands(world,index){
  if(index.relations.size<128)return false;
  const size=world.shape.spacing*6,bins=new Map();
  for(const r of index.relations.values()){
    const a=world.groups.get(r.sourceSubgraphId)?.center,b=world.groups.get(r.targetSubgraphId)?.center;
    if(!a||!b)continue;
    const seen=new Set();
    for(const t of [.12,.32,.50,.68,.88]){
      const x=floor(a.x+t*(b.x-a.x),size),y=floor(a.y+t*(b.y-a.y),size);
      const k=x+','+y;if(seen.has(k))continue;seen.add(k);
      const n=(bins.get(k)??0)+1;if(n>=16)return true;bins.set(k,n);
    }
  }
  return false;
}
class BankLedger {
  constructor(s){this.spacing=s;this.gap=s*.125;this.tile=s*4;this.rows={x:new Map(),y:new Map()};this.tiles=new Map();}
  store(points,id,remove=false){
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],k=axis(a,b);if(k!=='x'&&k!=='y')continue;
      const fixed=a[cross(k)],lo=Math.min(a[k],b[k]),hi=Math.max(a[k],b[k]);
      const segment={id,lo,hi,fixed,k};
      const edit=(map,key)=>{
        let items=map.get(key);
        if(remove){if(items){const i=items.findIndex(q=>q.id===id&&q.lo===lo&&q.hi===hi&&q.fixed===fixed);if(i>=0)items.splice(i,1);}}
        else{if(!items)map.set(key,items=[]);items.push(segment);}
      };
      edit(this.rows[k],floor(fixed,this.gap));
      const fc=floor(fixed,this.tile);for(let c=floor(lo,this.tile);c<=floor(hi,this.tile);c++)
        edit(this.tiles,k==='x'?c+','+fc:fc+','+c);
    }
  }
  parallel(k,at,lo,hi){
    const bin=floor(at,this.gap);let cost=0;
    for(let t=bin-1;t<=bin+1;t++)for(const v of this.rows[k].get(t)??[]){
      const gap=Math.abs(at-v.fixed),common=Math.min(hi,v.hi)-Math.max(lo,v.lo);
      if(common<=eps||gap>=this.gap)continue;
      if(gap<eps)cost+=this.spacing*30+common*2;
      if(common>this.spacing*.28)cost+=this.spacing*8+common*.9;
    }
    return cost;
  }
  lanes(record,a,b,k){
    const at=a[cross(k)],lo=Math.min(a[k],b[k]),hi=Math.max(a[k],b[k]),s=this.spacing;
    const reach=Math.min(s*12,Math.max(s*6,(hi-lo)*.32)),min=at-reach,max=at+reach;
    const cuts=[];
    for(const r of record.surfaces){
      if(r.onlyZ!==undefined&&Math.abs(a.z-r.onlyZ)>eps)continue;
      const left=k==='x'?r.left:r.top,right=k==='x'?r.right:r.bottom;
      if(right<=lo+eps||left>=hi-eps)continue;
      const t=k==='x'?r.top:r.left,u=k==='x'?r.bottom:r.right;
      if(t<max&&u>min)cuts.push([Math.max(t,min),Math.min(u,max)]);
    }
    cuts.sort((a,b)=>a[0]-b[0]);const free=[];let from=min;
    for(const [t,u] of cuts){if(t>from)free.push([from,t]);from=Math.max(from,u);}
    if(from<max)free.push([from,max]);
    const candidates=[],pitch=this.gap*1.015;
    for(const [l,r] of free){
      const positions=[];
      for(let offset=l+s*.012;offset<r-s*.012;offset+=pitch){
        // When a run uses all clean seats, a deterministic sub-seat avoids
        // an exact shared centreline while keeping ordinary lanes apart.
        for(const d of [0,record.phase*s*.025]){
          const value=offset+d;if(value>r-s*.008)continue;
          positions.push({value,price:this.parallel(k,value,lo,hi)+Math.abs(value-at)*.6});
        }
      }
      positions.sort((a,b)=>a.price-b.price);candidates.push(...positions.slice(0,5));
    }
    return candidates.sort((a,b)=>a.price-b.price).slice(0,9).map(p=>p.value);
  }
  price(points,limit=Infinity){
    const s=this.spacing,gap=this.gap;
    let price=0;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],k=axis(a,b);if(k!=='x'&&k!=='y')continue;
      const at=a[cross(k)],lo=Math.min(a[k],b[k]),hi=Math.max(a[k],b[k]),bucket=floor(at,gap);
      for(let bin=bucket-1;bin<=bucket+1;bin++)for(const v of this.rows[k].get(bin)??[]){
        const d=Math.abs(at-v.fixed),common=Math.min(hi,v.hi)-Math.max(lo,v.lo);if(d>=gap||common<eps)continue;
        if(d<eps)price+=s*30+common*2;
        if(common>s*.27)price+=s*5+common*(1.6-.9*d/gap);
      }
      if(price>limit)return price;
      const fc=floor(at,this.tile);
      for(let c=floor(lo,this.tile);c<=floor(hi,this.tile);c++){
        const key=k==='x'?c+','+fc:fc+','+c;
        for(const v of this.tiles.get(key)??[]){
          if(v.k===k||v.fixed<=lo+eps||v.fixed>=hi-eps||at<=v.lo+eps||at>=v.hi-eps)continue;
          price+=s*.45;
        }
      }
      if(price>limit)return price;
    }
    return price;
  }
}
function choose(options,ledger){
  let best,cost=Infinity;
  for(const o of options){
    const score=o.score+ledger.price(o.p,cost-o.score);
    if(score<cost){cost=score;best=o;}
  }
  return {best,cost};
}
function spaceRails(record,current,ledger){
  let {best,cost}=current;
  const s=ledger.spacing;
  if(!record.bare||cost-best.score<s)return best;
  for(let i=1;i<best.p.length-2;i++){
    const points=best.p,a=points[i],b=points[i+1],k=axis(a,b);
    if(k==='z'||axis(points[i-1],a)==='z'||axis(b,points[i+2])==='z')continue;
    const v=cross(k);
    const seats=ledger.lanes(record,a,b,k);
    for(const value of seats){
      const shifted=points.slice();
      shifted[i]={...a,[v]:value};shifted[i+1]={...b,[v]:value};
      const trial=record.bare(shifted);if(!trial||trial.topCover>best.topCover+eps||trial.len>1.38*current.best.len+2*s)continue;
      // Evaluate the inexpensive world cost first. Exact title and platform
      // projection are needed only for alternatives that could still win.
      const pressure=ledger.price(trial.p,cost-trial.score);
      if(trial.score+pressure>=cost)continue;
      const full=record.measure(shifted);if(full&&full.score+pressure<cost){best=full;cost=full.score+pressure;}
    }
  }
  return best;
}
export function solveDenseBanks(rows,records,s){
  const ledger=new BankLedger(s),solved=new Map();
  for(const {id} of rows){
    const record=records.get(id);let choice=choose(record.paths,ledger);
    if(record.expand&&choice.cost-choice.best.score>s)choice=choose(record.expand(),ledger);
    const path=spaceRails(record,choice,ledger);
    solved.set(id,path);ledger.store(path.p,id);
  }
  // One bounded revisit, reserved for the most contested corridors.
  const pressure=[];
  for(const [id,path] of solved){
    ledger.store(path.p,id,true);let burden=0;
    for(let i=1;i<path.p.length;i++){
      const a=path.p[i-1],b=path.p[i],k=axis(a,b);if(k==='z')continue;
      burden+=ledger.parallel(k,a[cross(k)],Math.min(a[k],b[k]),Math.max(a[k],b[k]));
    }
    ledger.store(path.p,id);if(burden>s)pressure.push([id,burden]);
  }
  const queued=pressure.sort((a,b)=>b[1]-a[1]).slice(0,Math.ceil(Math.sqrt(rows.length)*6));
  for(const [id] of queued){
    const prior=solved.get(id),record=records.get(id);
    ledger.store(prior.p,id,true);
    const options=record.expand?record.expand():record.paths;
    const path=spaceRails(record,choose([prior,...options],ledger),ledger);
    solved.set(id,path);ledger.store(path.p,id);
  }
  return new Map([...solved].map(([id,o])=>[id,o.p]));
}
