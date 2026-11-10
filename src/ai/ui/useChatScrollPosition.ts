import { useEffect, useState, type RefObject } from 'react';

/** One reading position drives both the turn marker and the scroll controls. */
export function useChatScrollPosition(history: RefObject<HTMLDivElement>, turnKey: string) {
  const [position, setPosition] = useState({ taskId: '', atLatest: true });
  useEffect(() => {
    const element = history.current; if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchors = [...element.querySelectorAll<HTMLElement>('[data-ai-turn-anchor]')];
        const top = element.getBoundingClientRect().top + 48;
        const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
        let current = anchors[0];
        for (const anchor of anchors) { if (anchor.getBoundingClientRect().top <= top) current = anchor; else break; }
        if (atLatest && anchors.length) current = anchors[anchors.length - 1];
        const taskId = current?.dataset.aiTurnAnchor ?? '';
        setPosition(previous => previous.taskId === taskId && previous.atLatest === atLatest ? previous : { taskId, atLatest });
      });
    };
    update(); element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update); observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('scroll', update); };
  }, [history, turnKey]);
  return position;
}
