import { create } from 'zustand';
import type { PointerEvent as ReactPointerEvent } from 'react';

export const SIDEBAR_LIMITS = {
  left: { min: 180, max: 420, fallback: 224 },
  right: { min: 200, max: 460, fallback: 240 },
  directory: { min: 180, max: 460, fallback: 268 },
  review: { min: 240, max: 520, fallback: 310 },
};
export type SidebarSide = 'left' | 'right';
export type DockablePanel = 'directory' | 'review';
export type LeftPanelList = 'canvases' | DockablePanel;
export type DirectoryPlacement = 'left' | 'after-left' | 'before-right' | 'right';
export type DetachedDirectorySide = Extract<DirectoryPlacement, 'after-left' | 'before-right'>;

interface NewUiStore {
  isLeftSidebarOpen: boolean;
  isRightSidebarOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  isResizing: boolean;
  previewCanvasId: string | null;
  leftPanelTab: LeftPanelList;
  rightPanelTab: 'documents' | DockablePanel;
  directoryPlacement: DirectoryPlacement;
  directoryWidth: number;
  directoryDrag: { x: number; y: number } | null;
  dockPreview: DirectoryPlacement | null;
  reviewPlacement: DirectoryPlacement;
  reviewWidth: number;
  reviewDrag: { x: number; y: number } | null;
  reviewDockPreview: DirectoryPlacement | null;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setIsResizing: (resizing: boolean) => void;
  setPreviewCanvasId: (canvasId: string | null) => void;
  setLeftPanelTab: (tab: LeftPanelList) => void;
  setRightPanelTab: (tab: 'documents' | DockablePanel) => void;
  setDirectoryPlacement: (placement: DirectoryPlacement) => void;
  setDirectoryWidth: (width: number) => void;
  setDirectoryDrag: (drag: { x: number; y: number } | null, target?: DirectoryPlacement | null) => void;
  setReviewPlacement: (placement: DirectoryPlacement) => void;
  setReviewWidth: (width: number) => void;
  setReviewDrag: (drag: { x: number; y: number } | null, target?: DirectoryPlacement | null) => void;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function placePanel(s: NewUiStore, panel: DockablePanel, placement: DirectoryPlacement): Partial<NewUiStore> {
  return { ...(panel === 'directory' ? { directoryPlacement: placement } : { reviewPlacement: placement }),
    leftPanelTab: placement === 'left' ? panel : s.leftPanelTab === panel ? 'canvases' : s.leftPanelTab,
    rightPanelTab: placement === 'right' ? panel : s.rightPanelTab === panel ? 'documents' : s.rightPanelTab,
    isLeftSidebarOpen: placement === 'left' || s.isLeftSidebarOpen, isRightSidebarOpen: placement === 'right' || s.isRightSidebarOpen,
    directoryDrag: null, dockPreview: null, reviewDrag: null, reviewDockPreview: null, previewCanvasId: null };
}
export const useNewUiStore = create<NewUiStore>((set) => ({
  isLeftSidebarOpen: true, isRightSidebarOpen: true,
  leftWidth: SIDEBAR_LIMITS.left.fallback, rightWidth: SIDEBAR_LIMITS.right.fallback,
  isResizing: false, previewCanvasId: null,
  leftPanelTab: 'canvases', rightPanelTab: 'documents', directoryPlacement: 'left',
  directoryWidth: SIDEBAR_LIMITS.directory.fallback, directoryDrag: null, dockPreview: null,
  reviewPlacement: 'right', reviewWidth: SIDEBAR_LIMITS.review.fallback, reviewDrag: null, reviewDockPreview: null,
  toggleLeftSidebar: () => set(s => ({ isLeftSidebarOpen: !s.isLeftSidebarOpen })),
  toggleRightSidebar: () => set(s => ({ isRightSidebarOpen: !s.isRightSidebarOpen })),
  setLeftWidth: width => set({ leftWidth: clamp(width, SIDEBAR_LIMITS.left.min, SIDEBAR_LIMITS.left.max) }),
  setRightWidth: width => set({ rightWidth: clamp(width, SIDEBAR_LIMITS.right.min, SIDEBAR_LIMITS.right.max) }),
  setIsResizing: isResizing => set({ isResizing }),
  setPreviewCanvasId: previewCanvasId => set({ previewCanvasId }),
  setLeftPanelTab: leftPanelTab => set({ leftPanelTab }),
  setRightPanelTab: rightPanelTab => set({ rightPanelTab }),
  setDirectoryPlacement: placement => set(s => placePanel(s, 'directory', placement)),
  setDirectoryWidth: width => set({ directoryWidth: clamp(width, SIDEBAR_LIMITS.directory.min, SIDEBAR_LIMITS.directory.max) }),
  setDirectoryDrag: (directoryDrag, dockPreview = null) => set({ directoryDrag, dockPreview }),
  setReviewPlacement: placement => set(s => placePanel(s, 'review', placement)),
  setReviewWidth: width => set({ reviewWidth: clamp(width, SIDEBAR_LIMITS.review.min, SIDEBAR_LIMITS.review.max) }),
  setReviewDrag: (reviewDrag, reviewDockPreview = null) => set({ reviewDrag, reviewDockPreview }),
}));

export function useSidebarInsets({ reserveExpandButtons = false }: { reserveExpandButtons?: boolean } = {}): { left: number; right: number } {
  const leftOpen = useNewUiStore(s => s.isLeftSidebarOpen), rightOpen = useNewUiStore(s => s.isRightSidebarOpen);
  const leftWidth = useNewUiStore(s => s.leftWidth), rightWidth = useNewUiStore(s => s.rightWidth);
  const placement = useNewUiStore(s => s.directoryPlacement), width = useNewUiStore(s => s.directoryWidth);
  const reviewPlacement = useNewUiStore(s => s.reviewPlacement), reviewWidth = useNewUiStore(s => s.reviewWidth);
  return { left: (leftOpen ? leftWidth : reserveExpandButtons ? 64 : 0) + (placement === 'after-left' ? width : 0) + (reviewPlacement === 'after-left' ? reviewWidth : 0),
    right: (rightOpen ? rightWidth : reserveExpandButtons ? 64 : 0) + (placement === 'before-right' ? width : 0) + (reviewPlacement === 'before-right' ? reviewWidth : 0) };
}

/** Detached panels stack toward the canvas: directory first, AI review second. */
export function detachedPanelOffset(s: Pick<NewUiStore, 'isLeftSidebarOpen' | 'isRightSidebarOpen' | 'leftWidth' | 'rightWidth' | 'directoryPlacement' | 'directoryWidth'>,
  panel: DockablePanel, side: DetachedDirectorySide): number {
  const base = side === 'after-left' ? s.isLeftSidebarOpen ? s.leftWidth : 0 : s.isRightSidebarOpen ? s.rightWidth : 0;
  return base + (panel === 'review' && s.directoryPlacement === side ? s.directoryWidth : 0);
}

/** Only actual sidebar interiors and their inner edges are valid destinations. */
export function directoryDockTarget(x: number, y: number): DirectoryPlacement | null {
  for (const side of ['left', 'right'] as const) {
    const element = document.querySelector(`[data-sidebar="${side}"]`);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (y < rect.top || y > rect.bottom) continue;
    const edge = side === 'left' ? rect.right : rect.left;
    if (Math.abs(x - edge) <= 28) return side === 'left' ? 'after-left' : 'before-right';
    if (rect.width > 0 && x >= rect.left && x <= rect.right) return side;
  }
  // The inner edge of a detached group is also a convenient independent target.
  for (const element of document.querySelectorAll<HTMLElement>('[data-sidebar-dock]')) {
    const rect = element.getBoundingClientRect(), side = element.dataset.dockSide;
    const edge = side === 'after-left' ? rect.right : rect.left;
    if (y >= rect.top && y <= rect.bottom && Math.abs(x - edge) <= 28) return side as DetachedDirectorySide;
  }
  return null;
}

let suppressDirectoryClickUntil = 0;
export const directoryClickAllowed = () => Date.now() > suppressDirectoryClickUntil;

/** A click selects a tab. Only movement beyond the threshold starts a drag. */
export function beginPanelDockDrag(panel: DockablePanel, event: ReactPointerEvent): void {
  if (event.button !== 0 || !event.isPrimary) return;
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY }, pointerId = event.pointerId;
  const oldCursor = document.body.style.cursor, oldSelect = document.body.style.userSelect;
  let dragging = false;
  const setDrag = (drag: { x: number; y: number } | null, target?: DirectoryPlacement | null) => {
    const state = useNewUiStore.getState();
    (panel === 'directory' ? state.setDirectoryDrag : state.setReviewDrag)(drag, target);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape);
    window.removeEventListener('blur', cancel);
    document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelect;
    if (dragging) suppressDirectoryClickUntil = Date.now() + 300;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
    dragging = true; e.preventDefault();
    document.body.style.cursor = 'grabbing'; document.body.style.userSelect = 'none';
    useNewUiStore.getState().setPreviewCanvasId(null);
    setDrag({ x: e.clientX, y: e.clientY }, directoryDockTarget(e.clientX, e.clientY));
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    cleanup();
    const target = dragging ? directoryDockTarget(e.clientX, e.clientY) : null;
    const state = useNewUiStore.getState();
    if (target) (panel === 'directory' ? state.setDirectoryPlacement : state.setReviewPlacement)(target);
    else setDrag(null);
  };
  const cancel = () => { cleanup(); setDrag(null); };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
  window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape); window.addEventListener('blur', cancel);
}

