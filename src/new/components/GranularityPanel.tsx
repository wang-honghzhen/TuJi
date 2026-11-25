import { GranularityObjectSelect } from './GranularityObjectSelect';
import { GraphNameLabel } from './GraphPathLabel';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { groupExpanded, groupSettings, relationSettings, type CanvasGranularity, type GranularityIndex,
  type GroupSettings, type RelationSettings } from '../canvasGranularity';
import './granularity.css';

interface Props {
  id: string;
  index: GranularityIndex;
  settings: CanvasGranularity;
  name: (id:string)=>string;
  onChoose: (id:string)=>void;
  onGroup: (id:string,patch:GroupSettings)=>void;
  onRelation: (id:string,config:RelationSettings)=>void;
  onLocate: (edgeId:string)=>void;
  onClose: ()=>void;
  style: CSSProperties;
}

export function GranularityPanel({id,index,settings,name,onChoose,onGroup,onRelation,onLocate,onClose,style}: Props) {
  const relation=index.relations.get(id), current=relationSettings(settings,id);
  const group=groupSettings(settings,id);
  const partialMembers=new Set(current.mode==='partial'?current.memberIds:[]);
  const members=new Set(relation?.memberEdgeIds.filter(key=>current.mode==='expanded'||partialMembers.has(key)));
  const toggleMember=(member:string, checked:boolean)=>{
    if(!relation)return;
    if(checked)members.add(member);else members.delete(member);
    const ids=relation.memberEdgeIds.filter(edge=>members.has(edge));
    onRelation(id,ids.length===relation.relationCount?{mode:'expanded'}:ids.length?{mode:'partial',memberIds:ids}:{mode:'aggregate'});
  };
  return <section className="canvas-granularity-panel" data-canvas-interactive data-granularity-panel={id} role="region" aria-label="局部显示粒度" style={style}
    onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}>
    <header><strong>{relation?'子图间关系':'子图显示'}</strong><button onClick={onClose} aria-label="关闭粒度面板"><X size={16}/></button></header>
    <GranularityObjectSelect id={id} index={index} name={name} onChoose={onChoose} />
    {relation ? <>
      <div className="granularity-actions">{(['aggregate','expanded','hidden'] as const).map((mode,i)=><button key={mode} data-relation-setting={mode}
        aria-pressed={current.mode===mode} onClick={()=>onRelation(id,{mode})}>{['聚合','展开全部成员','隐藏'][i]}</button>)}</div>
      <p>{relation.relationCount} 条原始关系 · 已展开 {members.size} 条</p>
      <ul>{relation.memberEdgeIds.map(key=>{
        const e=index.edgesById.get(key)!;
        return <li key={key}><label><input type="checkbox" data-relation-member={key} checked={members.has(key)}
          onChange={ev=>toggleMember(key,ev.target.checked)}/><span><GraphNameLabel id={e.sourceNodeId} name={name(e.sourceNodeId)} /> {e.directed?'→':'—'} <GraphNameLabel id={e.targetNodeId} name={name(e.targetNodeId)} />
          {e.edgeContent&&<small>{e.edgeContent}</small>}</span></label>
          <button title="展开并定位这条原始关系" data-member-locate={key} onClick={()=>onLocate(key)}>定位</button></li>;
      })}</ul></> : <>
      <label><input type="checkbox" data-group-expanded checked={groupExpanded(index,settings,id)}
        onChange={e=>onGroup(id,{expanded:e.target.checked})}/>展开子图内容</label>
      <label><input type="checkbox" data-group-internal checked={group.internalEdges}
        onChange={e=>onGroup(id,{internalEdges:e.target.checked})}/>显示内部关系</label>
      <label>子图内观察范围<select data-group-focus value={group.focusNodeId??''} onChange={e=>onGroup(id,{focusNodeId:e.target.value||null})}>
        <option value="">全部直接节点</option>{[...index.nodeIds].filter(key=>index.parents.get(key)===id).map(key=>
          <option value={key} key={key}>{name(key)}及其邻居</option>)}</select></label>
    </>}
  </section>;
}
