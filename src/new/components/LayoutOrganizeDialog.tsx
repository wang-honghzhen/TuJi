import { useEffect, useRef, useState } from 'react';
import { useAiStore } from '@/ai/client';
import { getStructurePaths } from '@/v3/structure';
import type { CanvasRecord, GraphState } from '@/v3/types';
import type { LayoutStats } from '@/v3/relationshipLayout';
import { GraphChoiceField } from './GraphChoiceField';

interface Preview { proposalId: string; graphRevision: number; graph: GraphState; stats: LayoutStats; affectedCanvasIds?: string[] }
// The organizer owns these errors; discarded/canceled previews must not pollute the composer.
const localErrors = { reportError: false };
const area = (value?: number) => value === undefined ? '' : `${Math.round(value / 100) / 10}k`;
/** What the run actually did, in the user's terms: how much moved, and whether
 *  the crossings it was asked to reduce went down or the proposal was dropped.
 *  A figure that did not change is left out instead of padding the sentence. */
function summary(stats?: LayoutStats): string {
  if (!stats) return '等待预览。';
  const parts: string[] = [];
  if (stats.packed) parts.push(`按阅读顺序整理 ${stats.packed} 个对象`);
  if ((stats.crossingsBefore ?? 0) > 0 || (stats.crossingsAfter ?? 0) > 0)
    parts.push(`交叉 ${stats.crossingsBefore ?? 0} → ${stats.crossingsAfter ?? 0}`);
  const [before, after] = [stats.areaBefore, stats.areaAfter];
  if (before !== undefined && after !== undefined && Math.abs(after - before) > Math.max(before * .05, 1000))
    parts.push(`占用 ${area(before)} → ${area(after)}`);
  const detail = parts.length ? `${parts.join('，')}。` : '';
  if (stats.moved) return `预览调整 ${stats.moved} 个对象的位置。${detail}`;
  if (stats.rejected) return `${
    (stats.crossingsAfter ?? 0) > (stats.crossingsBefore ?? 0) ? '整理会增加交叉，已保留当前排布。' : '整理改善幅度过小，已保留当前排布。'
  }${detail}`;
  return `当前排布已经合适，无需调整。${detail}`;
}
export function LayoutOrganizeDialog({ state, canvas, graphRevision, initialRegionId, onPreview, onClose, onCommitted, onInspect }: {
  state: GraphState; canvas: CanvasRecord; graphRevision: number; initialRegionId: string;
  onPreview: (graph: GraphState | null) => void; onClose: () => void; onCommitted: (changeSetId: string) => void;
  onInspect?: (regionId: string) => void;
}) {
  const [regionId, setRegionId] = useState(initialRegionId), [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), mounted = useRef(true), current = useRef<Preview>();
  const operationId = useRef(`user-layout:${crypto.randomUUID()}`);
  const previewCallback = useRef(onPreview); previewCallback.current = onPreview;
  const paths = getStructurePaths(state, canvas).filter(p => p.kind !== 'node');
  const generate = async () => {
    const request = ++sequence.current; setBusy(true); setError(''); setPreview(undefined); previewCallback.current(null);
    if (current.current) void useAiStore.getState().command('graph.layout.cancel', { proposalId: current.current.proposalId }, localErrors).catch(() => undefined);
    current.current = undefined; operationId.current = `user-layout:${crypto.randomUUID()}`;
    try {
      const result = await useAiStore.getState().command<Preview>('graph.layout.preview', { canvasId: canvas.canvasId, regionId }, localErrors);
      if (!mounted.current || request !== sequence.current) { void useAiStore.getState().command('graph.layout.cancel', { proposalId: result.proposalId }, localErrors).catch(() => undefined); return; }
      current.current = result; setPreview(result); previewCallback.current(result.graph);
    } catch (cause) { if (mounted.current && request === sequence.current) setError(cause instanceof Error ? cause.message : '整理失败'); }
    finally { if (mounted.current && request === sequence.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    // StrictMode replays setup/cleanup synchronously. Start only the surviving effect's request.
    queueMicrotask(() => { if (active) void generate(); });
    return () => {
      active = false; mounted.current = false; sequence.current++; previewCallback.current(null);
      if (current.current) void useAiStore.getState().command('graph.layout.cancel', { proposalId: current.current.proposalId }, localErrors).catch(() => undefined);
    };
  }, [regionId]);
  useEffect(() => {
    if (preview && preview.graphRevision !== graphRevision) {
      previewCallback.current(null); setError('画布已更新，请重新生成预览。');
    }
  }, [graphRevision, preview]);
  const apply = async () => {
    if (!preview) return; setBusy(true); setError('');
    try {
      const result = await useAiStore.getState().command<{ changeSetId: string }>('graph.layout.apply', { proposalId: preview.proposalId, operationId: operationId.current }, localErrors);
      onCommitted(result.changeSetId); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="fixed inset-0 z-[200] bg-black/15" data-layout-organize-overlay>
    <section role="dialog" aria-modal="true" aria-label="整理目录" data-layout-organize className="space-panel space-form absolute right-6 top-20 w-[360px] max-w-[calc(100vw-24px)] p-5 text-sm">
      <h2 className="font-medium text-blue-100">整理目录</h2>
      <div className="mt-3 text-xs text-slate-400">范围
        <div data-layout-scope className="mt-1 grid"><GraphChoiceField field="layout-scope" value={regionId} disabled={busy}
          options={paths.map(path => ({ id: path.id, label: path.path, segments: path.segments }))} onChange={setRegionId} placeholder="选择目录路径" /></div>
      </div>
      <p className="mt-3 text-xs text-slate-400">排列此目录的直属节点与子目录，保留子目录内部排布。画布正在显示预览。</p>
      <p role="status" data-layout-summary className="mt-3 text-xs text-slate-200">{busy ? '正在计算或保存…' : summary(preview?.stats)}</p>
      {preview && (preview.affectedCanvasIds?.length ?? 0) > 1 && <p className="mt-2 text-xs text-slate-400">共享内容会同步到 {preview.affectedCanvasIds!.length} 个画布。</p>}
      {error && <p role="alert" className="mt-3 text-xs text-amber-200">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button data-layout-cancel className="rounded px-2 py-1.5 text-xs hover:bg-white/10" onClick={onClose}>取消</button>
        <button data-layout-fit className="rounded px-2 py-1.5 text-xs hover:bg-white/10" disabled={!preview || busy} onClick={() => onInspect?.(regionId)}>适应预览</button>
        <button data-layout-regenerate className="rounded px-2 py-1.5 text-xs hover:bg-white/10" disabled={busy} onClick={() => { void generate(); }}>重新生成</button>
        <button data-layout-apply className="space-primary-button px-3 py-1.5 text-xs disabled:opacity-40" disabled={busy || !preview?.stats.moved || preview.graphRevision !== graphRevision} onClick={() => { void apply(); }}>应用布局</button>
      </div>
    </section>
  </div>;
}
