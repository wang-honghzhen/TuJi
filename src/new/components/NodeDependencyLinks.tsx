import { useMemo } from 'react';
import { visibleDependency } from '@/v3/dependencies';
import type { GraphEdge } from '@/v3/types';
import type { CanvasNodeOption } from '@/v3/layout';
import { duplicatePathIds } from '../graphPathIdentity';
import { GraphPathLabel } from './GraphPathLabel';

export function NodeDependencyLinks({nodeId,edges,options,onLocate}:{
  nodeId:string; edges:GraphEdge[]; options:CanvasNodeOption[]; onLocate:(id:string)=>void;
}) {
  const groups=useMemo(()=>{
    const visible=new Set(options.map(option=>option.id));
    const targets=new Set<string>(),dependents=new Set<string>();
    for(const edge of edges){
      if((edge.sourceNodeId!==nodeId && edge.targetNodeId!==nodeId) || !visibleDependency(edge,id=>visible.has(id)))continue;
      if(edge.sourceNodeId===nodeId)targets.add(edge.targetNodeId);
      else dependents.add(edge.sourceNodeId);
    }
    return [{label:'依赖',items:options.filter(n=>targets.has(n.id))},
      {label:'被依赖',items:options.filter(n=>dependents.has(n.id))}].filter(group=>group.items.length);
  },[edges,nodeId,options]);
  return <>{groups.map(({label,items})=>{
    const suffix=duplicatePathIds(items.map(n=>({id:n.id,label:n.path})));
    return <section key={label} aria-label={label} className="mt-3 border-t border-white/10 pt-2 text-xs">
      <div className="text-slate-400">{label}</div>
      {items.map(n=><button key={n.id} type="button" data-dependency-target={n.id} className="block w-full rounded px-1 py-1 text-left hover:bg-blue-500/15"
        onClick={()=>onLocate(n.id)}><GraphPathLabel segments={n.segments} /> {suffix.get(n.id)}</button>)}
    </section>;
  })}</>;
}
