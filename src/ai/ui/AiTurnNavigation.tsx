import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationTurnLabel } from './conversationTimeline';
import './turn-navigation.css';

export function AiTurnNavigation({ turns, active, onJump }: {
  turns: ConversationTurnLabel[]; active: string; onJump: (taskId: string) => void;
}) {
  const [hovered, setHovered] = useState<number>(), [focused, setFocused] = useState<number>();
  const [point, setPoint] = useState({ left: 0, top: 0, width: 280 });
  const list = useRef<HTMLElement>(null), tooltipId = useId(), key = turns.map(turn => turn.taskId).join('|');
  const manuallyScrolling = useRef(false), previousActive = useRef(active);
  const center = hovered ?? focused;
  useEffect(() => {
    if (previousActive.current !== active) { previousActive.current = active; manuallyScrolling.current = false; }
    if (center !== undefined || manuallyScrolling.current) return;
    const nav = list.current, button = nav?.querySelector<HTMLElement>('[aria-current=location]');
    if (!nav || !button) return;
    const row = button.getBoundingClientRect(), bounds = nav.getBoundingClientRect();
    if (row.top < bounds.top + 8) nav.scrollTop -= bounds.top + 8 - row.top;
    else if (row.bottom > bounds.bottom - 8) nav.scrollTop += row.bottom - bounds.bottom + 8;
  }, [active, center, key]);
  useEffect(() => { setHovered(undefined); setFocused(undefined); }, [key]);
  const position = (button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect(), width = Math.min(300, innerWidth - 24);
    setPoint({ left: Math.max(12, Math.min(bounds.right + 8, innerWidth - width - 12)), top: Math.max(8, Math.min(bounds.top + bounds.height / 2 - 18, innerHeight - 44)), width });
  };
  if (!turns.length) return null;
  return <div className="ai-turn-navigation" data-ai-turn-navigation>
    <nav ref={list} className="ai-turn-navigation-list" aria-label="对话轮次导航" onPointerLeave={() => setHovered(undefined)}
      onWheel={event => { manuallyScrolling.current = true; setHovered(undefined); setFocused(undefined); event.stopPropagation(); }}
      onTouchStart={() => { manuallyScrolling.current = true; }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) manuallyScrolling.current = true; }}
      onScroll={() => { setHovered(undefined); const button = list.current?.querySelector<HTMLButtonElement>('button:focus'); if (button) position(button); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
      {turns.map((turn, index) => {
        const distance = center === undefined ? Infinity : Math.abs(index - center);
        const width = [42, 35, 26, 19][distance] ?? 14;
        const context = turn.contextRange ?? (turn.protected ? '已在当前提示词中' : '未在当前提示词中');
        return <button key={turn.taskId} type="button" className="ai-turn-tick" data-ai-turn-tick={turn.taskId}
          data-protected={turn.protected} data-starred={turn.starred} data-current-task={turn.current || undefined} aria-current={active === turn.taskId ? 'location' : undefined}
          aria-label={`第 ${index + 1} 轮${turn.current ? '，当前任务' : ''}，${context}${turn.starred ? '，已标注' : ''}：${turn.preview}`}
          aria-describedby={center === index ? tooltipId : undefined} style={{ '--tick-width': `${width}px` } as CSSProperties}
          onPointerEnter={event => { setHovered(index); position(event.currentTarget); }} onPointerDown={() => setFocused(undefined)}
          onFocus={event => { if (event.currentTarget.matches(':focus-visible')) { setFocused(index); position(event.currentTarget); } }}
          onClick={() => onJump(turn.taskId)}>
          <span className="ai-turn-star" aria-hidden="true" /><span className="ai-turn-line" aria-hidden="true" />
          <span className="ai-turn-position" aria-hidden="true" />
          <span className="ai-turn-current" aria-hidden="true" />
        </button>;
      })}
    </nav>
    {center !== undefined && turns[center] && createPortal(<div id={tooltipId} role="tooltip" className="ai-turn-preview" style={point}>
      <span>{center + 1}</span><p>{turns[center].preview}
        <small>{turns[center].current ? '当前任务；' : ''}{turns[center].contextRange ?? (turns[center].protected ? '已在当前提示词中' : '未在当前提示词中')}</small></p>
    </div>, document.body)}
  </div>;
}
