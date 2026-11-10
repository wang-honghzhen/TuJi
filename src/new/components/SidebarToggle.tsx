import type { CSSProperties } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';

export function SidebarToggle({ side, expanded, onClick, label, hidden, className = '', style }: {
  side: 'left' | 'right'; expanded: boolean; onClick: () => void; label: string;
  hidden?: boolean; className?: string; style?: CSSProperties;
}) {
  const pointsLeft = side === 'left' ? expanded : !expanded;
  const Arrow = pointsLeft ? ChevronsLeft : ChevronsRight;
  return <button type="button" onClick={onClick} title={label} aria-label={label} aria-expanded={expanded}
    aria-hidden={hidden} tabIndex={hidden ? -1 : 0} data-sidebar-toggle data-side={side}
    data-mode={expanded ? 'collapse' : 'expand'} style={style}
    className={`sidebar-toggle ${expanded ? '' : 'sidebar-toggle-expand'} ${className}`}>
    <Arrow size={18} strokeWidth={2.2} aria-hidden="true" />
  </button>;
}
