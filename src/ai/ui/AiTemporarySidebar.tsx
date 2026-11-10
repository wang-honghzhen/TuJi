import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, ChevronsRight, GripVertical, ChevronDown, X } from 'lucide-react';
import { useAiStore } from '../client';
import type { OrderedTaskSelection, Session, TemporaryMode } from '../domain';
import { temporaryModeDescriptions, temporaryMode } from '../temporaryModes';
import { closeTemporarySession, defaultTemporaryWindow, fitTemporaryWindow, touchTemporarySession, useTemporaryWindows, type TemporaryWindow } from '../temporaryWindows';
import { AiChatPage } from './AiChatPage';
import { AiHistoryPicker } from './AiHistoryPicker';
import { AiError, useAction } from './common';

const resizeDirections = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] as const;

function FloatingTemporary({ session, index }: { session: Session; index: number }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command);
  const enteredId = useAiStore(s => s.enteredSessionByCanvas[session.canvasId]);
  const bounds = useTemporaryWindows(s => s.windows[session.id]) ?? defaultTemporaryWindow(index);
  const focused = useTemporaryWindows(s => s.focusedId === session.id);
  const [choosing, setChoosing] = useState(false);
  const [choosingSource,setChoosingSource]=useState<string>();
  const [modeOpen,setModeOpen]=useState(false);
  const modeMenu=useRef<HTMLDivElement>(null);
  const modeDrawer=useRef<HTMLDivElement>(null);
  const anchor=modeMenu.current?.getBoundingClientRect();
  useEffect(()=>{if(!modeOpen)return;const close=(e:globalThis.PointerEvent)=>{if(!modeMenu.current?.contains(e.target as Node)&&!modeDrawer.current?.contains(e.target as Node))setModeOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setModeOpen(false);};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    const resized=()=>setModeOpen(false);window.addEventListener('resize',resized);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);window.removeEventListener('resize',resized);};},[modeOpen]);
  const gesture = useRef<{ pointerId: number; x: number; y: number; bounds: TemporaryWindow; direction: string }>();
  const action = useAction();
  const current = snapshot?.sessions.find(s => s.id === enteredId && s.mode !== 'temporary' && s.lifecycle !== 'deleted');
  const workspace = snapshot?.workspaces.find(w => w.id === session.workspaceId);
  const sourceId = session.temporaryContext?.sourceSessionId;
  const memories = snapshot?.snapshots.filter(s => workspace?.snapshotIds.includes(s.id)) ?? [];
  const source = snapshot?.sessions.find(s=>s.id===sourceId);
  const sourceName = source?.title || memories.find(m=>m.sourceSessionId===sourceId)?.sourceTitle;
  const sourceLabel = source && source.lifecycle!=='deleted' ? sourceName : sourceName ? `${sourceName}（已删除）` : '来源会话已不可用';
  const taskIds = workspace?.sessionContext?.taskOrder ?? [...new Set(memories.flatMap(s => s.sourceTaskIds))];
  const locked = !!session.temporaryContext?.lockedAt || !!snapshot?.tasks.some(t=>t.sessionId===session.id);
  const sourceBusy=!!snapshot?.tasks.some(t=>t.sessionId===current?.id&&t.status!=='completed');
  const mode=temporaryMode(session)??'minimal';
  const labels:Record<TemporaryMode,string>={minimal:'极简',branch:'分支',custom:'自定义'};
  const configure=async(next:TemporaryMode,ids:string[]=[],source=current?.id)=>{
    await command('temporary.configure',{sessionId:session.id,mode:next,sourceSessionId:source,currentSessionId:current?.id,orderedTasks:ids.map(taskId=>({sessionId:source!,taskId})),expectedRevision:session.temporaryContext?.revision??1});
    setModeOpen(false);
  };
  const select = async (selection: OrderedTaskSelection[]) => {
    await configure('custom',selection.map(t=>t.taskId),selection[0]?.sessionId??choosingSource);
    setChoosing(false);
  };
  const begin = (event: PointerEvent<HTMLElement>, direction = '') => {
    if (event.button !== 0 || (!direction && (event.target as Element).closest('button,input,select,a'))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds, direction };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y, rect = start.bounds;
    let next = { ...rect };
    if (!start.direction) next = { ...rect, x: rect.x + dx, y: rect.y + dy };
    else {
      if (start.direction.includes('e')) next.width = rect.width + dx;
      if (start.direction.includes('s')) next.height = rect.height + dy;
      if (start.direction.includes('w')) { next.width = Math.max(Math.min(360, window.innerWidth - 16), rect.width - dx); next.x = rect.x + rect.width - next.width; }
      if (start.direction.includes('n')) { next.height = Math.max(Math.min(360, window.innerHeight - 16), rect.height - dy); next.y = rect.y + rect.height - next.height; }
    }
    useTemporaryWindows.getState().update(session.id, next);
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    if (!gesture.current.direction && event.clientX >= window.innerWidth - 24) useTemporaryWindows.getState().update(session.id, { hidden: true });
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <aside className="ai-temporary-sidebar" data-ai-temporary-sidebar data-session-id={session.id} data-focused={focused}
    aria-label={`临时会话 ${index + 1}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, zIndex: focused ? 202 : 201 }}
    onPointerDownCapture={() => {useTemporaryWindows.getState().focus(session.id);touchTemporarySession(session.id);}} onInputCapture={()=>touchTemporarySession(session.id)} onWheelCapture={()=>touchTemporarySession(session.id)} onKeyDownCapture={()=>touchTemporarySession(session.id)} onPointerMove={move} onPointerUp={end}
    onPointerCancel={() => { gesture.current = undefined; }} onLostPointerCapture={() => { gesture.current = undefined; }}>
    <AiChatPage canvasId={session.canvasId} sessionId={session.id} onHeadingPointerDown={begin}
      headingSubtitle={mode!=='minimal'&&<span className="ai-temporary-source" data-ai-memory-source={sourceId} title={`记忆来源：${sourceLabel}`}>记忆来源：{sourceLabel}</span>}
      headingExtra={<><GripVertical className="ai-temporary-grip" size={14} aria-hidden="true" />
        <div ref={modeMenu} className="relative">
          <button className="ai-button ai-temporary-select" disabled={action.busy} data-ai-temporary-select aria-expanded={modeOpen} aria-haspopup="menu"
            title={`${temporaryModeDescriptions[mode]}${locked?' 已开始对话，模式及选区已锁定。':''}`} onClick={()=>setModeOpen(v=>!v)}>{labels[mode]}<ChevronDown size={12}/></button>
          {modeOpen&&anchor&&createPortal(<div ref={modeDrawer} role="menu" data-ai-temporary-modes className="space-menu fixed w-72 p-2 rounded-lg shadow-xl overflow-y-auto"
            style={{left:Math.max(8,Math.min(anchor.left,window.innerWidth-296)),top:anchor.bottom+6,maxHeight:Math.max(120,window.innerHeight-anchor.bottom-14),zIndex:3100}}>
            {(['branch','minimal','custom'] as const).map(next=>{const unavailable=locked?'已开始对话，不能更换模式':next!=='minimal'&&!current?'请先进入一个普通会话':next==='branch'&&sourceBusy?'来源会话任务尚未结束，暂不能启用分支':'';
              return <div key={next} title={unavailable||temporaryModeDescriptions[next]}><button type="button" role="menuitemradio" aria-checked={mode===next} data-ai-temporary-mode={next}
                disabled={action.busy||!!unavailable} className="w-full text-left rounded px-3 py-2 hover:bg-white/10 disabled:opacity-45"
                onClick={()=>{if(next==='custom'){setChoosingSource(current?.id);setModeOpen(false);setChoosing(true);}else void action.run(()=>configure(next));}}>
                <span className="block text-sm">{labels[next]}{mode===next?' · 当前':''}</span><span className="block text-xs text-slate-400 mt-1 whitespace-normal">{unavailable||temporaryModeDescriptions[next]}</span></button></div>;})}
            {sourceId&&<p className="px-3 py-2 text-xs text-slate-400 whitespace-normal">来源：{snapshot?.sessions.find(s=>s.id===sourceId)?.title??'已不可用'}{mode==='custom'?` · 已选 ${taskIds.length} 个任务`:''}</p>}
            <p className="px-3 py-1 text-xs text-slate-500">闲置一小时后自动清理</p>
          </div>,document.body)}
        </div></>}
      headingActions={<><button type="button" className="sidebar-toggle" data-side="right" data-mode="collapse" aria-expanded="true" aria-label="收起到右侧" title="收起到右侧书签" data-ai-dock-temporary onClick={() => useTemporaryWindows.getState().update(session.id, { hidden: true })}><ChevronsRight size={18} strokeWidth={2.2} aria-hidden="true" /></button>
        <button className="ai-icon-button" aria-label="关闭并删除临时会话" title="关闭并删除临时会话记录" disabled={action.busy} onClick={() => void action.run(() => closeTemporarySession(session.id))}><X size={16} /></button></>} />
    {action.error && <div className="ai-temporary-error"><AiError text={action.error} /></div>}
    {resizeDirections.map(direction => <div key={direction} className={`ai-temporary-resize ai-temporary-resize-${direction}`} data-ai-resize-temporary={direction}
      role="separator" tabIndex={0} aria-label={`调整临时会话大小 ${direction}`} onPointerDown={event => begin(event, direction)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        useTemporaryWindows.getState().update(session.id, { width: bounds.width + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0),
          height: bounds.height + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0) });
      }} />)}
    {choosing && <AiHistoryPicker canvasId={session.canvasId} initialSourceId={choosingSource} singleSource allowAdd={!locked && !!current}
      busy={action.busy} error={action.error} initial={sourceId===current?.id&&sourceId ? taskIds.map(taskId=>({sessionId:sourceId,taskId})) : []}
      onClose={() => setChoosing(false)} onApply={selection => void action.run(() => select(selection))} />}
  </aside>;
}

export function AiTemporarySidebar({ canvasId }: { canvasId: string }) {
  const allSessions = useAiStore(s => s.snapshot?.sessions);
  const sessions = allSessions?.filter(s => s.canvasId === canvasId && s.mode === 'temporary' && s.lifecycle === 'active') ?? [];
  const windows = useTemporaryWindows(s => s.windows);
  useEffect(() => {
    const fit = () => { const ui = useTemporaryWindows.getState(); for (const [id, bounds] of Object.entries(ui.windows)) ui.update(id, fitTemporaryWindow(bounds)); };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const hidden = sessions.filter(s => windows[s.id]?.hidden);
  return <>
    {sessions.filter(s => !windows[s.id]?.hidden).map((session, index) => <FloatingTemporary key={session.id} session={session} index={index} />)}
    {!!hidden.length && <nav className="ai-temporary-bookmarks" aria-label="收起的临时会话">
      {hidden.slice(0, 3).map((session, index) => <button key={session.id} className="ai-temporary-bookmark" data-ai-temporary-bookmark={session.id}
        title={`展开临时会话 ${index + 1}`} aria-label={`展开临时会话 ${index + 1}`} onClick={() => {touchTemporarySession(session.id); const ui = useTemporaryWindows.getState(); ui.update(session.id, { hidden: false }); ui.focus(session.id); }}>
        <Bookmark size={16} /><span>临时 {index + 1}</span></button>)}
    </nav>}
  </>;
}
