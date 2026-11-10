import { modeOf, MODE_LABELS } from '@/v3/design';
import { useMemo, type ReactNode } from 'react';
import { LayoutList, Plus, Settings } from 'lucide-react';
import { SidebarToggle } from './SidebarToggle';
import type { CanvasRecord } from '@/v3/types';
import { useAiStore } from '@/ai/client';
import { beginSidebarResize, useNewUiStore } from '../newUiStore';
import { canvasListSummaries } from '../canvasListSummary';
import { NewSessionIcon } from './NewSessionIcon';
import { DirectoryTab, ReviewTab, NewDirectoryDock } from './NewDirectoryDock';

interface NewLeftSidebarProps {
  canvases: CanvasRecord[];
  activeCanvasId: string | null;
  onOpenCanvas: (canvasId: string) => void;
  onCreateCanvas: () => void;
  directoryPanel: ReactNode;
  reviewPanel: ReactNode;
  onSettings?: () => void;
}

export function NewLeftSidebar({ canvases, activeCanvasId, onOpenCanvas, onCreateCanvas, directoryPanel, reviewPanel, onSettings }: NewLeftSidebarProps) {
  const isOpen = useNewUiStore(s => s.isLeftSidebarOpen), toggle = useNewUiStore(s => s.toggleLeftSidebar);
  const width = useNewUiStore(s => s.leftWidth), resizing = useNewUiStore(s => s.isResizing);
  const preview = useNewUiStore(s => s.previewCanvasId), setPreview = useNewUiStore(s => s.setPreviewCanvasId);
  const tab = useNewUiStore(s => s.leftPanelTab), setTab = useNewUiStore(s => s.setLeftPanelTab);
  const placement = useNewUiStore(s => s.directoryPlacement), drag = useNewUiStore(s => s.directoryDrag);
  const reviewPlacement = useNewUiStore(s => s.reviewPlacement), reviewDrag = useNewUiStore(s => s.reviewDrag);
  const snapshot = useAiStore(s => s.snapshot);
  const summaries = useMemo(() => canvasListSummaries(canvases, snapshot), [canvases, snapshot?.sessions, snapshot?.events, snapshot?.tasks]);
  const showDirectory = placement === 'left' && tab === 'directory' && !drag;
  const showReview = reviewPlacement === 'left' && tab === 'review' && !reviewDrag;
  const showCanvases = !showDirectory && !showReview;

  return <>
    <aside data-sidebar="left" aria-hidden={!isOpen} style={{ width: isOpen ? width : 0 }}
      className={`relative z-10 shrink-0 h-full overflow-hidden ${resizing ? '' : 'transition-[width] duration-300 ease-in-out'}`}>
      {isOpen && <div onPointerDown={e => beginSidebarResize('left', e)} title="拖拽调整宽度"
        className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize hover:bg-blue-400/40" />}
      <div style={{ width }} className={`relative isolate h-full flex flex-col space-sidebar border-r transition-[visibility] ${isOpen ? 'visible delay-0' : 'invisible delay-300'}`}>
        <div onMouseEnter={() => setPreview(null)} className="px-3 pt-4 pb-2.5">
          <div className="flex items-center justify-between gap-2.5 px-1">
            <div className="tuji-brand" aria-label="图记">
              <span className="tuji-brand-mark"><img src="/brand/tuji.jpg" alt="" draggable={false} /></span>
              <span className="tuji-brand-name">图记</span>
            </div>
            <SidebarToggle side="left" expanded onClick={toggle} label="折叠侧栏" />
          </div>
        </div>
        <div className="px-3 pb-2.5" onMouseEnter={() => setPreview(null)}>
          <div data-sidebar-tabs className="flex items-center gap-1 rounded-xl bg-space-900/70 border border-space-700 p-1">
            <button type="button" data-canvas-tab aria-pressed={showCanvases} data-active={showCanvases} onClick={() => setTab('canvases')} title="显示画布"
              className={`flex-1 min-w-0 h-8 flex items-center justify-center gap-1 rounded-lg text-[12px] font-medium ${showCanvases ? 'bg-blue-500/20 text-blue-100 ring-1 ring-inset ring-blue-400/40' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}><LayoutList size={13} className="shrink-0" /><span className="truncate">画布</span></button>
            {placement === 'left' && <DirectoryTab source="left" active={showDirectory} onClick={() => setTab('directory')} />}
            {reviewPlacement === 'left' && <ReviewTab canvasId={activeCanvasId} source="left" active={showReview} onClick={() => setTab('review')} />}
          </div>
        </div>
        <div className="flex-1 min-h-0 flex flex-col border-t border-white/5">
          {showDirectory ? directoryPanel : showReview ? reviewPanel : <>
            <div className="px-4 pt-3 pb-1.5 flex items-center justify-between"><span className="text-[11px] font-medium text-slate-500">画布</span><span className="text-[11px] text-slate-600 tabular-nums">{canvases.length}</span></div>
            <div className="flex-1 min-h-0 overflow-y-auto new-scroll px-2 pb-2">
              <div aria-hidden="true" className="new-session-rule mx-auto" />
              {canvases.map((canvas, index) => {
                const active = canvas.canvasId === activeCanvasId, summary = summaries.get(canvas.canvasId)!;
                const updated = new Date(summary.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
                return <button key={canvas.canvasId} data-ai-canvas-button={canvas.canvasId} type="button" data-active={active} aria-pressed={active}
                  onClick={() => onOpenCanvas(canvas.canvasId)} onMouseEnter={() => { const s = useNewUiStore.getState(); if (!s.directoryDrag && !s.reviewDrag) setPreview(canvas.canvasId); }}
                  title={active ? '当前画布；再次点击返回临时画布' : `打开画布：${canvas.canvasName}`}
                  className={`new-session-btn group relative w-full text-left pl-12 pr-2.5 py-2.5 rounded-xl transition-all duration-300 ${active ? 'bg-blue-500/10' : 'hover:bg-white/5'} ${preview === canvas.canvasId ? 'ring-1 ring-inset ring-blue-400/30' : ''}`}>
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"><NewSessionIcon mode={modeOf(canvas)} phase={index} active={active} /></span>
                  <div className="min-w-0"><span className={`block text-[13px] font-medium truncate ${active ? 'text-blue-200' : 'text-slate-300'}`}>{canvas.canvasName}</span>
                    <p data-canvas-summary className="text-[11px] text-slate-500 truncate mt-0.5" title={`有 ${summary.sessionCount} 个会话 · ${updated}`}>{MODE_LABELS[modeOf(canvas)]} · {summary.sessionCount} 个会话 · {updated}</p></div>
                  <span aria-hidden="true" className="new-session-rule absolute bottom-0 left-1/2 -translate-x-1/2" />
                </button>;
              })}
            </div>
          </>}
        </div>
        <div onMouseEnter={() => setPreview(null)} className="p-2.5 border-t border-white/5">
          {showCanvases && <button type="button" onClick={onCreateCanvas} title="新建画布" className="mb-1.5 w-full h-10 flex items-center justify-center gap-2 rounded-xl space-create-canvas text-slate-100 text-[13px] font-medium"><Plus size={17} />新建画布</button>}
          <button type="button" onClick={onSettings} className="w-full h-10 flex items-center gap-2.5 px-3 rounded-xl text-[13px] font-medium text-slate-400 hover:bg-white/5 hover:text-slate-200"><Settings size={17} />设置</button>
        </div>
      </div>
    </aside>
    <NewDirectoryDock>{directoryPanel}</NewDirectoryDock>
  </>;
}
