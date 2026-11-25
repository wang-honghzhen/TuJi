import { create } from 'zustand';
import { useAiStore } from '@/ai/client';
import type { PanelState } from './api';
import { flushPaperEditors } from '@/ai/ui/PaperEditor';
import { flushCanvasEdits } from '@/new/canvasEditFlush';
import { flushDraftActions } from '@/ai/draftTransfers';
import { flushUserNoteEditors } from '@/ai/ui/UserNoteEditor';

const initial: PanelState = { ready: !window.tujiDesktop, host: 'none', background: false, detached: false, used: false,
  activeTab: 'notebook', canvasId: '', width: 520, notePageId: '', drafts: {}, reading: {}, enteredSessionByCanvas: {},
  orb: { flipX: false, flipY: false, dock: '' } };
try {
  if (!window.tujiDesktop) {
    const saved = JSON.parse(localStorage.getItem('tuji:notebook-view') ?? '{}');
    if (Array.isArray(saved.noteTabs)) initial.noteTabs = saved.noteTabs;
    if (Array.isArray(saved.dockedAiCanvases)) initial.dockedAiCanvases = saved.dockedAiCanvases.filter((id: unknown) => typeof id === 'string');
    if (typeof saved.noteDirectoryId === 'string') initial.noteDirectoryId = saved.noteDirectoryId;
    if (typeof saved.notePageId === 'string') initial.notePageId = saved.notePageId;
    if (typeof saved.activeTab === 'string') initial.activeTab = saved.activeTab;
    if (saved.reading && typeof saved.reading === 'object') initial.reading = saved.reading;
  }
} catch { /* An invalid view cache must not prevent the notebook from opening. */ }
export const usePanelState = create<PanelState>(() => initial);
usePanelState.subscribe(state => {
  if (window.tujiDesktop) return;
  try { localStorage.setItem('tuji:notebook-view', JSON.stringify({ noteTabs: state.noteTabs, noteDirectoryId: state.noteDirectoryId,
    notePageId: state.notePageId, activeTab: state.activeTab, reading: state.reading, dockedAiCanvases: state.dockedAiCanvases })); } catch { /* Content is saved independently. */ }
});
let applying = false;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;
export async function preparePanelTransfer() {
  (document.activeElement as HTMLElement | null)?.blur();
  await flushPaperEditors();
  await flushUserNoteEditors();
  await flushDraftActions();
  const canvas = usePanelState.getState().canvasId;
  if (window.tujiDesktop?.role === 'main' && canvas) await flushCanvasEdits(canvas);
  await publishDrafts();
}
async function publishDrafts() {
  clearTimeout(draftTimer);
  const store = useAiStore.getState();
  // Startup can request a window transfer before either source of draft state has loaded.
  if (!usePanelState.getState().ready || !store.snapshot) return;
  const ids = new Set(store.snapshot.sessions.filter(s => s.mode === 'temporary' && s.lifecycle === 'active').map(s => s.id));
  const drafts = Object.fromEntries(Object.entries(store.draftsBySession).filter(([id]) => ids.has(id)));
  if (window.tujiDesktop) await window.tujiDesktop.command('patch-view', { drafts, reading: usePanelState.getState().reading });
  else usePanelState.setState({ drafts });
}
export function initializePanelBridge() {
  if (initialized) return; initialized = true;
  const api = window.tujiDesktop;
  if (!api) return;
  const accept = (state: PanelState) => {
    const previous = usePanelState.getState();
    const localOwner = previous.ready && previous.host === api.role && state.host === api.role;
    applying = true;
    usePanelState.setState({ ...state, ready: true, ...(localOwner ? { reading: previous.reading } : {}) });
    // Ordinary main-window drafts are local; only temporary drafts move between hosts.
    const store = useAiStore.getState(), draftsBySession = { ...store.draftsBySession };
    for (const session of store.snapshot?.sessions ?? []) if (session.mode === 'temporary') delete draftsBySession[session.id];
    Object.assign(draftsBySession, state.drafts);
    useAiStore.setState({ ...(!localOwner ? { draftsBySession } : {}), ...(api.role === 'panel' ? { enteredSessionByCanvas: state.enteredSessionByCanvas, activeSessionByCanvas: state.enteredSessionByCanvas } : {}) });
    applying = false;
  };
  api.onState(accept);
  void api.getState().then(accept).catch(cause => useAiStore.setState({ error: String(cause) }));
  api.onPrepare(preparePanelTransfer);
  useAiStore.subscribe((state, previous) => {
    if (applying || api.role === 'orb' || state.draftsBySession === previous.draftsBySession) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { void publishDrafts().catch(() => undefined); }, 100);
  });
}
export async function panelCommand(action: string, payload: Record<string, unknown> = {}) {
  if (window.tujiDesktop) { await window.tujiDesktop.command(action, payload); return; }
  const state = usePanelState.getState();
  if (action === 'set-canvas-ai-dock') {
    const ids = new Set(state.dockedAiCanvases);
    if (payload.docked) ids.add(String(payload.canvasId)); else ids.delete(String(payload.canvasId));
    usePanelState.setState({ dockedAiCanvases: [...ids] });
  } else if (action === 'open-panel') { await preparePanelTransfer(); usePanelState.setState({ host: 'main', used: true, activeTab: String(payload.tab ?? state.activeTab) }); }
  else if (action === 'hide-panel') { await preparePanelTransfer(); usePanelState.setState({ host: 'none' }); }
  else if (action === 'toggle-detach') { await preparePanelTransfer(); usePanelState.setState({ detached: !state.detached }); }
  else if (action === 'patch-view' || action === 'set-context') usePanelState.setState(payload as Partial<PanelState>);
  else if (action === 'forget-tab') { const drafts = { ...state.drafts }, reading = { ...state.reading }; delete drafts[String(payload.id)]; delete reading[String(payload.id)];
    usePanelState.setState({ drafts, reading, ...(state.activeTab === payload.id ? { activeTab: String(payload.next ?? 'notebook') } : {}) }); }
}
export function setPanelReading(id: string, position: { top: number; following: boolean }) {
  const reading = { ...usePanelState.getState().reading, [id]: position };
  usePanelState.setState({ reading });
}
