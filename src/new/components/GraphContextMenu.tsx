import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Point } from '@/v3/types';

export interface GraphMenuItem { label: string; key: string; run: () => void; danger?: boolean; disabled?: boolean }
export function GraphContextMenu({ position, items, onClose }: { position: Point; items: GraphMenuItem[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null); const [point, setPoint] = useState(position);
  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect(); if (!rect) return;
    setPoint({ x: Math.max(8, Math.min(innerWidth - rect.width - 8, position.x)), y: Math.max(8, Math.min(innerHeight - rect.height - 8, position.y)) });
  }, [position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return createPortal(<div ref={root} data-canvas-interactive data-graph-menu role="menu" className="space-menu fixed z-[230] w-56 p-1.5 text-xs"
    style={{ left: point.x, top: point.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item) => <button key={item.key} type="button" role="menuitem" data-graph-action={item.key} disabled={item.disabled}
      className={`block w-full rounded-lg px-3 py-2 text-left hover:bg-blue-500/20 disabled:opacity-40 ${item.danger ? 'text-red-300' : ''}`}
      onClick={() => { onClose(); item.run(); }}>{item.label}</button>)}
  </div>, document.body);
}
