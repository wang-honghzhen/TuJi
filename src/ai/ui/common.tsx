import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { modalResizeDirections, useModalGeometry } from './useModalGeometry';
import './ai.css';

export function AiModal({ title, children, onClose, wide = false, className = '', navigation, footer, adjustable = false, dismissible = true }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; navigation?: ReactNode; footer?: ReactNode;
  adjustable?: boolean;
  dismissible?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const geometry = useModalGeometry(dialog, adjustable);
  const close = useRef(onClose);
  close.current = () => { if (dismissible) onClose(); };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (modals[modals.length - 1] !== dialog.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      // A dialog must trap focus in everything focusable, including disclosure summaries and links.
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])') ?? [])
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return createPortal(<div className="ai-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={dialog} className={`ai-modal ${wide ? 'ai-modal-wide' : ''} ${adjustable ? 'ai-modal-adjustable' : ''} ${className}`}
      style={adjustable && geometry.geometry ? { position: 'fixed', ...geometry.geometry } : undefined}
      data-modal-interaction={geometry.interaction} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="ai-modal-heading" onPointerDown={event => geometry.start(event, 'move')} onPointerMove={geometry.move}
        onPointerUp={geometry.finish} onPointerCancel={geometry.finish} onLostPointerCapture={geometry.finish}>
        <h2>{title}</h2>{dismissible && <button className="ai-icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>}</div>
      {navigation}
      <div className="ai-modal-content new-scroll">{children}</div>
      {footer && <div className="ai-modal-footer">{footer}</div>}
      {adjustable && modalResizeDirections.map(direction => <button key={direction} type="button" className={`ai-modal-resize ai-modal-resize-${direction}`} data-modal-resize={direction}
        tabIndex={direction === 'se' ? 0 : -1} aria-label={direction === 'se' ? '调整笔记窗口大小' : `调整笔记窗口大小 ${direction}`} title="拖动调整大小，或使用方向键"
        onPointerDown={event => geometry.start(event, direction)} onPointerMove={geometry.move} onPointerUp={geometry.finish}
        onPointerCancel={geometry.finish} onLostPointerCapture={geometry.finish} onKeyDown={event => {
          const step = event.shiftKey ? 40 : 10;
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          geometry.resizeBy(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
            event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
        }} />)}
    </div>
  </div>, document.body);
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。'); }
    finally { running.current = false; setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function AiError({ text }: { text?: string | null }) {
  return text ? <p role="alert" className="ai-error">{text}</p> : null;
}

export function formatTime(time: string) {
  return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
