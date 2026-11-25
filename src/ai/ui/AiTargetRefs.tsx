import { Fragment, useId, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { GraphReferenceLabel } from '../../new/components/GraphPathLabel';
import { LocateFixed, X } from 'lucide-react';
import { useAiStore } from '../client';
import { graphTargetName } from '../toolDescriptions';
import type { CanvasTargetGroup } from '../domain';
import { displayTargetGroups } from '../targetGroups';

export function AiTargetRefs({refs,groups,availableRefs,canvasId,names,pending=false,onLocate,onRemoveGroup,removeDisabled=false}:{refs:string[];groups?:CanvasTargetGroup[];availableRefs?:ReadonlySet<string>;canvasId:string;names?:Record<string,string>;pending?:boolean;onLocate?:(refs:string[])=>void;onRemoveGroup?:(groupId:string)=>void;removeDisabled?:boolean}){
  const graph=useAiStore(s=>s.snapshot?.graph);
  const selected = displayTargetGroups(groups, refs);
  const [preview, setPreview] = useState<{ groupId: string; position: CSSProperties } | null>(null);
  const tooltipId = useId();
  const show = (groupId: string, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect(), width = Math.min(320, innerWidth - 16);
    setPreview({ groupId, position: {
      left: Math.max(8, Math.min(bounds.left, innerWidth - width - 8)), maxWidth: width,
      ...(bounds.top > innerHeight / 2 ? { bottom: innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }),
    } });
  };
  const current = selected.find(group => group.groupId === preview?.groupId);
  const name = (ref: string) => names?.[ref] ?? graphTargetName({ graph: graph ?? null }, ref, canvasId);
  if(!selected.length)return null;
  return <div className="ai-target-refs" data-ai-target-refs aria-label={`随消息携带 ${selected.length} 组对象`}>
    <span className="ai-target-caption"><LocateFixed size={13} aria-hidden="true"/>{pending?'将携带':'关联对象'} {selected.length} 组</span>
    {selected.map((group,index)=>{const valid = availableRefs ? group.targetIds.filter(ref => availableRefs.has(ref)) : group.targetIds;
      const missing = group.targetIds.length - valid.length;
      const title=group.targetIds.map(ref=>`${name(ref)}${availableRefs&&!availableRefs.has(ref)?'（已失效）':''}`).join('、');
      const label=`第 ${index+1} 组 · ${group.targetIds.length ? `${group.targetIds.length} 个对象${missing?`（${missing} 个失效）`:''}` : '对象已失效'}`;
      return <span className={`ai-chip${pending&&onRemoveGroup?' ai-target-removable':''}`} key={group.groupId} data-ai-target-group={group.groupId} aria-label={title || '此组对象已不在当前画布中'} onPointerEnter={event => show(group.groupId, event.currentTarget)}
        onPointerLeave={() => setPreview(null)} onFocus={event => show(group.groupId, event.currentTarget)}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null); }}
        onKeyDown={event => { if (event.key === 'Escape') setPreview(null); }}>
      {onLocate?<button type="button" className="ai-target-name" aria-describedby={current?.groupId === group.groupId ? tooltipId : undefined} disabled={!valid.length} onClick={()=>onLocate(valid)}>{label}</button>:<span className="ai-target-name">{label}</span>}
      {pending&&onRemoveGroup&&<button type="button" className="ai-target-remove" data-ai-remove-target-group={group.groupId} title={`移除第 ${index+1} 组`} aria-label={`移除第 ${index+1} 组引用`}
        disabled={removeDisabled} onClick={event=>{event.stopPropagation();onRemoveGroup(group.groupId);}}><X size={11} aria-hidden="true"/></button>}
    </span>;})}
    {current && preview && createPortal(<div id={tooltipId} role="tooltip" className="ai-target-preview" style={preview.position}>
      {current.targetIds.length ? current.targetIds.map((id, i) => <Fragment key={id}>{i > 0 && '、'}
        <GraphReferenceLabel id={id} name={name(id)} graph={graph} canvasId={canvasId} />
        {availableRefs && !availableRefs.has(id) && '（已失效）'}</Fragment>) : '此组对象已不在当前画布中'}
    </div>, document.body)}
  </div>;
}
