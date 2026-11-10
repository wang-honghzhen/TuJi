import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAiStore } from '@/ai/client';
import { formatTime } from '@/ai/ui/common';
import { AiCreateSessionDialog } from '@/ai/ui/AiSessionBar';
import { layoutSessionDag, SESSION_ICON_SIZE, SESSION_NODE_HEIGHT, SESSION_NODE_WIDTH } from '../sessionGraphLayout';
import { useNewUiStore, useSidebarInsets } from '../newUiStore';
import { NewSessionIcon } from './NewSessionIcon';
import { useSessionGraphDismiss } from '../useSessionGraphDismiss';

const comparablePreview = (text: string) => text.trim().replace(/\s+/g, ' ').replace(/[。！？!?，,；;：:….]+$/u, '');

export function NewSessionGraphOverlay({ canvasId, currentCanvasId, onSelect }: { canvasId: string; currentCanvasId: string; onSelect?: (canvasId: string, sessionId: string) => void }) {
  const clearPreview = useNewUiStore(state => state.setPreviewCanvasId);
  const { left } = useSidebarInsets();
  const snapshot = useAiStore(state => state.snapshot);
  const activeId = useAiStore(state => state.activeSessionByCanvas[canvasId]);
  const enteredId = useAiStore(state => state.enteredSessionByCanvas[canvasId]);
  // A remembered/default session on a previewed canvas is not the user's current session.
  const currentId = canvasId === currentCanvasId && enteredId === activeId ? enteredId : undefined;
  const setActive = useAiStore(state => state.setActiveSession);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number }>();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; parentId?: string }>();
  const [create, setCreate] = useState<{ parentId?: string }>();
  const [tooltip, setTooltip] = useState<{ title: string; x: number; y: number; width: number }>();
  const sessions = (snapshot?.sessions ?? []).filter(session => session.mode !== 'temporary' && session.canvasId === canvasId && session.lifecycle !== 'deleted');
  const sessionKey = JSON.stringify(sessions.map(session => [session.id, session.title, session.mode, session.workspaceId, session.createdAt]));
  const firstByWorkspace = useMemo(() => {
    const first = new Map<string, string>();
    for (const message of snapshot?.messages ?? []) if (message.role === 'user' && !first.has(message.workspaceId)) first.set(message.workspaceId, message.text.replace(/\s+/g, ' ').trim());
    return first;
  }, [snapshot?.messages]);
  const edges = (snapshot?.inheritanceEdges ?? []).filter(edge => edge.canvasId === canvasId);
  const edgeKey = JSON.stringify(edges.map(edge => [edge.id, edge.parentSessionId, edge.childSessionId]));
  const layout = useMemo(() => layoutSessionDag(sessions, edges), [sessionKey, edgeKey]);
  const canPan = sessions.length > 0 && (layout.width + 64 > viewport.width || layout.height + 64 > viewport.height);
  const points = new Map(layout.nodes.map(node => [node.session.id, node]));
  useSessionGraphDismiss({ canvasId, nodes: layout.nodes, left, viewport, pan, suspended: dragging || !!menu || !!create, onDismiss: clearPreview });
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { setPan({ x: 0, y: 0 }); drag.current = undefined; setDragging(false); setMenu(undefined); setTooltip(undefined); }, [canvasId, canPan]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) { if (menu) setMenu(undefined); else clearPreview(null); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [clearPreview, menu]);
  return <div ref={host} className="new-session-graph-overlay" style={{ left, right: 0, cursor: canPan ? dragging ? 'grabbing' : 'grab' : 'default' }} data-ai-session-graph data-ai-graph-can-pan={canPan}
    onContextMenu={event => {
      event.preventDefault(); event.stopPropagation(); setTooltip(undefined);
      const id = (event.target as Element).closest<HTMLElement>('[data-ai-session-node]')?.dataset.aiSessionNode;
      const candidates = sessions.filter(session => session.mode !== 'temporary');
      const parentId = candidates.find(session => session.id === id)?.id ?? (!id ? candidates.find(session => session.id === activeId)?.id ?? candidates[0]?.id : undefined);
      if (sessions.length && !parentId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ x: Math.max(rect.left + 8, Math.min(event.clientX, window.innerWidth - 180)), y: Math.min(event.clientY, window.innerHeight - 60), parentId });
    }}
    onPointerDown={event => {
      if (!(event.target as Element).closest('[data-ai-session-menu]')) setMenu(undefined);
      if (!canPan || event.button !== 0 || (event.target as Element).closest('button')) return;
      event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; setDragging(true);
    }}
    onPointerMove={event => { const start = drag.current; if (start?.pointerId === event.pointerId) { setTooltip(undefined); setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }); } }}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = undefined; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { drag.current = undefined; setDragging(false); }}>
    {!sessions.length && <p className="new-session-graph-empty" data-ai-session-empty>暂无会话记录，创建一个或者聊天以开启会话</p>}
    <div className="new-session-graph-space" style={{ transform: `translate(${24 + pan.x}px, ${viewport.height / 2 + pan.y}px)` }} data-ai-graph-pan={`${pan.x},${pan.y}`}>
      <svg className="new-session-graph-lines" aria-hidden="true"><defs><linearGradient id="session-thread-gold" gradientUnits="userSpaceOnUse" x1={SESSION_NODE_WIDTH / 2} y1={0} x2={Math.max(SESSION_NODE_WIDTH / 2 + 1, layout.width - SESSION_NODE_WIDTH / 2)} y2={0}><stop stopColor="#936d2e" /><stop offset=".55" stopColor="#f1cd86" /><stop offset="1" stopColor="#aa8246" /></linearGradient></defs>
        {edges.map(edge => { const parent = points.get(edge.parentSessionId), child = points.get(edge.childSessionId); if (!parent || !child) return null;
          const start = parent.x + SESSION_ICON_SIZE / 2, end = child.x - SESSION_ICON_SIZE / 2, bend = (start + end) / 2;
          return <path key={edge.id} d={`M ${start} ${parent.y} C ${bend} ${parent.y}, ${bend} ${child.y}, ${end} ${child.y}`} stroke="url(#session-thread-gold)" strokeWidth="1" fill="none" data-ai-session-edge={edge.id} data-active={edge.parentSessionId === currentId || edge.childSessionId === currentId} />;
        })}
      </svg>
      {layout.nodes.map((node, index) => {
        const first = firstByWorkspace.get(node.session.workspaceId) ?? '尚未开始聊天';
        const titleText = comparablePreview(node.session.title), firstText = comparablePreview(first);
        const repeated = Boolean(titleText) && (titleText === firstText || /(?:…|\.{3})$/.test(node.session.title.trim()) && firstText.startsWith(titleText));
        const showTitle = (element: HTMLElement) => {
          const label = element.querySelector<HTMLElement>('.new-session-graph-name');
          if (!label) return;
          const clipped = label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight;
          const details = repeated && first !== node.session.title ? first.slice(0, 160) + (first.length > 160 ? '…' : '') : clipped ? node.session.title : undefined;
          if (!details) { setTooltip(undefined); return; }
          const rect = label.getBoundingClientRect();
          const width = Math.min(300, window.innerWidth - left - 24);
          setTooltip({ title: details, width, x: Math.max(left + width / 2 + 12, Math.min(rect.x + rect.width / 2, window.innerWidth - width / 2 - 12)), y: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 82)) });
        };
        return <button key={node.session.id} type="button" className="new-session-btn new-session-graph-node" style={{ left: node.x - SESSION_NODE_WIDTH / 2, top: node.y - SESSION_ICON_SIZE / 2, width: SESSION_NODE_WIDTH, height: SESSION_NODE_HEIGHT }} data-ai-session-node={node.session.id} data-ai-session-depth={node.depth} data-active={currentId === node.session.id} aria-label={`进入会话：${node.session.title}`} aria-pressed={currentId === node.session.id}
          onMouseEnter={event => showTitle(event.currentTarget)} onMouseLeave={() => setTooltip(undefined)} onFocus={event => showTitle(event.currentTarget)} onBlur={() => setTooltip(undefined)}
          onClick={() => { if(onSelect)onSelect(canvasId,node.session.id);else setActive(canvasId,node.session.id); clearPreview(null); }}>
          <span className="new-session-graph-galaxy"><NewSessionIcon mode={node.session.mode === 'design' ? 'design' : 'explore'} size={SESSION_ICON_SIZE} phase={index} active={currentId === node.session.id} /></span>
          <span className="new-session-graph-name">{node.session.title}</span>
          {!repeated && <span className="new-session-graph-first" title={first}>{first.slice(0, 160)}</span>}
          <time dateTime={node.session.createdAt} title={`创建时间：${formatTime(node.session.createdAt)}`}>{formatTime(node.session.createdAt)}</time>
        </button>;
      })}
    </div>
    {tooltip && <div role="tooltip" className="new-session-name-tooltip" style={{ left: tooltip.x, top: tooltip.y, maxWidth: tooltip.width }} data-ai-title-tooltip>{tooltip.title}</div>}
    {menu && <div role="menu" className="new-session-graph-menu" style={{ left: menu.x, top: menu.y }} data-ai-session-menu>
      <button type="button" role="menuitem" data-ai-graph-create onClick={() => { setCreate({ parentId: menu.parentId }); setMenu(undefined); }}>{sessions.length ? '创建子会话' : '创建根会话'}</button>
    </div>}
    {create && <AiCreateSessionDialog key={`${canvasId}:${create.parentId ?? 'root'}`} canvasId={canvasId} initialParentId={create.parentId}
      onCreated={onSelect?sessionId=>onSelect(canvasId,sessionId):undefined} onClose={() => setCreate(undefined)} />}
  </div>;
}
