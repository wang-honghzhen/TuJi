import { FilePlus, MoreHorizontal } from 'lucide-react';
import { SidebarToggle } from './SidebarToggle';
import { DocumentMeta } from '@/types/document';
import { useNewUiStore, beginSidebarResize } from '../newUiStore';
import type { ReactNode } from 'react';
import { DirectoryTab, ReviewTab } from './NewDirectoryDock';
import { GraphNameLabel } from './GraphPathLabel';
import { NewTreeIcon } from './NewTreeIcon';

interface NewRightSidebarProps {
  documents: DocumentMeta[];
  /** 当前正在画布上渲染的文档 id（可能多个） */
  activeDocumentIds: string[];
  /** Direct canvas entries can be removed here; nested documents remain inside their parent. */
  rootDocumentIds: string[];
  /** 点击：在画布上加入 / 移出该文档 */
  onAddDocument: (documentId: string) => void;
  onCreateDocument: () => void;
  directoryPanel: ReactNode;
  reviewPanel: ReactNode;
  canvasId: string;
}

/* ============================================================
 * 右侧边栏（图文档栏）—— 可折叠 · 可拖拽调宽 · 玻璃面板
 *
 * 列表排序：
 *   基准顺序 = 按修改时间倒序（最新的在最上面）
 *   画布上的文档整体**置顶**，置顶组内部同样按修改时间倒序
 *
 *   关键：置顶只是**显示层的重排**，不修改底层数组、也不改 updatedAt。
 *   所以文档从画布移出后，会自然落回它按时间该在的位置，
 *   整个列表的顺序不会被打乱。
 * ============================================================ */

