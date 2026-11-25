import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Copy, Move, Maximize, Minus } from 'lucide-react';
import './window-controls.css';

export function DesktopWindowControls() {
  const controls = window.tujiWindow;
  const [maximized, setMaximized] = useState(false), [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragPointer = useRef<number | null>(null), group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!controls) return;
    let active = true, notified = false;
    const unsubscribe = controls.onStateChanged(state => {
      notified = true; setMaximized(state.maximized);
      if (state.maximized) { dragPointer.current = null; setDragging(false); }
    });
    void controls.getState().then(state => { if (active && !notified) setMaximized(state.maximized); }).catch(() => {});
    const unsubscribePointer = controls.onControlsPointer(pointer => {
      if (pointer.edge) setVisible(true);
      else if (!pointer.inside && dragPointer.current === null && !group.current?.matches(':focus-visible, :has(:focus-visible)')) setVisible(false);
    });
    const blur = () => { controls.drag('cancel'); dragPointer.current = null; setDragging(false); setVisible(false); };
    window.addEventListener('blur', blur);
    return () => { active = false; unsubscribe(); unsubscribePointer(); window.removeEventListener('blur', blur); controls.drag('cancel'); };
  }, [controls]);
  if (!controls) return null;
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null; controls.drag(event.type === 'pointerup' ? 'end' : 'cancel'); setDragging(false);
    const rect = group.current?.getBoundingClientRect();
    setVisible(event.type === 'pointerup' && !!rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={group} className="desktop-window-controls" role="group" aria-label="窗口操作" tabIndex={0}
    data-visible={visible || dragging} data-maximized={maximized}
    onPointerLeave={event => {
      // The native resize border can take the pointer away from the renderer
      // while it is still over the buttons. Native tracking covers that edge.
      if (event.relatedTarget instanceof Element && dragPointer.current === null && !group.current?.matches(':focus-visible, :has(:focus-visible)')) setVisible(false);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) setVisible(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation(); controls.drag('cancel'); dragPointer.current = null; setDragging(false); setVisible(false);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    }}>
    <div className="desktop-window-buttons">
      {!maximized && <button type="button" className="desktop-window-button desktop-window-drag" aria-label="拖动窗口" title="按住拖动窗口"
        data-dragging={dragging}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); dragPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true); controls.drag('start');
        }} onPointerMove={event => { if (dragPointer.current === event.pointerId) controls.drag('move'); }}
        onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
        <Move size={17} aria-hidden="true" />
      </button>}
      <button type="button" className="desktop-window-button" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原窗口' : '最大化窗口'}
        onClick={() => controls.toggleMaximize()}>{maximized ? <Copy size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}</button>
      <button type="button" className="desktop-window-button" aria-label="最小化" title="隐藏为悬浮球"
        onClick={() => controls.minimize()}><Minus size={17} aria-hidden="true" /></button>
    </div>
  </div>;
}
