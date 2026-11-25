import { canvasDirectories } from '@/v3/canvas';
import { MessagesSquare, PanelRightClose } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlaybackStore, taskParts, presentationOwner } from '@/ai/presentationClient';
import { SidebarToggle } from './components/SidebarToggle';
import { NewLeftSidebar } from './components/NewLeftSidebar';
import { NewCanvasDirectoryPanel } from './components/NewCanvasDirectoryPanel';
import { NewRightSidebar } from './components/NewRightSidebar';
import { NewTreeIcon } from './components/NewTreeIcon';
import { NewStageLayer } from './components/NewStageLayer';
import { CanvasReviewPanel } from './components/CanvasReviewPanel';
import { NewReviewDock } from './components/NewDirectoryDock';
import { CanvasBackground, CanvasBackgroundProvider } from './backgrounds/CanvasBackground';
import { NewSessionGraphOverlay } from './components/NewSessionGraphOverlay';
import { NewAiReplyPanel } from './components/NewAiReplyPanel';
import { NewChatInput } from './components/NewChatInput';
import { CanvasAiDrawer } from './components/CanvasAiDrawer';
import { flushDraftActions } from '@/ai/draftTransfers';
import { panelCommand, usePanelState } from '@/desktop/panelState';
import { trackCanvasMutation } from './canvasEditFlush';
import { AiTemporarySidebar } from '@/ai/ui/AiTemporarySidebar';
import { openGlobalTemporarySession, openTemporarySession } from '@/ai/temporaryWindows';
import { DraftCanvasLeaveDialog } from './components/DraftCanvasLeaveDialog';
import { CanvasCreateDialog } from './components/CanvasCreateDialog';
import { NameDialog } from './components/NameDialog';
import { modeOf } from '@/v3/design';
import { GraphActionDialog } from './components/GraphActionDialog';
import { GraphTreeTransferDialog } from './components/GraphTreeTransferDialog';
import { LayoutOrganizeDialog } from './components/LayoutOrganizeDialog';
import type { CanvasFocusRequest, GraphActionRequest, GraphMutation, GraphMutationResult } from './graphActions';
import { ownershipNotice, type StructureCommand, type StructureConflict } from '@/v3/structure';
import { getRootDocumentIds } from '@/v3/documentTrees';
import { useNewUiStore, useSidebarInsets } from './newUiStore';
import { getCanvasDocumentIds } from '@/v3/layout';
import type { Point, GraphState } from '@/v3/types';
import { bootstrap, DRAFT_ID, emptyGraph, listDocumentMeta } from '@/v3/storage';
import { sessionTasks, useAiStore } from '@/ai/client';
import type { Session } from '@/ai/domain';
import { AiChatPage, AiSettingsDialog } from '@/ai/ui';
import { AiSetupPage } from '@/ai/ui/AiSetupPage';
import { uiAudio } from './uiAudio';
import { installUiSoundEvents } from './uiSoundEvents';
import { DEFAULT_SOUND_SETTINGS } from '@/shared/soundSettings';
import { GraphAppearanceProvider } from './graphAppearance';
import { searchCanvas } from './graphSearch';
import type { SidebarSearchKind, SidebarSearchValues } from './components/SearchField';

const expandButtonClass = (visible: boolean) => `absolute top-3 z-30 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`;
const EMPTY_TARGETS: string[] = [];
/** Browser records are the one-time migration source. Records written by an older format
 *  cannot be read at all, and the first start must still succeed: report what was skipped
 *  and start from an empty canvas. Browser storage is only read here, never rewritten. */
function browserGraph() {
  try { return { graph: bootstrap(), skipped: '' }; }
  catch (cause) { return { graph: emptyGraph(), skipped: cause instanceof Error ? cause.message : '浏览器记录无法读取' }; }
}
let migration: Promise<{ skipped: string }> | undefined;
function migrateBrowserData() {
  if (!migration) migration = Promise.resolve().then(async () => {
    const { graph, skipped } = browserGraph();
    await useAiStore.getState().command('graph.migrate', { graph });
    return { skipped };
  }).catch(cause => { migration = undefined; throw cause; });
  return migration;
}

