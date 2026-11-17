import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Copy, Folder, FolderTree, Move, MessagesSquare, PanelRight, X } from 'lucide-react';
import { useAiStore } from '@/ai/client';
import type { Session } from '@/ai/domain';
import { isDesktopTemporary, isGlobalTemporary, isIndependentTemporary, temporaryLabel } from '@/ai/temporaryModes';
import { closeTemporarySession, touchTemporarySession } from '@/ai/temporaryWindows';
import { TemporaryChat } from '@/ai/ui/AiTemporarySidebar';
import { UserNotebook } from '@/ai/ui/UserNotebook';
import { AiError, useAction } from '@/ai/ui/common';
import { panelCommand, usePanelState } from './panelState';
import { reconcileNotebookView } from './notebookViewState';
import './companion.css';

export function UtilityPanel({ canvasId }: { canvasId?: string }) {
  const ui = usePanelState(), snapshot = useAiStore(s => s.snapshot);
  const entered = useAiStore(s => s.enteredSessionByCanvas);
  const role = window.tujiDesktop?.role ?? 'main';
  const action = useAction();
  const canvas = canvasId ?? ui.canvasId;
  const canvasSessions = snapshot?.sessions.filter(s => s.mode === 'temporary' && !isIndependentTemporary(s) && s.lifecycle === 'active' && s.canvasId === canvas) ?? [];
  const globalSessions = snapshot?.sessions.filter(s => isGlobalTemporary(s) && s.lifecycle === 'active') ?? [];
  const desktopSessions = snapshot?.sessions.filter(s => isDesktopTemporary(s) && s.lifecycle === 'active') ?? [];
  const sessions = [...(ui.background ? [] : canvasSessions), ...globalSessions, ...desktopSessions];
  const selected = sessions.find(s => s.id === ui.activeTab);
  const noteTabs = ui.noteTabs ?? [];
  const notebookSelected = ui.activeTab === 'notebook' || ui.activeTab === 'note-directory' || noteTabs.some(tab => tab.id === ui.activeTab);
  const visible = ui.ready && ui.host === role;
  const [mounted, setMounted] = useState(visible), [shown, setShown] = useState(false);
  const [floating, setFloating] = useState({ x: Math.max(12, innerWidth - 550), y: 56 });
  const gesture = useRef<{ x: number; y: number; width: number; left: number; top: number; drag: boolean; native: boolean; pointerId: number; target: HTMLElement }>();
  const [dragging, setDragging] = useState(false);
  const [edgeTab, setEdgeTab] = useState({ theme: 'note', selected: false });
  const header = useRef<HTMLElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const tabKey = [...noteTabs.map(tab => tab.id), ...sessions.map(session => session.id)].join('|');
  useLayoutEffect(() => {
    const bar = header.current, scroll = tabs.current;
    if (!mounted || !bar || !scroll) return;
    const update = () => {
      const viewport = scroll.getBoundingClientRect();
      const candidates = [...scroll.querySelectorAll<HTMLElement>('.utility-tab')].filter(tab => {
        const rect = tab.getBoundingClientRect();
        return rect.right > viewport.left + 1 && rect.left < viewport.right - 1;
      });
      const nearest = candidates.at(-1) ?? bar.querySelector<HTMLElement>('.utility-tab-pins .utility-tab:last-child');
      const theme = nearest?.dataset.theme ?? 'note', selected = nearest?.dataset.selected === 'true';
      setEdgeTab(previous => previous.theme === theme && previous.selected === selected ? previous : { theme, selected });
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    scroll.querySelectorAll('.utility-tab').forEach(tab => observer.observe(tab));
    scroll.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); scroll.removeEventListener('scroll', update); };
  }, [mounted, tabKey, ui.activeTab]);
  useEffect(() => {
    if (role !== 'main') return;
    void panelCommand('set-context', { canvasId: canvas ?? '', enteredSessionByCanvas: entered }).catch(() => undefined);
  }, [canvas, entered, role]);
  useEffect(() => {
    if (visible) { setMounted(true); const frame = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(frame); }
    setShown(false); const timer = setTimeout(() => setMounted(false), 200); return () => clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    if (visible && snapshot && !notebookSelected && !selected) void panelCommand('patch-view', { activeTab: 'notebook' });
  }, [visible, !!snapshot, notebookSelected, ui.activeTab, !!selected]);
  useEffect(() => {
    if (!visible || !snapshot) return;
    const current = usePanelState.getState(), data = useAiStore.getState().snapshot;
    if (current.host !== role || !data) return;
    const patch = reconcileNotebookView(current, data.userNotePages ?? [], data.userNoteDirectories ?? []);
    if (patch) void panelCommand('patch-view', patch).catch(() => undefined);
  }, [visible, ui.noteTabs, ui.notePageId, ui.noteDirectoryId, snapshot?.userNotePages, snapshot?.userNoteDirectories]);
  useEffect(() => { if (visible) tabs.current?.querySelector('[aria-selected="true"]')?.closest('.utility-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [visible, mounted, ui.activeTab]);
  const open = (tab: string) => action.run(async () => {
    if (sessions.some(s => s.id === tab)) touchTemporarySession(tab);
    await panelCommand('open-panel', { tab });
  });
  const remove = (session: Session) => action.run(async () => {
    const index = sessions.findIndex(s => s.id === session.id);
    const next = sessions[index + 1]?.id ?? sessions[index - 1]?.id ?? 'notebook';
    await closeTemporarySession(session.id, next);
  });
  const label = temporaryLabel;
  const closeNoteTab = (id: string) => action.run(async () => {
    await panelCommand('open-panel', { tab: ui.activeTab === id ? 'note-directory' : ui.activeTab });
    const state = usePanelState.getState();
    const reading = Object.fromEntries(Object.entries(state.reading).filter(([key]) => !key.startsWith('note:' + id + ':') && key !== 'directory:' + id));
    await panelCommand('patch-view', { noteTabs: (state.noteTabs ?? []).filter(tab => tab.id !== id), reading });
  });
  const begin = (event: PointerEvent<HTMLElement>, drag: boolean) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current || (drag && !ui.detached)) return;
    const native = drag && role === 'panel' && !!window.tujiDesktop;
    if (drag && window.tujiDesktop && !native) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { x: event.screenX, y: event.screenY, width: ui.width, left: floating.x, top: floating.y, drag, native, pointerId: event.pointerId, target: event.currentTarget };
    if (drag) setDragging(true);
    if (native) window.tujiDesktop?.dragPanel('start');
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    if (g.native) window.tujiDesktop?.dragPanel('move');
    else if (g.drag) setFloating({ x: Math.max(0, Math.min(innerWidth - 80, g.left + event.screenX - g.x)), y: Math.max(0, Math.min(innerHeight - 60, g.top + event.screenY - g.y)) });
    else void panelCommand('patch-view', { width: Math.max(360, Math.min(1200, g.width + g.x - event.screenX)) });
  };
  const end = (event?: PointerEvent<HTMLElement>) => {
    const g = gesture.current; if (!g || (event && event.pointerId !== g.pointerId)) return;
    gesture.current = undefined;
    if (g.native) window.tujiDesktop?.dragPanel(event?.type === 'pointerup' ? 'end' : 'cancel');
    if (g.target.hasPointerCapture(g.pointerId)) g.target.releasePointerCapture(g.pointerId);
    setDragging(false);
  };
  useEffect(() => {
    const cancel = () => end();
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); cancel(); };
  }, []);
  useEffect(() => { if (!visible || !ui.detached) end(); }, [visible, ui.detached]);
  const browserFloating = !window.tujiDesktop && ui.detached;
  const style: CSSProperties = role === 'panel' ? {} : { width: Math.min(ui.width, innerWidth - 24), ...(browserFloating ? { left: floating.x, top: floating.y, right: 'auto', bottom: 'auto', height: Math.max(360, innerHeight - 112) } : {}) };
  return <>
    {role === 'main' && !visible && <nav className="utility-bookmarks" aria-label="笔记和临时会话">
      <button type="button" className="utility-bookmark utility-bookmark-note" data-user-notebook-bookmark title="用户笔记" aria-label="打开用户笔记" onClick={() => void open('notebook')}><BookOpen size={17} /><span>笔记</span></button>
      {sessions.map(session => <div className="utility-bookmark-wrap" key={session.id}>
        <button type="button" className="utility-bookmark" data-ai-temporary-bookmark={session.id} title={label(session) + ' · ' + session.title} onClick={() => void open(session.id)}><MessagesSquare size={16} /><span>{label(session)}</span></button>
        <button type="button" className="utility-quick-delete" aria-label={'删除' + label(session)} disabled={action.busy} onClick={() => void remove(session)}><X size={10} /></button>
      </div>)}
    </nav>}
    {mounted && <aside className={'utility-panel' + (role === 'panel' ? ' utility-panel-native' : '') + (browserFloating ? ' utility-panel-floating' : '')}
      data-visible={shown && visible} data-detached={ui.detached} data-ai-temporary-sidebar aria-label="笔记与临时会话侧边页" style={style}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onPointerDownCapture={() => { if (selected) touchTemporarySession(selected.id); }} onInputCapture={() => { if (selected) touchTemporarySession(selected.id); }}
      onKeyDownCapture={event => { if (event.key === 'Escape') end(); if (selected) touchTemporarySession(selected.id); }} onWheelCapture={() => { if (selected) touchTemporarySession(selected.id); }}>
      {!ui.detached && <div className="utility-resize" role="separator" aria-label="调整侧边页宽度" aria-orientation="vertical" tabIndex={0}
        onPointerDown={event => begin(event, false)} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); void panelCommand('patch-view', { width: ui.width + (event.key === 'ArrowLeft' ? 20 : -20) }); }
        }} />}
      <header ref={header} className="utility-header" data-edge-theme={edgeTab.theme} data-edge-selected={edgeTab.selected}>
      <div className="utility-tabs" role="tablist" aria-label="侧边页标签">
        <div className="utility-tab-pins">
        <div className="utility-tab" data-theme="note" data-selected={ui.activeTab === 'notebook'}><button type="button" role="tab" aria-selected={ui.activeTab === 'notebook'} onClick={() => void open('notebook')}><BookOpen size={14} /><span>笔记</span></button></div>
        <div className="utility-tab" data-theme="note" data-selected={ui.activeTab === 'note-directory'}><button type="button" role="tab" aria-selected={ui.activeTab === 'note-directory'} onClick={() => void open('note-directory')}><FolderTree size={14} /><span>目录</span></button></div>
        </div>
        <div ref={tabs} className="utility-tab-scroll" onWheel={event => { event.currentTarget.scrollLeft += event.deltaY; }}>
        {noteTabs.map(tab => {
          const name = snapshot?.userNoteDirectories?.find(dir => dir.id === tab.directoryId)?.name ?? '笔记目录';
          return <div className="utility-tab utility-note-tab" data-theme="note" data-selected={ui.activeTab === tab.id} key={tab.id}>
            <button type="button" role="tab" aria-selected={ui.activeTab === tab.id} title={name} onClick={() => void open(tab.id)}>{tab.kind === 'pages' ? <BookOpen size={13} /> : <Folder size={13} />}<span>{name}</span></button>
            <button type="button" className="utility-tab-delete" aria-label={'关闭目录标签 ' + name} disabled={action.busy} onClick={() => void closeNoteTab(tab.id)}><X size={12} /></button>
          </div>;
        })}
        {sessions.map(session => <div className="utility-tab" data-theme="temporary" data-selected={selected?.id === session.id} key={session.id}>
          <button type="button" role="tab" aria-selected={selected?.id === session.id} title={session.title} onClick={() => void open(session.id)}><MessagesSquare size={13} /><span>{label(session)}</span></button>
          <button type="button" className="utility-tab-delete" aria-label={'删除' + label(session)} disabled={action.busy} onClick={() => void remove(session)}><X size={12} /></button>
        </div>)}
        </div>
      </div>
        <div className="utility-actions" role="group" aria-label="侧边页操作">
          {ui.detached && <button type="button" className="utility-drag-handle" data-dragging={dragging}
            title="按住拖动侧边页" aria-label="拖动侧边页"
            onPointerDown={event => begin(event, true)} onKeyDown={event => {
              if (!browserFloating || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              setFloating(old => ({ x: Math.max(0, Math.min(innerWidth - 80, old.x + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0))),
                y: Math.max(0, Math.min(innerHeight - 60, old.y + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0))) }));
            }}><Move size={16} aria-hidden="true" /></button>}
          <button type="button" aria-label={ui.detached ? '停靠侧边页' : '窗口化侧边页'} title={ui.detached ? '停靠到右侧' : '整个侧边页窗口化'} disabled={action.busy} onClick={() => void action.run(() => panelCommand('toggle-detach'))}>{ui.detached ? <PanelRight size={16} /> : <Copy size={15} />}</button>
          <button type="button" aria-label="隐藏侧边页" title="收起到右侧" disabled={action.busy} data-ai-dock-temporary onClick={() => void action.run(() => panelCommand('hide-panel'))}><ArrowRight size={18} /></button>
        </div>
      </header>
      <div className="utility-content" role="tabpanel">
        {selected ? <TemporaryChat key={selected.id} session={selected} /> : <UserNotebook key={ui.activeTab} tabId={ui.activeTab} />}
      </div>
      <AiError text={action.error} />
    </aside>}
    {!mounted && action.error && <div className="utility-error"><AiError text={action.error} /></div>}
  </>;
}