function beginResize(event: ReactPointerEvent, width: number, direction: number, change: (width: number) => void): void {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const startX = event.clientX;
  const oldCursor = document.body.style.cursor, oldSelect = document.body.style.userSelect;
  useNewUiStore.getState().setIsResizing(true);
  document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  const move = (e: PointerEvent) => change(width + (e.clientX - startX) * direction);
  const finish = () => {
    useNewUiStore.getState().setIsResizing(false);
    document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelect;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', finish);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish); window.addEventListener('blur', finish);
}
export function beginDirectoryResize(side: DetachedDirectorySide, event: ReactPointerEvent): void {
  const s = useNewUiStore.getState();
  beginResize(event, s.directoryWidth, side === 'after-left' ? 1 : -1, s.setDirectoryWidth);
}
export function beginReviewResize(side: DetachedDirectorySide, event: ReactPointerEvent): void {
  const s = useNewUiStore.getState();
  beginResize(event, s.reviewWidth, side === 'after-left' ? 1 : -1, s.setReviewWidth);
}
export function beginSidebarResize(side: SidebarSide, event: ReactPointerEvent): void {
  const s = useNewUiStore.getState();
  beginResize(event, side === 'left' ? s.leftWidth : s.rightWidth, side === 'left' ? 1 : -1, side === 'left' ? s.setLeftWidth : s.setRightWidth);
}
