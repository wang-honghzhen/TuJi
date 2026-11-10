import { useEffect, useMemo } from 'react';
import { Info, Scan, Sparkles } from 'lucide-react';
import { useAiStore } from '@/ai/client';
import { reviewEntries, expandReviewSelection } from '@/ai/changeReview';
import { DEFAULT_REVIEW_PANEL, reviewUnitsAtRefs, useReviewUi } from '@/ai/reviewUi';
import type { ReviewDelta } from '@/ai/reviewTypes';
import { ChangeReviewActions, ReviewAllActions } from '@/ai/ui/ChangeReviewActions';
import { reviewObjectName, reviewObjectRefs } from '@/ai/ui/reviewPresentation';
import './canvas-review.css';

const EMPTY: string[] = [];
function displayDelta(delta: ReviewDelta, name: (ref: string) => string) {
  const field = delta.path.at(-1) ?? '', labels: Record<string, string> = { name: '名称', content: '正文', description: '子图说明', edgeContent: '关系说明', directed: '关系方向', sourceNodeId: '起点', targetNodeId: '终点', pros: '优点', cons: '不足', type: '类型' };
  const value = (v: unknown): string => {
    if (delta.member) return v ? '包含此成员' : '不包含此成员';
    if (v === undefined) return '不存在';
    if (field === 'directed') return v ? '有向关系' : '无向关系';
    if (typeof v === 'string') return ['sourceNodeId', 'targetNodeId'].includes(field) ? name(v) : v || '（空）';
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : value(x)).join('\n');
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (delta.layout) return `横向 ${Math.round(Number(r.x))}，纵向 ${Math.round(Number(r.y))}`;
      if (typeof r.sourceNodeId === 'string' && typeof r.targetNodeId === 'string') return `${name(r.sourceNodeId)} ${r.directed ? '→' : '—'} ${name(r.targetNodeId)}\n${r.edgeContent ?? ''}`;
      if ('name' in r) return [r.name, r.content, r.description, (r.metadata as { description?: string } | undefined)?.description,
        Array.isArray(r.childIds) ? `${r.childIds.length} 个子项` : undefined].filter(x => x !== undefined && x !== '').join('\n');
      return Object.entries(r).map(([key, v]) => `${labels[key] ?? key}：${value(v)}`).join('\n');
    }
    return String(v);
  };
  return { label: delta.member ? `成员 · ${name(delta.member)}` : delta.layout ? '位置' : labels[field] ?? name(delta.id), before: value(delta.before), after: value(delta.after) };
}

