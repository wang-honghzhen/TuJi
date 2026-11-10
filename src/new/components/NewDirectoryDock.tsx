import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FolderTree, GripVertical, Sparkles } from 'lucide-react';
import { SidebarToggle } from './SidebarToggle';
import { beginPanelDockDrag, beginDirectoryResize, beginReviewResize, detachedPanelOffset, directoryClickAllowed, useNewUiStore, type DockablePanel } from '../newUiStore';
import { useAiStore } from '@/ai/client';
import { reviewEntries, reviewDecisionCount } from '@/ai/changeReview';

type TabProps = { active: boolean; onClick: () => void; source: string };
function PanelTab({ panel, active, onClick, source, count = 0 }: TabProps & { panel: DockablePanel; count?: number }) {
  const label = panel === 'directory' ? '目录' : 'AI 修改', Icon = panel === 'directory' ? FolderTree : Sparkles;
  return <button type="button" data-directory-tab={panel === 'directory' ? source : undefined} data-review-tab={panel === 'review' ? source : undefined}
    aria-pressed={active} data-active={active} aria-label={`${label}${count ? `，待决策 ${count} 项` : ''}`}
    onClick={() => { if (directoryClickAllowed()) onClick(); }} onPointerDown={e => beginPanelDockDrag(panel, e)}
    title={`${label}${count ? ` · 待决策 ${count} 项` : ''} · 拖到侧栏合并，拖到内侧边缘独立停靠`}
    className={`relative flex-1 min-w-0 h-8 flex items-center justify-center gap-1 rounded-lg text-[12px] font-medium cursor-grab active:cursor-grabbing ${active ? 'bg-blue-500/20 text-blue-100 ring-1 ring-inset ring-blue-400/40' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}>
    <Icon size={13} className="shrink-0" /><span className="truncate">{label}</span>
    {count > 0 && <span data-review-pending={count} aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-300" />}
  </button>;
}
export const DirectoryTab = (props: TabProps) => <PanelTab {...props} panel="directory" />;
export function ReviewTab({ canvasId, ...props }: TabProps & { canvasId: string | null }) {
  const count = useAiStore(s => s.snapshot ? reviewDecisionCount(s.snapshot,reviewEntries(s.snapshot).filter(e => e.change.review!.canvasId === canvasId && e.unit.state === 'pending').map(e=>e.unit.id)) : 0);
  return <PanelTab {...props} panel="review" count={count} />;
}

/** Both panels share the existing sidebar merge, independent dock and resize behavior. */
function PanelDock({ panel, canvasId = null, children }: { panel: DockablePanel; canvasId?: string | null; children: ReactNode }) {
  const s = useNewUiStore(), review = panel === 'review';
  const placement = review ? s.reviewPlacement : s.directoryPlacement, width = review ? s.reviewWidth : s.directoryWidth;
  const drag = review ? s.reviewDrag : s.directoryDrag, target = review ? s.reviewDockPreview : s.dockPreview;
  const label = review ? 'AI 修改' : '目录';
  const left = detachedPanelOffset(s, panel, 'after-left'), right = detachedPanelOffset(s, panel, 'before-right');
  const detached = placement === 'after-left' || placement === 'before-right';
  const snapped = target !== null;
  const ghostWidth = target === 'left' ? s.leftWidth : target === 'right' ? s.rightWidth : snapped ? width : 164;
  const ghostHeight = snapped ? window.innerHeight : 220;
  const ghostX = target === 'left' ? 0 : target === 'right' ? window.innerWidth - s.rightWidth : target === 'after-left' ? left : target === 'before-right' ? window.innerWidth - right - width
    : Math.max(8, Math.min((drag?.x ?? 0) + 14, window.innerWidth - ghostWidth - 8));
  const ghostY = snapped ? 0 : Math.max(8, Math.min((drag?.y ?? 0) - 18, window.innerHeight - ghostHeight - 8));
  const merge = () => (review ? s.setReviewPlacement : s.setDirectoryPlacement)(placement === 'after-left' ? 'left' : 'right');
  return <>
    {detached && !drag && <aside data-sidebar-dock={panel} data-dock-side={placement}
      data-directory-dock={!review ? placement : undefined} data-review-dock={review ? placement : undefined}
      style={{ width, ...(placement === 'after-left' ? { left } : { right }) }}
      className={`fixed inset-y-0 z-30 ${s.isResizing ? '' : 'transition-[width] duration-300'}`}>
      <div className={`relative isolate h-full flex flex-col space-sidebar ${placement === 'after-left' ? 'border-r' : 'border-l'}`}>
        <div className="flex gap-1 px-2 pt-3.5 pb-2">
          {review ? <ReviewTab canvasId={canvasId} source="detached" active onClick={() => {}} /> : <DirectoryTab source="detached" active onClick={() => {}} />}
          <SidebarToggle side={placement === 'after-left' ? 'left' : 'right'} expanded label={placement === 'after-left' ? '收回左侧栏' : '收回右侧栏'} onClick={merge} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col border-t border-white/5">{children}</div>
        <div onPointerDown={e => (review ? beginReviewResize : beginDirectoryResize)(placement, e)} title="拖拽调整宽度"
          className={`absolute inset-y-0 z-20 w-1.5 cursor-col-resize hover:bg-blue-400/40 ${placement === 'after-left' ? 'right-0' : 'left-0'}`} />
      </div>
    </aside>}
    {drag && createPortal(<div aria-hidden="true" data-directory-drag-preview={!review ? '' : undefined} data-review-drag-preview={review ? '' : undefined} data-dock-target={target ?? 'none'}
      style={{ width: ghostWidth, height: ghostHeight, transform: `translate3d(${ghostX}px, ${ghostY}px, 0)` }}
      className={`fixed left-0 top-0 z-[70] pointer-events-none flex flex-col overflow-hidden rounded-xl border bg-space-950/90 shadow-2xl ${snapped ? 'border-blue-400/70' : 'border-blue-400/40'}`}>
      <div className="flex items-center gap-1 px-2 py-2 border-b border-white/10 text-slate-200 text-xs">
        <GripVertical size={14} />{label}<span className="ml-auto text-[10px] text-slate-500">{snapped ? '松手放到这里' : '拖到侧栏'}</span>
      </div>
      <div className="relative flex-1 min-h-0 overflow-hidden opacity-60">
        {review ? <div className="p-3 text-xs text-slate-400 leading-6">查看本轮、上轮修改<br />保留或回退所选内容</div>
          : <div className="absolute inset-0 flex flex-col origin-top-left" style={snapped ? undefined : { width, height: 330, transform: `scale(${ghostWidth / width})` }}>{children}</div>}
      </div>
    </div>, document.body)}
  </>;
}
export const NewDirectoryDock = ({ children }: { children: ReactNode }) => <PanelDock panel="directory">{children}</PanelDock>;
export const NewReviewDock = ({ children, canvasId }: { children: ReactNode; canvasId: string }) => <PanelDock panel="review" canvasId={canvasId}>{children}</PanelDock>;
