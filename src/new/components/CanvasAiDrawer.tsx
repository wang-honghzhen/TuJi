import { MoreHorizontal, MessageSquare, MessagesSquare, PanelRightClose } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { activeTask, getSession, useAiStore } from '@/ai/client';
import { AiChatPage } from '@/ai/ui/AiChatPage';
import { useCanvasForeground } from '../canvasInteractionScope';
import { useNewUiStore } from '../newUiStore';
import { GraphContextMenu } from './GraphContextMenu';
import './canvas-ai-drawer.css';

interface Props {
  canvasId: string;
  canvasName: string;
  expanded: boolean;
  bookmarkInset: number;
  onOpen: () => void;
  onFold: () => void;
  onRestore: () => void;
  onWidth: (width: number) => void;
}

const readReplies = new Map<string, string>();

export function CanvasAiDrawer({ canvasId, canvasName, expanded, bookmarkInset, onOpen, onFold, onRestore, onWidth }: Props) {
  const snapshot = useAiStore(s => s.snapshot);
  const selectedId = useAiStore(s => s.activeSessionByCanvas[canvasId]);
  const session = getSession(snapshot, canvasId, selectedId);
  const task = activeTask(snapshot, session?.id);
  const foreground = useCanvasForeground();
  const replyKey = useMemo(() => {
    if (!snapshot || !session) return '';
    const taskIds = new Set(snapshot.tasks.filter(t => t.sessionId === session.id).map(t => t.id));
    let latest;
    for (const m of snapshot.messages) if (m.role === 'assistant' && m.text && taskIds.has(m.taskId)
      && (!latest || m.createdAt > latest.createdAt || (m.createdAt === latest.createdAt && (m.sequence ?? 0) >= (latest.sequence ?? 0)))) latest = m;
    return latest ? `${latest.id}:${latest.version}:${latest.text.length}` : '';
  }, [session?.id, snapshot?.tasks, snapshot?.messages]);
  useLayoutEffect(() => { if (session && !readReplies.has(session.id)) readReplies.set(session.id, replyKey); }, [session?.id, replyKey]);
  const onReadLatest = useCallback(() => { if (expanded && foreground && session) readReplies.set(session.id, replyKey); }, [expanded, foreground, session?.id, replyKey]);
  const unread = !!session && !!replyKey && readReplies.has(session.id) && readReplies.get(session.id) !== replyKey;
  const status = task?.interaction ? '待答复' : unread ? '有新回复' : '';
  const restore = () => { if (session) readReplies.delete(session.id); onRestore(); };
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const drawer = useRef<HTMLElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const bookmark = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    setMenu(undefined);
    if (!expanded) {
      if (wasOpen.current) bookmark.current?.focus({ preventScroll: true });
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const element = drawer.current!;
    foldButton.current?.focus({ preventScroll: true });
    const measure = () => onWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); onWidth(0); };
  }, [expanded, onWidth]);
  const menuAtPointer = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  };
  return <>
    {expanded ? <aside ref={drawer} className="canvas-ai-drawer" aria-label="画布 AI 侧页" data-canvas-ai-drawer
      onContextMenu={event => {
        const target = event.target;
        if (event.defaultPrevented || !(target instanceof Element) || target.closest('input, textarea, select, a, button, summary, [contenteditable="true"]')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.containsNode(target, true)) return;
        menuAtPointer(event);
      }}>
      <header className="canvas-ai-drawer-header">
        <MessagesSquare size={18} className="canvas-ai-glyph" aria-hidden="true" />
        <h2>画布 AI</h2><span className="canvas-ai-canvas-name" title={canvasName}>{canvasName}</span>
        <button type="button" aria-label="画布 AI 更多操作" title="更多操作" aria-haspopup="menu"
          onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 4 }); }}><MoreHorizontal size={18} /></button>
        <button type="button" ref={foldButton} onClick={onFold} aria-label="收起画布 AI 侧页" title="收起到右侧"><PanelRightClose size={17} /></button>
      </header>
      <div className="canvas-ai-drawer-body">
        {session ? <AiChatPage canvasId={canvasId} hideHeading canvasDrawer={{ onRestore: restore, onReadLatest }}
          onNavigate={refs => useAiStore.getState().requestCanvasSelection(canvasId, refs, 'ai')} /> :
          <div className="canvas-ai-empty"><MessageSquare size={24} aria-hidden="true"/><span>尚未选择会话</span>
            <button type="button" className="ai-button" onClick={() => useNewUiStore.getState().setPreviewCanvasId(canvasId)}>选择会话</button>
          </div>}
      </div>
    </aside> : <button ref={bookmark} type="button" className="canvas-ai-bookmark" data-canvas-ai-bookmark
      data-status={task?.interaction ? 'interaction' : unread ? 'unread' : undefined}
      style={{ '--canvas-ai-bookmark-inset': `${bookmarkInset}px` } as CSSProperties}
      aria-expanded={false} aria-label={`打开画布 AI${status ? '，' + status : ''}`} title="展开画布 AI · 右键可还原聊天视图"
      onClick={onOpen} onContextMenu={menuAtPointer}><MessagesSquare size={16} aria-hidden="true" /><span>画布 AI</span>
      {status && <span className="canvas-ai-status" aria-hidden="true">{task?.interaction ? '待答复' : ''}</span>}</button>}
    {menu && <GraphContextMenu position={menu} items={[{ key: 'restoreCanvasChat', label: '还原聊天视图', run: restore }]} onClose={() => setMenu(undefined)} />}
  </>;
}