export function NewRightSidebar({
  documents,
  activeDocumentIds,
  rootDocumentIds,
  onAddDocument,
  onCreateDocument,
  directoryPanel,
  reviewPanel,
  canvasId,
}: NewRightSidebarProps) {
  const isOpen = useNewUiStore((state) => state.isRightSidebarOpen);
  const toggle = useNewUiStore((state) => state.toggleRightSidebar);
  const width = useNewUiStore((state) => state.rightWidth);
  const isResizing = useNewUiStore((state) => state.isResizing);
  const placement = useNewUiStore(s => s.directoryPlacement), tab = useNewUiStore(s => s.rightPanelTab);
  const drag = useNewUiStore(s => s.directoryDrag);
  const reviewPlacement = useNewUiStore(s => s.reviewPlacement), reviewDrag = useNewUiStore(s => s.reviewDrag);
  const showDirectory = placement === 'right' && tab === 'directory' && !drag;
  const showReview = reviewPlacement === 'right' && tab === 'review' && !reviewDrag;
  const showDocuments = !showDirectory && !showReview;

  const byUpdatedDesc = (a: DocumentMeta, b: DocumentMeta) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

  const pinned = documents
    .filter((doc) => activeDocumentIds.includes(doc.documentId))
    .sort(byUpdatedDesc);
  const rest = documents
    .filter((doc) => !activeDocumentIds.includes(doc.documentId))
    .sort(byUpdatedDesc);
  // 置顶组在前，其余按时间倒序 —— 两边各自排好，顺序是稳定的
  const ordered = [...pinned, ...rest];

  return (
    <aside
      data-sidebar="right"
      aria-hidden={!isOpen}
      style={{ width: isOpen ? width : 0 }}
      className={`relative z-10 shrink-0 h-full overflow-hidden ${
        isResizing ? '' : 'transition-[width] duration-300 ease-in-out'
      }`}
    >
      {/* 拖拽调宽的把手：贴在内侧（左）边缘 */}
      {isOpen && (
        <div
          onPointerDown={(event) => beginSidebarResize('right', event)}
          title="拖拽调整宽度"
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-blue-400/40 active:bg-blue-400/60 transition-colors"
        />
      )}

      {/* 半透明压暗与背景模糊；节点和边仍在侧栏后方连续绘制。 */}
      <div
        style={{ width }}
        className={`relative isolate h-full flex flex-col space-sidebar border-l transition-[visibility] ${
          isOpen ? 'visible delay-0' : 'invisible delay-300'
        }`}
      >
        <SidebarToggle side="right" expanded onClick={toggle} label="折叠图文档栏"
          style={{ position: 'absolute', right: 12, top: 16, zIndex: 30 }} />

        {(placement === 'right' || reviewPlacement === 'right') && <div className="pl-3 pr-12 pt-4 pb-2" data-sidebar-tabs>
          <div className="flex items-center gap-1 rounded-xl bg-space-900/70 border border-space-700 p-1">
            <button type="button" data-document-tab aria-pressed={showDocuments} onClick={() => useNewUiStore.getState().setRightPanelTab('documents')}
              className={`flex-1 min-w-0 h-8 rounded-lg text-[12px] font-medium ${showDocuments ? 'bg-blue-500/20 text-blue-100 ring-1 ring-inset ring-blue-400/40' : 'text-slate-400 hover:bg-white/5'}`}>图文档</button>
            {placement === 'right' && <DirectoryTab source="right" active={showDirectory} onClick={() => useNewUiStore.getState().setRightPanelTab('directory')} />}
            {reviewPlacement === 'right' && <ReviewTab canvasId={canvasId} source="right" active={showReview} onClick={() => useNewUiStore.getState().setRightPanelTab('review')} />}
          </div>
        </div>}
        {showDirectory || showReview ? <div className="flex-1 min-h-0 flex flex-col">{showDirectory ? directoryPanel : reviewPanel}</div> : <div data-document-library className="flex-1 min-h-0 flex flex-col">
          <div className={`flex items-center justify-between px-3 pb-2 ${placement === 'right' || reviewPlacement === 'right' ? 'pt-1' : 'pt-4 pr-12'}`}>
            <span className="text-[11px] text-slate-500">{documents.length} 个图文档</span>
            <button type="button" title="新建图文档" aria-label="新建图文档" onClick={onCreateDocument}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-blue-300 transition-colors">
              <FilePlus size={15} />新建
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto new-scroll px-2.5 pb-2.5 space-y-2">
          {ordered.map((doc, index) => {
            const isOnCanvas = activeDocumentIds.includes(doc.documentId);
            // 置顶组与其余之间画一条分隔，让「为什么它在上面」一眼可读
            const isFirstUnpinned = !isOnCanvas && index > 0 && pinned.length > 0;

            return (
              <div key={doc.documentId}>
                {isFirstUnpinned && (
                  <div className="flex items-center gap-2 px-1 pb-2 pt-1">
                    <span className="h-px flex-1 bg-space-700" />
                    <span className="text-[10px] text-slate-600">其余图文档</span>
                    <span className="h-px flex-1 bg-space-700" />
                  </div>
                )}

                <button
                  data-library-document={doc.documentId}
                  type="button"
                  draggable
                  onClick={() => { if (!isOnCanvas) onAddDocument(doc.documentId); }}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(
                      'application/x-qixue-document',
                      doc.documentId
                    );
                  }}
                  title={isOnCanvas ? '已在画布中；请在画布目录中右键操作' : '点击加入画布'}
                  className={`group w-full text-left px-2.5 py-2.5 rounded-xl border transition-all ${
                    isOnCanvas
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-space-700 bg-space-850/25 hover:border-space-600 hover:bg-space-800/40'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {/* 图标 */}
                    <div
                      className="new-document-icon"
                      data-active={isOnCanvas}
                    >
                      <NewTreeIcon />
                    </div>

                    {/* 信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <GraphNameLabel id={doc.documentId} name={doc.documentName} kind="document" className="flex-1 text-[13px] font-medium truncate" />
                        {rootDocumentIds.includes(doc.documentId) && <span data-tree-root={doc.documentId} title={`${doc.documentName}目录树`} className="shrink-0 rounded border border-amber-400/25 px-1 py-0.5 text-[9px] text-amber-200">目录树根</span>}
                        {/* 在画布上的加一个状态点 */}
                        {isOnCanvas && (
                          <span
                            title="正在画布中渲染"
                            className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.9)]"
                          />
                        )}
                        <span className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreHorizontal size={14} />
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-500 truncate mt-0.5">
                        {doc.description}
                      </p>

                      <div className="flex items-center gap-2.5 mt-1.5 text-[10px] text-slate-500 tabular-nums">
                        <span>{doc.stats.nodeCount} 节点</span>
                        <span>{doc.stats.edgeCount} 边</span>
                        <span className="ml-auto text-slate-600">
                          {new Date(doc.updatedAt).toLocaleDateString('zh-CN')}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
          </div>
        </div>}
      </div>
    </aside>
  );
}
