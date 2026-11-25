import type { projectSpatialInk } from './projectSpatialInk';

type DrawLine = ReturnType<typeof projectSpatialInk>['lines'][number];
interface StrokeBatch {
  key:string;
  width:number;
  stroke:string;
  alpha:number;
  occluded:boolean;
  paths:string[];
}

/** While a dense sphere is in motion, ordinary strokes can share SVG paint
 * commands. Each original retains its own continuous hit path and arrow. */
export function batchOrbitInk(lines:DrawLine[],pathIds:ReadonlySet<string>,solidStroke:(id:string)=>string|undefined) {
  const ids=new Set<string>(),styles=new Map<string,StrokeBatch>();
  for(const line of lines){
    if(line.kind!=='edge'||line.highlighted||pathIds.has(line.id))continue;
    const stroke=solidStroke(line.id);
    // A gradient has its own screen-space axis. It stays on the original
    // path even during orbit, so its endpoint colors remain attached.
    if(!stroke)continue;
    ids.add(line.id);
    for(const run of line.runs){
      const {width,alpha}=run;
      const key=[stroke,width,alpha].join('/');
      let batch=styles.get(key);
      if(!batch){batch={key,stroke,width,alpha,occluded:!!run.occluded,paths:[]};styles.set(key,batch);}
      let subpath='';
      for(const {x,y} of run.points){
        subpath+=(subpath?'L':'M')+Math.round(x*10)/10+','+Math.round(y*10)/10;
      }
      batch.paths.push(subpath);
    }
  }
  return {ids,styles:Array.from(styles.values()).sort((a,b)=>a.alpha-b.alpha)};
}
