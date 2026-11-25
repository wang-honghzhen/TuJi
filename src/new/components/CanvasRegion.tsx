import type { CSSProperties, MouseEventHandler, PointerEventHandler } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RenderBlock } from '@/v3/layout';
import { regionHeaderRect } from '../regionControls';

interface Props {
  block: RenderBlock;
  document: boolean;
  accent: string;
  active: boolean;
  selected: boolean;
  focused: boolean;
  zoom: number;
  onBorderDown: PointerEventHandler<HTMLDivElement>;
  onSelect: MouseEventHandler<HTMLButtonElement>;
  onToggle: () => void;
}

export function CanvasRegion({ block, document, accent, active, selected, focused, zoom, onBorderDown, onSelect, onToggle }: Props) {
  const { x, y, width, height } = block.rect;
  const style = {
    left: x, top: y, width, height,
    '--region-accent': accent,
    '--region-border-hit': `${Math.min(16, 8 / zoom)}px`,
    '--region-title-size': `${Math.min(block.collapsed ? 32 : 26, Math.max(15, 12 / zoom))}px`,
    '--region-header-height': `${regionHeaderRect(block).height}px`,
  } as CSSProperties;
  const toggleLabel = (block.collapsed ? '展开 ' : '折叠 ') + block.name;
  return <div data-region-id={block.id} data-region-collapsed={block.collapsed} data-region-kind={document ? 'document' : 'subgraph'}
    data-hover-id={block.id} data-hover-kind="record" data-region-selected={selected} data-neighbor-focus={focused || undefined}
    className={`canvas-region ${block.collapsed ? 'is-folded' : ''} ${active ? 'is-active' : ''}`} style={style}>
    <div data-record-header={block.id} className="canvas-region-controls">
      <button type="button" data-canvas-interactive className="canvas-region-toggle" aria-expanded={!block.collapsed}
        aria-label={toggleLabel} title={toggleLabel} onClick={e => { if (!e.ctrlKey && !e.metaKey) onToggle(); }}>
        {block.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      </button>
      <button type="button" data-canvas-interactive data-region-title className="canvas-region-name"
        title={block.name} onClick={onSelect} onDoubleClick={e => { if (!e.ctrlKey && !e.metaKey) onToggle(); }}>{block.name}</button>
    </div>
    {(['top', 'right', 'bottom', 'left'] as const).map(side =>
      <div key={side} data-canvas-interactive data-region-border={side} aria-hidden="true" onPointerDown={onBorderDown} />)}
  </div>;
}
