import { useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GraphEdge, Point } from '@/v3/types';
import type { CanvasNodeOption } from '@/v3/layout';
import type { EdgePatch } from '@/v3/storage';
import { CanvasTextField } from './CanvasTextField';
import { CanvasEdgePicker, type EdgePickerAnchor, type EdgePickerKind } from './CanvasEdgePicker';
import { GraphNameLabel } from './GraphPathLabel';

export interface CanvasDetail {
  kind: 'node' | 'edge' | 'record';
  id: string;
  title: string;
  content: string;
  accent: string;
  targetAccent?: string;
  meta?: string;
}
interface Props {
  detail: CanvasDetail;
  position: Point;
  size: { width: number; height: number };
  maxWidth: number;
  maxHeight: number;
  onResize: (size: { width: number; height: number }) => void;
  onMove: (position: Point) => void;
  onEnter: () => void;
  onLeave: () => void;
  selected?: boolean;
  onActivate: () => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  edge?: GraphEdge;
  designDetails?: ReactNode;
  nodeOptions: CanvasNodeOption[];
  endpointName: (id: string) => string;
  onEdgeChange: (patch: EdgePatch) => void;
}

export function CanvasDetailPanel({ detail, position, size, maxWidth, maxHeight, onResize, onMove, onEnter, onLeave,
  selected, onActivate, onClose, edge, designDetails, nodeOptions, endpointName, onEdgeChange }: Props) {
  const resizing = useRef<{ pointerId: number; start: Point; size: typeof size } | null>(null);
  const moving = useRef<{ pointerId: number; start: Point; position: Point; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState<EdgePickerAnchor | null>(null);
  const openPicker = (kind: EdgePickerKind, element: HTMLButtonElement) => { if (edge?.membershipFor) return; onActivate(); setPicker(picker?.kind === kind ? null : { kind, element }); };
  const closePicker = () => setPicker(null);
  return <>{createPortal(<aside data-canvas-interactive data-canvas-detail data-detail-id={detail.id} data-detail-selected={Boolean(selected)}
    className="space-panel canvas-detail-panel fixed z-[160] flex flex-col"
    style={{ left: position.x, top: position.y, width: size.width, height: size.height, minWidth: 230, minHeight: 150,
      maxWidth: Math.max(230, maxWidth), maxHeight: Math.max(150, maxHeight), overflow: 'hidden', userSelect: 'text',
      '--detail-accent': detail.accent, '--detail-target': detail.targetAccent ?? detail.accent } as CSSProperties}
    onPointerEnter={onEnter} onPointerLeave={onLeave} onPointerDown={(event) => { event.stopPropagation(); onActivate(); }}>
    <div data-detail-drag title="拖动空白处移动详情框" className={`relative shrink-0 px-4 py-3 border-b border-white/10 touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input, textarea, [data-text-key]'))) return;
        event.preventDefault(); event.stopPropagation(); onActivate(); onEnter(); closePicker();
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        moving.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, position,
          width: rect.width, height: rect.height };
        setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = moving.current; if (!current || current.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        onMove({ x: Math.max(8, Math.min(window.innerWidth - current.width - 8, current.position.x + event.clientX - current.start.x)),
          y: Math.max(8, Math.min(window.innerHeight - current.height - 8, current.position.y + event.clientY - current.start.y)) });
      }}
      onPointerUp={(event) => {
        if (!moving.current) return;
        event.stopPropagation(); moving.current = null; setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { moving.current = null; setDragging(false); }} onLostPointerCapture={() => { moving.current = null; setDragging(false); }}>
      <span data-detail-drag-handle aria-hidden="true" className="absolute top-0 left-4 right-12 h-3" />
      <button type="button" aria-label="关闭详情" title="关闭详情" onClick={onClose} className="canvas-detail-close"><X size={16} /></button>
      <div className="pr-7">
      {edge ? <div className="flex items-center gap-1 text-[13px] font-semibold leading-5">
        <button type="button" data-edge-edit="source" title="更换起点" aria-haspopup="dialog" aria-expanded={picker?.kind === 'source'} className="flex-1 min-w-0 truncate text-left hover:text-blue-300" onClick={(event) => openPicker('source', event.currentTarget)}><GraphNameLabel id={edge.sourceNodeId} name={endpointName(edge.sourceNodeId)} /></button>
        <button type="button" data-edge-edit="direction" title="修改方向" aria-haspopup="dialog" aria-expanded={picker?.kind === 'direction'} className="px-2 rounded hover:bg-white/10 text-blue-200" onClick={(event) => openPicker('direction', event.currentTarget)}>{edge.directed ? '→' : '—'}</button>
        <button type="button" data-edge-edit="target" title="更换终点" aria-haspopup="dialog" aria-expanded={picker?.kind === 'target'} className="flex-1 min-w-0 truncate text-right hover:text-blue-300" onClick={(event) => openPicker('target', event.currentTarget)}><GraphNameLabel id={edge.targetNodeId} name={endpointName(edge.targetNodeId)} /></button>
      </div> : detail.kind === 'node' ? <CanvasTextField target={{ kind: 'node', id: detail.id, field: 'name' }} value={detail.title} surface="detail"
        className="canvas-detail-title text-[13px] font-semibold break-words leading-5" multiline={false} placeholder="点击输入节点名" onActivate={onActivate} /> :
        <div className="text-[13px] font-semibold break-words leading-5"><GraphNameLabel id={detail.id} name={detail.title} /></div>}
      {edge ? <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 leading-4">
        <span className="min-w-0 truncate">{detail.meta?.split('\n')[0]}</span>
      </div> : detail.meta && <div className="mt-1 text-[11px] text-slate-400 leading-4 whitespace-pre-wrap">{detail.meta}</div>}
      </div>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto new-scroll px-4 py-3 text-[14px] leading-6 whitespace-pre-wrap break-words">
      {detail.kind === 'record' || edge?.membershipFor ? <div>{detail.content || '暂无内容'}</div> : <CanvasTextField
        target={detail.kind === 'edge' ? { kind: 'edge', id: detail.id, field: 'edgeContent' } : { kind: 'node', id: detail.id, field: 'content' }}
        value={detail.content} surface="detail" className="min-h-24" placeholder={detail.kind === 'edge' ? '点击输入关系描述' : '点击输入节点内容'} onActivate={onActivate} />}
      {designDetails}
    </div>
    <button type="button" data-detail-resize aria-label="调整详情框大小" className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize touch-none select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); onActivate(); onEnter(); closePicker();
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        resizing.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, size: { width: rect.width, height: rect.height } };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = resizing.current;
        if (!current || current.pointerId !== event.pointerId) return;
        event.preventDefault();
        onResize({ width: Math.round(Math.max(230, Math.min(Math.max(230, Math.min(maxWidth, window.innerWidth - position.x - 8)), current.size.width + event.clientX - current.start.x))),
          height: Math.round(Math.max(150, Math.min(Math.max(150, window.innerHeight - position.y - 8), current.size.height + event.clientY - current.start.y))) });
      }}
      onPointerUp={(event) => {
        resizing.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { resizing.current = null; }}>
      <svg viewBox="0 0 20 20" className="w-5 h-5 text-slate-500" aria-hidden="true"><path d="M10 17L17 10M14 17L17 14" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
  </aside>, document.body)}
    {picker && edge && <CanvasEdgePicker key={picker.kind} anchor={picker} edge={edge} nodeOptions={nodeOptions}
      panelX={position.x} panelY={position.y} panelWidth={size.width} panelHeight={size.height}
      onChange={onEdgeChange} onClose={closePicker} onEnter={onEnter} onLeave={onLeave} />}
  </>;
}
