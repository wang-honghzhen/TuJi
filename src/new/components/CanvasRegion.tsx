import type { CSSProperties, MouseEventHandler, PointerEventHandler } from 'react';
import { ChevronDown, ChevronRight, File, Move, Layers } from 'lucide-react';
import type { GraphEdge, Rect } from '@/v3/types';
import type { RenderBlock } from '@/v3/layout';

export interface RegionSummary { nodeCount: number; regionCount: number; preview: RenderBlock[] }
interface Props {
  block: RenderBlock;
  document: boolean;
  active: boolean;
  selected: boolean;
  disabled: boolean;
  summary: RegionSummary;
  edges: GraphEdge[];
  zoom: number;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onSelect: MouseEventHandler<HTMLDivElement>;
  onToggle: () => void;
  onEnter: PointerEventHandler<HTMLDivElement>;
  onLeave: () => void;
}

/** The occupied rectangle stays explicit, while a soft surface and title tab
 * carry the hierarchy instead of stacking heavy picture-frame borders. */
export function CanvasRegion({ block, document, active, selected, summary, edges, zoom, onPointerDown, onSelect, onEnter, onLeave }: Omit<Props, 'disabled' | 'onToggle'>) {
  const points = new Map<string, { x: number; y: number }>();
  if (summary.preview.length) {
    const xs = summary.preview.map(b => b.rect.x + b.rect.width / 2);
    const ys = summary.preview.map(b => b.rect.y + b.rect.height / 2);
    const minX = Math.min(...xs); const minY = Math.min(...ys);
    const width = Math.max(...xs) - minX; const height = Math.max(...ys) - minY;
    const scale = Math.min(78 / Math.max(width, 1), 32 / Math.max(height, 1));
    summary.preview.forEach((b, i) => points.set(b.id, { x: 12 + (78 - width * scale) / 2 + (xs[i] - minX) * scale,
      y: 8 + (32 - height * scale) / 2 + (ys[i] - minY) * scale }));
  }
  const style = { left: block.rect.x, top: block.rect.y, width: block.rect.width, height: block.rect.height,
    zIndex: block.depth * 4, '--region-rgb': document ? '215, 188, 132' : '155, 180, 215' } as CSSProperties;
  return <div data-region-id={block.id} data-region-collapsed={block.collapsed} data-region-kind={document ? 'document' : 'subgraph'}
    data-region-selected={selected} className={`canvas-region ${block.collapsed ? 'is-folded' : ''} ${active ? 'is-active' : ''}`}
    style={style}>
    {block.collapsed && <div data-canvas-interactive data-hover-id={block.id} data-hover-kind="record"
      className="canvas-region-summary overflow-hidden" style={{ display: zoom < .7 ? 'none' : undefined }}
      onPointerDown={onPointerDown} onDragStart={event => event.preventDefault()} onClick={onSelect} onPointerEnter={onEnter} onPointerMove={onEnter} onPointerLeave={onLeave}>
      <div className="canvas-region-metrics" style={{ fontSize: Math.max(18, 11 / zoom) }}><span>{summary.nodeCount} <small style={{ fontSize: Math.max(10, 11 / zoom) }}>节点</small></span>
        <small style={{ fontSize: Math.max(10, 11 / zoom) }}>{summary.regionCount ? `${summary.regionCount} 个下级区域` : document ? '图文档' : '子图'} · 已折叠</small></div>
      <svg width="104" height="50" viewBox="0 0 104 50" aria-hidden="true" className="canvas-region-preview">
        {edges.filter(e => !e.removed && points.has(e.sourceNodeId) && points.has(e.targetNodeId)).slice(0, 24).map(e => {
          const a = points.get(e.sourceNodeId)!; const b = points.get(e.targetNodeId)!;
          return <line key={e.edgeId} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" opacity=".35" />;
        })}
        {[...points].map(([id, p]) => <rect key={id} x={p.x - 4} y={p.y - 2.5} width="8" height="5" rx="1.8" fill="currentColor" opacity=".75" />)}
      </svg>
    </div>}
  </div>;
}

export function CanvasRegionControls({ block, document, active, selected, disabled, rect, summary, onPointerDown, onSelect, onToggle, onEnter, onLeave }:
  Omit<Props, 'edges' | 'zoom'> & { rect: Rect }) {
  return <div data-canvas-interactive data-hover-id={block.id} data-hover-kind="record" data-record-header={block.id}
    data-region-selected={selected} data-active={active} className="canvas-region-controls"
    title={block.name} style={{ left: rect.x, top: rect.y, width: rect.width, zIndex: active ? 2 : 1 }}
    onPointerDown={onPointerDown} onDragStart={event => event.preventDefault()} onClick={onSelect}
    onPointerEnter={onEnter} onPointerMove={onEnter} onPointerLeave={onLeave}>
    <button data-canvas-interactive type="button" disabled={disabled} className="canvas-region-toggle"
      title={(block.collapsed ? '展开 ' : '折叠 ') + block.name} aria-label={(block.collapsed ? '展开 ' : '折叠 ') + block.name}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onToggle(); }}>
      {block.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
    </button>
    <button data-region-drag type="button" className="canvas-region-grip" title={'拖动 ' + block.name} aria-label={'拖动 ' + block.name}>
      <Move size={17} aria-hidden="true" />
    </button>
    {rect.width >= 128 && <>
      {document ? <File size={13} className="text-amber-200/90" /> : <Layers size={13} />}
      <span data-region-title className="canvas-region-name">{block.name}</span>
      {!block.collapsed && <span className="canvas-region-count">{summary.nodeCount}</span>}
    </>}
  </div>;
}
