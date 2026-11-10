import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

interface Geometry { left: number; top: number; width: number; height: number }
export const modalResizeDirections = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] as const;
type Interaction = 'move' | typeof modalResizeDirections[number];
const MARGIN = 10;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const available = () => ({ width: Math.max(1, window.innerWidth - MARGIN * 2), height: Math.max(1, window.innerHeight - MARGIN * 2) });

function fit(geometry: Geometry): Geometry {
  const space = available();
  const width = clamp(geometry.width, Math.min(360, space.width), space.width);
  const height = clamp(geometry.height, Math.min(240, space.height), space.height);
  return { width, height, left: clamp(geometry.left, MARGIN, window.innerWidth - width - MARGIN),
    top: clamp(geometry.top, MARGIN, window.innerHeight - height - MARGIN) };
}

export function useModalGeometry(dialog: RefObject<HTMLDivElement>, enabled: boolean) {
  const [geometry, setGeometry] = useState<Geometry>();
  const [interaction, setInteraction] = useState<'move' | 'resize'>();
  const drag = useRef<{ pointerId: number; x: number; y: number; geometry: Geometry; mode: Interaction }>();
  useLayoutEffect(() => {
    if (!enabled || !dialog.current) return;
    const { left, top, width, height } = dialog.current.getBoundingClientRect();
    setGeometry(fit({ left, top, width, height }));
    const resize = () => setGeometry(current => current && fit(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [dialog, enabled]);

  const start = (event: PointerEvent<HTMLElement>, mode: Interaction) => {
    if (!enabled || event.button !== 0 || !dialog.current) return;
    if (mode === 'move' && (event.target as Element).closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
    const { left, top, width, height } = dialog.current.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, geometry: { left, top, width, height }, mode };
    setInteraction(mode === 'move' ? 'move' : 'resize');
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const rect = start.geometry, space = available();
    if (start.mode === 'move') { setGeometry(fit({ ...rect, left: rect.left + dx, top: rect.top + dy })); return; }
    const next = { ...rect }, minWidth = Math.min(360, space.width), minHeight = Math.min(240, space.height);
    if (start.mode.includes('e')) next.width = clamp(rect.width + dx, minWidth, window.innerWidth - rect.left - MARGIN);
    if (start.mode.includes('s')) next.height = clamp(rect.height + dy, minHeight, window.innerHeight - rect.top - MARGIN);
    if (start.mode.includes('w')) { next.left = clamp(rect.left + dx, MARGIN, rect.left + rect.width - minWidth); next.width = rect.left + rect.width - next.left; }
    if (start.mode.includes('n')) { next.top = clamp(rect.top + dy, MARGIN, rect.top + rect.height - minHeight); next.height = rect.top + rect.height - next.top; }
    setGeometry(next);
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined; setInteraction(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { geometry, interaction, start, move, finish,
    resizeBy: (dx: number, dy: number) => setGeometry(current => current && fit({ ...current, width: current.width + dx, height: current.height + dy })) };
}
