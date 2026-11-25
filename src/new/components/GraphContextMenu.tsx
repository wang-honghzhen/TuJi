import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Point } from '@/v3/types';

export interface GraphMenuItem { label: ReactNode; key: string; run: () => void; danger?: boolean; disabled?: boolean }
export function GraphContextMenu({ position, items, onClose, trigger }: { position: Point; items: GraphMenuItem[]; onClose: () => void; trigger?: HTMLElement }) {
  const root = useRef<HTMLDivElement>(null); const [point, setPoint] = useState(position);
  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect(); if (!rect) return;
    setPoint({ x: Math.max(8, Math.min(innerWidth - rect.width - 8, position.x)), y: Math.max(8, Math.min(innerHeight - rect.height - 8, position.y)) });
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); trigger?.focus({ preventScroll: true }); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); };
  }, [onClose, trigger]);
  return createPortal(<div ref={root} data-canvas-interactive data-graph-menu role="menu" className="space-menu fixed z-[230] w-56 overflow-y-auto overscroll-contain p-1.5 text-xs"
    style={{ left: point.x, top: point.y, maxHeight: 'calc(100dvh - 16px)' }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item) => <button key={item.key} type="button" role="menuitem" data-graph-action={item.key} disabled={item.disabled}
      className={`block w-full rounded-lg px-3 py-2 text-left hover:bg-blue-500/20 disabled:opacity-40 ${item.danger ? 'text-red-300' : ''}`}
      onClick={() => { onClose(); trigger?.focus({ preventScroll: true }); item.run(); }}>{item.label}</button>)}
  </div>, document.body);
}
