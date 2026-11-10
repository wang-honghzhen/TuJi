import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAiStore } from '@/ai/client';
import { reviewEntries, expandReviewSelection, reviewDecisionCount, reviewUnitRefs } from '@/ai/changeReview';
import { reviewUnitsAtRefs, useReviewUi } from '@/ai/reviewUi';
import type { RenderModel } from '@/v3/layout';
import type { Point, Rect } from '@/v3/types';
import type { CanvasViewport } from '../canvasViewportStore';
import { useSidebarInsets } from '../newUiStore';
import { ChangeReviewActions } from '@/ai/ui/ChangeReviewActions';

const EMPTY: string[] = [];
const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
interface ReviewTarget { id: string; label: string; ids: string[]; refs: string[]; anchor: Point }
function LocalReview({ canvasId, target, onClose }: { canvasId: string; target: ReviewTarget; onClose: () => void }) {
  const element = useRef<HTMLElement>(null), insets = useSidebarInsets();
  const [height, setHeight] = useState(88), [, resize] = useState(0);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => { if (element.current) setHeight(element.current.getBoundingClientRect().height); });
    if (element.current) observer.observe(element.current);
    const onResize = () => resize(value => value + 1); window.addEventListener('resize', onResize);
    return () => { observer.disconnect(); window.removeEventListener('resize', onResize); };
  }, []);
  const width = Math.min(285, Math.max(200, window.innerWidth - insets.left - insets.right - 24));
  const left = Math.max(8, insets.left + 8, Math.min(target.anchor.x, window.innerWidth - insets.right - width - 8));
  const top = Math.max(64, Math.min(target.anchor.y, window.innerHeight - height - 16));
  return createPortal(<aside ref={element} className="canvas-review-local" data-canvas-popup data-review-local={target.id}
    style={{ position: 'fixed', left, top, width, zIndex: 170 }} aria-label={`${target.label}的待决策修改`}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="canvas-review-local-title" title={target.label}>{target.label}</div>
    <ChangeReviewActions canvasId={canvasId} unitIds={target.ids} scopeRefs={target.refs} onClose={onClose} />
  </aside>, document.body);
}
export function CanvasReviewOverlay({ canvasId, model, view }: { canvasId: string; model: RenderModel; view: CanvasViewport }) {
  const snapshot = useAiStore(s => s.snapshot), selected = useReviewUi(s => s.selected[canvasId] ?? EMPTY);
  const linked = useReviewUi(s => s.linked[canvasId] ?? EMPTY), emphasized = snapshot ? expandReviewSelection(snapshot,[...selected, ...linked]) : [...selected, ...linked];
  const boxMode = useReviewUi(s => s.boxCanvasId === canvasId), select = useReviewUi(s => s.select), box = useReviewUi(s => s.box);
  const [drag, setDrag] = useState<{ start: Point; end: Point; extend: boolean }>();
  const canvasSelection = useAiStore(s => s.selectedRefsByCanvas[canvasId] ?? EMPTY);
  const [localTarget, setLocalTarget] = useState<string>(), [dismissed, dismiss] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => { setLocalTarget(undefined); dismiss(false); }, [canvasId, canvasSelection.join('|')]);
  const entries = useMemo(() => snapshot ? reviewEntries(snapshot).filter(e => e.unit.state === 'pending'
    && (e.change.review!.canvasId === canvasId || e.change.affectedCanvasIds.includes(canvasId))) : [], [snapshot?.changes, canvasId]);
  if (!snapshot || !entries.length) return null;
  const ghosts = entries.flatMap(e => e.unit.ghosts.filter(g => (g.canvasId ?? e.change.review!.canvasId) === canvasId).map(ghost => ({ unit: e.unit, ghost, change: e.change })))
    .filter(e => !model.membership.has(e.ghost.id) && !model.edges.some(edge => edge.edge.edgeId === e.ghost.id));
  const pick = (ids: string[], extend: boolean, refs: string[]) => {
    // A marker/ghost selection also applies while the review sidebar is hidden.
    useReviewUi.getState().panel(canvasId, { canvasSelectionKey: canvasSelection.join('|') });
    select(canvasId, extend ? [...selected, ...ids] : ids, extend ? [...(useReviewUi.getState().selectionRefs[canvasId] ?? []), ...refs] : refs);
  };
  const choose = (ref: string, ids: string[], extend = false) => { setLocalTarget(ref); dismiss(false); pick(ids, extend, [ref]); };
  const own = new Set(entries.filter(e => e.change.review!.canvasId === canvasId).map(e => e.unit.id));
  const matching = (ref: string) => entries.filter(e=>own.has(e.unit.id)&&reviewUnitRefs(e.unit).includes(ref)).map(e=>e.unit.id);
  const origin = svg.current?.getBoundingClientRect();
  const screen = (p: Point) => ({ x: (origin?.left ?? 0) + view.x + p.x * view.zoom, y: (origin?.top ?? 0) + view.y + p.y * view.zoom + 8 });
  const targets: ReviewTarget[] = model.blocks.flatMap(block => {
    const ids = block.kind === 'node' ? matching(block.id)
      : reviewUnitsAtRefs(snapshot, canvasId, [block.id]);
    return ids.length ? [{ id: block.id, label: block.name, ids, refs: [block.id], anchor: screen({ x: block.rect.x, y: block.rect.y + (block.kind === 'node' ? block.rect.height : 36) }) }] : [];
  });
  for (const edge of model.edges) {
    const ids = entries.filter(e => own.has(e.unit.id) && reviewUnitRefs(e.unit).some(ref => [edge.edge.edgeId, ...(edge.aggregateEdgeIds ?? [])].includes(ref))).map(e => e.unit.id);
    if (ids.length) targets.push({ id: edge.edge.edgeId, label: edge.edge.edgeContent || '关系', ids, refs: [edge.edge.edgeId, ...(edge.aggregateEdgeIds ?? [])],
      anchor: screen({ x: (edge.source.x + edge.target.x) / 2, y: (edge.source.y + edge.target.y) / 2 }) });
  }
  for (const { ghost, unit, change } of ghosts) if (change.review!.canvasId === canvasId) targets.push({ id: ghost.id,
    label: unit.refs.includes(ghost.id) ? `已删除 · ${ghost.name || '关系'}` : `${unit.label}（包含${ghost.name || '关系'}）`, ids: [...new Set([unit.id,...matching(ghost.id)])], refs: [ghost.id],
    anchor: screen({ x: ghost.x, y: ghost.y + (ghost.kind === 'region' ? 36 : ghost.height) }) });
  const activeId = localTarget ?? (canvasSelection.length === 1 ? canvasSelection[0] : undefined);
  const active = !dismissed ? targets.find(t => t.id === activeId) : undefined;
  const close = () => { dismiss(true); setLocalTarget(undefined); useReviewUi.getState().link(canvasId, []); };
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - view.x) / view.zoom, y: (event.clientY - bounds.top - view.y) / view.zoom };
  };
  const selection = drag ? { x: Math.min(drag.start.x, drag.end.x), y: Math.min(drag.start.y, drag.end.y), width: Math.abs(drag.start.x - drag.end.x), height: Math.abs(drag.start.y - drag.end.y) } : undefined;
  return <><svg ref={svg} data-review-overlay className="absolute inset-0 h-full w-full" style={{ zIndex: 125, pointerEvents: boxMode ? 'auto' : 'none', cursor: boxMode ? 'crosshair' : undefined }}
    onPointerDown={event => { if (!boxMode || event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); const start = point(event); setDrag({ start, end: start, extend: event.shiftKey }); }}
    onPointerMove={event => { if (drag) { event.stopPropagation(); setDrag({ ...drag, end: point(event) }); } }}
    onPointerUp={event => {
      if (!drag) return; event.stopPropagation();
      const end = point(event), rect = { x: Math.min(drag.start.x, end.x), y: Math.min(drag.start.y, end.y), width: Math.abs(end.x - drag.start.x), height: Math.abs(end.y - drag.start.y) };
      const refs = model.blocks.filter(b => b.kind === 'node' ? intersects(rect, b.rect) : contains(rect, b.rect)).map(b => b.id);
      for (const e of model.edges) if (contains(rect, { ...e.source, width: 0, height: 0 }) && contains(rect, { ...e.target, width: 0, height: 0 })) refs.push(e.edge.edgeId);
      const ids = reviewUnitsAtRefs(snapshot, canvasId, refs);
      for (const { ghost, unit, change } of ghosts) if (change.review!.canvasId === canvasId && (ghost.kind === 'region' ? contains(rect, ghost) : intersects(rect, ghost))) { ids.push(unit.id,...matching(ghost.id)); refs.push(ghost.id); }
      pick(ids, drag.extend, refs); setDrag(undefined); box(undefined);
    }} onPointerCancel={() => setDrag(undefined)}>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
      {model.blocks.map(block => {
        const direct = entries.filter(e => reviewUnitRefs(e.unit).includes(block.id));
        const nested = block.kind === 'node' ? [] : reviewUnitsAtRefs(snapshot, canvasId, [block.id], true);
        const ids = [...new Set([...direct.map(e => e.unit.id), ...nested])]; if (!ids.length) return null;
        const created = direct.some(e => e.unit.kind === 'create'), color = created ? '#4ade80' : '#fbbf24';
        const foreign = entries.find(e => ids.includes(e.unit.id) && e.change.review!.canvasId !== canvasId);
        const source = foreign ? ` · 来自${snapshot.graph?.canvases.find(c => c.canvasId === foreign.change.review!.canvasId)?.canvasName ?? '其他画布'}` : '';
        const text = `${block.kind !== 'node' && !direct.length ? '待处理' : created ? '＋新增' : '修改'}${block.kind !== 'node' ? ` ${reviewDecisionCount(snapshot,ids)}` : ''}${source}`;
        return <g key={block.id} data-review-mark={block.id}>
          <rect x={block.rect.x - 3} y={block.rect.y - 3} width={block.rect.width + 6} height={block.rect.height + 6} rx={12} fill="none" stroke={color} strokeWidth={ids.some(id => emphasized.includes(id)) ? 3.5 : 1.5} strokeDasharray={created ? undefined : '6 3'} />
          <g data-review-open={block.id} role={ids.some(id => own.has(id)) ? 'button' : undefined} tabIndex={ids.some(id => own.has(id)) ? 0 : undefined}
            aria-label={`决定是否保留${block.name}的修改`} style={{ pointerEvents: !boxMode && ids.some(id => own.has(id)) ? 'auto' : 'none', cursor: 'pointer' }}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); choose(block.id, ids.filter(id => own.has(id)), event.shiftKey); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(block.id, ids.filter(id => own.has(id))); } }}>
            <rect x={block.rect.x + 5} y={block.rect.y - 22} width={Math.max(76, text.length * 11)} height={22} rx={4} fill="#0f172a" />
            <text x={block.rect.x + 9} y={block.rect.y - 7} fill={color} fontSize={11}>{text}</text>
          </g>
        </g>;
      })}
      {model.edges.map(edge => {
        const related = entries.filter(e => reviewUnitRefs(e.unit).some(ref => [edge.edge.edgeId, ...(edge.aggregateEdgeIds ?? [])].includes(ref)));
        if (!related.length) return null;
        const created = related.some(e => e.unit.kind === 'create'), color = created ? '#4ade80' : '#fbbf24';
        const foreign = related.find(e => e.change.review!.canvasId !== canvasId);
        const source = foreign ? ` · 来自${snapshot.graph?.canvases.find(c => c.canvasId === foreign.change.review!.canvasId)?.canvasName ?? '其他画布'}` : '';
        return <g key={edge.edge.edgeId} data-review-edge={edge.edge.edgeId}><path d={edge.route.path} stroke={color} strokeWidth={related.some(e => emphasized.includes(e.unit.id)) ? 4.5 : 2} strokeDasharray="6 3" fill="none" />
          <text data-review-open={edge.edge.edgeId} x={(edge.source.x + edge.target.x) / 2} y={(edge.source.y + edge.target.y) / 2 - 8} fill={color} fontSize={11}
            role={related.some(e => own.has(e.unit.id)) ? 'button' : undefined} tabIndex={related.some(e => own.has(e.unit.id)) ? 0 : undefined}
            aria-label={`决定是否保留关系${edge.edge.edgeContent}的修改`} style={{ pointerEvents: !boxMode && related.some(e => own.has(e.unit.id)) ? 'auto' : 'none', cursor: 'pointer' }}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); choose(edge.edge.edgeId, related.filter(e => own.has(e.unit.id)).map(e => e.unit.id), event.shiftKey); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(edge.edge.edgeId, related.filter(e => own.has(e.unit.id)).map(e => e.unit.id)); } }}>
            {created ? '＋新增关系' : '修改关系'}{source}</text></g>;
      })}
      {ghosts.map(({ unit, ghost, change }) => <g key={`${unit.id}:${ghost.id}`} data-review-ghost={ghost.id} role={change.review!.canvasId === canvasId ? 'button' : undefined} tabIndex={change.review!.canvasId === canvasId ? 0 : undefined} aria-label={`已删除的${ghost.name}`}
        style={{ pointerEvents: boxMode || change.review!.canvasId !== canvasId ? 'none' : 'auto', cursor: 'pointer' }} onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); choose(ghost.id, [...new Set([unit.id,...matching(ghost.id)])], event.shiftKey); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(ghost.id, [...new Set([unit.id,...matching(ghost.id)])], event.shiftKey); } }}>
        {ghost.kind === 'edge' ? <line x1={ghost.x} y1={ghost.y} x2={ghost.targetX} y2={ghost.targetY} stroke="#fb7185" strokeWidth={emphasized.includes(unit.id) ? 5 : 3} strokeDasharray="7 5" />
          : <><rect x={ghost.x} y={ghost.y} width={ghost.width} height={ghost.height} rx={10} stroke="#fb7185" strokeWidth={emphasized.includes(unit.id) ? 3 : 1.5} fill="#7f1d1d25" strokeDasharray="7 5" />
            <text x={ghost.x + 10} y={ghost.y + 21} fill="#fda4af" fontSize={12}>－已删除 · {ghost.name}{change.review!.canvasId !== canvasId ? ` · 来自${snapshot.graph?.canvases.find(c => c.canvasId === change.review!.canvasId)?.canvasName ?? '其他画布'}` : ''}</text></>}
      </g>)}
      {selection && <rect {...selection} fill="#60a5fa25" stroke="#93c5fd" strokeWidth={1 / view.zoom} />}
    </g>
  </svg>{active && !boxMode && <LocalReview key={`${canvasId}:${active.id}`} canvasId={canvasId} target={active} onClose={close} />}</>;
}
