import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasNodeOption } from '@/v3/layout';
import type { GraphEdge } from '@/v3/types';
import type { EdgePatch } from '@/v3/storage';
import { GraphPathLabel } from './GraphPathLabel';

export type EdgePickerKind = 'source' | 'target' | 'direction';
export interface EdgePickerAnchor { kind: EdgePickerKind; element: HTMLButtonElement }

interface Props {
  anchor: EdgePickerAnchor;
  edge: GraphEdge;
  nodeOptions: CanvasNodeOption[];
  panelX: number;
  panelY: number;
  panelWidth: number;
  panelHeight: number;
  onChange: (patch: EdgePatch) => void;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

/** Kept outside the detail panel so its scroll area cannot clip the options. */
export function CanvasEdgePicker({ anchor, edge, nodeOptions, panelX, panelY, panelWidth, panelHeight,
  onChange, onClose, onEnter, onLeave }: Props) {
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const endpoint = anchor.kind === 'source' || anchor.kind === 'target';
  const title = anchor.kind === 'source' ? '选择起点' : anchor.kind === 'target' ? '选择终点' : '选择方向';
  const options = nodeOptions.filter((item) => item.id !== (anchor.kind === 'source' ? edge.targetNodeId : edge.sourceNodeId) &&
    item.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const placed = Boolean(bounds);
  useEffect(() => { if (placed && endpoint) searchInput.current?.focus({ preventScroll: true }); }, [placed, endpoint]);

  useLayoutEffect(() => {
    const menu = popup.current; if (!menu) return;
    const place = () => {
      const rect = anchor.element.getBoundingClientRect();
      const scroller = anchor.element.closest('.new-scroll')?.getBoundingClientRect();
      if (!anchor.element.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight ||
        (scroller && (rect.bottom <= scroller.top || rect.top >= scroller.bottom))) { onClose(); return; }
      const width = Math.min(endpoint ? 320 : 210, window.innerWidth - 16);
      // Measure at full available height before choosing a side; a previously
      // clipped list must be able to grow again when the panel moves.
      menu.style.width = `${width}px`; menu.style.maxHeight = `${window.innerHeight - 16}px`;
      const height = menu.getBoundingClientRect().height;
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const above = Math.max(0, rect.top - 14);
      const useAbove = below < height && above > below;
      const maxHeight = Math.max(0, useAbove ? above : below);
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
      const top = useAbove ? Math.max(8, rect.top - Math.min(height, maxHeight) - 6) : Math.min(window.innerHeight - 8, rect.bottom + 6);
      menu.style.maxHeight = `${maxHeight}px`;
      setBounds((old) => old && old.left === left && old.top === top && old.width === width && old.maxHeight === maxHeight ? old :
        { left, top, width, maxHeight });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(anchor.element);
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && menu.contains(event.target))) place(); };
    window.addEventListener('resize', place); window.addEventListener('scroll', onScroll, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [anchor, endpoint, panelX, panelY, panelWidth, panelHeight, search, options.length, onClose]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !anchor.element.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); onClose(); anchor.element.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [anchor, onClose]);

  const choose = (patch: EdgePatch) => { onChange(patch); onClose(); anchor.element.focus({ preventScroll: true }); };
  const currentNodeId = anchor.kind === 'source' ? edge.sourceNodeId : edge.targetNodeId;
  return createPortal(<div ref={popup} data-canvas-interactive data-canvas-popup data-edge-picker={anchor.kind} data-picker-owner={edge.edgeId}
    role="dialog" aria-label={title} className="space-menu fixed z-[180] flex flex-col p-2 text-xs leading-5"
    style={{ left: bounds?.left ?? 0, top: bounds?.top ?? 0, width: bounds?.width ?? (endpoint ? 320 : 210),
      maxHeight: bounds?.maxHeight ?? window.innerHeight - 16, visibility: bounds ? 'visible' : 'hidden', overflow: 'hidden' }}
    onPointerDown={(event) => event.stopPropagation()} onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <div className="flex shrink-0 justify-between text-slate-400 mb-2"><span>{title}</span>
      <button type="button" onClick={onClose} aria-label="关闭选项" className="px-1 hover:text-slate-100">×</button></div>
    {endpoint ? <>
      <input ref={searchInput} data-endpoint-search value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索路径或节点名"
        className="w-full shrink-0 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 mb-2 outline-none focus:border-blue-400" />
      <div className="min-h-0 max-h-52 overflow-y-auto new-scroll">{options.length ? options.map((item) =>
        <button key={item.id} type="button" data-endpoint-option={item.id} aria-pressed={item.id === currentNodeId}
          className={`block w-full text-left px-2 py-1.5 break-words rounded hover:bg-blue-500/20 ${item.id === currentNodeId ? 'bg-blue-500/15 text-blue-200' : ''}`}
          onClick={() => choose({ [anchor.kind === 'source' ? 'sourceNodeId' : 'targetNodeId']: item.id })}><GraphPathLabel segments={item.segments} /></button>) :
        <div className="px-2 py-2 text-slate-500">没有匹配的节点</div>}</div>
    </> : <div className="min-h-0 overflow-y-auto new-scroll">
      {(['reverse', 'forward', 'none'] as const).map((direction, index) => <button key={direction} type="button" data-direction-option={direction}
        className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-blue-500/20" onClick={() => choose({ direction })}>
        <span className="w-5 text-center text-lg text-blue-200">{['←', '→', '—'][index]}</span><span>{['交换起点与终点', '有向边', '无向边'][index]}</span></button>)}</div>}
  </div>, document.body);
}
