import { LocateFixed, X } from 'lucide-react';
import { useAiStore } from '../client';
import { graphTargetName } from '../toolDescriptions';

export function AiTargetRefs({refs,canvasId,names,pending=false,onLocate,onRemove,removeDisabled=false}:{refs:string[];canvasId:string;names?:Record<string,string>;pending?:boolean;onLocate?:(refs:string[])=>void;onRemove?:(ref:string)=>void;removeDisabled?:boolean}){
  const graph=useAiStore(s=>s.snapshot?.graph);
  if(!refs.length)return null;
  return <div className="ai-target-refs" data-ai-target-refs aria-label={`随消息携带 ${refs.length} 项对象`}>
    <span className="ai-target-caption"><LocateFixed size={13} aria-hidden="true"/>{pending?'将携带':'关联对象'} {refs.length} 项</span>
    {refs.map(ref=>{const name=names?.[ref]??graphTargetName({graph:graph??null},ref,canvasId);return <span className={`ai-chip${pending&&onRemove?' ai-target-removable':''}`} key={ref} data-ai-target-ref={ref} title={name}>
      {onLocate?<button type="button" className="ai-target-name" onClick={()=>onLocate([ref])}>{name}</button>:<span className="ai-target-name">{name}</span>}
      {pending&&onRemove&&<button type="button" className="ai-target-remove" data-ai-remove-target={ref} title={`移除引用：${name}`} aria-label={`移除引用 ${name}`}
        disabled={removeDisabled} onClick={event=>{event.stopPropagation();onRemove(ref);}}><X size={11} aria-hidden="true"/></button>}
    </span>;})}
  </div>;
}
