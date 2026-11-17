import { useEffect, useRef, useState } from 'react';
import { BookOpen, MessagesSquare, X } from 'lucide-react';
import { useAiStore } from '@/ai/client';
import type { Session } from '@/ai/domain';
import { isDesktopTemporary, temporaryLabel, temporaryNumber } from '@/ai/temporaryModes';
import { closeTemporarySession, touchTemporarySession } from '@/ai/temporaryWindows';
import { panelCommand, usePanelState } from './panelState';
import './companion.css';

const CENTER = 140, RING = 88, START = -24, END = 114;
const point = (angle: number) => ({ x: CENTER + RING * Math.cos(angle * Math.PI / 180), y: CENTER + RING * Math.sin(angle * Math.PI / 180) });
const arc = (a: number, b: number) => { const p = point(a), q = point(b); return `M ${p.x} ${p.y} A ${RING} ${RING} 0 0 1 ${q.x} ${q.y}`; };

export function FloatingOrb() {
  const ui = usePanelState(), all = useAiStore(s => s.snapshot?.sessions);
  const sessions = all?.filter(s => isDesktopTemporary(s) && s.lifecycle === 'active') ?? [];
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pressed = useRef<{ x: number; y: number; moved: boolean }>();
  const lastClick = useRef<{ x: number; y: number; time: number }>();
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(), collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const busyRef = useRef(false), expandedRef = useRef(expanded); expandedRef.current = expanded;
  const run = async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const open = (tab: string) => run(async () => { clearTimeout(clickTimer.current); if (tab !== 'notebook') touchTemporarySession(tab); await panelCommand('open-panel', { tab }); setExpanded(false); });
  const create = () => run(async () => {
    clearTimeout(clickTimer.current);
    if (!useAiStore.getState().snapshot?.setupCompleted) { await panelCommand('show-main'); return; }
    const session = await useAiStore.getState().command<Session>('temporary.createDesktop');
    await panelCommand('open-panel', { tab: session.id }); setExpanded(false);
  });
  useEffect(() => {
    let lastHit = false;
    const collapse = () => {
      // Keep one deadline: repeated outside moves must not postpone it forever.
      if (!collapseTimer.current) collapseTimer.current = setTimeout(() => {
        collapseTimer.current = undefined; expandedRef.current = false; setExpanded(false);
      }, 300);
    };
    const hover = (x: number, y: number) => {
      const dx = x - CENTER, dy = y - CENTER, distance = Math.hypot(dx, dy);
      const target = document.elementFromPoint(x, y);
      const hit = !!target?.closest('[data-orb-interactive]') || !!pressed.current;
      if (hit !== lastHit) { lastHit = hit; window.tujiDesktop?.hitTest(hit); }
      if (pressed.current) return;
      const { flipX, flipY } = usePanelState.getState().orb;
      // A padded, connected sector includes the orbit, delete controls, and the
      // whole path from the core to every button. Blank pixels still click through.
      const inOrbit = distance <= 44 || distance <= 128 && dx * (flipX ? -1 : 1) >= -48 && dy * (flipY ? -1 : 1) >= -48;
      if (distance <= 31 && hit || expandedRef.current && inOrbit) {
        clearTimeout(collapseTimer.current); collapseTimer.current = undefined;
        expandedRef.current = true; setExpanded(true);
      } else collapse();
    };
    const move = (event: MouseEvent) => hover(event.clientX, event.clientY);
    const stop = window.tujiDesktop?.onOrbPointer(({ x, y, visible }) => {
      if (visible) hover(x, y);
      else {
        pressed.current = undefined; lastClick.current = undefined; lastHit = false;
        clearTimeout(clickTimer.current); clearTimeout(collapseTimer.current); collapseTimer.current = undefined;
        expandedRef.current = false; setExpanded(false);
      }
    });
    window.addEventListener('mousemove', move);
    return () => { stop?.(); window.removeEventListener('mousemove', move); clearTimeout(clickTimer.current); clearTimeout(collapseTimer.current); };
  }, []);
  const entries = [{ id: 'notebook', label: '用户笔记', kind: 'note' },
    ...(sessions.length < 3 ? [{ id: 'new', label: '新建极简悬浮会话', kind: 'create' }] : []),
    ...sessions.map(session => ({ id: session.id, label: `${temporaryLabel(session)} · ${session.title}`, kind: 'session', number: temporaryNumber(session) }))];
  const angles = entries.map((_, index) => START + (END - START) * (index + 1) / (entries.length + 1));
  const arcs = [START, ...angles.map(angle => angle + 12)].map((start, index) => arc(start, index < angles.length ? angles[index] - 12 : END));
  const sx = ui.orb.flipX ? -1 : 1, sy = ui.orb.flipY ? -1 : 1;
  return <main className="orb-stage" data-expanded={expanded} data-busy={busy} data-dock={ui.orb.dock} aria-label="图记悬浮窗">
    <div className="orb-orbit" aria-hidden={!expanded}>
      <svg className="orb-tracks" viewBox="0 0 280 280" style={{ transform: `scale(${sx}, ${sy})` }} aria-hidden="true">
        {arcs.map((d, index) => <path d={d} key={index} />)}
      </svg>
      {entries.map((entry, index) => {
        const p = point(angles[index]);
        return <div className="orb-satellite-wrap" key={entry.id} style={{ left: CENTER + (p.x - CENTER) * sx, top: CENTER + (p.y - CENTER) * sy, transitionDelay: `${index * 20}ms` }}>
          <button type="button" className="orb-satellite" data-orb-interactive data-orb-action={entry.id} tabIndex={expanded ? 0 : -1}
            data-selected={entry.kind !== 'create' && ui.used && ui.activeTab === entry.id} title={entry.label} aria-label={entry.label} disabled={busy}
            onClick={() => { void (entry.kind === 'create' ? create() : open(entry.id)); }}>
            {entry.kind === 'note' ? <BookOpen size={16} /> : entry.kind === 'create' ? <MessagesSquare size={16} /> : <span className="orb-session-number">{'number' in entry ? entry.number : ''}</span>}
          </button>
          {entry.kind === 'session' && <button type="button" className="orb-delete" data-orb-interactive tabIndex={expanded ? 0 : -1} aria-label={'删除' + entry.label} disabled={busy}
            onClick={event => { event.stopPropagation(); void run(() => closeTemporarySession(entry.id)); }}><X size={9} /></button>}
        </div>;
      })}
    </div>
    <button type="button" className="orb-core" data-orb-interactive aria-label="图记：双击打开主窗口" title="双击打开图记 · 拖动可贴边" disabled={busy}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); clearTimeout(clickTimer.current);
        pressed.current = { x: event.screenX, y: event.screenY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); window.tujiDesktop?.drag('start'); }}
      onPointerMove={event => {
        const start = pressed.current; if (!start) return;
        if (Math.hypot(event.screenX - start.x, event.screenY - start.y) > 5) start.moved = true;
        if (start.moved) { lastClick.current = undefined; expandedRef.current = false; setExpanded(false); window.tujiDesktop?.drag('move'); }
      }}
      onPointerUp={event => {
        const start = pressed.current; if (!start) return;
        pressed.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (start.moved) { window.tujiDesktop?.drag('end'); return; }
        window.tujiDesktop?.drag('cancel');
        // PointerEvent.detail is always zero for a mouse. Recognize two completed
        // clicks explicitly, independently of capture and Windows activation.
        const previous = lastClick.current, now = performance.now();
        if (previous && now - previous.time < 500 && Math.hypot(event.screenX - previous.x, event.screenY - previous.y) <= 6) {
          lastClick.current = undefined; clearTimeout(clickTimer.current); void run(() => panelCommand('show-main'));
        } else {
          lastClick.current = { x: event.screenX, y: event.screenY, time: now };
          clickTimer.current = setTimeout(() => {
            lastClick.current = undefined;
            const state = usePanelState.getState();
            const available = useAiStore.getState().snapshot?.sessions.filter(s => isDesktopTemporary(s) && s.lifecycle === 'active') ?? [];
            if (state.used || available.length) void open(state.activeTab === 'notebook' || available.some(s => s.id === state.activeTab) ? state.activeTab : available[0]?.id ?? 'notebook');
          }, 500);
        }
      }}
      onLostPointerCapture={() => { if (pressed.current) { pressed.current = undefined; lastClick.current = undefined; window.tujiDesktop?.drag('end'); clearTimeout(clickTimer.current); } }}
      onPointerCancel={() => { pressed.current = undefined; lastClick.current = undefined; window.tujiDesktop?.drag('end'); clearTimeout(clickTimer.current); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void run(() => panelCommand('show-main')); } }}>
      <img src="/brand/app-icon.png" draggable={false} alt="" /><span className="orb-core-rim" />
    </button>
    {error && <div className="orb-error" role="alert">{error}</div>}
  </main>;
}
