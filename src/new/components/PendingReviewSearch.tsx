import { useMemo } from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { useAiStore } from '@/ai/client';
import { useReviewUi } from '@/ai/reviewUi';
import { useNewUiStore } from '../newUiStore';
import { searchPendingReviews, type PendingReviewResult } from '../graphSearch';
import { SearchHighlight } from './SearchField';

export function openPendingReview(canvasId: string, result: PendingReviewResult) {
  const snapshot = useAiStore.getState().snapshot;
  const tasks = snapshot?.canvasReviewStates?.[canvasId]?.taskIds ?? [];
  const round = Math.max(0, [...tasks].reverse().indexOf(result.taskId));
  useReviewUi.getState().panel(canvasId, { round, lastTaskId: tasks.at(-1), canvasSelectionKey: (useAiStore.getState().selectedRefsByCanvas[canvasId] ?? []).join('|') });
  useReviewUi.getState().select(canvasId, result.unitIds);
  useNewUiStore.getState().setReviewPlacement('right');
  useNewUiStore.getState().setRightPanelTab('review');
}

export function PendingReviewSearch({ canvasId, query }: { canvasId: string; query: string }) {
  const snapshot = useAiStore(s => s.snapshot);
  const results = useMemo(() => snapshot ? searchPendingReviews(snapshot, canvasId, query) : [], [snapshot, canvasId, query]);
  return <><div className="graph-search-count" aria-live="polite"><span>{results.length} 条待审核提交</span><span>当前画布</span></div>
    <div className="graph-search-results pending-search-results new-scroll">
      {!results.length && <p className="graph-search-empty">{query ? '没有匹配的待审核提交' : '当前没有待审核提交'}<br /><span>已处理的修改不在搜索范围内</span></p>}
      {results.map(result => <button type="button" key={result.id} data-pending-search-result={result.id} className="graph-search-result" onClick={() => openPendingReview(canvasId, result)}>
        <Sparkles size={15} /><span className="graph-search-result-copy"><strong><SearchHighlight text={result.label} query={query} /></strong>
          {result.paths.map(path => <small key={path}>{path}</small>)}{result.detail && <span><SearchHighlight text={result.detail} query={query} /></span>}
          <small>{new Date(result.createdAt).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })} · {result.unitIds.length} 项修改</small>
        </span><ArrowUpRight size={14} className="graph-search-go" />
      </button>)}
    </div></>;
}