export function CanvasReviewPanel({ canvasId }: { canvasId: string }) {
  const snapshot = useAiStore(s => s.snapshot);
  const canvasSelection = useAiStore(s => s.selectedRefsByCanvas[canvasId] ?? EMPTY);
  const selected = useReviewUi(s => s.selected[canvasId] ?? EMPTY), select = useReviewUi(s => s.select);
  const selectionRefs = useReviewUi(s => s.selectionRefs[canvasId] ?? EMPTY);
  const link = useReviewUi(s => s.link), working = useReviewUi(s => !!s.working[canvasId]);
  const boxCanvasId = useReviewUi(s => s.boxCanvasId), box = useReviewUi(s => s.box);
  const panel = useReviewUi(s => s.panels[canvasId] ?? DEFAULT_REVIEW_PANEL), configure = useReviewUi(s => s.panel);
  const entries = useMemo(() => snapshot ? reviewEntries(snapshot).filter(e => e.unit.state === 'pending' && e.change.review!.canvasId === canvasId) : [], [snapshot?.changes, canvasId]);
  const taskIds = snapshot?.canvasReviewStates?.[canvasId]?.taskIds ?? EMPTY;
  const roundTaskId = taskIds.at(-1 - panel.round), shown = entries.filter(e => e.change.taskId === roundTaskId);
  const roundTask = snapshot?.tasks.find(t => t.id === roundTaskId);
  const archived=snapshot?.changes.find(c=>c.taskId===roundTaskId&&c.reviewArchive)?.reviewArchive;
  const roundRequest = snapshot?.messages.find(m => m.id === roundTask?.rootUserMessageId)?.text??archived?.request??archived?.title;
  const roundSession = snapshot?.sessions.find(s => s.id === (roundTask?.sessionId??archived?.sessionId));
  const ids = snapshot ? expandReviewSelection(snapshot, selected.filter(id => entries.some(e => e.unit.id === id))) : [];
  const canvasSelectionKey = canvasSelection.join('|');
  useEffect(() => () => { link(canvasId, []); if (useReviewUi.getState().boxCanvasId === canvasId) box(undefined); }, [canvasId]);
  useEffect(() => {
    if (panel.lastTaskId !== taskIds.at(-1)) configure(canvasId, { round: 0, lastTaskId: taskIds.at(-1) });
  }, [canvasId, taskIds.at(-1)]);
  useEffect(() => {
    if (snapshot && panel.canvasSelectionKey !== canvasSelectionKey) {
      select(canvasId, reviewUnitsAtRefs(snapshot, canvasId, canvasSelection), canvasSelection);
      configure(canvasId, { canvasSelectionKey });
    }
  }, [canvasId, canvasSelectionKey, !!snapshot]);
  useEffect(() => { if (!entries.length && boxCanvasId === canvasId) box(undefined); }, [entries.length, boxCanvasId, canvasId]);
  if (!snapshot || !entries.length) return <div data-review-empty className="review-empty">
    <Sparkles size={23} aria-hidden="true" /><p>{snapshot ? '暂无待处理的 AI 修改' : '正在读取 AI 修改…'}</p>
    <p className="review-help">AI 修改后，点击画布上的标记即可保留或回退。</p>
  </div>;
  const name = reviewObjectName(snapshot, canvasId);
  const groups = new Map<string, typeof shown>();
  for (const e of shown) {
    const key = e.change.review?.groupId ?? 'legacy:' + (e.unit.parentId ?? canvasId);
    const group = groups.get(key) ?? []; group.push(e); groups.set(key, group);
  }
  const toggle = (groupIds: string[]) => {
    link(canvasId, []);
    select(canvasId, groupIds.every(id => ids.includes(id)) ? ids.filter(id => !groupIds.includes(id)) : [...ids, ...groupIds]);
  };
  const differences = (unit: typeof shown[number]['unit']) => <details className="review-unit-diff"><summary>查看变化</summary>
    {unit.deltas.filter(d => !d.layout || unit.kind === 'move' && unit.refs.includes(d.path.at(-1)!)).map((d, i) => {
      const diff = displayDelta(d, name);
      return <div key={i} className="review-diff"><strong>{diff.label}</strong>
        <div className="review-before"><span>修改前</span><pre>{diff.before}</pre></div>
        <div className="review-after"><span>修改后</span><pre>{diff.after}</pre></div></div>;
    })}</details>;
  return <section data-review-panel className="canvas-review-panel" aria-label="AI 修改">
    <div className="review-heading"><span>修改已应用</span><span tabIndex={0} role="note" aria-label="审阅说明"
      title="保留会确认当前结果，回退会撤回相关修改。这里只保留最近两轮待处理修改；开始第三轮写入时，最早一轮会自动保留。"><Info size={14} /></span></div>
    <div className="review-body">
      <div className="review-toolbar">
        <div className="review-round-tabs" role="group" aria-label="修改轮次">
          {[0, 1].map(n => <button key={n} disabled={!taskIds.at(-1 - n)} aria-pressed={panel.round === n}
            onClick={() => configure(canvasId, { round: n })}>{n ? '上轮' : '本轮'}</button>)}
        </div>
        <button className="review-text-button" disabled={working || !shown.length} onClick={() => { link(canvasId, []); select(canvasId, shown.map(e => e.unit.id)); }}
          data-review-select-round>全选{panel.round ? '上轮' : '本轮'}</button>
        <button className="review-box-button" aria-label="框选修改" title="在画布上框选修改" aria-pressed={boxCanvasId === canvasId}
          disabled={working} onClick={() => box(boxCanvasId === canvasId ? undefined : canvasId)}><Scan size={15} /></button>
      </div>
      <p className="review-help review-round" title={(roundSession?.title || '会话') + (roundRequest ? ' · ' + roundRequest : '')}>{roundRequest || roundSession?.title || '画布修改'}</p>
      <div className="review-list">
        {!shown.length && <p className="review-help">这一轮已全部处理。</p>}
        {[...groups].map(([key, group]) => {
          const groupIds = group.map(e => e.unit.id), count = groupIds.filter(id => ids.includes(id)).length;
          const grouped = group[0].change.review?.policy === 'group';
          const refs = reviewObjectRefs(snapshot, groupIds), names = refs.map(name);
          const label = grouped ? names.slice(0, 2).join('、') + (names.length > 2 ? ' 等 ' + names.length + ' 个对象' : '')
            : name(group[0].unit.parentId ?? canvasId);
          const kinds = [...new Set(group.map(e => ({ create: '新增', update: '修改', delete: '删除', move: '移动' }[e.unit.kind])))].join('、');
          const commits = [...new Set(group.map(e => e.change.id))];
          return <div key={key} className={'review-group' + (count ? ' is-selected' : '')} data-review-group={grouped ? key : undefined}>
            <label className="review-group-label"><input type="checkbox" checked={count === group.length} disabled={working}
              ref={el => { if (el) el.indeterminate = count > 0 && count < group.length; }} onChange={() => toggle(groupIds)} />
              <span title={names.join('、')}>{label}</span></label>
            {grouped ? <><p className="review-group-caption">{kinds}{refs.length > 1 ? ' · 一起处理' : ''}</p>
              <details className="review-group-details"><summary>查看修改</summary>
                {group.map(({ unit, change }, index) => <div key={unit.id} data-review-unit={unit.id} className="review-item">
                  {group[index - 1]?.change.id !== change.id && commits.length > 1 && <p data-review-commit={change.id} className="review-help">提交 {commits.indexOf(change.id) + 1}</p>}
                  <span data-review-kind={unit.kind}>{unit.label}</span>{differences(unit)}
                </div>)}
              </details></>
              : <><p className="review-group-caption">早期修改，可单项选择</p>
                {group.map(({ unit }) => <div key={unit.id} data-review-unit={unit.id} className="review-item">
                  <label><input type="checkbox" checked={ids.includes(unit.id)} disabled={working} onChange={() => toggle([unit.id])} />
                    <span data-review-kind={unit.kind}>{unit.label}</span></label>{differences(unit)}
                </div>)}
              </>}
          </div>;
        })}
      </div>
    </div>
    <div className="review-footer">
      {ids.length ? <div data-review-selection>
        <div className="review-selection-heading"><span>已选修改</span><button className="review-text-button" disabled={working}
          onClick={() => { select(canvasId, []); link(canvasId, []); }}>取消选择</button></div>
        <ChangeReviewActions key={canvasId} canvasId={canvasId} unitIds={ids} scopeRefs={selectionRefs} />
      </div> : <ReviewAllActions canvasId={canvasId} surface="canvas" />}
    </div>
  </section>;
}
