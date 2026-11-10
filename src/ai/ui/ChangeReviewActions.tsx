import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { useAiStore } from '../client';
import { reviewEntries, reviewSelection, reviewUiVersion } from '../changeReview';
import { reviewRefsInArea, useReviewUi } from '../reviewUi';
import type { ReviewAction, ReviewPreview } from '../reviewTypes';
import { reviewObjectName, reviewObjectRefs } from './reviewPresentation';
import './change-review-actions.css';

type Decision = { preview: ReviewPreview; version: string; requestId: string };
const EMPTY: string[] = [];
/** Both actions are checked in advance. Only expanded scope or conflicts need another step. */
export function ChangeReviewActions({ canvasId, unitIds, scopeRefs = EMPTY, all = false, onClose }: {
  canvasId: string; unitIds: string[]; scopeRefs?: string[]; all?: boolean; onClose?: () => void;
}) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command);
  const busy = useReviewUi(s => !!s.working[canvasId]), work = useReviewUi(s => s.work), link = useReviewUi(s => s.link);
  const [decision, setDecision] = useState<Decision>(), [error, setError] = useState('');
  const [previews, setPreviews] = useState<Partial<Record<ReviewAction, Decision>>>({});
  const [refresh, setRefresh] = useState(0), [saving, setSaving] = useState(false);
  const inFlight = useRef(false), refreshDecision = useRef<ReviewAction>();
  const version = JSON.stringify([reviewUiVersion(snapshot, canvasId, unitIds), scopeRefs, refresh]);
  const fresh = decision?.version === version;
  useEffect(() => {
    let cancelled = false; setPreviews({}); setError('');
    if (!snapshot || !unitIds.length) return;
    const selection = reviewSelection(snapshot, unitIds);
    void Promise.all((['approve', 'revert'] as const).map(async action => {
      const preview = await command<ReviewPreview>('changes.review.preview', { canvasId, ...selection, action }, { reportError: false });
      return [action, { preview, version, requestId: 'review-request:' + crypto.randomUUID() }] as const;
    })).then(rows => {
      if (cancelled) return;
      const next = Object.fromEntries(rows); setPreviews(next);
      if (refreshDecision.current) {
        const updated = next[refreshDecision.current];
        setDecision(updated); link(canvasId, updated.preview.unitIds); refreshDecision.current = undefined;
      }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法检查影响范围'); });
    const timer = window.setTimeout(() => { if (!cancelled) setRefresh(n => n + 1); }, 105000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [version]);
  const cancel = () => { setDecision(undefined); setError(''); refreshDecision.current = undefined; link(canvasId, []); };
  const save = async (value: Decision) => {
    if (inFlight.current || useReviewUi.getState().working[canvasId] || value.version !== version || value.preview.conflicts.length) return;
    inFlight.current = true; work(canvasId, true); setSaving(true); setError('');
    try {
      await command('changes.review.apply', { planToken: value.preview.planToken, requestId: value.requestId }, { reportError: false });
      const ui = useReviewUi.getState();
      ui.select(canvasId, (ui.selected[canvasId] ?? []).filter(id => !value.preview.unitIds.includes(id)), ui.selectionRefs[canvasId]);
      cancel(); onClose?.();
    } catch (cause) {
      setDecision(value); setError(cause instanceof Error ? cause.message : '决定未能保存');
    } finally { inFlight.current = false; work(canvasId, false); setSaving(false); }
  };
  const refs = (p?: ReviewPreview) => p?.affectedRefs ?? (snapshot ? reviewObjectRefs(snapshot, p?.unitIds ?? unitIds) : []);
  const area = snapshot && scopeRefs.length ? reviewRefsInArea(snapshot, canvasId, scopeRefs) : undefined;
  const outside = (p: ReviewPreview) => area ? refs(p).filter(ref => !area.has(ref)) : [];
  const otherCanvases = (p: ReviewPreview) => p.affectedCanvasIds.filter(id => id !== canvasId);
  const run = (action: ReviewAction) => {
    const value = previews[action];
    if (!value || value.version !== version || busy || decision && !fresh) return;
    setDecision(value); link(canvasId, value.preview.unitIds);
    if (!value.preview.conflicts.length && !value.preview.linked.length && !outside(value.preview).length && !otherCanvases(value.preview).length) void save(value);
  };
  const hover = (action: ReviewAction) => {
    const p = previews[action]; if (p?.version === version) link(canvasId, p.preview.unitIds);
  };
  const approve = previews.approve?.version === version ? previews.approve.preview : undefined;
  const revert = previews.revert?.version === version ? previews.revert.preview : undefined;
  const ready = !!approve && !!revert;
  const sameScope = ready && JSON.stringify([...refs(approve)].sort()) === JSON.stringify([...refs(revert)].sort());
  const name = snapshot ? reviewObjectName(snapshot, canvasId) : () => '对象';
  const rounds = new Set(snapshot ? reviewEntries(snapshot).filter(e => (decision?.preview.unitIds ?? [...(approve?.unitIds ?? []), ...(revert?.unitIds ?? [])]).includes(e.unit.id)).map(e => e.change.taskId) : []);
  const canvasNames = (p: ReviewPreview) => otherCanvases(p).map(id => snapshot?.graph?.canvases.find(c => c.canvasId === id)?.canvasName ?? '已移除画布').join('、');
  const scopeList = (p: ReviewPreview) => <ul>{refs(p).map(ref => <li key={ref}>{name(ref)}{outside(p).includes(ref) && <span> · 所选区域外</span>}</li>)}</ul>;
  const refreshPreview = () => { refreshDecision.current = decision?.preview.action; setRefresh(n => n + 1); };
  return <div className="change-review-actions" data-review-quick-actions onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="change-review-buttons">
      <button type="button" data-review-keep disabled={busy || !unitIds.length || !approve || !!decision && !fresh}
        title={approve ? '保留涉及的 ' + refs(approve).length + ' 个对象的修改' : '正在检查影响范围'}
        onMouseEnter={() => hover('approve')} onFocus={() => hover('approve')} onClick={() => run('approve')}>
        <Check size={14} />{all ? '全部保留' : '保留'}{ready && !sameScope && <span>{refs(approve).length}</span>}</button>
      <button type="button" data-review-revert disabled={busy || !unitIds.length || !revert || !!decision && !fresh}
        title={revert ? '回退涉及的 ' + refs(revert).length + ' 个对象的修改' : '正在检查影响范围'}
        onMouseEnter={() => hover('revert')} onFocus={() => hover('revert')} onClick={() => run('revert')}>
        <RotateCcw size={14} />{all ? '全部回退' : '回退'}{ready && !sameScope && <span>{refs(revert).length}</span>}</button>
      {onClose && <button type="button" className="change-review-close" aria-label="关闭就地决策" disabled={busy} onClick={() => { cancel(); onClose(); }}><X size={14} /></button>}
    </div>
    {!decision && ready && <>
      <details className="change-review-scope" data-review-quick-scope key={version}>
        <summary>{sameScope ? '涉及 ' + refs(revert).length + ' 个对象' : '保留 ' + refs(approve).length + ' · 回退 ' + refs(revert).length + ' 个对象'}{!all && rounds.size > 1 ? ' · 含上轮修改' : ''}</summary>
        {sameScope ? scopeList(revert) : <><p>保留范围</p>{scopeList(approve)}<p>回退范围</p>{scopeList(revert)}</>}
      </details>
      {area && (outside(approve).length > 0 || outside(revert).length > 0) && <p className="change-review-warning" data-review-outside>
        {sameScope ? '还涉及所选区域外的 ' + outside(revert).length + ' 个对象' : '部分关联修改位于所选区域外'}，执行前会确认。</p>}
      {(otherCanvases(approve).length > 0 || otherCanvases(revert).length > 0) && <p className="change-review-warning">同时影响画布：{[...new Set([canvasNames(approve), canvasNames(revert)].filter(Boolean))].join('、')}</p>}
    </>}
    {!ready && !decision && !error && <p className="change-review-muted" role="status">正在检查…</p>}
    {saving && <p role="status">正在保存…</p>}
    {decision && !saving && <div className="change-review-confirm" data-review-quick-preview aria-live="polite">
      <p>将{decision.preview.action === 'approve' ? '保留' : '回退'}涉及 {refs(decision.preview).length} 个对象的修改。</p>
      {outside(decision.preview).length > 0 && <p className="change-review-warning">包含所选区域外的 {outside(decision.preview).length} 个对象。</p>}
      {decision.preview.linked.length > 0 && <p className="change-review-warning">为保持关联完整，将同时处理相关修改。</p>}
      {!!otherCanvases(decision.preview).length && <p className="change-review-warning">同时影响画布：{canvasNames(decision.preview)}</p>}
      <details className="change-review-scope"><summary>查看影响内容</summary>{scopeList(decision.preview)}
        {!!decision.preview.linked.length && <><p>关联原因</p><ul>{decision.preview.linked.map(item => <li key={item.id}>{item.label}：{item.reason}</li>)}</ul></>}
      </details>
      {[...new Set(decision.preview.conflicts.map(c => c.message))].map(message => <p className="change-review-error" key={message}>{message}</p>)}
      {!fresh && <p className="change-review-warning">修改已变化，请刷新后确认。</p>}
      <div className="change-review-buttons">
        <button type="button" data-review-quick-confirm disabled={busy || !fresh || !!decision.preview.conflicts.length} onClick={() => void save(decision)}>
          {error ? '重试保存' : '确认' + (decision.preview.action === 'approve' ? '保留' : '回退') + ' ' + refs(decision.preview).length + ' 个对象'}</button>
        {(!fresh || error) && <button type="button" disabled={busy} onClick={refreshPreview}>刷新范围</button>}
        <button type="button" disabled={busy} onClick={cancel}>取消</button>
      </div>
    </div>}
    {error && <p className="change-review-error" role="alert">{error}{!decision && <button disabled={busy} onClick={refreshPreview}>重试</button>}</p>}
  </div>;
}
export function ReviewAllActions({ canvasId, surface }: { canvasId: string; surface: 'chat' | 'canvas' }) {
  const snapshot = useAiStore(s => s.snapshot);
  const ids = snapshot ? reviewEntries(snapshot).filter(e => e.change.review!.canvasId === canvasId && e.unit.state === 'pending'
    && snapshot.canvasReviewStates?.[canvasId]?.taskIds.includes(e.change.taskId)).map(e => e.unit.id) : [];
  if (!ids.length || !snapshot) return null;
  return <div className={'change-review-all change-review-all-' + surface} data-review-all={surface}>
    <p>{surface === 'chat' ? 'AI 修改 · ' : ''}最近两轮</p>
    <ChangeReviewActions key={canvasId} canvasId={canvasId} unitIds={ids} all />
  </div>;
}
