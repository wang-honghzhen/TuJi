import { useLayoutEffect, useState } from 'react';
import type { Rect } from '@/v3/types';

const overlays = [
  '[data-canvas-toolbar]', '.canvas-search-popover', '[data-granularity-panel]', '[data-spatial-path-panel]',
  '[data-canvas-detail]', '[data-canvas-popup]', '[data-graph-menu]', '.workspace-view-actions', '[data-sidebar-toggle]',
  '.new-canvas-composer .canvas-composer-surface', '.new-canvas-composer .canvas-reply-panel',
  '[data-canvas-ai-bookmark]', '.utility-panel',
].join(',');

/** Measure the painted controls in screen coordinates. The clear space on
 * either side of a floating composer remains available for edge counts. */
export function useCanvasOcclusions(enabled: boolean, left: number, right: number) {
  const [rects, setRects] = useState<Rect[]>([]);
  useLayoutEffect(() => {
    if (!enabled) return;
    let surfaces: Element[] = [];
    let frame = 0;
    function measure() {
      frame = 0;
      const next = surfaces.flatMap(element => {
        if (element.getAttribute('aria-hidden') === 'true') return [];
        const { x, y, width, height } = element.getBoundingClientRect();
        return width && height ? [{ x, y, width, height }] : [];
      });
      setRects(old => old.length === next.length && old.every((r, i) =>
        r.x === next[i].x && r.y === next[i].y && r.width === next[i].width && r.height === next[i].height) ? old : next);
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const attributes = new MutationObserver(schedule);
    function bind() {
      resize.disconnect();
      attributes.disconnect();
      surfaces = Array.from(document.querySelectorAll(overlays));
      for (const element of surfaces) {
        resize.observe(element);
        attributes.observe(element, { attributes: true, attributeFilter: ['style', 'aria-hidden', 'class'] });
      }
      schedule();
    }
    // Only changes that add or remove an overlay can change the observed set.
    const mounts = new MutationObserver(records => {
      for (const record of records) {
        if ((record.target as Element).closest?.('[data-canvas-world], [data-granular-view]')) continue;
        if ([...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement &&
          (node.matches(overlays) || node.querySelector(overlays)))) { bind(); break; }
      }
    });
    mounts.observe(document.body, { childList: true, subtree: true });
    bind();
    window.addEventListener('resize', schedule);
    document.addEventListener('transitionend', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      mounts.disconnect(); resize.disconnect(); attributes.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('transitionend', schedule, true);
    };
  }, [enabled, left, right]);
  return rects;
}
