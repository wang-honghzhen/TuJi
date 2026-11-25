import { GraphNameLabel } from './GraphPathLabel';
import { ArrowLeftRight, Route, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { PathStep } from '../spatialPath';
import './spatial-path.css';

interface Props {
  start: string;
  end: string;
  steps: PathStep[] | null | undefined;
  current: string | null;
  nameOf: (id: string) => string;
  onStart: () => void;
  onSwap: () => void;
  onFocus: (id: string) => void;
  onClose: () => void;
}

export function SpatialPathPanel({start,end,steps,current,nameOf,onStart,onSwap,onFocus,onClose}: Props) {
  const heading = useRef<HTMLElement>(null);
  const opened = steps!==undefined;
  useEffect(()=>{
    if (opened && document.activeElement===document.body) heading.current?.focus({preventScroll:true});
  },[opened]);
  if (steps === undefined) return <button type="button" className="spatial-path-start" data-spatial-path-start
    title="沿当前显示关系的方向查找最短路径" onClick={onStart}><Route size={15}/>追踪两点路径</button>;
  return <section className="spatial-path-panel" data-spatial-path-panel ref={heading} tabIndex={-1} aria-label="两点之间的最短路径">
    <header>
      <strong>最短路径</strong>{steps && <span>{steps.length} 步</span>}
      <button type="button" onClick={onSwap} data-spatial-path-swap title="交换起点和终点" aria-label="交换起点和终点"><ArrowLeftRight size={15}/></button>
      <button type="button" onClick={onClose} data-spatial-path-close title="结束追踪" aria-label="结束追踪"><X size={15}/></button>
    </header>
    <p className="spatial-path-endpoints"><GraphNameLabel id={start} name={nameOf(start)} /> → <GraphNameLabel id={end} name={nameOf(end)} /></p>
    {steps ? <ol>{steps.map((s,i)=><li key={s.edge.edgeId}>
      <button type="button" data-spatial-path-step={s.edge.edgeId} aria-current={current===s.edge.edgeId?'step':undefined}
        onClick={()=>onFocus(s.edge.edgeId)} title={`定位第 ${i+1} 段关系`}>
        <span className="spatial-step-number">{i+1}</span>
        <span><GraphNameLabel id={s.from} name={nameOf(s.from)} /> {s.edge.directed?'→':'—'} <GraphNameLabel id={s.to} name={nameOf(s.to)} />
          {s.edge.edgeContent.trim() && <small>{s.edge.edgeContent}</small>}</span>
      </button>
    </li>)}</ol> : <p className="spatial-path-empty" role="status">当前显示的关系中没有这个方向的路径。</p>}
  </section>;
}
