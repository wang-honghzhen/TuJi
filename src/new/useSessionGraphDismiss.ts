import { useEffect, useRef } from 'react';
import { SESSION_ICON_SIZE, SESSION_NODE_HEIGHT, SESSION_NODE_WIDTH, type PositionedSession } from './sessionGraphLayout';

const DISMISS_DISTANCE = 120;
const DISMISS_DELAY = 100;

function nearRectangle(x: number, y: number, left: number, top: number, width: number, height: number) {
  const dx = Math.max(left - x, 0, x - left - width);
  const dy = Math.max(top - y, 0, y - top - height);
  return dx * dx + dy * dy <= DISMISS_DISTANCE * DISMISS_DISTANCE;
}

/** Keep a forgiving corridor between nodes; dismiss only after a sustained departure. */
export function useSessionGraphDismiss({ canvasId, nodes, left, viewport, pan, suspended, onDismiss }: {
  canvasId: string; nodes: PositionedSession[]; left: number;
  viewport: { width: number; height: number }; pan: { x: number; y: number };
  suspended: boolean; onDismiss: (canvasId: null) => void;
}) {
  const latest = useRef({ nodes, left, viewport, pan, onDismiss });
  latest.current = { nodes, left, viewport, pan, onDismiss };
  const ready = !!viewport.width && !!viewport.height;
  useEffect(() => {
    if (suspended || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frameFallback: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined, pointer: PointerEvent | undefined, outside = false;
    const cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const farAway = () => {
      const event = pointer; if (!event) return false;
      const { nodes, left, viewport, pan } = latest.current;
      const target = event.target instanceof Element ? event.target : null;
      // Hovering the trigger keeps the preview open; all menu/modal work is protected.
      if (event.buttons || document.querySelector('[aria-modal="true"]') || target?.closest('[data-ai-canvas-button], [data-ai-session-menu]')) return false;
      if (outside) return true;
      const x = event.clientX - left - 24 - pan.x;
      const y = event.clientY - viewport.height / 2 - pan.y;
      const trigger = [...document.querySelectorAll<HTMLElement>('[data-ai-canvas-button]')]
        .find(element => element.dataset.aiCanvasButton === canvasId)?.getBoundingClientRect();
      // Bridge the hovered sidebar entry to every root, including after panning or resizing.
      // The entry may be far above or below the root; node proximity alone leaves a gap.
      if (trigger) {
        const roots = nodes.filter(node => node.depth === 0);
        const destinations = roots.length ? roots.map(node => ({
          left: left + 24 + pan.x + node.x - SESSION_NODE_WIDTH / 2,
          top: viewport.height / 2 + pan.y + node.y - SESSION_ICON_SIZE / 2,
          width: SESSION_NODE_WIDTH, height: SESSION_NODE_HEIGHT,
        })) : [{ left: left + viewport.width / 2 - 180, top: viewport.height / 2 - 24, width: 360, height: 48 }];
        if (destinations.some(root => {
          const bridgeLeft = Math.min(trigger.right, root.left), bridgeTop = Math.min(trigger.top, root.top);
          return nearRectangle(event.clientX, event.clientY, bridgeLeft, bridgeTop,
            Math.max(trigger.right, root.left + root.width) - bridgeLeft,
            Math.max(trigger.bottom, root.top + root.height) - bridgeTop);
        })) return false;
      }
      const nearby = nodes.length
        ? nodes.some(node => nearRectangle(x, y, node.x - SESSION_NODE_WIDTH / 2, node.y - SESSION_ICON_SIZE / 2, SESSION_NODE_WIDTH, SESSION_NODE_HEIGHT))
        // Empty canvases still allow reading the hint and opening the root-session menu.
        : nearRectangle(event.clientX, event.clientY, left + viewport.width / 2 - 180, viewport.height / 2 - 24, 360, 48);
      return !nearby;
    };
    const evaluate = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (frameFallback !== undefined) clearTimeout(frameFallback);
      frameFallback = undefined;
      frame = undefined;
      if (!farAway()) cancel();
      else if (timer === undefined) timer = setTimeout(() => {
        timer = undefined;
        if (farAway()) latest.current.onDismiss(null);
      }, DISMISS_DELAY);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      pointer = event; outside = false;
      if (frame === undefined) {
        frame = requestAnimationFrame(evaluate);
        // Occluded windows can defer animation frames. Bound that delay as well.
        frameFallback = setTimeout(evaluate,32);
      }
    };
    const down = (event: PointerEvent) => { pointer = event; cancel(); };
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      pointer = event; outside = true;
      if (frame === undefined) { frame = requestAnimationFrame(evaluate); frameFallback = setTimeout(evaluate,32); }
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', move, { passive: true });
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    return () => {
      cancel();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (frameFallback !== undefined) clearTimeout(frameFallback);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', move);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerout', leave);
    };
  }, [canvasId, ready, suspended]);
}