export default function NewApp() {
  useEffect(() => {
    const configure = () => { const snapshot = useAiStore.getState().snapshot; uiAudio.configure(snapshot ? snapshot.soundSettings ?? DEFAULT_SOUND_SETTINGS : null); };
    configure();
    const unsubscribe = useAiStore.subscribe((state, previous) => {
      if (Boolean(state.snapshot) !== Boolean(previous.snapshot) || state.snapshot?.soundSettings !== previous.snapshot?.soundSettings) configure();
    });
    const cleanup = installUiSoundEvents();
    return () => { unsubscribe(); cleanup(); };
  }, []);
  const snapshot = useAiStore(s => s.snapshot), connection = useAiStore(s => s.connection);
  const serviceError = useAiStore(s => s.error), view = useAiStore(s => s.view);
  const replyTargets = useAiStore(s => s.replyTargetRefsByCanvas);
  const graphState = snapshot?.graph ?? null;
  const [activeCanvasId, setActiveCanvasId] = useState(DRAFT_ID);
  const dockedAi = usePanelState(s => s.dockedAiCanvases?.includes(activeCanvasId) ?? false);
  const notebookOpen = usePanelState(s => s.host === 'main');
  const notebookInset = usePanelState(s => s.host === 'main' && !s.detached ? s.width : 0);
  const inBackground = usePanelState(s => s.background);
  const [openAiCanvas, setOpenAiCanvas] = useState<string>();
  const [aiDrawerWidth, setAiDrawerWidth] = useState(0);
  const aiExpanded = dockedAi && openAiCanvas === activeCanvasId && !notebookOpen && !inBackground && view === 'canvas';
  const presenting = view === 'canvas' && !dockedAi && !inBackground;
  const currentCanvas = useRef(activeCanvasId); currentCanvas.current = activeCanvasId;
  useEffect(() => { setOpenAiCanvas(undefined); }, [activeCanvasId, view]);
  useEffect(() => { if (notebookOpen || inBackground) setOpenAiCanvas(undefined); }, [notebookOpen, inBackground]);
  const storedPlayback=usePlaybackStore(s=>s.byCanvas[activeCanvasId]);
  const enteredSessionId=useAiStore(s=>s.activeSessionByCanvas[activeCanvasId]);
  const playback=graphState?.canvases.find(c=>c.canvasId===activeCanvasId)?.isDraft?undefined:
    snapshot?.tasks.some(t=>t.id===storedPlayback?.taskId&&t.sessionId===enteredSessionId)?storedPlayback:undefined;
  const presentationParts=taskParts(snapshot,playback?.taskId),presentationPart=presentationParts.find(p=>p.seq===(playback?.cursor??1));
  const drawerTask = dockedAi && enteredSessionId ? sessionTasks(snapshot, enteredSessionId).at(-1) : undefined;
  const canvasAiTargets = presenting ? presentationPart?.targets ?? replyTargets[activeCanvasId] : drawerTask?.presentationFocus;
  const visibleTask=useRef<string>();
  useEffect(()=>{
    const next=presenting?playback?.taskId:undefined,previous=visibleTask.current;
    visibleTask.current=next;
    if(previous&&previous!==next)void useAiStore.getState().command('presentation.control',{taskId:previous,owner:presentationOwner,action:'background'}).catch(()=>undefined);
  },[presenting,playback?.taskId,activeCanvasId]);
  const initialCanvasChosen = useRef(false), mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const canvasEntryVersion = useRef(0);
  const placementQueue = useRef<Promise<unknown>>(Promise.resolve());
  const originalFields = useRef(new Map<string, string>());
  const composer = useRef<HTMLDivElement>(null);
  const [composerBottomInset, setComposerBottomInset] = useState(360);
  const [migrationError, setMigrationError] = useState('');
  const [skippedLegacy, setSkippedLegacy] = useState('');
  const [pendingNavigation, setPendingNavigation] = useState<{ proceed: () => Promise<void>; draftCanvasId: string } | null>(null);
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const [naming, setNaming] = useState<'canvas' | 'document' | null>(null);
  const [rename, setRename] = useState<{ kind: 'canvas' | 'document'; id: string; original: string } | null>(null);
  const [actionRequest, setActionRequest] = useState<GraphActionRequest | null>(null);
  const [organizeRegionId, setOrganizeRegionId] = useState<string | null>(null);
  const [layoutPreviewGraph, setLayoutPreviewGraph] = useState<GraphState | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<{ command: StructureCommand; conflicts: StructureConflict[]; revision: string } | null>(null);
  const [focusRequest, setFocusRequest] = useState<CanvasFocusRequest | null>(null), [notice, setNotice] = useState('');
  const focusSequence = useRef(0);
  const isLeftSidebarOpen = useNewUiStore(s => s.isLeftSidebarOpen), isRightSidebarOpen = useNewUiStore(s => s.isRightSidebarOpen);
  const toggleLeftSidebar = useNewUiStore(s => s.toggleLeftSidebar), toggleRightSidebar = useNewUiStore(s => s.toggleRightSidebar);
  const isResizing = useNewUiStore(s => s.isResizing), previewCanvasId = useNewUiStore(s => s.previewCanvasId);
  const insets = useSidebarInsets();
  const directoryPlacement = useNewUiStore(s => s.directoryPlacement), reviewPlacement = useNewUiStore(s => s.reviewPlacement);
  const [sidebarSearches, setSidebarSearches] = useState<SidebarSearchValues>({ documents: '', review: '', directory: '' });
  const setSidebarSearch = (kind: SidebarSearchKind, value: string) => setSidebarSearches(old => ({ ...old, [kind]: value }));
  useEffect(() => { setSidebarSearches({ documents: '', review: '', directory: '' }); }, [activeCanvasId]);
  useEffect(() => useAiStore.getState().connect(), []);
  useEffect(() => { if (snapshot && !snapshot.graph) void migrateBrowserData()
    .then(result => { if (result.skipped) setSkippedLegacy(result.skipped); })
    .catch(cause => setMigrationError(cause instanceof Error ? cause.message : '旧数据迁移失败')); }, [snapshot]);
  useEffect(() => {
    if (graphState && (!initialCanvasChosen.current || !graphState.canvases.some(c => c.canvasId === activeCanvasId))) {
      initialCanvasChosen.current = true;
      setActiveCanvasId(graphState.canvases.find(c => c.isDraft)?.canvasId ?? graphState.canvases[0]?.canvasId ?? DRAFT_ID);
    }
  }, [graphState, activeCanvasId]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { setActionRequest(null); setPendingTransfer(null); setFocusRequest(null); setOrganizeRegionId(null); setLayoutPreviewGraph(null); }, [activeCanvasId]);
  useEffect(() => {
    if (view !== 'canvas' || !composer.current) { setComposerBottomInset(0); return; }
    const element = composer.current;
    const measure = () => setComposerBottomInset(Math.ceil(window.innerHeight - element.getBoundingClientRect().top) + 12);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [view, dockedAi, Boolean(graphState), activeCanvasId]);

  const canvas = graphState?.canvases.find(c => c.canvasId === activeCanvasId) ?? null;
  const visibleDocuments = useMemo(() => graphState && canvas ? getCanvasDocumentIds(graphState, canvas) : new Set<string>(), [graphState?.documents, canvas]);
  const documents = useMemo(() => graphState && canvas ? listDocumentMeta(graphState).filter(doc => modeOf(graphState.documents[doc.documentId]) === modeOf(canvas)) : [], [graphState?.documents, graphState?.edges, canvas?.canvasId, canvas?.mode]);
  const rootDocumentIds = useMemo(() => new Set(graphState ? getRootDocumentIds(graphState) : []), [graphState?.documents]);
  const canvases = useMemo(() => graphState ? graphState.canvases.filter(c => !c.isDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [], [graphState?.canvases]);
  const navigate = (id: string, forceSelect = false) => { useAiStore.getState().setView('canvas'); setFocusRequest({ id, forceSelect, sequence: ++focusSequence.current }); };
  const executeGraph = (command: object, canvasId = activeCanvasId, expectedFields?: Array<{ refId: string; field: string; value: string }>): Promise<GraphMutationResult & { cleanedEdges?: number; graphRevision: number }> => {
    const operationId = `user-op:${crypto.randomUUID()}`;
    const operation = mutationQueue.current.then(async () => {
      const current = useAiStore.getState().snapshot; if (!current?.graph) throw new Error('数据尚未加载');
      const result = await useAiStore.getState().command<GraphMutationResult & { cleanedEdges?: number; graphRevision: number; changeSetId?: string }>('graph.mutate',
        { canvasId, command, operationId, expectedFields, expectedGraphRevision: current.graphRevision });
      return result;
    });
    mutationQueue.current = operation.catch(() => undefined); return trackCanvasMutation(canvasId,operation);
  };
  const mutate = async (command: GraphMutation): Promise<GraphMutationResult> => {
    try {
      const result = await executeGraph(command);
      if (result.id) navigate(result.id, true); if (result.cleanedEdges) setNotice(`已清理 ${result.cleanedEdges} 条失效边`);
      return result;
    } catch (cause) {
      const failure = cause as Error & { details?: { conflicts?: StructureConflict[]; revision?: string } };
      if (command.type !== 'createEdge' && command.type !== 'updateDesignNode' && failure.details?.conflicts && failure.details.revision) {
        setPendingTransfer({ command, conflicts: failure.details.conflicts, revision: failure.details.revision }); return { ok: false, pending: true };
      }
      return { ok: false, error: failure.message || '结构保存失败' };
    }
  };
  const saveDirect = async (command: object) => {
    try { return await executeGraph(command); } catch (cause) { setNotice(cause instanceof Error ? cause.message : '保存失败'); return null; }
  };
  const requestNavigation = (proceed: () => Promise<void>) => {
    useNewUiStore.getState().setPreviewCanvasId(null);
    const finish = proceed;
    const sessionIds = new Set(snapshot?.sessions.filter(session => session.canvasId === activeCanvasId && session.lifecycle !== 'deleted').map(session => session.workspaceId));
    const store = useAiStore.getState();
    const hasContent = canvas && (canvasDirectories(canvas).some(directory => directory.childIds.length > 0)
      || snapshot?.messages.some(message => sessionIds.has(message.workspaceId))
      || snapshot?.workspaces.some(workspace => sessionIds.has(workspace.id) && (workspace.workNotes.length || workspace.pinnedNotes.length || workspace.artifactIds.length))
      || Object.entries(store.draftsBySession).some(([ref, draft]) => (ref === `canvas:${activeCanvasId}` || snapshot?.sessions.some(session => session.canvasId === activeCanvasId && session.id === ref)) && Boolean(draft.text.trim() || draft.artifactIds.length)));
    if (canvas?.isDraft && hasContent) setPendingNavigation({ proceed: finish, draftCanvasId: canvas.canvasId });
    else void finish().catch(cause => setNotice(cause instanceof Error ? cause.message : '切换失败'));
  };
  const commitCanvasEntry = async (id: string, sessionId?: string) => {
    const version = ++canvasEntryVersion.current;
    const store = useAiStore.getState();
    const target = store.snapshot?.graph?.canvases.find(c => c.canvasId === id);
    if (!target) return;
    let selectedId = sessionId;
    if (!target.isDraft && !selectedId && !store.snapshot?.sessions.some(s => s.canvasId === id && s.mode !== 'temporary' && s.lifecycle !== 'deleted'))
      selectedId = (await store.command<Session>('session.ensure', { canvasId: id })).id;
    if (version !== canvasEntryVersion.current) return;
    store.clearActiveSession(activeCanvasId);
    store.clearActiveSession(id);
    if (!target.isDraft && selectedId) store.setActiveSession(id, selectedId);
    setActiveCanvasId(id); store.setView('canvas');
    useNewUiStore.getState().setPreviewCanvasId(null);
  };
  const openCanvas = (id: string, toggle = false, sessionId?: string) => {
    const target = toggle && id === activeCanvasId ? graphState?.canvases.find(c => c.isDraft)?.canvasId ?? id : id;
    if (target === activeCanvasId) { void commitCanvasEntry(target,sessionId).catch(cause=>setNotice(String(cause))); return; }
    requestNavigation(() => commitCanvasEntry(target,sessionId));
  };
  const openAction = (request: GraphActionRequest) => { setPendingTransfer(null); setActionRequest(request); };
  const moveDirectoryItems = (ids: string[], parentId: string) => {
    if (!graphState || !canvas) return;
    try {
      if (ownershipNotice(graphState, canvas, ids, parentId)) { openAction({ type: 'move', origin: 'directory', ids, parentId }); return; }
      void mutate({ type: 'move', ids, parentId }).then(result => { if (result.error) setNotice(result.error); });
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '移动失败'); }
  };
  const saveCurrentCanvas = async (name: string) => {
    if (!canvas) return;
    const save = async () => { const result = await executeGraph({ type: canvas.isDraft ? 'saveCanvas' : 'cloneCanvas', name }); if (result?.id) await commitCanvasEntry(result.id); setNaming(null); };
    if (canvas.isDraft) await save(); else { setNaming(null); requestNavigation(save); }
  };
  if (snapshot && !snapshot.setupCompleted) return <AiSetupPage />;
  if (!graphState || !canvas) return <div className="min-h-screen bg-space-950 text-slate-300 p-8">
    <h1 className="text-lg font-semibold">{migrationError ? '旧画布迁移未完成' : '正在连接本地服务…'}</h1>
    {(migrationError || serviceError) && <p className="mt-3 text-red-200">{migrationError || serviceError}</p>}
    <p className="mt-2 text-slate-400">首次连接会备份浏览器中的旧画布并迁移到本地数据库。</p>
    <button type="button" className="mt-4 rounded bg-blue-500/20 px-4 py-2" onClick={() => { setMigrationError(''); void useAiStore.getState().refresh().catch(() => undefined); }}>重新连接</button>
  </div>;

  const add = (id: string, point?: Point) => { if (!visibleDocuments.has(id)) openAction({ type: 'importDocument', origin: 'library', id, point }); };
  const createNewDocument = async (name: string) => {
    const result = await executeGraph({ type: 'createDocument', name }); setNaming(null); if (result?.id) add(result.id);
  };
  const createNewCanvas = () => setCreatingCanvas(true);
  const directoryPanel = <NewCanvasDirectoryPanel canvas={canvas} state={graphState} onNavigate={navigate} onAction={openAction} onMove={moveDirectoryItems} onNotice={setNotice} onOrganize={setOrganizeRegionId}
    query={sidebarSearches.directory} onQueryChange={value => setSidebarSearch('directory', value)} showSearch={directoryPlacement !== 'right'} />;
  const reviewPanel = <CanvasReviewPanel canvasId={canvas.canvasId} query={sidebarSearches.review} onQueryChange={value => setSidebarSearch('review', value)} showSearch={reviewPlacement !== 'right'} />;
  const stageState = layoutPreviewGraph ?? graphState;
  const stageCanvas = stageState.canvases.find(c => c.canvasId === activeCanvasId) ?? canvas;
  const changeAiSurface = async (action: 'dock' | 'expand' | 'fold' | 'restore') => {
    try {
      await flushDraftActions();
      if (currentCanvas.current !== activeCanvasId) return;
      if (action === 'expand') {
        if (notebookOpen) await panelCommand('hide-panel');
        if (currentCanvas.current === activeCanvasId) setOpenAiCanvas(activeCanvasId);
        return;
      }
      setOpenAiCanvas(undefined);
      if (action === 'fold') return;
      await panelCommand('set-canvas-ai-dock', { canvasId: activeCanvasId, docked: action === 'dock' });
      if (action === 'restore' && currentCanvas.current === activeCanvasId) useAiStore.getState().setView('chat');
    } catch (error) { setNotice(error instanceof Error ? error.message : '切换 AI 视图失败'); }
  };
  return <CanvasBackgroundProvider><GraphAppearanceProvider state={graphState} light={snapshot?.personalizationSettings?.canvasBackgroundId === 'white-grid'}><div className="canvas-ai-workspace relative w-screen h-screen bg-space-950 text-slate-200 overflow-hidden">
    <CanvasBackground />
    <main className={`absolute inset-0 z-10 min-w-0 h-full`}>
      {view === 'canvas' || canvas.isDraft ? <>
        <NewStageLayer state={stageState} canvas={stageCanvas} graphRevision={snapshot?.graphRevision??0} onAddDocument={add} onAction={openAction} onOrganize={setOrganizeRegionId} focusRequest={focusRequest} composerBottomInset={dockedAi ? 0 : composerBottomInset} aiDrawerWidth={aiExpanded ? aiDrawerWidth : 0}
          onCreateTemporary={point => { void (canvas.isDraft ? openGlobalTemporarySession() : openTemporarySession(canvas.canvasId, { point })).catch(cause => setNotice(cause instanceof Error ? cause.message : '无法打开临时会话')); }}
          onPlacementOccupancy={(refId, active) => {
            const request = placementQueue.current.catch(() => undefined).then(() => useAiStore.getState().command('graph.positioning', { refId, active }));
            placementQueue.current = request; return request;
          }}
          onMoveBlock={(id, parentId, point) => saveDirect({ type: 'moveBlock', id, parentId, point })}
          onCreateEdge={async input => (await saveDirect({ type: 'createEdge', input }))?.id ?? null}
          onReconnectEdge={(id, end, nodeId) => saveDirect({ type: 'reconnectEdge', id, end, nodeId })}
          onUpdateEdge={(id, patch) => { void saveDirect({ type: 'updateEdge', id, patch }); }}
          onEditText={async (target, value) => {
            const key = `${target.id}:${target.field}`, original = originalFields.current.get(key);
            if (original === undefined) throw new Error('编辑版本已失效，输入仍保留，请重新核对');
            const result = await executeGraph(target.kind === 'node' ? { type: 'updateNodeText', id: target.id, field: target.field, value }
              : { type: 'updateEdge', id: target.id, patch: { edgeContent: value } }, canvas.canvasId, [{ refId: target.id, field: target.field, value: original }]);
            if (result.ok) originalFields.current.set(key, value); return result.ok;
          }}
          onEditOccupancy={async (refId, field, active, expectedValue) => {
            await useAiStore.getState().command('graph.editing', { refId, field, active, expectedValue });
            const key = `${refId}:${field}`;
            if (active && expectedValue !== undefined) originalFields.current.set(key, expectedValue);
            else if (!active) originalFields.current.delete(key);
          }}
          onSelectionChange={refs => useAiStore.getState().setSelectedRefs(canvas.canvasId, refs)} playingPresentation={presenting}
          aiTaskId={dockedAi ? drawerTask?.id : playback?.taskId}
          aiTargetRefs={enteredSessionId && !canvas.isDraft && !inBackground ? canvasAiTargets ?? EMPTY_TARGETS : EMPTY_TARGETS}
          onSaveCanvas={() => setNaming('canvas')} />
        {!canvas.isDraft && !dockedAi && <div ref={composer} className="new-canvas-composer absolute bottom-0 z-20 flex flex-col items-center pointer-events-none" style={{ left: insets.left, right: insets.right,
          transition: isResizing ? 'none' : 'left 300ms ease-in-out, right 300ms ease-in-out' }}>
          <div className="new-canvas-composer-content w-full px-5 pb-4 flex flex-col gap-3 pointer-events-auto"><NewAiReplyPanel canvasId={canvas.canvasId} /><NewChatInput canvasId={canvas.canvasId} /></div>
        </div>}
      </> : <div className="new-chat-frame absolute inset-y-0 min-w-0" data-left-collapsed={!isLeftSidebarOpen} data-right-collapsed={!isRightSidebarOpen}
        style={{ left: insets.left, right: insets.right }}>
        <AiChatPage canvasId={canvas.canvasId} hideHeading onNavigate={refs => useAiStore.getState().requestCanvasSelection(canvas.canvasId, refs, 'ai')} />
      </div>}
      {!canvas.isDraft && (!dockedAi || view === 'chat') && <div className="workspace-view-actions" style={{ right: insets.right + 16 }}>
        {view === 'canvas' && <button type="button" className="canvas-ai-dock-action" aria-label="收起 AI 到右侧" title="收起 AI 到右侧"
          onClick={() => void changeAiSurface('dock')}><PanelRightClose size={18} /></button>}
        <button type="button" className="workspace-view-toggle" data-ai-view-toggle data-view-target={view === 'canvas' ? 'chat' : 'canvas'}
        aria-label={view === 'canvas' ? '查看完整聊天记录' : '返回画布'} title={view === 'canvas' ? '查看完整聊天记录' : '返回画布'}
        onClick={() => useAiStore.getState().setView(view === 'canvas' ? 'chat' : 'canvas')}>
        {view === 'canvas' ? <MessagesSquare size={19} aria-hidden="true" /> : <NewTreeIcon size={32} />}
      </button></div>}
      <SidebarToggle side="left" expanded={false} onClick={toggleLeftSidebar} label="展开画布栏" hidden={isLeftSidebarOpen}
        style={{ left: insets.left + 12 }} className={expandButtonClass(!isLeftSidebarOpen)} />
      <SidebarToggle side="right" expanded={false} onClick={toggleRightSidebar} label="展开图文档栏" hidden={isRightSidebarOpen}
        style={{ right: insets.right + 12 }} className={expandButtonClass(!isRightSidebarOpen)} />
    </main>
    <div className="absolute inset-y-0 left-0 z-30"><NewLeftSidebar canvases={canvases} currentDraft={canvas.isDraft ? canvas : undefined} activeCanvasId={activeCanvasId}
      onRenameCanvas={target => setRename({ kind: 'canvas', id: target.canvasId, original: target.canvasName })}
      onOpenCanvas={id => openCanvas(id, true)} onCreateCanvas={() => { void createNewCanvas(); }} directoryPanel={directoryPanel} reviewPanel={reviewPanel}
      onSettings={() => { useNewUiStore.getState().setPreviewCanvasId(null); useAiStore.getState().setSettingsOpen(true); }} /></div>
    <div className={`absolute inset-y-0 right-0 z-30`}><NewRightSidebar documents={documents} rootDocumentIds={rootDocumentIds}
      onRenameDocument={target => setRename({ kind: 'document', id: target.documentId, original: target.documentName })}
      activeDocumentIds={visibleDocuments}
      onAddDocument={add} onCreateDocument={() => setNaming('document')} directoryPanel={directoryPanel} reviewPanel={reviewPanel} canvasId={canvas.canvasId}
      searches={sidebarSearches} onSearchChange={setSidebarSearch} onSearchEnter={kind => {
        if (kind !== 'directory') return;
        const first = searchCanvas(graphState, canvas, sidebarSearches.directory, false)[0];
        if (first) navigate(first.id);
      }} /></div>
    <NewReviewDock canvasId={canvas.canvasId}>{reviewPanel}</NewReviewDock>
    <AiTemporarySidebar canvasId={canvas.canvasId} />
    {!canvas.isDraft && view === 'canvas' && dockedAi && <CanvasAiDrawer key={activeCanvasId} canvasId={activeCanvasId} canvasName={canvas.canvasName}
      expanded={aiExpanded} bookmarkInset={notebookInset} onWidth={setAiDrawerWidth}
      onOpen={() => void changeAiSurface('expand')} onFold={() => void changeAiSurface('fold')} onRestore={() => void changeAiSurface('restore')} />}
    {previewCanvasId && !graphState.canvases.find(c=>c.canvasId===previewCanvasId)?.isDraft && <NewSessionGraphOverlay canvasId={previewCanvasId} currentCanvasId={activeCanvasId} onSelect={(canvasId,sessionId) => openCanvas(canvasId,false,sessionId)} />}
    {pendingNavigation && <DraftCanvasLeaveDialog onCancel={() => setPendingNavigation(null)} onKeep={async () => { await pendingNavigation.proceed(); setPendingNavigation(null); }}
      onSave={async name => { const result = await executeGraph({ type: 'saveCanvas', name }, pendingNavigation.draftCanvasId); if (!result.ok) throw new Error(result.error ?? '另存失败'); await pendingNavigation.proceed(); setPendingNavigation(null); }} />}
    {creatingCanvas && <CanvasCreateDialog onClose={() => setCreatingCanvas(false)} onCreate={(name, mode) => { setCreatingCanvas(false); requestNavigation(async () => { const result = await executeGraph({ type: 'createCanvas', name, mode }); if (result?.id) await commitCanvasEntry(result.id); }); }} /> }
    {naming && <NameDialog key={naming} title={naming === 'canvas' ? '另存为画布' : '创建图文档'}
      label={naming === 'canvas' ? '画布名称' : '图文档名称'} initialName={naming === 'canvas' ? canvas.isDraft ? '未命名画布' : `${canvas.canvasName} 副本` : ''}
      submitLabel={naming === 'canvas' ? '另存为画布' : '创建图文档'} onClose={() => setNaming(null)}
      onSubmit={naming === 'canvas' ? saveCurrentCanvas : createNewDocument} />}
    {rename && <NameDialog title={rename.kind === 'canvas' ? '重命名画布' : '重命名图文档'}
      label={rename.kind === 'canvas' ? '画布名称' : '图文档名称'} initialName={rename.original} submitLabel="保存名称"
      onClose={() => setRename(null)} onSubmit={async name => {
        if (name !== rename.original) {
          const isCanvas = rename.kind === 'canvas';
          await executeGraph(isCanvas ? { type: 'renameCanvas', name } : { type: 'renameDocument', id: rename.id, name },
            isCanvas ? rename.id : activeCanvasId, [{ refId: rename.id, field: isCanvas ? 'canvasName' : 'name', value: rename.original }]);
        }
        setRename(null);
      }} />}
    {actionRequest && <GraphActionDialog key={`${activeCanvasId}:${actionRequest.type}:${actionRequest.id ?? ''}:${actionRequest.ids?.join(',') ?? ''}`}
      request={actionRequest} state={graphState} canvas={canvas} onSubmit={mutate} onClose={() => setActionRequest(null)} />}
    {pendingTransfer && <GraphTreeTransferDialog key={pendingTransfer.revision} conflicts={pendingTransfer.conflicts} state={graphState}
      targetId={pendingTransfer.command.type === 'registerDocument' ? pendingTransfer.command.id :
        'parentId' in pendingTransfer.command ? pendingTransfer.command.parentId : undefined}
      onCancel={() => { setPendingTransfer(null); setActionRequest(null); }}
      onResolve={async choices => { const result = await mutate({ ...pendingTransfer.command, resolution: { revision: pendingTransfer.revision, choices } });
        if (result.ok) { setPendingTransfer(null); setActionRequest(null); } return result; }} />}
    {organizeRegionId && <LayoutOrganizeDialog state={graphState} canvas={canvas} graphRevision={snapshot?.graphRevision ?? 0} initialRegionId={organizeRegionId}
      onInspect={id => setFocusRequest({ id, sequence: ++focusSequence.current })}
      onPreview={setLayoutPreviewGraph} onClose={() => { setOrganizeRegionId(null); setLayoutPreviewGraph(null); }} />}

    <AiSettingsDialog />
    {connection !== 'connected' && <div role="status" className="fixed top-3 left-1/2 -translate-x-1/2 z-[210] rounded border border-amber-400/30 bg-slate-950/95 px-3 py-2 text-xs text-amber-200">本地服务连接中；正在恢复记录…</div>}
    {notice && <div role="status" data-graph-notice className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[210] max-w-lg rounded-xl border border-slate-600 bg-slate-950/95 px-4 py-3 text-xs text-slate-200 shadow-lg pointer-events-none">{notice}</div>}
    {skippedLegacy && <div role="status" data-legacy-browser-skip className="fixed top-3 left-1/2 -translate-x-1/2 z-[211] max-w-xl rounded-xl border border-amber-400/40 bg-slate-950/95 px-4 py-3 text-xs text-amber-100 shadow-lg">
      <div>浏览器中的旧画布没有迁移：{skippedLegacy}。已按空画布启动。</div>
      <div className="mt-1 text-amber-200/80">旧记录仍完整保留在浏览器存储中，没有被上传或删除。</div>
      <button type="button" data-legacy-browser-dismiss className="mt-2 rounded bg-amber-400/20 px-2 py-1 text-amber-100" onClick={() => setSkippedLegacy('')}>知道了</button>
    </div>}
  </div></GraphAppearanceProvider></CanvasBackgroundProvider>;
}
