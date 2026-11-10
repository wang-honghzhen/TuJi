import { useState } from 'react';
import { useAiStore } from '../client';
import type { OrderedTaskSelection } from '../domain';
import { AiChatPage } from './AiChatPage';
import { AiError, AiModal } from './common';
import { historyTurns } from '../history';

/** The flat selection is also the inheritance/eviction order, including interleaved sources. */
export function AiHistoryPicker({ canvasId, initial = [], initialSourceId, singleSource = false, allowAdd = true, maxRounds,
  onApply, onClose, busy = false, error }: { canvasId: string; initial?: OrderedTaskSelection[]; initialSourceId?: string; singleSource?: boolean;
  allowAdd?: boolean; maxRounds?: number; busy?: boolean; error?: string;
  onApply: (selections: OrderedTaskSelection[]) => void; onClose: () => void }) {
  const snapshot = useAiStore(s => s.snapshot);
  const [draft, setDraft] = useState<OrderedTaskSelection[]>(initial);
  const [source, setSource] = useState(initialSourceId ?? initial[0]?.sessionId);
  const sessions = snapshot?.sessions.filter(s => s.canvasId === canvasId && s.mode !== 'temporary' && s.lifecycle !== 'deleted'
    && (!singleSource || s.id === initialSourceId)) ?? [];
  const select = (taskIds: string[]) => setDraft(old => {
    const kept = old.filter(t => t.sessionId !== source || taskIds.includes(t.taskId));
    // A task may be visible through several descendants. An explicit click picks
    // its current source while retaining the task's single place in the order.
    return [...kept.map(t=>taskIds.includes(t.taskId)?{...t,sessionId:source!}:t),
      ...taskIds.filter(id => !kept.some(t => t.taskId === id)).map(taskId => ({ sessionId:source!,taskId }))];
  });
  const move = (index:number,delta:number) => setDraft(old => {
    const next=[...old],target=index+delta;if(target<0||target>=next.length)return old;
    [next[index],next[target]]=[next[target],next[index]];return next;
  });
  return <AiModal title="选择继承任务及顺序" wide onClose={onClose}>
    <AiError text={error} />
    <p className="ai-muted">按点击顺序继承完整任务。可调整顺序，容量不足时最前面的任务先退出提示词。</p>
    {!singleSource && <div className="ai-row">{sessions.map(session => <button key={session.id} className="ai-button" data-ai-select-source={session.id}
      aria-pressed={source===session.id} onClick={()=>setSource(session.id)}>{session.title}</button>)}</div>}
    {source && <div className="ai-history-picker"><AiChatPage canvasId={canvasId} sessionId={source}
      selection={{taskIds:draft.filter(t=>t.sessionId===source).map(t=>t.taskId),onChange:select,maxRounds,allowAdd}} /></div>}
    {!!draft.length && <ol className="ai-column" data-ai-inheritance-order>{draft.map((item,index)=>{
      const turn=snapshot&&historyTurns(snapshot,item.sessionId).find(t=>t.taskId===item.taskId);
      const title=turn?.messages.find(m=>m.id===turn.rootMessageId)?.text??'任务';
      return <li className="ai-row ai-spread" key={item.taskId}><span>{index+1}. {sessions.find(s=>s.id===item.sessionId)?.title} · {title.slice(0,60)}</span>
        <span className="ai-row"><button className="ai-button" aria-label={`上移第${index+1}个任务`} disabled={index===0} onClick={()=>move(index,-1)}>上移</button>
          <button className="ai-button" aria-label={`下移第${index+1}个任务`} disabled={index===draft.length-1} onClick={()=>move(index,1)}>下移</button>
          <button className="ai-button" onClick={()=>setDraft(old=>old.filter(t=>t.taskId!==item.taskId))}>移除</button></span></li>;
    })}</ol>}
    <div className="ai-row"><button className="ai-button" onClick={onClose}>取消</button>
      <button className="ai-button ai-button-primary" data-ai-selection-done data-ai-selection-apply disabled={busy} onClick={()=>onApply(draft)}>{busy?'正在应用…':'应用选择'}</button></div>
  </AiModal>;
}
