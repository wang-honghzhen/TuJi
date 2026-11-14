import { useEffect, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Copy, Folder, FolderTree, GripVertical, MessagesSquare, PanelRight, X } from 'lucide-react';
import { useAiStore } from '@/ai/client';
import type { Session } from '@/ai/domain';
import { isDesktopTemporary } from '@/ai/temporaryModes';
import { closeTemporarySession, touchTemporarySession } from '@/ai/temporaryWindows';
import { TemporaryChat } from '@/ai/ui/AiTemporarySidebar';
import { UserNotebook } from '@/ai/ui/UserNotebook';
import { AiError, useAction } from '@/ai/ui/common';
import { panelCommand, usePanelState } from './panelState';
import { reconcileNotebookView } from './notebookViewState';
import './companion.css';

export const temporaryLabel = (session: Session, index: number) => isDesktopTemporary(session)
  ? `悬浮 ${session.temporaryContext?.desktopNumber}` : `画布 ${index + 1}`;

export function UtilityPanel({ canvasId }: { canvasId?: string }) {
  const ui = usePanelState(), snapshot = useAiStore(s => s.snapshot);
  const entered = useAiStore(s => s.enteredSessionByCanvas);
  const role = window.tujiDesktop?.role ?? 'main';
  const action = useAction();
  const canvas = canvasId ?? ui.canvasId;
  const canvasSessions = snapshot?.sessions.filter(s => s.mode === 'temporary' && !isDesktopTemporary(s) && s.lifecycle === 'active' && s.canvasId === canvas) ?? [];
  const desktopSessions = snapshot?.sessions.filter(s => isDesktopTemporary(s) && s.lifecycle === 'active') ?? [];
  const sessions = [...(ui.background ? [] : canvasSessions), ...desktopSessions];
  const selected = sessions.find(s => s.id === ui.activeTab);
  const noteTabs = ui.noteTabs ?? [];
  const notebookSelected = ui.activeTab === 'notebook' || ui.activeTab === 'note-directory' || noteTabs.some(tab => tab.id === ui.activeTab);
  const visible = ui.ready && ui.host === role;
  const [mounted, setMounted] = useState(visible), [shown, setShown] = useState(false);
  const [floating, setFloating] = useState({ x: Math.max(12, innerWidth - 550), y: 56 });
  const gesture = useRef<{ x: number; y: number; width: number; left: number; top: number; drag: boolean }>();
  const tabs = useRef<HTMLDivElement>(null);
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
  useEffect(() => { if (visible) tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'start' }); }, [visible, mounted, ui.activeTab]);
  const open = (tab: string) => action.run(async () => {
    if (sessions.some(s => s.id === tab)) touchTemporarySession(tab);
    await panelCommand('open-panel', { tab });
  });
  const remove = (session: Session) => action.run(async () => {
    const index = sessions.findIndex(s => s.id === session.id);
    const next = sessions[index + 1]?.id ?? sessions[index - 1]?.id ?? 'notebook';
    await closeTemporarySession(session.id, next);
  });
  const label = (session: Session) => temporaryLabel(session, canvasSessions.findIndex(s => s.id === session.id));
  const closeNoteTab = (id: string) => action.run(async () => {
    await panelCommand('open-panel', { tab: ui.activeTab === id ? 'note-directory' : ui.activeTab });
    const state = usePanelState.getState();
    const reading = Object.fromEntries(Object.entries(state.reading).filter(([key]) => !key.startsWith('note:' + id + ':') && key !== 'directory:' + id));
    await panelCommand('patch-view', { noteTabs: (state.noteTabs ?? []).filter(tab => tab.id !== id), reading });
  });
  const begin = (event: PointerEvent<HTMLElement>, drag: boolean) => {
    if (event.button !== 0 || (drag && (window.tujiDesktop || !ui.detached || (event.target as Element).closest('button')))) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { x: event.screenX, y: event.screenY, width: ui.width, left: floating.x, top: floating.y, drag };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current; if (!g) return;
    if (g.drag) setFloating({ x: Math.max(0, Math.min(innerWidth - 80, g.left + event.screenX - g.x)), y: Math.max(0, Math.min(innerHeight - 60, g.top + event.screenY - g.y)) });
    else void panelCommand('patch-view', { width: Math.max(360, Math.min(1200, g.width + g.x - event.screenX)) });
  };
  const end = () => { gesture.current = undefined; };
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
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onPointerDownCapture={() => { if (selected) touchTemporarySession(selected.id); }} onInputCapture={() => { if (selected) touchTemporarySession(selected.id); }}
      onKeyDownCapture={() => { if (selected) touchTemporarySession(selected.id); }} onWheelCapture={() => { if (selected) touchTemporarySession(selected.id); }}>
      <div className="utility-resize" role="separator" aria-label="调整侧边页宽度" aria-orientation="vertical" tabIndex={0}
        onPointerDown={event => begin(event, false)} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); void panelCommand('patch-view', { width: ui.width + (event.key === 'ArrowLeft' ? 20 : -20) }); }
        }} />
      <header className={'utility-header' + (ui.detached && role === 'panel' ? ' utility-native-drag' : '')} onPointerDown={event => begin(event, true)}>
        <div className="utility-heading"><GripVertical size={13} /><span>{ui.background ? '随手记' : '笔记与临时会话'}</span></div>
        <div className="utility-actions">
          <button type="button" aria-label={ui.detached ? '停靠侧边页' : '窗口化侧边页'} title={ui.detached ? '停靠到右侧' : '整个侧边页窗口化'} disabled={action.busy} onClick={() => void action.run(() => panelCommand('toggle-detach'))}>{ui.detached ? <PanelRight size={16} /> : <Copy size={15} />}</button>
          <button type="button" aria-label="隐藏侧边页" title="收起到右侧" disabled={action.busy} data-ai-dock-temporary onClick={() => void action.run(() => panelCommand('hide-panel'))}><ArrowRight size={18} /></button>
        </div>
      </header>
      <div className="utility-tabs" role="tablist" aria-label="侧边页标签">
        <div className="utility-tab-pins">
        <div className="utility-tab" data-selected={ui.activeTab === 'notebook'}><button type="button" role="tab" aria-selected={ui.activeTab === 'notebook'} onClick={() => void open('notebook')}><BookOpen size={14} /><span>笔记</span></button></div>
        <div className="utility-tab" data-selected={ui.activeTab === 'note-directory'}><button type="button" role="tab" aria-selected={ui.activeTab === 'note-directory'} onClick={() => void open('note-directory')}><FolderTree size={14} /><span>目录</span></button></div>
        </div>
        <div ref={tabs} className="utility-tab-scroll new-scroll" onWheel={event => { event.currentTarget.scrollLeft += event.deltaY; }}>
        {noteTabs.map(tab => {
          const name = snapshot?.userNoteDirectories?.find(dir => dir.id === tab.directoryId)?.name ?? '笔记目录';
          return <div className="utility-tab utility-note-tab" data-selected={ui.activeTab === tab.id} key={tab.id}>
            <button type="button" role="tab" aria-selected={ui.activeTab === tab.id} title={name} onClick={() => void open(tab.id)}>{tab.kind === 'pages' ? <BookOpen size={13} /> : <Folder size={13} />}<span>{name}</span></button>
            <button type="button" className="utility-tab-delete" aria-label={'关闭目录标签 ' + name} disabled={action.busy} onClick={() => void closeNoteTab(tab.id)}><X size={12} /></button>
          </div>;
        })}
        {sessions.map(session => <div className="utility-tab" data-selected={selected?.id === session.id} key={session.id}>
          <button type="button" role="tab" aria-selected={selected?.id === session.id} title={session.title} onClick={() => void open(session.id)}><MessagesSquare size={13} /><span>{label(session)}</span></button>
          <button type="button" className="utility-tab-delete" aria-label={'删除' + label(session)} disabled={action.busy} onClick={() => void remove(session)}><X size={12} /></button>
        </div>)}
        </div>
      </div>
      <div className="utility-content" role="tabpanel">
        {selected ? <TemporaryChat key={selected.id} session={selected} /> : <UserNotebook key={ui.activeTab} tabId={ui.activeTab} />}
      </div>
      <AiError text={action.error} />
    </aside>}
    {!mounted && action.error && <div className="utility-error"><AiError text={action.error} /></div>}
  </>;
}
