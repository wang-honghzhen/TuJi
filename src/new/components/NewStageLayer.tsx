import { DESIGN_LABELS } from '@/v3/design';
import { DesignDetails } from './DesignDetails';
import { canvasDirectories, canvasDirectory, canvasDirectoryEntries } from '@/v3/canvas';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Pencil, Save } from 'lucide-react';
import { createPortal } from 'react-dom';
import { buildRenderModel, getCanvasNodeOptions, regionContentOrigin, type RenderBlock, type RenderEdge, type RenderModel } from '@/v3/layout';
import { GranularSpatialCanvas } from './GranularSpatialCanvas';
import { GranularityPanel } from './GranularityPanel';
import { buildGranularityIndex, createGranularity, crossAggregationState, openPlanarAncestors, relationSettings, revealPlanarObjects,
  setAllGroups, setAllRelations, updateGroup, updateRelation, type CanvasGranularity, type GranularityIndex, type RelationSettings } from '../canvasGranularity';
import { canvasDisplayCommand } from '../canvasDisplayCommands';
import { useCameraTransition } from '../useCameraTransition';
import { CONNECTION_SIDES, distanceToRoute, facingSide, makeEdgeRoute, nearestPort, placeEdgeLabel, pointOnRoute, portPoint, routeBounds, sideVector, type EdgeLabel } from '@/v3/edgeGeometry';
import { RectangleIndex } from '@/v3/rectangleIndex';
import type { CanvasRecord, ConnectionSide, GraphState, Point } from '@/v3/types';
import type { CreateEdgeInput, EdgePatch } from '@/v3/storage';
import { nodeGeometry } from '@/v3/nodeGeometry';
import { previewBlockMove } from '@/v3/regionLayout';
import { CanvasRegion } from './CanvasRegion';
import { adjustPlanarExpansion, buildPlanarGranularityModel, projectPlanarGranularity, projectSpatialGranularity, visibleRelationIndex, withoutPlanarOffsets } from '../planarGranularity';
import { neighborhoodPaths } from '../neighborhoodPaths';
import { PlanarSubgraphRelations } from './PlanarSubgraphRelations';
import { canonicalRegionPoint, regionHeaderRect } from '../regionControls';
import { CanvasSearch } from './CanvasSearch';
import { CanvasDisplayOptions } from './CanvasDisplayOptions';
import { searchFocusView } from '../graphSearch';
import { useSidebarInsets } from '../newUiStore';
import { useCanvasBackground } from '../backgrounds/CanvasBackground';
import { loadCanvasViewport, saveCanvasViewport, flushCanvasViewport, type CanvasViewport } from '../canvasViewportStore';
import { CanvasDetailPanel, type CanvasDetail } from './CanvasDetailPanel';
import { NodeDependencyLinks } from './NodeDependencyLinks';
import { CanvasEditingProvider, CanvasTextField, useCanvasEditing, type EditOccupancyCallback, type TextTarget } from './CanvasTextField';
import { CanvasTextPreview } from './CanvasTextPreview';
import { canvasTextMetrics } from '../canvasTextPresentation';
import { GraphContextMenu, type GraphMenuItem } from './GraphContextMenu';
import type { CanvasFocusRequest, GraphActionRequest } from '../graphActions';
import { useEdgeRouting } from '../useEdgeRouting';
import { canvasViewportBounds, indexCanvasObjects } from '../canvasVisibility';
import { useCanvasOcclusions } from '../useCanvasOcclusions';
import { usePlaybackStore } from '@/ai/presentationClient';
import { useAiStore } from '@/ai/client';
import { connectionLevel, nodeConnectionCounts } from '@/v3/nodeConnections';
import { CanvasReviewOverlay } from './CanvasReviewOverlay';
import { canvasInteractionBlocked, useCanvasForeground } from '../canvasInteractionScope';
import { resolvePresentationTargets } from '../presentationTargets';
import { useAiCanvasSelection } from '../useAiCanvasSelection';

import { GraphAppearanceProvider, graphNameAppearance, darkEdgeAccents, lightEdgeAccents } from '../graphAppearance';
import { GraphNameLabel } from './GraphPathLabel';

interface Props {
  state: GraphState;
  canvas: CanvasRecord;
  graphRevision: number;
  onAddDocument: (id: string, world: Point) => void;
  onMoveBlock: (id: string, parentId: string, point: Point) => Promise<{ ok: boolean; graphRevision: number } | null>;
  onCreateEdge: (input: CreateEdgeInput) => string | null | Promise<string | null>;
  onReconnectEdge: (edgeId: string, end: 'source' | 'target', nodeId: string) => Promise<{ ok: boolean; graphRevision: number } | null>;
  onUpdateEdge: (edgeId: string, patch: EdgePatch) => unknown;
  onEditText: (target: TextTarget, value: string) => boolean | Promise<boolean>;
  onEditOccupancy?: EditOccupancyCallback;
  onSelectionChange?: (refs: string[]) => void;
  onCreateTemporary?: (point: Point) => void;
  aiTargetRefs?: string[];
  playingPresentation: boolean;
  aiTaskId?: string;
  composerBottomInset?: number;
  aiDrawerWidth?: number;
  onSaveCanvas: () => void;
  onAction: (request: GraphActionRequest) => void;
  onOrganize?: (regionId: string) => void;
  onPlacementOccupancy?: (refId: string, active: boolean) => Promise<unknown>;
  focusRequest: CanvasFocusRequest | null;
}
type View = CanvasViewport;
type Snap = ReturnType<typeof nearestPort>;
type Gesture =
  | { type: 'pan'; pointerId: number; startClient: Point; startView: View; regionId?: string }
  | { type: 'block'; kind: 'node' | 'record'; pointerId: number; id: string; parentId: string; startClient: Point; startLocal: Point; zoom: number; offset: Point }
  | { type: 'edgePress'; pointerId: number; edgeId: string; end: 'source' | 'target' | null; startClient: Point; cancelled: boolean; ready: boolean }
  | { type: 'link'; pointerId: number; fixed: Point; fixedSide: ConnectionSide; otherId: string;
      sourceId?: string; sourceSide?: ConnectionSide; edgeId?: string; end?: 'source' | 'target'; point: Point; snap: Snap; directed: boolean; hasLeft: boolean };
interface Focus { mode: 'selected' | 'neighbors' }
interface Hover { kind: CanvasDetail['kind']; id: string; position: Point; edgeAnchor?: Point; pinned?: boolean; manual?: boolean }
interface PendingMove { token: number; canvasId: string; id: string; parentId: string; point: Point; committedRevision?: number }
interface PendingReconnect { token: number; canvasId: string; edgeId: string; end: 'source' | 'target'; nodeId: string; committedRevision?: number }
function editable(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}
function stopCameraFollow(canvasId: string) {
  const playback = usePlaybackStore.getState();
  if (playback.byCanvas[canvasId]?.cameraFollow !== false) playback.set(canvasId, { cameraFollow: false });
}

type CanvasViewKind = '2d' | 'layered' | 'sphere';
const emptySelection:ReadonlySet<string> = new Set();
interface TransferFrame { id?: string; u: number; v: number; zoomRatio?: number }

function planarCameraAnchor(model: RenderModel, index: GranularityIndex, id: string): Point | undefined {
  const rect = (key: string) => key === index.rootId ? model.bounds : model.blocks.find(b => b.id === key)?.rect;
  const center = (r: RenderBlock['rect']) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const block = rect(id);
  if (block) return center(block);
  const line = model.edges.find(e => e.edge.edgeId === id);
  if (line) return line.route.middle;
  const relation = index.relations.get(id), edge = index.edgesById.get(id);
  const ids = relation ? [relation.sourceSubgraphId, relation.targetSubgraphId] : edge ? [edge.sourceNodeId, edge.targetNodeId] : [];
  const ends = ids.map(rect).filter(r => !!r).map(center);
  if (ends.length === 1) return ends[0];
  if (ends.length === 2) return { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
}

export function NewStageLayer({ state, canvas, graphRevision, onAddDocument, onMoveBlock, onCreateEdge, onReconnectEdge, onUpdateEdge, onEditText, onEditOccupancy, onSelectionChange, onCreateTemporary, aiTargetRefs = [], playingPresentation, aiTaskId, composerBottomInset = 210, aiDrawerWidth = 0, onSaveCanvas, onAction, onOrganize, onPlacementOccupancy, focusRequest }: Props) {
  const storedPlayback=usePlaybackStore(s=>s.byCanvas[canvas.canvasId]);
  const playbackAvailable=useAiStore(s=>!canvas.isDraft&&!!s.activeSessionByCanvas[canvas.canvasId]&&!!s.snapshot?.tasks.some(t=>t.id===storedPlayback?.taskId&&t.sessionId===s.activeSessionByCanvas[canvas.canvasId]));
  const playback=playingPresentation&&playbackAvailable?storedPlayback:undefined;
  const activeSessionId = useAiStore(s => s.activeSessionByCanvas[canvas.canvasId]);
  const presentationPart = useAiStore(s => s.snapshot?.presentationParts?.find(p => p.taskId === playback?.taskId && p.seq === playback?.cursor));
  const autoFocusHandled = useAiStore(s => !!presentationPart && !!s.snapshot?.presentationAutoFocus?.[presentationPart.id]);
  const settingsOpen = useAiStore(s => s.settingsOpen);
  const selectionRequest = useAiStore(s => s.canvasSelectionRequest);
  const [selectionNotice, setSelectionNotice] = useState('');
  useEffect(() => { if (selectionNotice) { const timer = setTimeout(() => setSelectionNotice(''), 5500); return () => clearTimeout(timer); } }, [selectionNotice]);
  const presentationPaused=useAiStore(s=>{const task=s.snapshot?.tasks.find(t=>t.id===playback?.taskId);return !!(task?.pauseRequested||task?.presentation?.playbackPaused);});
  const sidebarInsets = useSidebarInsets(), sidebarControls = useSidebarInsets({ reserveExpandButtons: true });
  const insets = { ...sidebarInsets, right: Math.max(sidebarInsets.right, aiDrawerWidth) };
  const controlInsets = { ...sidebarControls, right: Math.max(sidebarControls.right, aiDrawerWidth) };
  const paintId = useId().replace(/:/g, '');
  const lightGrid = useCanvasBackground().settings.canvasBackgroundId === 'white-grid';
  const edgeAccents = lightGrid ? lightEdgeAccents : darkEdgeAccents;
  const groupAccent = (id: string) => graphNameAppearance(state, id, undefined, lightGrid).accent;
  const connections = useMemo(() => nodeConnectionCounts(state.edges), [state.edges]);
  const accentLevel = (id?: string) => id && state.nodes[id] ? connectionLevel(connections.get(id) ?? 0) : 'neutral';
  const natural = useMemo(() => buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true }), [state, canvas]);
  const visitKey = JSON.stringify([canvas.canvasId, activeSessionId, playingPresentation, aiTaskId, presentationPart?.id,
    playingPresentation ? undefined : aiTargetRefs]);
  const visit = useMemo(() => ({ key: visitKey, partId: presentationPart?.id }), [visitKey]);
  const selectionContext = useRef({ state, natural, activeSessionId, visit });
  selectionContext.current = { state, natural, activeSessionId, visit };
  const initialView = () => ({ x: insets.left + 48 - natural.bounds.x, y: 80 - natural.bounds.y, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const [activeView, setActiveView] = useState<CanvasViewKind>('2d');
  const focusAfterSwitch=useRef(false);
  useLayoutEffect(()=>{
    if(!focusAfterSwitch.current)return;
    focusAfterSwitch.current=false;
    (viewport.current?.querySelector<SVGSVGElement>('[data-granular-view]')??viewport.current)?.focus({preventScroll:true});
  },[activeView]);
  const spatial = activeView !== '2d';
  const spatialRef = useRef(spatial); spatialRef.current = spatial;
  const [spatialFocus, setSpatialFocus] = useState<(CanvasFocusRequest & {fit?:boolean; animate?:boolean}) | null>(null);
  const spatialSequence = useRef(0);
  const focusInSpace = (id: string, animate = false) => setSpatialFocus({ id, animate, sequence: ++spatialSequence.current });
  const incomingFrame = useRef<TransferFrame>();
  const spatialFrame = useRef<TransferFrame>();
  const [canvasSettings, setCanvasSettings] = useState<Record<string, CanvasGranularity>>({});
  const initialGranularity = useMemo(() => createGranularity(canvas), [canvas.canvasId, canvas.collapsed]);
  const granularity = canvasSettings[canvas.canvasId] ?? initialGranularity;
  const changeGranularity = (change: (old: CanvasGranularity) => CanvasGranularity) =>
    setCanvasSettings(old => {
      const previous=old[canvas.canvasId]??initialGranularity, next=change(previous);
      return next===previous?old:{...old,[canvas.canvasId]:adjustPlanarExpansion(previewState, previewCanvas, semanticIndex, previous, next)};
    });
  const [newEdgeToReveal,setNewEdgeToReveal]=useState<string|null>(null);
  const [planarLocation, setPlanarLocation] = useState<{
    canvasId: string; blockIds: string[]; select?: { kind: Hover['kind']; id: string; details: boolean };
  } | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [granularityPanel, setGranularityPanel] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => loadCanvasViewport(canvas.canvasId, initialView()));
  const viewRef = useRef(view);
  const { animate: animatePan, cancel: cancelPan } = useCameraTransition();
  const viewFrame = useRef<number | null>(null);
  const viewportCanvasId = useRef(canvas.canvasId);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const gestureFrame = useRef<number | null>(null);
  const placementOccupancy = useRef(onPlacementOccupancy); placementOccupancy.current = onPlacementOccupancy;
  useEffect(() => {
    if (gesture?.type !== 'block') return;
    const id = gesture.id; const acquired = Promise.resolve(placementOccupancy.current?.(id, true)).catch(() => undefined);
    const timer = window.setInterval(() => { void placementOccupancy.current?.(id, true).catch(() => undefined); }, 20000);
    return () => { window.clearInterval(timer); void acquired.then(() => placementOccupancy.current?.(id, false)).catch(() => undefined); };
  }, [gesture?.type === 'block' ? gesture.id : null]);
  const [pendingMoves, setPendingMoves] = useState<PendingMove[]>([]);
  const [pendingReconnects, setPendingReconnects] = useState<PendingReconnect[]>([]);
  const moveSequence = useRef(0);
  const [showInternalEdges, setShowInternalEdges] = useState(true);
  const [showCrossEdges, setShowCrossEdges] = useState(true);
  const [showOutsideEdges, setShowOutsideEdges] = useState(true);
  const [selected, setSelected] = useState<Hover | null>(null);
  const [multiMode, setMultiMode] = useState(false);
  const [multiIds, setMultiIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ position: Point; items: GraphMenuItem[] } | null>(null);
  const selectedIds = useMemo(() => multiMode ? multiIds : new Set(selected ? [selected.id] : []),
    [selected?.id, multiMode, multiIds]);
  const selectedEdgeId = selected?.kind === 'edge' ? selected.id : null;
  const [focus, setFocus] = useState<Focus | null>(null);
  const [neighborhoodFocusId, setNeighborhoodFocusId] = useState<string | null>(null);
  const activeNeighbor = focus?.mode === 'neighbors' ? neighborhoodFocusId : null;
  const [clickedSelection, setClickedSelection] = useState<ReadonlySet<string>>(emptySelection);
  const previousScope = useRef<Focus['mode'] | undefined>(undefined);
  const [scopeNotice, setScopeNotice] = useState('');
  useEffect(() => {
    const mode = focus?.mode, previous = previousScope.current;
    if (mode === previous) return;
    previousScope.current = mode;
    const name = (scope: Focus['mode'] | undefined) => scope === 'neighbors' ? '邻域' : '仅选中';
    const action = previous ? `已从${name(previous)}切换到${name(mode)}` : `已进入${name(mode)}模式`;
    setScopeNotice(mode ? `${action} · 再按 ${mode === 'neighbors' ? '4' : '5'} 退出` : `已退出${name(previous)}模式 · 全显示`);
    const timer = setTimeout(() => setScopeNotice(''), 2200);
    return () => clearTimeout(timer);
  }, [focus?.mode]);
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoveredPlanarRelationId, setHoveredPlanarRelationId] = useState<string | null>(null);
  const hoverTarget = useRef<Pick<Hover, 'kind' | 'id'> | null>(null);
  const [popup, setPopup] = useState<Hover | null>(null);
  const popupRequest = useRef(0);
  const previewRequest = useRef(0);
  const [nearEnd, setNearEnd] = useState<{ edgeId: string; end: 'source' | 'target' } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [detailSize, setDetailSize] = useState({ width: 330, height: 300 });
  const [dropActive, setDropActive] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1400, height: 900 });
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endCandidate = useRef<{ edgeId: string; end: 'source' | 'target' } | null>(null);
  const readyEnd = useRef<typeof nearEnd>(null);
  const suppressContextUntil = useRef(0);
  const editing = useCanvasEditing(onEditText, onEditOccupancy,canvas.canvasId);
  useEffect(()=>{usePlaybackStore.getState().set(canvas.canvasId,{interactionBusy:!!gesture||!!editing.session});},[!!gesture,!!editing.session,canvas.canvasId]);
  const pendingAutoFocus = useRef(new Set<string>());
  const revisiting = !!presentationPart && (presentationPart.seq === 0 || autoFocusHandled || pendingAutoFocus.current.has(presentationPart.id));
  const aiSelection = useAiCanvasSelection(visitKey, revisiting, aiTargetRefs, !!focus);
  const aiTargets = aiSelection.targets;
  const revealedEdgeIds = useMemo(() => new Set(state.edges.filter(edge =>
    selectedIds.has(edge.edgeId) || aiTargets.has(edge.edgeId)).map(edge => edge.edgeId)), [state.edges, selectedIds, aiTargets]);
  const edgeVisibility = useMemo(() => ({ showInternalEdges, showCrossEdges, showOutsideEdges }),
    [showInternalEdges, showCrossEdges, showOutsideEdges]);
  const pointer = useRef<Point | null>(null);
  const previousEntries = useRef<{ canvasId: string; ids: Set<string> } | null>(null);
  const selectionCallback = useRef(onSelectionChange); selectionCallback.current = onSelectionChange;
  const selectionKey = JSON.stringify(multiMode ? [...multiIds].sort() : selected ? [selected.id] : []);
  useEffect(() => { selectionCallback.current?.(JSON.parse(selectionKey) as string[]); }, [canvas.canvasId, selectionKey]);

  const updateView = useCallback((update: (old: View) => View, coalesce = false) => {
    cancelPan();
    const next = update(viewRef.current);
    viewRef.current = next;
    if (coalesce) {
      if (viewFrame.current === null) viewFrame.current = requestAnimationFrame(() => { viewFrame.current = null; setView(viewRef.current); saveCanvasViewport(viewportCanvasId.current, viewRef.current); });
    } else {
      if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); viewFrame.current = null;
      setView(next); saveCanvasViewport(viewportCanvasId.current, next);
    }
  }, [cancelPan]);
  useEffect(() => () => { if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); }, []);
  useLayoutEffect(() => {
    if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); viewFrame.current = null;
    cancelPan();
    viewportCanvasId.current = canvas.canvasId;
    const next = loadCanvasViewport(canvas.canvasId, initialView());
    viewRef.current = next; setView(next);
  }, [canvas.canvasId]);
  useEffect(() => {
    const canvasId = canvas.canvasId;
    const flush = () => flushCanvasViewport(canvasId);
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [canvas.canvasId]);
  const zoomAt = useCallback((screen: Point, factor: number, coalesce = false) => {
    clearEnd();
    if (viewRef.current.zoom * factor < .65) setRevealed(old => old.size ? new Set() : old);
    updateView((old) => {
      const zoom = Math.max(0.12, Math.min(3, old.zoom * factor));
      if (zoom === old.zoom) return old;
      return { x: screen.x - (screen.x - old.x) * zoom / old.zoom,
        y: screen.y - (screen.y - old.y) * zoom / old.zoom, zoom };
    }, coalesce);
  }, [updateView]);
  const stopHold = () => { if (holdTimer.current) clearTimeout(holdTimer.current); holdTimer.current = null; };
  const updateGesture = (next: Gesture | null, coalesce = false) => {
    stopHold(); endCandidate.current = null; readyEnd.current = null; setNearEnd(null); gestureRef.current = next;
    if (coalesce) {
      if (gestureFrame.current === null) gestureFrame.current = requestAnimationFrame(() => { gestureFrame.current = null; setGesture(gestureRef.current); });
    } else { if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null; setGesture(next); }
  };
  useEffect(() => () => { if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current); }, []);
  const clearDismiss = () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); dismissTimer.current = null; };
  const clearEnd = () => { stopHold(); endCandidate.current = null; readyEnd.current = null; setNearEnd(null); };
  const clearHover = () => { clearDismiss(); hoverTarget.current = null; setHover(null); setHoveredPlanarRelationId(null); clearEnd(); };
  const dismissPreview = () => { previewRequest.current++; setPopup(old => old?.pinned ? old : null); };
  const scheduleDismiss = () => { clearEnd(); clearDismiss(); dismissTimer.current = setTimeout(() => {
    hoverTarget.current = null; setHover(null); dismissPreview();
  }, 250); };
  const bottomInset = Math.max(0, composerBottomInset);
  const visibleHeight = Math.max(180, viewportSize.height - bottomInset);
  const visibleCenter = () => ({ x: (insets.left + viewportSize.width - insets.right) / 2, y: Math.max(100, visibleHeight / 2) });

  const regionSummaries = useMemo(() => {
    const summaries = new Map<string, { nodeCount: number; regionCount: number }>();
    // Render blocks are parent-first. Accumulate every subtree once, from its leaves up.
    for (let i = natural.blocks.length - 1; i >= 0; i--) {
      const block = natural.blocks[i];
      const parent = summaries.get(block.parentId) ?? { nodeCount: 0, regionCount: 0 };
      const children = summaries.get(block.id);
      parent.nodeCount += (children?.nodeCount ?? 0) + Number(block.kind === 'node');
      parent.regionCount += (children?.regionCount ?? 0) + Number(block.kind !== 'node');
      summaries.set(block.parentId, parent);
    }
    return summaries;
  }, [natural]);
  const detailNeedsNodes = popup?.kind === 'node' || popup?.kind === 'edge';
  const nodeOptions = useMemo(() => detailNeedsNodes ? getCanvasNodeOptions(state, canvas) : [], [state, canvas, detailNeedsNodes]);
  const movingBlock = gesture?.type === 'block' ? gesture : undefined;
  const reconnectId = gesture?.type === 'link' && gesture.snap ? gesture.edgeId : undefined;
  const reconnectEnd = reconnectId && gesture?.type === 'link' ? gesture.end : undefined;
  const reconnectNodeId = reconnectId && gesture?.type === 'link' ? gesture.snap?.id : undefined;
  const previewState = useMemo(() => {
    let preview = state;
    for (const move of pendingMoves) if (move.canvasId === canvas.canvasId && (move.committedRevision === undefined || graphRevision < move.committedRevision)) {
      preview = previewBlockMove(preview, move.canvasId, move.id, move.parentId, move.point);
    }
    if (movingBlock && (movingBlock.offset.x || movingBlock.offset.y)) preview = previewBlockMove(preview, canvas.canvasId, movingBlock.id, movingBlock.parentId,
      { x: movingBlock.startLocal.x + movingBlock.offset.x, y: movingBlock.startLocal.y + movingBlock.offset.y });
    const replacements = pendingReconnects.filter(change => change.canvasId === canvas.canvasId
      && (change.committedRevision === undefined || graphRevision < change.committedRevision));
    if (reconnectId && reconnectEnd && reconnectNodeId) replacements.push({ token: 0, canvasId: canvas.canvasId,
      edgeId: reconnectId, end: reconnectEnd, nodeId: reconnectNodeId });
    if (replacements.length) preview = { ...preview, edges: preview.edges.map(edge => replacements.reduce((current, change) =>
      change.edgeId === edge.edgeId ? { ...current, [change.end === 'source' ? 'sourceNodeId' : 'targetNodeId']: change.nodeId } : current, edge)) };
    return preview;
  }, [state, canvas.canvasId, graphRevision, movingBlock, pendingMoves, pendingReconnects, reconnectId, reconnectEnd, reconnectNodeId]);
  useEffect(() => {
    setPendingMoves(old => {
      const remaining = old.filter(move => move.canvasId === canvas.canvasId && (move.committedRevision === undefined || graphRevision < move.committedRevision));
      return remaining.length === old.length ? old : remaining;
    });
  }, [canvas.canvasId, graphRevision, pendingMoves]);
  useEffect(() => {
    setPendingReconnects(old => {
      const remaining = old.filter(change => change.canvasId === canvas.canvasId && (change.committedRevision === undefined || graphRevision < change.committedRevision));
      return remaining.length === old.length ? old : remaining;
    });
  }, [canvas.canvasId, graphRevision, pendingReconnects]);
  const previewCanvas = previewState.canvases.find((item) => item.canvasId === canvas.canvasId) ?? canvas;
  const semanticIndex = useMemo(() => buildGranularityIndex(previewState, previewCanvas), [previewState, previewCanvas]);
  const semanticSelection = useMemo(() => new Set([...(selectedRelationId ? [selectedRelationId] : selectedIds), ...aiTargets]), [selectedRelationId, selectedIds, aiTargets]);
  const hasClickedAnchor = useMemo(() => [...clickedSelection].some(id => (selectedIds.has(id) || id === selectedRelationId)
    && (semanticIndex.nodeIds.has(id) || semanticIndex.groupIds.has(id) || semanticIndex.edgesById.has(id) || semanticIndex.relations.has(id))),
    [clickedSelection, selectedIds, selectedRelationId, semanticIndex]);
  useEffect(() => {
    if (focus?.mode === 'selected' && !hasClickedAnchor && !multiMode || focus?.mode === 'neighbors' && !neighborhoodFocusId) setFocus(null);
  }, [focus, hasClickedAnchor, multiMode, neighborhoodFocusId]);
  const neighborAnchor = useMemo(() => neighborhoodFocusId ? new Set([neighborhoodFocusId]) : emptySelection, [neighborhoodFocusId]);
  const filterAnchors = useMemo(() => aiSelection.explicitlyLocated ? semanticSelection
    : selectedRelationId ? new Set([selectedRelationId]) : selectedIds,
    [aiSelection.explicitlyLocated, semanticSelection, selectedRelationId, selectedIds]);
  const scopeSelection = focus?.mode === 'neighbors' ? neighborAnchor : focus ? filterAnchors : emptySelection;
  const semanticScene = useMemo(() => (spatial ? projectSpatialGranularity : projectPlanarGranularity)(
    semanticIndex, granularity, scopeSelection, focus?.mode ?? 'all', edgeVisibility),
    [spatial, semanticIndex, granularity, scopeSelection, focus, edgeVisibility]);
  const spatialRelations = useMemo(() => spatial ? visibleRelationIndex(semanticIndex, semanticScene) : semanticIndex,
    [spatial, semanticIndex, semanticScene]);
  const revealObjects = (index: typeof semanticIndex, settings: CanvasGranularity, ids: readonly string[]) =>
    revealPlanarObjects(index, settings, ids, spatial && !settings.defaultExpanded && !focus);

  useEffect(()=>{
    if(!newEdgeToReveal||!semanticIndex.edgesById.has(newEdgeToReveal))return;
    changeGranularity(old=>revealObjects(semanticIndex,old,[newEdgeToReveal]));
    setNewEdgeToReveal(null);
  },[newEdgeToReveal,semanticIndex]);
  const spatialNatural=useMemo(()=>spatial && previewState!==state
    ?buildRenderModel(previewState,previewCanvas,{zoom:1,ignoreCollapse:true,skipEdges:true})
    :natural,[spatial,previewState,state,previewCanvas,natural]);
  const draggedBlock = movingBlock && (movingBlock.offset.x || movingBlock.offset.y) ? movingBlock.id : undefined;
  const planarPlacements = useMemo(() => {
    const ids = pendingMoves.filter(move => move.canvasId === canvas.canvasId).map(move => move.id);
    if (draggedBlock) ids.push(draggedBlock);
    return withoutPlanarOffsets(granularity, ids).planarPlacements;
  }, [granularity, canvas.canvasId, draggedBlock, pendingMoves]);
  const baseModel = useMemo(() => spatial ? natural : buildPlanarGranularityModel(previewState, previewCanvas, semanticScene, semanticIndex.parents, planarPlacements),
    [spatial, natural, previewState, previewCanvas, semanticScene, semanticIndex.parents, planarPlacements]);
  // Reframe for a new focus. Geometry updates and view switches retain their own framing.
  useLayoutEffect(() => {
    if (!activeNeighbor) {
      setSpatialFocus(previous => previous?.animate ? null : previous);
      return;
    }
    if (spatial) {
      focusInSpace(activeNeighbor, true);
      return;
    }
    const index = visibleRelationIndex(semanticIndex, semanticScene);
    const anchor = planarCameraAnchor(baseModel, index, activeNeighbor);
    if (!anchor) return;
    const start = viewRef.current, center = visibleCenter();
    const dx = center.x - anchor.x * start.zoom - start.x;
    const dy = center.y - anchor.y * start.zoom - start.y;
    if (Math.hypot(dx, dy) < 1) return;
    animatePan(t => {
      const next = { ...start, x: start.x + dx * t, y: start.y + dy * t };
      viewRef.current = next;
      setView(next);
      saveCanvasViewport(canvas.canvasId, next);
    });
    return cancelPan;
  }, [activeNeighbor, canvas.canvasId]);
  const planarAncestors = useMemo(() => {
    const ids = new Set<string>();
    const include = (id: string) => {
      let group = semanticIndex.groupIds.has(id) ? id : semanticIndex.parents.get(id);
      while (group && !ids.has(group)) {
        ids.add(group);
        group = semanticIndex.parents.get(group);
      }
    };
    if (!spatial) for (const id of selectedRelationId ? [selectedRelationId] : selectedIds) {
      const pair = semanticIndex.relations.get(id), edge = semanticIndex.edgesById.get(id);
      if (pair) { include(pair.sourceSubgraphId); include(pair.targetSubgraphId); }
      else if (edge) { include(edge.sourceNodeId); include(edge.targetNodeId); }
      else if (semanticIndex.groupIds.has(id)) ids.add(id);
      else include(id);
    }
    return ids;
  }, [spatial, semanticIndex, selectedIds, selectedRelationId]);
  const viewportRect = useMemo(() => canvasViewportBounds(view, viewportSize), [view, viewportSize]);
  const screenOcclusions = useCanvasOcclusions(semanticScene.relations.length > 0 || !!activeNeighbor, insets.left, insets.right);
  const relationViewport = useMemo(() => ({
    x: viewportRect.x + insets.left / view.zoom, y: viewportRect.y,
    width: Math.max(0, viewportSize.width - insets.left - insets.right) / view.zoom, height: viewportRect.height,
  }), [viewportRect, insets.left, insets.right, viewportSize.width, view.zoom]);
  const relationOcclusions = useMemo(() => screenOcclusions.map(r => ({
    x: (r.x - view.x) / view.zoom, y: (r.y - view.y) / view.zoom, width: r.width / view.zoom, height: r.height / view.zoom,
  })), [screenOcclusions, view]);
  const routeOptions = useMemo(() => ({ viewport: viewportRect, labels: true,
    expandedEdgeIds: [...revealedEdgeIds, ...baseModel.edges.filter(e =>
      semanticScene.collapsedGroupIds.has(e.sourceBlockId ?? '') || semanticScene.collapsedGroupIds.has(e.targetBlockId ?? '')).map(e => e.edge.edgeId),
      ...(hover?.kind === 'edge' ? [hover.id] : []), ...(popup?.kind === 'edge' ? [popup.id] : []),
      ...(gesture?.type === 'link' && gesture.edgeId ? [gesture.edgeId] : [])] }),
    [viewportRect, baseModel.edges, semanticScene.collapsedGroupIds, revealedEdgeIds, hover?.kind === 'edge' ? hover.id : null,
      popup?.kind === 'edge' ? popup.id : null, gesture?.type === 'link' ? gesture.edgeId : null]);
  const routed = useEdgeRouting(baseModel, routeOptions, Boolean(gesture), canvas.canvasId, !spatial);
  const model = useMemo(() => ({ ...baseModel, edges: routed.edges }), [baseModel, routed.edges]);
  const residualRelationOfEdge = useMemo(() => {
    const represented = new Map<string, string>();
    if (!spatial) for (const relation of semanticScene.relations) {
      for (const id of relation.memberEdgeIds) represented.set(id, relation.id);
    }
    return represented;
  }, [spatial, semanticScene.relations]);
  const hoverIncident = useMemo(() => {
    const ids = new Set<string>();
    if (!spatial && hover?.kind === 'node') for (const edge of semanticIndex.incidentEdges.get(hover.id) ?? []) {
      ids.add(edge.edgeId);
      const relation = residualRelationOfEdge.get(edge.edgeId);
      if (relation) ids.add(relation);
    }
    return ids;
  }, [spatial, hover?.id, hover?.kind, residualRelationOfEdge, semanticIndex]);
  const hoveredEndpoints = useMemo(() => {
    if (!spatial && hoveredPlanarRelationId) {
      const pair = semanticScene.relations.find(r => r.id === hoveredPlanarRelationId);
      if (pair) return new Set([pair.sourceSubgraphId, pair.targetSubgraphId]);
    }
    if (!spatial && hover?.kind === 'edge') {
      const edge = semanticIndex.edgesById.get(hover.id);
      if (edge) return new Set([edge.sourceNodeId, edge.targetNodeId]);
    }
    return new Set<string>();
  }, [spatial, hoveredPlanarRelationId, semanticScene.relations, hover?.id, hover?.kind, semanticIndex]);
  const readingNode = !spatial && !focus && !multiMode && selected?.kind === 'node' ? selected.id : undefined;
  const neighborhood = useMemo(() => {
    if (!readingNode) return;
    const incident = new Set<string>(), neighbors = new Set<string>();
    // Visible endpoints respect cross-edge filters, folded representatives and boundary stubs.
    for (const {edge,sourceBlockId,targetBlockId} of model.edges) {
      if (sourceBlockId !== readingNode && targetBlockId !== readingNode) continue;
      incident.add(edge.edgeId);
      const other: string | undefined = sourceBlockId === readingNode ? targetBlockId : sourceBlockId;
      if (other && other !== readingNode) neighbors.add(other);
    }
    return incident.size ? {incident,neighbors} : undefined;
  }, [readingNode,model.edges]);
  const blockIndex = useMemo(() => spatial ? null : indexCanvasObjects(model.blocks, b => b.id, b => b.rect), [spatial, model.blocks]);
  const edgeIndex = useMemo(() => spatial ? null : indexCanvasObjects(model.edges, e => e.edge.edgeId, e => routeBounds(e.route)), [spatial, model.edges]);
  const draggedId = gesture?.type === 'block' ? gesture.id : gesture?.type === 'link' ? gesture.edgeId : undefined;
  const snapId = gesture?.type === 'link' ? gesture.snap?.id : undefined;
  const retained = useMemo(() => {
    const ids = new Set(selectedIds);
    for (const id of [hover?.id, draggedId, snapId, editing.session?.target.id]) if (id) ids.add(id);
    return ids;
  }, [selectedIds, hover?.id, draggedId, snapId, editing.session?.target.id]);
  const mounted = {
    blocks: useMemo(() => blockIndex?.(viewportRect, 120, retained) ?? [], [blockIndex, viewportRect, retained]),
    edges: useMemo(() => edgeIndex?.(viewportRect, 120, retained) ?? [], [edgeIndex, viewportRect, retained]),
  };
  const readingScale = Math.max(1, 1 / view.zoom);
  const readingLabels = useMemo(() => {
    const labels = new Map<string, EdgeLabel>();
    if (!neighborhood || readingScale === 1) return labels;
    const occupied = new RectangleIndex(mounted.blocks.map(block => block.kind === 'node' ? block.rect : regionHeaderRect(block)));
    const toWorld = (x: number, y: number, width: number, height: number) => ({
      x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom, width: width / view.zoom, height: height / view.zoom,
    });
    const area = toWorld(insets.left + 8, 64, viewportSize.width - insets.left - insets.right - 16, visibleHeight - 72);
    for (const edge of mounted.edges) {
      if (edge.label && neighborhood.incident.has(edge.edge.edgeId))
        labels.set(edge.edge.edgeId, placeEdgeLabel(edge.route, edge.label.text, occupied, area, readingScale));
    }
    return labels;
  }, [neighborhood, readingScale, mounted.blocks, mounted.edges, view, insets.left, insets.right, viewportSize.width, visibleHeight]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const foreground = useCanvasForeground();
  const [otherTargets,setOtherTargets]=useState(0);
  const targetKey=aiTargetRefs.join('\0');
  const visibleTargets = useRef(targetKey); visibleTargets.current = targetKey;
  useLayoutEffect(()=>setOtherTargets(0),[targetKey,canvas.canvasId,playback?.cursor]);
  useLayoutEffect(()=>{
    if(!targetKey||!playback||gestureRef.current||editing.session||!foreground||settingsOpen||canvasInteractionBlocked())return;
    const explicit=playback.locate > (playback.consumedLocate ?? 0);
    if(!explicit&&(!presentationPart||presentationPart.seq===0||autoFocusHandled||pendingAutoFocus.current.has(presentationPart.id)
      ||presentationPaused&&playback.mode!=='review'))return;
    if(explicit){
      // An explicit location request can reveal a folded/filtered object without changing graph data.
      if(aiSelection.needsPartLocation || !aiSelection.explicitlyLocated){aiSelection.locate();return;}
      const ids=aiTargetRefs.flatMap(id=>{const edge=state.edges.find(e=>e.edgeId===id);return edge?[edge.sourceNodeId,edge.targetNodeId]:[id];});
      const needed=new Set<string>();for(const id of ids){if(!natural.membership.has(id))continue;needed.add(id);let parent=natural.parentOf.get(id);while(parent&&!needed.has(parent)){needed.add(parent);parent=natural.parentOf.get(parent);}}
      if([...needed].some(id=>!revealed.has(id))){
        changeGranularity(old=>revealObjects(semanticIndex,old,aiTargetRefs));
        setRevealed(old=>new Set([...old,...needed]));return;
      }
    }
    const blocks=model.blocks,byId=new Map(blocks.map(b=>[b.id,b]));
    const find=(id:string)=>{let block=natural.blocks.find(b=>b.id===id),seen=new Set<string>();
      while(block&&!byId.has(block.id)&&!seen.has(block.id)){seen.add(block.id);block=natural.blocks.find(b=>b.id===block!.parentId);}return block?byId.get(block.id):undefined;};
    const targets=aiTargetRefs.flatMap(id=>{const block=find(id);if(block)return [block];const edge=semanticIndex.edgesById.get(id);return edge?[find(edge.sourceNodeId),find(edge.targetNodeId)].filter((b):b is RenderBlock=>!!b):[];});
    if(!targets.length){setOtherTargets(0);return;}
    const first=targets[explicit?((playback!.locate-1)%targets.length):0].rect,near=targets.filter(b=>Math.hypot(b.rect.x-first.x,b.rect.y-first.y)*viewRef.current.zoom<Math.max(300,viewportSize.width-insets.left-insets.right));
    const x=Math.min(...near.map(b=>b.rect.x)),y=Math.min(...near.map(b=>b.rect.y)),right=Math.max(...near.map(b=>b.rect.x+b.rect.width)),bottom=Math.max(...near.map(b=>b.rect.y+b.rect.height));
    const applyLocation = () => {
      if (spatialRef.current) { focusInSpace(aiTargetRefs[explicit ? (playback!.locate - 1) % aiTargetRefs.length : 0]); return; }
      setOtherTargets(targets.length-near.length);
      const left=insets.left+36,top=68,width=Math.max(180,viewportSize.width-insets.left-insets.right-72),height=Math.max(150,viewportSize.height-composerBottomInset-100),v=viewRef.current;
      if(x*v.zoom+v.x>=left&&right*v.zoom+v.x<=left+width&&y*v.zoom+v.y>=top&&bottom*v.zoom+v.y<=top+height)return;
      const zoom=Math.min(v.zoom,Math.max(.55,Math.min(width/Math.max(1,right-x),height/Math.max(1,bottom-y))));
      const dx=x*zoom+v.x<left?left-x*zoom:right*zoom+v.x>left+width?left+width-right*zoom:v.x;
      const dy=y*zoom+v.y<top?top-y*zoom:bottom*zoom+v.y>top+height?top+height-bottom*zoom:v.y;
      updateView(()=>({zoom,x:dx,y:dy}));
    };
    if (explicit) {
      usePlaybackStore.getState().set(canvas.canvasId, { consumedLocate: playback.locate }); applyLocation(); return;
    }
    const partId = presentationPart!.id;
    pendingAutoFocus.current.add(partId);
    void useAiStore.getState().command<{ claimed: boolean }>('presentation.claimAutoFocus', { partId, canvasId: canvas.canvasId, sessionId: activeSessionId }, { reportError: false })
      .then(result => {
        const store = useAiStore.getState(), current = usePlaybackStore.getState().byCanvas[canvas.canvasId];
        if (!result.claimed || !alive.current || selectionContext.current.visit !== visit || visibleTargets.current !== targetKey || viewportCanvasId.current !== canvas.canvasId || store.view !== 'canvas'
          || store.activeSessionByCanvas[canvas.canvasId] !== activeSessionId || current?.taskId !== playback.taskId || current.cursor !== playback.cursor
          || current.cameraFollow === false || gestureRef.current || current.interactionBusy || canvasInteractionBlocked()
          || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        applyLocation();
      }).catch(() => { if (alive.current) setSelectionNotice('自动定位状态保存失败，可点击回复区的定位按钮查看对象'); })
      .finally(() => pendingAutoFocus.current.delete(partId));
  },[targetKey,canvas.canvasId,activeSessionId,presentationPart?.id,autoFocusHandled,foreground,settingsOpen,playback?.taskId,playback?.cursor,playback?.locate,playback?.consumedLocate,playback?.cameraFollow,playback?.mode,model.blocks,model.edges,presentationPaused,revealed,focus,aiSelection.needsPartLocation,aiSelection.explicitlyLocated,!!gesture,!!editing.session]);
  const fitPlanarView = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const rect = baseModel.bounds;
    const top = 70; const bottom = Math.max(top + 100, element.clientHeight - bottomInset - 16);
    const zoom = baseModel.blocks.length ? Math.max(.12, Math.min(1.5,
      (element.clientWidth - insets.left - insets.right - 48) / Math.max(rect.width, 1),
      (bottom - top - 32) / Math.max(rect.height, 1))) : 1;
    updateView(() => ({ x: (insets.left + element.clientWidth - insets.right) / 2 - (rect.x + rect.width / 2) * zoom,
      y: (top + bottom) / 2 - (rect.y + rect.height / 2) * zoom, zoom }));
  }, [baseModel, bottomInset, insets.left, insets.right, updateView]);
  useEffect(() => {
    let active = true;
    void editing.finish().then((saved) => {
      if (!active) return;
      setFocus(null); setNeighborhoodFocusId(null); setClickedSelection(emptySelection); setMenu(null); setRevealed(new Set()); setActiveView('2d'); setSpatialFocus(null); setSelectedRelationId(null); setGranularityPanel(null); setNewEdgeToReveal(null); incomingFrame.current = undefined;
      if (saved) { setSelected(null); setMultiMode(false); setMultiIds(new Set()); }
      updateGesture(null); clearHover(); popupRequest.current++; setPopup(null);
    });
    return () => { active = false; };
  }, [canvas.canvasId]);
  useEffect(() => {
    const exists = (id: string) => natural.membership.has(id) || state.edges.some((edge) => edge.edgeId === id && !edge.removed);
    setNeighborhoodFocusId(old => old && !exists(old) && !semanticIndex.groupIds.has(old) && !semanticIndex.relations.has(old) ? null : old);
    setSelected((old) => old && !exists(old.id) ? null : old);
    setPopup((old) => old && !exists(old.id) ? null : old);
    setMultiIds((old) => [...old].every(exists) ? old : new Set([...old].filter(exists)));
    setSelectedRelationId(old=>old && !semanticIndex.relations.has(old) ? null : old);
  }, [natural, state.edges, semanticIndex]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const ids = new Set(canvasDirectories(canvas).flatMap((dir) => dir.childIds).filter((id) => Boolean(state.documents[id])));
    const old = previousEntries.current; previousEntries.current = { canvasId: canvas.canvasId, ids };
    if (!old || old.canvasId !== canvas.canvasId) return;
    const added = [...ids].find((id) => !old.ids.has(id));
    if (!added) return;
    if (spatialRef.current) { focusInSpace(added); return; }
    setFocus(null); setSelected(null);
    const block = natural.blocks.find((item) => item.id === added); const element = viewport.current;
    if (!block || !element) return;
    updateView((current) => {
      const left = current.x + block.rect.x * current.zoom; const top = current.y + block.rect.y * current.zoom;
      if (left >= insets.left + 20 && left + block.rect.width * current.zoom <= element.clientWidth - insets.right - 20 && top >= 65 && top + block.rect.height * current.zoom <= element.clientHeight - bottomInset - 16) return current;
      return { ...current, x: (insets.left + element.clientWidth - insets.right) / 2 - (block.rect.x + block.rect.width / 2) * current.zoom,
        y: Math.max(100, (element.clientHeight - bottomInset) / 2) - (block.rect.y + block.rect.height / 2) * current.zoom };
    });
  }, [canvas, state.documents, natural, updateView, bottomInset]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || spatial) return;
    const onWheel = (event: WheelEvent) => {
      if (canvasInteractionBlocked()) return;
      if (!event.ctrlKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || (!element.contains(target) && !target.closest('[data-canvas-detail], [data-canvas-popup], [data-layout-organize-overlay]'))) return;
      event.preventDefault();
      if (gestureRef.current) return;
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-delta * 0.0015), true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || canvasInteractionBlocked(event.target, true)) return;
      if (event.key === 'Escape') { updateGesture(null); clearHover(); dismissPreview(); return; }
      if (event.ctrlKey && ['Minus', 'Equal', 'NumpadSubtract', 'NumpadAdd'].includes(event.code)) {
        event.preventDefault();
        stopCameraFollow(canvas.canvasId);
        if (!gestureRef.current) zoomAt({ x: (insets.left + element.clientWidth - insets.right) / 2, y: Math.max(100, (element.clientHeight - bottomInset) / 2) }, ['Minus', 'NumpadSubtract'].includes(event.code) ? 1 / 1.15 : 1.15);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || gestureRef.current || editable(event.target) || editable(document.activeElement)) return;
      if (event.key === 'Home' && !event.shiftKey) {
        const target = event.target;
        if (target instanceof Element && target !== document.body && target !== document.documentElement &&
          !element.contains(target) && !target.closest('[data-canvas-toolbar]')) return;
        event.preventDefault();
        stopCameraFollow(canvas.canvasId);
        fitPlanarView(); return;
      }
      const movement: Record<string, Point> = { a: { x: 42, y: 0 }, w: { x: 0, y: 42 }, s: { x: 0, y: -42 }, d: { x: -42, y: 0 } };
      const delta = movement[event.key.toLowerCase()];
      if (!delta) return;
      event.preventDefault(); stopCameraFollow(canvas.canvasId); updateView((old) => ({ ...old, x: old.x + delta.x, y: old.y + delta.y }));
    };
    const onBlur = () => { updateGesture(null); clearHover(); dismissPreview(); };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey); window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onBlur); };
  }, [spatial, zoomAt, updateView, insets.left, insets.right, bottomInset, fitPlanarView]);
  useEffect(() => () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  useEffect(() => {
    if (!hover || gesture || hoverTarget.current?.id !== hover.id || hoverTarget.current.kind !== hover.kind) return;
    const exists = hover.id === canvas.canvasId || (hover.kind === 'edge' ? model.edges.some((edge) => edge.edge.edgeId === hover.id)
      : hover.kind === 'node' ? natural.membership.has(hover.id) : model.blocks.some((block) => block.id === hover.id));
    if (!exists) { clearHover(); dismissPreview(); return; }
    const frame = requestAnimationFrame(() => {
      // Pointer events can change targets before React commits the next hover.
      // An older frame must not dismiss the preview opened by that event.
      if (hoverTarget.current?.id !== hover.id || hoverTarget.current.kind !== hover.kind) return;
      if (!pointer.current) return;
      const hit = document.elementFromPoint(pointer.current.x, pointer.current.y);
      if (hit?.closest('[data-canvas-detail], [data-canvas-popup]')) return;
      const item = hit?.closest('[data-hover-id]');
      let id = item?.getAttribute('data-hover-id') ?? (hit === viewport.current ? canvas.canvasId : null);
      if (spatial && hit?.closest('[data-granular-view]')) id = hit.closest('[data-space-object]')?.getAttribute('data-space-object') ?? canvas.canvasId;
      if (hit?.hasAttribute('data-edge-hit')) {
        const edge = model.edges.find(edge => edge.edge.edgeId === id);
        if (edge) id = nearestEdge(edge, worldPoint(pointer.current)).edge.edgeId;
      }
      if (id !== hover.id) { clearHover(); dismissPreview(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [view, model, gesture, spatial, hover?.kind, hover?.id]);

  const worldPoint = (client: Point): Point => {
    const rect = viewport.current!.getBoundingClientRect(); const current = viewRef.current;
    return { x: (client.x - rect.left - current.x) / current.zoom, y: (client.y - rect.top - current.y) / current.zoom };
  };
  // Detail positions are offsets in world coordinates from their graph object.
  // Only their position follows the world transform; size and typography stay fixed.
  const detailAnchor = (kind: Hover['kind'], id: string): Point => {
    if (kind === 'edge') {
      const edge = model.edges.find((item) => item.edge.edgeId === id) ?? natural.edges.find((item) => item.edge.edgeId === id);
      return edge ? pointOnRoute(edge.route, .5) : { x: 0, y: 0 };
    }
    return (model.blocks.find((item) => item.id === id) ?? natural.blocks.find((item) => item.id === id))?.anchor ?? { x: 0, y: 0 };
  };
  const attachDetail = (kind: Hover['kind'], id: string, screen: Point, transform = view, edgeAnchor?: Point): Point => {
    const anchor = edgeAnchor ?? detailAnchor(kind, id);
    return { x: (screen.x - transform.x) / transform.zoom - anchor.x, y: (screen.y - transform.y) / transform.zoom - anchor.y };
  };
  const panelPosition = (item: Hover): Point => {
    const anchor = item.edgeAnchor ?? detailAnchor(item.kind, item.id);
    return { x: view.x + (anchor.x + item.position.x) * view.zoom, y: view.y + (anchor.y + item.position.y) * view.zoom };
  };
  // A route can change while its detail controls are being used. Snapshot the
  // edge anchor when opening; keep fields still as endpoints/direction change.
  const detailGeometryKey = JSON.stringify([...new Map([selected, hover, popup].filter((item): item is Hover => Boolean(item))
    .map(item => [`${item.kind}:${item.id}`, item] as const)).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.kind, item.id, item.edgeAnchor ?? detailAnchor(item.kind, item.id)]));
  useEffect(() => {
    const width = Math.min(detailSize.width, Math.max(230, viewportSize.width - 16));
    // Correct only after graph geometry or available space changes. Ordinary pan
    // and zoom still preserve the existing world-relative attachment behavior.
    const keepReachable = (item: Hover | null): Hover | null => {
      if (!item) return item;
      const limit = item.manual ? viewportSize.height : visibleHeight;
      const height = Math.min(detailSize.height, Math.max(150, limit - 16));
      const point = panelPosition(item);
      const bounded = { x: Math.max(8, Math.min(viewportSize.width - width - 8, point.x)), y: Math.max(8, Math.min(limit - height - 8, point.y)) };
      return point.x === bounded.x && point.y === bounded.y ? item : { ...item, position: attachDetail(item.kind, item.id, bounded, view, item.edgeAnchor) };
    };
    setSelected(keepReachable); setHover(keepReachable); setPopup(keepReachable);
  }, [detailGeometryKey, bottomInset, viewportSize.width, viewportSize.height, detailSize.width, detailSize.height]);
  const detailPosition = (_kind: Hover['kind'], _id: string, cursor: Point): Point => {
    const left = spatial ? insets.left + 8 : 8, right = viewportSize.width - (spatial ? insets.right + 8 : 8);
    const top = spatial ? 64 : 8;
    const width = Math.min(detailSize.width, Math.max(230, right-left));
    const height = Math.min(detailSize.height, Math.max(150, visibleHeight-top-8));
    const x = cursor.x + 16 + width <= right ? cursor.x + 16 : cursor.x - width - 16;
    const y = cursor.y + 16 + height <= visibleHeight - 8 ? cursor.y + 16 : cursor.y - height - 16;
    return { x: Math.max(left, Math.min(right-width, x)),
      y: Math.max(top, Math.min(visibleHeight - height - 8, y)) };
  };
  const openDetail = async (kind: Hover['kind'], id: string, cursor: Point, pinned = false) => {
    clearDismiss();
    // Hover previews never replace a pinned inspector. Alt-click can replace it
    // or pin the current preview in place, without moving its fields.
    if (!pinned && popup?.pinned) return;
    if (popup?.kind === kind && popup.id === id) {
      if (pinned) { popupRequest.current++; setPopup(old => old && { ...old, pinned: true }); }
      return;
    }
    const request = ++popupRequest.current;
    const preview = previewRequest.current;
    if (editing.session?.target.id !== id && !await editing.finish()) return;
    if (request !== popupRequest.current || (!pinned && preview !== previewRequest.current)) return;
    const edgeAnchor = kind === 'edge' ? detailAnchor(kind, id) : undefined;
    setPopup({ kind, id, pinned, edgeAnchor, position: attachDetail(kind, id, detailPosition(kind, id, cursor), view, edgeAnchor) });
  };
  const showHover = (kind: Hover['kind'], id: string, event: ReactPointerEvent, _block?: RenderBlock) => {
    if (gestureRef.current) return;
    setHoveredPlanarRelationId(null);
    hoverTarget.current = { kind, id };
    clearDismiss(); pointer.current = { x: event.clientX, y: event.clientY };
    if (!event.altKey) dismissPreview();
    setHover((old) => {
      const cursor = { x: event.clientX, y: event.clientY };
      if (old?.kind === kind && old.id === id) return old;
      const edgeAnchor = kind === 'edge' ? detailAnchor(kind, id) : undefined;
      return { kind, id, edgeAnchor, position: attachDetail(kind, id, detailPosition(kind, id, cursor), view, edgeAnchor) };
    });
    if (event.altKey) void openDetail(kind, id, { x: event.clientX, y: event.clientY });
    if (kind !== 'edge') clearEnd();
  };
  const spatialKind = (id: string): Hover['kind'] | null => {
    if (state.nodes[id]) return 'node';
    if (id === canvas.canvasId || model.parentOf.has(id)) return 'record';
    return semanticIndex.edgesById.has(id) ? 'edge' : null;
  };
  useEffect(() => {
    const altPreview = (event: KeyboardEvent) => {
      if (canvasInteractionBlocked(event.target, true)) return;
      if (event.key !== 'Alt' || event.repeat || gestureRef.current || !pointer.current || editable(document.activeElement)) return;
      const hit = document.elementFromPoint(pointer.current.x, pointer.current.y);
      if (!hit || !viewport.current?.contains(hit)) return;
      const target = hit.closest('[data-hover-id]');
      if (spatial) {
        if (!hit.closest('[data-granular-view]')) return;
        const id = hit.closest('[data-space-object]')?.getAttribute('data-space-object') ?? canvas.canvasId;
        const kind = spatialKind(id);
        if (kind) { event.preventDefault(); void openDetail(kind, id, pointer.current); }
        return;
      }
      if (!target && hit.closest('[data-canvas-interactive]')) return;
      event.preventDefault();
      const kind = (target?.getAttribute('data-hover-kind') ?? 'record') as Hover['kind'];
      const id = target?.getAttribute('data-hover-id') ?? canvas.canvasId;
      void openDetail(kind, id, pointer.current);
    };
    const altRelease = (event: KeyboardEvent) => { if (event.key === 'Alt') dismissPreview(); };
    window.addEventListener('keydown', altPreview);
    window.addEventListener('keyup', altRelease);
    return () => { window.removeEventListener('keydown', altPreview); window.removeEventListener('keyup', altRelease); };
  });
  useEffect(() => { clearEnd(); }, [canvas.canvasId, view.x, view.y, view.zoom, state]);
  const selectItem = async (kind: Hover['kind'], id: string, cursor?: Point, force = false, clicked = false): Promise<boolean> => {
    if (multiMode && !force) return false;
    if (editing.session?.target.id !== id && !await editing.finish()) return false;
    if (clicked) setNeighborhoodFocusId(id);
    setClickedSelection(clicked ? new Set([id]) : emptySelection);
    setSelectedRelationId(null);
    popupRequest.current++;
    setPopup(old => old?.kind === kind && old.id === id ? old : null);
    if (force) { setMultiMode(false); setMultiIds(new Set()); }
    const block = model.blocks.find((item) => item.id === id);
    const point = cursor ?? pointer.current ?? (block ? { x: view.x + (block.rect.x + block.rect.width / 2) * view.zoom, y: view.y + (block.rect.y + block.rect.height / 2) * view.zoom } : visibleCenter());
    setSelected((old) => old?.kind === kind && old.id === id && !cursor ? old : { kind, id,
      edgeAnchor: kind === 'edge' ? detailAnchor(kind, id) : undefined, position: attachDetail(kind, id, detailPosition(kind, id, point)) });
    return true;
  };
  const activateDetail = async (item: Hover): Promise<boolean> => {
    clearDismiss();
    popupRequest.current++;
    setPopup(old => old?.id === item.id && old.kind === item.kind ? { ...old, pinned: true } : old);
    if (multiMode) return false;
    if (editing.session && editing.session.target.id !== item.id && !await editing.finish()) return false;
    // Promote a hover panel in place. Starting an editor is not a new canvas click.
    if (selected?.id !== item.id) setClickedSelection(emptySelection);
    setSelectedRelationId(null);
    setSelected(old => old?.id === item.id && old.kind === item.kind ? old : { ...item });
    return true;
  };
  const updateMultiSelection = async (kind: Hover['kind'], id: string) => {
    if (!await editing.finish()) return false;
    setSelectedRelationId(null);
    popupRequest.current++;
    setPopup(old => old?.kind === kind && old.id === id ? old : null);
    const removeAi = focus?.mode === 'selected' && aiSelection.explicitlyLocated && aiTargets.has(id);
    if (removeAi) aiSelection.dismiss(id);
    setClickedSelection(old => {
      const next = new Set([...old].filter(key => selectedIds.has(key)));
      if (removeAi || selectedIds.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(null); setMultiMode(true);
    setMultiIds(old => {
      const next = new Set(multiMode ? old : selected ? [selected.id] : []);
      if (removeAi || next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    return true;
  };
  const clickItem = async (kind: Hover['kind'], id: string, cursor?: Point, altKey = false): Promise<boolean> => {
    if (multiMode) {
      if (!await editing.finish()) return false;
      setNeighborhoodFocusId(id);
      popupRequest.current++;
      setPopup(old => old?.kind === kind && old.id === id ? old : null);
      if (selectedIds.has(id)) setClickedSelection(old => new Set([...old, id]));
    } else if (!await selectItem(kind, id, cursor, false, true)) return false;
    if (altKey && cursor) await openDetail(kind, id, cursor, true);
    return !multiMode;
  };
  const selectByPointer = async (kind: Hover['kind'], id: string, ctrlKey = false): Promise<boolean> => {
    if (ctrlKey) { await updateMultiSelection(kind, id); return false; }
    return clickItem(kind, id);
  };
  const capture = (event: ReactPointerEvent, next: Gesture) => {
    event.preventDefault(); event.stopPropagation();
    if (next.type !== 'edgePress') clearHover();
    viewport.current?.setPointerCapture(event.pointerId); updateGesture(next);
  };
  const backgroundDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-canvas-interactive]'))) return;
    const regionId = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-region-id]')?.dataset.regionId : undefined;
    capture(event, { type: 'pan', regionId, pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startView: viewRef.current });
  };
  const blockGesture = (block: RenderBlock, pointerId: number, startClient: Point): Extract<Gesture, { type: 'block' }> | null => {
    const parent = model.blocks.find(b => b.id === block.parentId);
    if (!parent && block.parentId !== canvas.canvasId) return null;
    // The rendered anchor includes presentation adjustments and legacy implicit placements.
    const origin = parent ? regionContentOrigin(parent) : { x: 0, y: 0 };
    const pos = { x: block.anchor.x - origin.x, y: block.anchor.y - origin.y };
    return { type: 'block', kind: block.kind === 'node' ? 'node' : 'record', pointerId, id: block.id,
      parentId: block.parentId, startClient, startLocal: pos, zoom: view.zoom, offset: { x: 0, y: 0 } };
  };
  const blockDown = (event: ReactPointerEvent, block: RenderBlock) => {
    if (event.button !== 0) return;
    if (event.ctrlKey) { event.preventDefault(); event.stopPropagation(); selectByPointer(block.kind === 'node' ? 'node' : 'record', block.id, true); return; }
    const next = blockGesture(block, event.pointerId, { x: event.clientX, y: event.clientY });
    if (next) capture(event, next);
  };
  const startEdge = (event: ReactPointerEvent, block: RenderBlock, side?: ConnectionSide) => {
    if (event.button !== 0 && event.button !== 2) return;
    if (event.ctrlKey && event.button === 0) { event.preventDefault(); event.stopPropagation(); selectByPointer('node', block.id, true); return; }
    suppressContextUntil.current = Date.now() + 1000;
    // Which side an edge leaves from is the layout's decision, not the user's:
    // it follows the direction the gesture starts heading in.
    const startSide = side ?? facingSide(block.rect, worldPoint({ x: event.clientX, y: event.clientY }));
    const fixed = portPoint(block.rect, startSide);
    capture(event, { type: 'link', pointerId: event.pointerId, sourceId: block.id, sourceSide: startSide,
      otherId: block.id, fixed, fixedSide: startSide, point: fixed, snap: null, directed: (event.buttons & 3) === 3, hasLeft: Boolean(event.buttons & 1) });
  };
  const closestEnd = (rendered: RenderEdge, point: Point): 'source' | 'target' | null => {
    const candidates = (['source', 'target'] as const).filter((end) => {
      const id = end === 'source' ? rendered.edge.sourceNodeId : rendered.edge.targetNodeId;
      return Boolean(state.nodes[id]) && id === (end === 'source' ? rendered.sourceBlockId : rendered.targetBlockId);
    }).map((end) => ({ end, distance: Math.hypot(rendered[end].x - point.x, rendered[end].y - point.y) * view.zoom })).sort((a, b) => a.distance - b.distance);
    return candidates[0]?.distance < 80 ? candidates[0].end : null;
  };
  const edgeMove = (event: ReactPointerEvent, hit: RenderEdge) => {
    if (gestureRef.current) return;
    const point = worldPoint({ x: event.clientX, y: event.clientY });
    const rendered = event.target instanceof Element && event.target.hasAttribute('data-edge-hit') ? nearestEdge(hit, point) : hit;
    const end = rendered.edge.membershipFor || rendered.aggregateEdgeIds?.length ? null : closestEnd(rendered, point);
    showHover('edge', rendered.edge.edgeId, event);
    if (!end) { clearEnd(); return; }
    const candidate = { edgeId: rendered.edge.edgeId, end };
    if (endCandidate.current?.edgeId === candidate.edgeId && endCandidate.current.end === candidate.end) return;
    clearEnd(); endCandidate.current = candidate;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      if (gestureRef.current || endCandidate.current !== candidate) return;
      readyEnd.current = candidate; setNearEnd(candidate);
    }, 300);
  };
  /** Hit bands are 14px wide and overlap freely, so the element that receives
   *  the pointer is whichever band was painted last. Resolve by distance: among
   *  the bands under the cursor, the nearest drawn line wins, which is the line
   *  the user aimed at. Convert the screen-space hit width to world units. */
  const nearestEdge = (rendered: RenderEdge, world: Point): RenderEdge => {
    const zoom = viewRef.current.zoom;
    const candidates = edgeIndex?.({ ...world, width: 0, height: 0 }, 7 / zoom);
    if (!candidates || candidates.length < 2) return rendered;
    let best = rendered, bestDistance = distanceToRoute(rendered.route, world);
    for (const other of candidates) {
      if (other.edge.edgeId === rendered.edge.edgeId || other.kind !== rendered.kind) continue;
      const distance = distanceToRoute(other.route, world);
      if (distance < bestDistance - .5 / zoom) { best = other; bestDistance = distance; }
    }
    return best;
  };
  const chooseGroupedEdge = (ids: readonly string[], position: Point, toggle: boolean, details = false) => {
    const byId = new Map(state.edges.map(edge => [edge.edgeId, edge]));
    const items = ids.flatMap(id => {
      const edge = byId.get(id);
      if (!edge || edge.removed) return [];
      return [{ key: id, label: <><GraphNameLabel id={edge.sourceNodeId} name={endpointName(edge.sourceNodeId)} />
        {edge.directed ? ' → ' : ' — '}<GraphNameLabel id={edge.targetNodeId} name={endpointName(edge.targetNodeId)} />
        {edge.edgeContent && ` · ${edge.edgeContent.slice(0, 35)}`}</>,
        run: () => { if (toggle) void selectByPointer('edge', id, true); else void clickItem('edge', id, position, details); } }];
    });
    if (items.length) setMenu({ position, items });
  };
  const edgeDown = (event: ReactPointerEvent, hit: RenderEdge) => {
    // Only a press on a hit band is ambiguous, so only that press is resolved by
    // distance. A press on the label or the endpoint dot already names its
    // relation and must not be stolen by a closer curve.
    const onBand = event.target instanceof Element && event.target.hasAttribute('data-edge-hit');
    const rendered = onBand ? nearestEdge(hit, worldPoint({ x: event.clientX, y: event.clientY })) : hit;
    if (event.button !== 0) return;
    if (rendered.aggregateEdgeIds?.length) {
      event.preventDefault(); event.stopPropagation();
      chooseGroupedEdge(rendered.aggregateEdgeIds, { x: event.clientX, y: event.clientY }, event.ctrlKey, event.altKey); return;
    }
    if (event.ctrlKey) { event.preventDefault(); event.stopPropagation(); selectByPointer('edge', rendered.edge.edgeId, true); return; }
    const end = rendered.edge.membershipFor ? null : closestEnd(rendered, worldPoint({ x: event.clientX, y: event.clientY }));
    const ready = Boolean(end && readyEnd.current?.edgeId === rendered.edge.edgeId && readyEnd.current.end === end);
    capture(event, { type: 'edgePress', pointerId: event.pointerId, edgeId: rendered.edge.edgeId, end,
      startClient: { x: event.clientX, y: event.clientY }, cancelled: false, ready });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointer.current = { x: event.clientX, y: event.clientY };
    const current = gestureRef.current;
    if (!current) {
      if (event.target instanceof Element) {
        const region = event.target.closest<HTMLElement>('[data-region-id]');
        if (region) showHover('record', region.dataset.regionId!, event);
        else if (!event.target.closest('[data-canvas-interactive]')) showHover('record', canvas.canvasId, event);
      }
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (current.type === 'pan') { updateView(() => ({ ...current.startView, x: current.startView.x + event.clientX - current.startClient.x, y: current.startView.y + event.clientY - current.startClient.y }), true); }
    else if (current.type === 'block') updateGesture({ ...current, offset: { x: (event.clientX - current.startClient.x) / current.zoom, y: (event.clientY - current.startClient.y) / current.zoom } }, true);
    else if (current.type === 'edgePress') {
      if (Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y) <= 6) return;
      const rendered = model.edges.find(edge => edge.edge.edgeId === current.edgeId);
      if (!current.cancelled && current.ready && current.end && rendered) {
        const opposite = current.end === 'source' ? 'target' : 'source';
        const point = worldPoint({ x: event.clientX, y: event.clientY });
        clearHover();
        updateGesture({ type: 'link', pointerId: current.pointerId, edgeId: current.edgeId, end: current.end,
          otherId: opposite === 'source' ? rendered.edge.sourceNodeId : rendered.edge.targetNodeId,
          fixed: rendered[opposite], fixedSide: opposite === 'source' ? rendered.sourceSide : rendered.targetSide,
          point, snap: nearestPort(model.blocks.filter(block => block.kind === 'node'), point, view.zoom,
            opposite === 'source' ? rendered.edge.sourceNodeId : rendered.edge.targetNodeId), directed: rendered.edge.directed, hasLeft: true });
      } else updateGesture({ ...current, cancelled: true });
    } else {
      const point = worldPoint({ x: event.clientX, y: event.clientY });
      updateGesture({ ...current, point, snap: nearestPort(model.blocks.filter((block) => block.kind === 'node'), point, view.zoom, current.otherId),
        directed: current.directed || (event.buttons & 3) === 3, hasLeft: current.hasLeft || Boolean(event.buttons & 1) }, true);
      if (event.buttons & 2) suppressContextUntil.current = Date.now() + 1000;
    }
  };
  const commitBlockMove = async (drag: Extract<Gesture, { type: 'block' }>, delta: Point) => {
    const move: PendingMove = { token: ++moveSequence.current, canvasId: canvas.canvasId, id: drag.id, parentId: drag.parentId,
      point: { x: drag.startLocal.x + delta.x, y: drag.startLocal.y + delta.y } };
    // Keep the dropped position visible until its acknowledged graph revision arrives.
    setPendingMoves(old => [...old, move]);
    try {
      const result = await onMoveBlock(move.id, move.parentId, move.point);
      if (result?.ok) changeGranularity(old => withoutPlanarOffsets(old, [move.id]));
      setPendingMoves(old => result?.ok ? old.map(item => item.token === move.token ? { ...item, committedRevision: result.graphRevision } : item)
        : old.filter(item => item.token !== move.token));
    } catch { setPendingMoves(old => old.filter(item => item.token !== move.token)); }
  };
  const commitReconnect = async (edgeId: string, end: 'source' | 'target', nodeId: string, cursor?: Point) => {
    const change: PendingReconnect = { token: ++moveSequence.current, canvasId: canvas.canvasId, edgeId, end, nodeId };
    setPendingReconnects(old => [...old, change]);
    void selectItem('edge', edgeId, cursor);
    try {
      const result = await onReconnectEdge(edgeId, end, nodeId);
      if(result?.ok)setNewEdgeToReveal(edgeId);
      setPendingReconnects(old => result?.ok ? old.map(item => item.token === change.token ? { ...item, committedRevision: result.graphRevision } : item)
        : old.filter(item => item.token !== change.token));
    } catch { setPendingReconnects(old => old.filter(item => item.token !== change.token)); }
  };
  const clickBackground = async (ctrl: boolean, cursor?: Point, detailId?: string) => {
    if (!await editing.finish()) return;
    setGranularityPanel(null);
    popupRequest.current++;
    if (detailId && cursor) await openDetail('record', detailId, cursor, true);
    else setPopup(null);
    if (multiMode && !ctrl) return;
    setSelectedRelationId(null);
    setClickedSelection(emptySelection);
    setSelected(null); setMultiMode(false); setMultiIds(new Set()); setRevealed(new Set());
    if (!multiMode) setNeighborhoodFocusId(null);
    if (!multiMode || focus?.mode !== 'neighbors') setFocus(null);
  };
  const onPointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); stopHold();
    const cursor = { x: event.clientX, y: event.clientY };
    updateGesture(null);
    if (viewport.current?.hasPointerCapture(event.pointerId)) viewport.current.releasePointerCapture(event.pointerId);
    if (current.type === 'block') {
      const dx = (event.clientX - current.startClient.x) / current.zoom; const dy = (event.clientY - current.startClient.y) / current.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        await commitBlockMove(current, { x: dx, y: dy });
      }
      else void clickItem(current.kind, current.id, cursor, event.altKey);
    } else if (current.type === 'edgePress') {
      if (!current.cancelled) void clickItem('edge', current.edgeId, cursor, event.altKey);
    } else if (current.type === 'link' && current.hasLeft) {
      const snap = nearestPort(model.blocks.filter((block) => block.kind === 'node'), worldPoint({ x: event.clientX, y: event.clientY }), view.zoom, current.otherId);
      if (snap) {
        if (current.edgeId && current.end) {
          await commitReconnect(current.edgeId, current.end, snap.id, cursor);
        }
        else if (current.sourceId && current.sourceSide) {
          try {
            const id = await onCreateEdge({ sourceNodeId: current.sourceId, targetNodeId: snap.id, directed: current.directed });
            if (id) { setNewEdgeToReveal(id); await selectItem('edge', id, cursor, true); }
          } catch { /* The mutation owner exposes errors; no edge is selected before a commit. */ }
        }
      }
    } else if (current.type === 'pan' && Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y) < 3) {
      await clickBackground(event.ctrlKey, cursor, event.altKey ? current.regionId ?? canvas.canvasId : undefined);
    }
  };
  const navigateTo = async (id: string, forceSelect = false, showDetails = false, clicked = false) => {
    if (id === canvas.canvasId) { if (spatial) focusInSpace(id); else fitPlanarView(); return; }
    const block = natural.blocks.find((item) => item.id === id);
    const edge = !block ? state.edges.find(item => item.edgeId === id && !item.removed) : undefined;
    const endpoints = edge ? [edge.sourceNodeId, edge.targetNodeId].map(ref => natural.blocks.find(item => item.id === ref)).filter((item): item is RenderBlock => !!item) : [];
    if (!block && !endpoints.length) return;
    if (!await editing.finish()) return;
    setSelectedRelationId(null);
    changeGranularity(old=>revealObjects(semanticIndex,old,[id]));
    popupRequest.current++;
    setPopup(old => old?.id === id ? old : null);
    clearHover();
    if (!forceSelect && !focusRequest?.forceSelect) setFocus(null);
    const targets = block ? [block] : endpoints;
    const ancestors = new Set<string>();
    for (const target of targets) { ancestors.add(target.id); let parent = natural.parentOf.get(target.id);
      while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = natural.parentOf.get(parent); } }
    setRevealed(ancestors);
    const center = visibleCenter();
    const kind = edge ? 'edge' : block!.kind === 'node' ? 'node' : 'record';
    const changingNeighbor = clicked && activeNeighbor && activeNeighbor !== id && forceSelect;
    if (!changingNeighbor) {
      if (spatial) focusInSpace(id);
      else setPlanarLocation({ canvasId: canvas.canvasId, blockIds: targets.map(target => target.id),
        select: !multiMode || forceSelect && !clicked ? { kind, id, details: showDetails } : undefined });
    }
    if (clicked) setNeighborhoodFocusId(id);
    if (!multiMode || forceSelect && !clicked) {
      setClickedSelection(clicked ? new Set([id]) : emptySelection);
      if (forceSelect) { setMultiMode(false); setMultiIds(new Set()); }
      const screen = detailPosition(kind, id, center);
      const item: Hover = { kind, id, position: attachDetail(kind, id, screen) };
      setSelected(item);
      if(showDetails)setPopup({...item,pinned:true});
    }
  };
  useEffect(() => { if (focusRequest) navigateTo(focusRequest.id, focusRequest.forceSelect); }, [focusRequest?.sequence]);
  useEffect(() => {
    if (!selectionRequest || selectionRequest.canvasId !== canvas.canvasId) return;
    let cancelled = false;
    void editing.finish().then(saved => {
      if (cancelled || useAiStore.getState().canvasSelectionRequest?.sequence !== selectionRequest.sequence) return;
      useAiStore.setState({ canvasSelectionRequest: null });
      if (!saved) { setSelectionNotice('请先保存当前编辑，再定位引用对象'); return; }
      const latest = selectionContext.current;
      if (latest.activeSessionId !== selectionRequest.sessionId || (selectionRequest.partId &&
        (latest.visit !== visit || latest.visit.partId !== selectionRequest.partId))) return;
      const { state, natural } = latest;
      const resolved = resolvePresentationTargets(state, canvas.canvasId, selectionRequest.refs);
      const refs = resolved.available;
      const restoreDuringNeighborhood = selectionRequest.source !== 'ai' && focus?.mode === 'neighbors';
      if (!restoreDuringNeighborhood) changeGranularity(old=>revealObjects(semanticIndex,old,refs));
      if (resolved.notice) setSelectionNotice(selectionRequest.source === 'ai' ? resolved.notice : resolved.notice.replaceAll('本段', '本组').replaceAll('指定', '引用'));
      popupRequest.current++; setPopup(null); clearHover();
      if (selectionRequest.source === 'ai') {
        aiSelection.locate(refs, latest.visit.key);
      } else {
        setClickedSelection(emptySelection);
        if (!restoreDuringNeighborhood) setFocus(null);
        setSelected(null); setSelectedRelationId(null);
        setMultiMode(refs.length > 0); setMultiIds(new Set(refs));
      }
      usePlaybackStore.getState().set(canvas.canvasId, { cameraFollow: false });
      if (restoreDuringNeighborhood) return;
      const targets = refs.flatMap(id => {
        const block = natural.blocks.find(b => b.id === id); if (block) return [block];
        const edge = state.edges.find(e => e.edgeId === id && !e.removed);
        return edge ? [edge.sourceNodeId, edge.targetNodeId].flatMap(ref => natural.blocks.find(b => b.id === ref) ?? []) : [];
      });
      const ancestors = new Set<string>();
      for (const target of targets) {
        ancestors.add(target.id); let parent = natural.parentOf.get(target.id);
        while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = natural.parentOf.get(parent); }
      }
      setRevealed(ancestors);
      if (targets.length && spatialRef.current) focusInSpace(refs[0]);
      else if (targets.length) setPlanarLocation({ canvasId: canvas.canvasId, blockIds: targets.map(b => b.id) });
    });
    return () => { cancelled = true; };
  }, [selectionRequest?.sequence, canvas.canvasId]);
  // Focus after disclosure so search and reference navigation use the final
  // positions of groups displaced by an expansion.
  useLayoutEffect(() => {
    if (!planarLocation) return;
    setPlanarLocation(null);
    if (spatial || planarLocation.canvasId !== canvas.canvasId) return;
    const ids = new Set(planarLocation.blockIds);
    const rects = baseModel.blocks.filter(b => ids.has(b.id)).map(b => b.rect);
    if (!rects.length) return;
    const width = Math.max(100, viewportSize.width - insets.left - insets.right - 80);
    const height = Math.max(100, visibleHeight - 120);
    const center = visibleCenter();
    const fitted = searchFocusView(rects, { x: center.x - width / 2, y: center.y - height / 2, width, height }, viewRef.current.zoom);
    updateView(() => fitted.view);
    if (planarLocation.select) {
      const { kind, id, details } = planarLocation.select;
      const edgeAnchor = kind === 'edge' ? fitted.anchor : undefined;
      const item = { kind, id, edgeAnchor, position: attachDetail(kind, id, detailPosition(kind, id, center), fitted.view, edgeAnchor) };
      setSelected(item);
      if (details) setPopup({ ...item, pinned: true });
    }
  }, [planarLocation, baseModel]);
  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('[data-canvas-detail], [data-canvas-popup], [data-graph-dialog], [data-graph-menu], [data-granularity-panel]') || editable(target)) return;
    event.preventDefault();
    if (Date.now() < suppressContextUntil.current || gestureRef.current?.type === 'link' || target.closest('[data-port-node]')) return;
    const point = worldPoint({ x: event.clientX, y: event.clientY });
    const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
    const hitEdge = target.closest('[data-edge-id]')?.getAttribute('data-edge-id');
    const hitBand = hitEdge && target.hasAttribute('data-edge-hit') ? model.edges.find(edge => edge.edge.edgeId === hitEdge) : undefined;
    const edgeId = hitBand ? nearestEdge(hitBand, point).edge.edgeId : hitEdge;
    const frameId = target.closest('[data-region-id]')?.getAttribute('data-region-id');
    const region = model.blocks.find(block => block.id === frameId) ?? model.blocks.filter((block) => block.kind !== 'node' && point.x >= block.rect.x && point.x <= block.rect.x + block.rect.width &&
      point.y >= block.rect.y && point.y <= block.rect.y + block.rect.height).sort((a, b) => b.depth - a.depth)[0];
    void showGraphMenu({ x: event.clientX, y: event.clientY }, point, nodeId, edgeId, region);
  };
  const showGraphMenu = async (menuPosition: Point, point: Point | undefined, nodeId?: string | null, edgeId?: string | null, region?: RenderBlock) => {
    const parentId = nodeId ? model.blocks.find(block => block.id === nodeId)?.parentId ?? canvas.canvasId : region?.id ?? canvas.canvasId;
    const pointForParent = (id: string) => {
      if (!point || spatial || id === canvas.canvasId) return point;
      const displayed = model.blocks.find(block => block.id === id);
      const canonical = natural.blocks.find(block => block.id === id);
      return displayed && canonical ? canonicalRegionPoint(point, displayed, canonical) : point;
    };
    if (!await editing.finish()) return;
    const action = (request: Omit<GraphActionRequest, 'origin'>) => () => onAction({ ...request, origin: 'canvas' });
    const pair = edgeId && semanticScene.edges.some(edge => edge.edgeId === edgeId)
      ? semanticIndex.relationOfEdge.get(edgeId) : undefined;
    const items: GraphMenuItem[] = [
      ...(pair ? [{ key: 'collapseEdgeGroup', label: '收起同一组的跨子图边', run: () => collapseRelation(pair) }] : []),
      ...(region && region.id !== canvas.canvasId && !edgeId && !nodeId ? [{
        key: 'foldGroup', label: semanticScene.collapsedGroupIds.has(region.id) ? '展开子图' : '收起子图', run: () => toggleGroup(region.id),
      }] : []),
      { key: 'localGranularity', label: '调整显示粒度…  G', run: () => inspectGranularity(edgeId??nodeId??region?.id) },
      { key: 'createNode', label: '创建节点', run: action({ type: 'createNode', parentId, pointForParent }) },
      { key: 'createEdge', label: '创建边', run: action({ type: 'createEdge', sourceId: nodeId ?? undefined }) },
      { key: 'createSubgraph', label: '创建子图', run: action({ type: 'createSubgraph', parentId, pointForParent }) },
    ];
    const refs = multiMode ? [...multiIds] : selected ? [selected.id] : [];
    if (refs.length) {
      const store = useAiStore.getState();
      const session = store.snapshot?.sessions.find(s => s.id === store.activeSessionByCanvas[canvas.canvasId]);
      const canAdd = !canvas.isDraft && session?.lifecycle === 'active' && session.canvasId === canvas.canvasId && session.mode !== 'temporary';
      items.unshift({ key: 'addToSession', label: canAdd ? '将选中对象添加到当前会话' : '将选中对象添加到当前会话（请先进入可用会话）', disabled: !canAdd,
        run: () => {
          const current = useAiStore.getState(), currentSession = current.snapshot?.sessions.find(s => s.id === current.activeSessionByCanvas[canvas.canvasId]);
          if (!currentSession || currentSession.id !== session?.id || currentSession.lifecycle !== 'active') { setSelectionNotice('当前会话已变化，请重新选择添加'); return; }
          const available = resolvePresentationTargets(current.snapshot?.graph, canvas.canvasId, refs).available;
          if (!available.length) { setSelectionNotice('选中的对象已不在当前画布中'); return; }
          current.addInputGroup(currentSession.id, available);
          setSelected(null); setMultiIds(new Set()); setMultiMode(false); setFocus(old => old?.mode === 'neighbors' ? old : null); setPopup(null); clearHover();
        } });
    }
    if (onCreateTemporary) items.push({ key: 'createTemporary', label: canvas.isDraft ? '创建极简临时会话' : '创建临时会话', run: () => onCreateTemporary(menuPosition) });
    if (onOrganize) items.push({ key: 'organize', label: '整理此目录…', run: () => onOrganize(region?.id ?? parentId) });
    const selectedNodes = [...multiIds].filter((id) => Boolean(state.nodes[id]));
    if (multiMode && selectedNodes.length) items.push(
      { key: 'group', label: '根据选中节点创建子图', run: action({ type: 'group', ids: selectedNodes }) },
      { key: 'move', label: '将选中节点移动到…', run: action({ type: 'move', ids: selectedNodes }) });
    if (nodeId && state.nodes[nodeId]?.design) items.push({ key: 'editDesign', label: '编辑设计信息', run: action({ type: 'editDesign', id: nodeId }) });
    if (nodeId) items.push({ key: 'deleteNode', label: '删除节点', danger: true, run: action({ type: 'deleteNode', id: nodeId }) });
    else if (edgeId) { const membership = state.edges.find(edge => edge.edgeId === edgeId)?.membershipFor;
      items.push(membership ? { key: 'editDesign', label: '编辑组合成员', run: action({ type: 'editDesign', id: membership }) } : { key: 'deleteEdge', label: '删除边', danger: true, run: action({ type: 'deleteEdge', id: edgeId }) }); }
    else if (region && (canvasDirectory(canvas, region.id) || state.documents[region.id]?.kind === 'subgraph')) items.push({ key: 'deleteSubgraph', label: '删除子图…', danger: true, run: action({ type: 'deleteSubgraph', id: region.id }) });
    clearHover(); setMenu({ position: menuPosition, items });
  };
  const activateFocus = (mode: Focus['mode'] | null) => {
    setFocus(mode ? { mode } : null); clearHover();
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDropActive(false);
    const id = event.dataTransfer.getData('application/x-qixue-document');
    if (id) onAddDocument(id, worldPoint({ x: event.clientX, y: event.clientY }));
  };

  const directoryNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of state.canvases) {
      for (const [id, directory] of canvasDirectoryEntries(item)) {
        if (!names.has(id)) names.set(id, directory.name);
      }
    }
    return names;
  }, [state.canvases]);
  const endpointName = useCallback((id: string) =>
    state.nodes[id]?.name ?? state.documents[id]?.name ?? directoryNames.get(id) ?? id,
  [state.nodes, state.documents, directoryNames]);
  const detailFor = (hover: Hover): CanvasDetail | null => {
    if (hover.kind === 'record' && hover.id === canvas.canvasId) return { kind: 'record', id: canvas.canvasId, title: canvas.canvasName,
      accent: groupAccent(canvas.canvasId), meta: canvas.mode === 'design' ? '设计画布' : '探索画布',
      content: `${natural.blocks.filter(block => block.kind === 'node').length} 个节点 · ${state.edges.filter(edge => !edge.removed && natural.membership.has(edge.sourceNodeId) && natural.membership.has(edge.targetNodeId)).length} 条关系` };
    if (hover.kind === 'node') {
      const node = state.nodes[hover.id];
      if (!node) return null;
      const directory = nodeOptions.find(item => item.id === node.nodeId)?.segments.slice(0, -1);
      return { kind: 'node', id: node.nodeId, title: node.name, content: node.content,
        meta: node.design && DESIGN_LABELS[node.design.type], pathSegments: directory,
        accent: edgeAccents[connectionLevel(connections.get(node.nodeId) ?? 0)] };
    }
    if (hover.kind === 'edge') {
      const edge = state.edges.find((item) => item.edgeId === hover.id); if (!edge) return null;
      const rendered = model.edges.find((item) => item.edge.edgeId === hover.id);
      return { kind: 'edge', id: edge.edgeId, title: `${endpointName(edge.sourceNodeId)} ${edge.directed ? '→' : '—'} ${endpointName(edge.targetNodeId)}`, content: edge.edgeContent, accent: edgeAccents[accentLevel(rendered?.sourceBlockId ?? edge.sourceNodeId)],
        targetAccent: edgeAccents[accentLevel(rendered?.targetBlockId ?? edge.targetNodeId)], meta: `${rendered?.kind === 'outside' ? '另一端在画布外' : rendered?.kind === 'filtered' ? '另一端在画布内，当前被过滤' : '画布内关系'}\n连接点：自动（由当前布局决定）` };
    }
    const block = model.blocks.find((item) => item.id === hover.id) ?? natural.blocks.find((item) => item.id === hover.id);
    if (!block) return null;
    const summary = regionSummaries.get(block.id);
    const folded = semanticScene.collapsedGroupIds.has(block.id);
    return { kind: 'record', id: block.id, title: block.name, accent: groupAccent(block.id),
      content: state.documents[block.id]?.metadata.description ?? canvasDirectory(canvas, block.id)?.description ?? '',
      meta: `${folded ? '已折叠' : '已展开'} · ${summary?.nodeCount ?? 0} 个节点 · ${summary?.regionCount ?? 0} 个下级区域` };

  };
  const linkPreview = gesture?.type === 'link' && gesture.hasLeft ? (() => {
    const moving = gesture.snap?.point ?? gesture.point;
    const movingSide = gesture.snap?.side ?? CONNECTION_SIDES.find((side) => {
      const vector = sideVector(side); return vector.x * (gesture.fixed.x - moving.x) + vector.y * (gesture.fixed.y - moving.y) > 0;
    }) ?? 'left';
    return gesture.end === 'source' ? makeEdgeRoute(moving, gesture.fixed, movingSide, gesture.fixedSide)
      : makeEdgeRoute(gesture.fixed, moving, gesture.fixedSide, movingSide);
  })() : null;
  const renderedEdges = mounted.edges.map((rendered) => {
    if (gesture?.type !== 'link' || gesture.edgeId !== rendered.edge.edgeId || !linkPreview) return rendered;
    // A snapped reconnection already passed through the normal routing model.
    // Only an unsnapped end uses a cursor-following curve.
    if (gesture.snap) return rendered;
    return { ...rendered, source: linkPreview.segments[0][0], target: linkPreview.segments.at(-1)![3], route: linkPreview,
      label: rendered.kind === 'full' ? placeEdgeLabel(linkPreview, rendered.edge.edgeContent, model.blocks.filter((block) => block.kind === 'node').map((block) => block.rect)) : undefined };
  }).sort((a, b) => {
    const priority = (id: string) => revealedEdgeIds.has(id) ? 3 : hover?.kind === 'edge' && hover.id === id ? 2 : hoverIncident.has(id) || neighborhood?.incident.has(id) ? 1 : 0;
    return priority(a.edge.edgeId) - priority(b.edge.edgeId) || Number(a.scope === 'internal') - Number(b.scope === 'internal');
  });
  const edgeOpacity = (rendered: RenderEdge) => {
    const id = rendered.edge.edgeId;
    if (revealedEdgeIds.has(id) || hoverIncident.has(id) || hover?.kind === 'edge' && hover.id === id || gesture?.type === 'link' && gesture.edgeId === id) return 1;
    if (neighborhood) return neighborhood.incident.has(id) ? 1 : lightGrid ? .32 : .22;
    // A cross-subgraph original shown by the granularity projection is an
    // explicitly revealed member. Give it the same resting ink as an internal edge.
    const dimmed = (rendered.scope === 'cross' && !semanticIndex.relationOfEdge.has(id)) || selectedEdgeId || hover?.kind === 'edge';
    return dimmed ? (lightGrid ? .7 : .4) : 1;
  };
  // Use routed endpoints, including live move/reconnect previews. Shared
  // attachment points get one dot instead of accumulating a brighter halo.
  const connectionPoints = new Map<string, Map<string, Point & { opacity: number }>>();
  for (const rendered of renderedEdges) {
    for (const end of ['source', 'target'] as const) {
      const reconnecting = gesture?.type === 'link' && gesture.edgeId === rendered.edge.edgeId && gesture.end === end;
      const id = reconnecting ? gesture.snap?.id : rendered[`${end}BlockId`];
      if (!id || !state.nodes[id]) continue;
      const point = rendered[end];
      const points = connectionPoints.get(id) ?? new Map<string, Point & { opacity: number }>();
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      points.set(key, { ...point, opacity: Math.max(points.get(key)?.opacity ?? 0, edgeOpacity(rendered)) });
      connectionPoints.set(id, points);
    }
  }
  const details = popup ? [popup] : [];
  const focusCanvas = () => (viewport.current?.querySelector<SVGSVGElement>('[data-granular-view]') ?? viewport.current)?.focus({ preventScroll: true });
  const nameOf = useCallback((id: string) => id === canvas.canvasId ? canvas.canvasName : endpointName(id),
    [canvas.canvasId, canvas.canvasName, endpointName]);
  const endpointPaths = useMemo(() => focus?.mode === 'neighbors' ? neighborhoodPaths(semanticIndex, semanticScene, nameOf) : undefined,
    [focus?.mode, semanticIndex, semanticScene, nameOf]);
  const setGroupExpanded = (id:string,expanded:boolean) => changeGranularity(old=>updateGroup(old,id,{expanded}));
  const toggleGroup = (id:string) => setGroupExpanded(id,semanticScene.collapsedGroupIds.has(id));
  const crossAggregation = useMemo(() => crossAggregationState(semanticIndex, granularity), [semanticIndex, granularity]);
  const toggleCrossAggregation = () => changeGranularity(old => {
    const mode = crossAggregationState(semanticIndex, old) === true ? 'expanded' : 'aggregate';
    const next = setAllRelations(old, mode);
    return mode === 'expanded' ? openPlanarAncestors(semanticIndex, next, semanticIndex.relationOfEdge.keys(),
      spatial && !next.defaultExpanded && !focus) : next;
  });
  const setRelation = (id: string, config: RelationSettings) => changeGranularity(old => {
    const next = updateRelation(old, id, config);
    const members = config.mode === 'expanded' ? semanticIndex.relations.get(id)?.memberEdgeIds : config.memberIds;
    if (!members) return next;
    // Spatial overview keeps non-member contents folded. A local branch fold
    // must be explicitly opened before revealing members hidden inside it.
    return openPlanarAncestors(semanticIndex, next, members, spatial && !next.defaultExpanded && !focus);
  });
  const expandRelation = (id: string) => {
    if (!semanticIndex.relations.has(id)) return;
    setRelation(id, { mode: 'expanded' });
    setGranularityPanel(null);
    clearHover();
  };
  const collapseRelation = (id: string) => {
    setRelation(id, { mode: 'aggregate' });
    setGranularityPanel(null);
    clearHover();
  };
  const toggleRelation = (id:string) => {
    const aggregated = !spatial && semanticScene.relations.some(r => r.id === id);
    setRelation(id, { mode: !aggregated && relationSettings(granularity, id).mode === 'expanded' ? 'aggregate' : 'expanded' });
  };
  const openRelation = (id:string,_point?:Point, clicked = true) => {
    void editing.finish().then(ok=>{
      if(!ok || !semanticIndex.relations.has(id))return;
      if (clicked) setNeighborhoodFocusId(id);
      if (!multiMode) {
        setClickedSelection(clicked ? new Set([id]) : emptySelection);
        setSelected(null); setSelectedRelationId(id);
      }
      setPopup(null); clearHover(); setGranularityPanel(id);
    });
  };
  const inspectGranularity = (id?:string) => {
    const target=id??selectedRelationId??selected?.id??canvas.canvasId;
    const relation=semanticIndex.relationOfEdge.get(target);
    const local=relation??(semanticIndex.nodeIds.has(target)?semanticIndex.parents.get(target):target);
    setGranularityPanel(local&& (semanticIndex.groupIds.has(local)||semanticIndex.relations.has(local))?local:canvas.canvasId);
  };
  const switchView = async (next: CanvasViewKind) => {
    if(next===activeView || !await editing.finish() || viewportCanvasId.current!==canvas.canvasId)return;
    updateGesture(null);clearHover();setPopup(null);setMenu(null);setDropActive(false);
    const center=visibleCenter(),w=Math.max(1,viewportSize.width-insets.left-insets.right),h=Math.max(1,visibleHeight-70);
    const anchorId = activeNeighbor ?? selectedRelationId ?? selected?.id ?? (focus ? scopeSelection.values().next().value : undefined);
    const planarFrame = spatial && next === '2d' && anchorId
      ? buildPlanarGranularityModel(previewState, previewCanvas, projectPlanarGranularity(
        semanticIndex, granularity, scopeSelection, focus?.mode ?? 'all', edgeVisibility), semanticIndex.parents, granularity.planarPlacements)
      : baseModel;
    const screenPoint=(id:string) => planarCameraAnchor(planarFrame, semanticIndex, id);
    if(!spatial){
      const current=viewRef.current;
      let id=anchorId;
      if(!id || !screenPoint(id)){
        const nearest=planarFrame.blocks
          .map(b=>({id:b.id,d:Math.hypot(current.x+(b.rect.x+b.rect.width/2)*current.zoom-center.x,current.y+(b.rect.y+b.rect.height/2)*current.zoom-center.y)}))
          .sort((a,b)=>a.d-b.d)[0]; id=nearest?.id;
      }
      const p=id?screenPoint(id):undefined;
      const fit=Math.min(w/Math.max(1,planarFrame.bounds.width),h/Math.max(1,planarFrame.bounds.height));
      incomingFrame.current={id,u:p?Math.max(.08,Math.min(.92,(current.x+p.x*current.zoom-insets.left)/w)):.5,
        v:p?Math.max(.08,Math.min(.92,(current.y+p.y*current.zoom-70)/h)):.5,zoomRatio:current.zoom/Math.max(.001,fit)};
    }else{
      incomingFrame.current=spatialFrame.current;
      if(next==='2d'){
        const p=anchorId?screenPoint(anchorId):undefined;
        if(p){
          const old=viewRef.current,x=old.x+p.x*old.zoom,y=old.y+p.y*old.zoom;
          if(x<insets.left+16||x>viewportSize.width-insets.right-16||y<48||y>visibleHeight-16){
            const frame=spatialFrame.current;
            const u=Math.max(.08,Math.min(.92,frame?.u??.5)), v=Math.max(.08,Math.min(.92,frame?.v??.5));
            updateView(()=>({...old,x:insets.left+u*w-p.x*old.zoom,y:70+v*h-p.y*old.zoom}));
          }
        }
      }
    }
    cancelPan();focusAfterSwitch.current=true;setSpatialFocus(null);setActiveView(next);
  };
  const shortcuts = useRef<(event: KeyboardEvent)=>void>(()=>{});
  shortcuts.current = event => {
    const command=canvasDisplayCommand(event);
    if(!command || gestureRef.current || canvasInteractionBlocked(event.target,true))return;
    const el=event.target instanceof Element?event.target:null;
    if(el&&el!==document.body&&el!==document.documentElement&&!viewport.current?.contains(el)&&!el.closest('[data-canvas-toolbar]'))return;
    if(el?.closest('[data-canvas-detail],[data-graph-menu]') || (event.code==='Space' && el?.closest('button,summary')))return;
    const target=activeNeighbor??selectedRelationId??selected?.id;
    const pair=selectedRelationId??(target?semanticIndex.relationOfEdge.get(target):undefined);
    const group=target&&(semanticIndex.groupIds.has(target)?target:semanticIndex.parents.get(target));
    const order:CanvasViewKind[]=['2d','layered','sphere'];
    if(command==='toggle'&&!pair&&!group || command==='locate'&&!target)return;
    if(command==='selected' && focus?.mode!=='selected' && !hasClickedAnchor ||
      command==='neighbors' && focus?.mode!=='neighbors' && !neighborhoodFocusId)return;
    event.preventDefault();stopCameraFollow(canvas.canvasId);
    switch(command){
      case '2d':case 'layered':case 'sphere':void switchView(command);break;
      case 'next':case 'previous':void switchView(order[(order.indexOf(activeView)+(command==='next'?1:2))%3]);break;
      case 'selected':case 'neighbors':activateFocus(focus?.mode===command?null:command);break;
      case 'toggle':if(pair)toggleRelation(pair);else if(group)toggleGroup(group);break;
      case 'internal':setShowInternalEdges(v=>!v);break;
      case 'cross':setShowCrossEdges(v=>!v);break;
      case 'outside':setShowOutsideEdges(v=>!v);break;
      case 'allGroups':changeGranularity(old=>setAllGroups(old,!old.defaultExpanded));break;
      case 'allRelations':toggleCrossAggregation();break;
      case 'inspect':if(granularityPanel){setGranularityPanel(null);focusCanvas();}else inspectGranularity();break;
      case 'locate':if(spatial)focusInSpace(target!);else if(pair && pair===target){
        const r=semanticScene.relations.find(relation=>relation.id===pair) ?? semanticIndex.relations.get(pair);
        if(r){const rects=baseModel.blocks.filter(b=>b.id===r.sourceSubgraphId||b.id===r.targetSubgraphId).map(b=>b.rect);
          if(r.sourceSubgraphId===canvas.canvasId||r.targetSubgraphId===canvas.canvasId)rects.push(baseModel.bounds);
          if(rects.length)updateView(()=>searchFocusView(rects,{x:insets.left+20,y:65,width:Math.max(120,viewportSize.width-insets.left-insets.right-40),height:Math.max(100,visibleHeight-85)},view.zoom).view);}
      }else void navigateTo(target!,true,false,clickedSelection.has(target!));break;
    }
  };
  useEffect(()=>{
    const run=(event:KeyboardEvent)=>shortcuts.current(event);
    window.addEventListener('keydown',run);
    return ()=>window.removeEventListener('keydown',run);
  },[]);
  const selectSpatialItem = (id: string | null, toggle = false, client?: Point, altKey = false) => {
    if (id) {
      const kind = state.nodes[id] ? 'node' : semanticIndex.groupIds.has(id) ? 'record' : 'edge';
      const position = client ?? visibleCenter();
      if (toggle) void updateMultiSelection(kind, id);
      else void clickItem(kind, id, position, altKey);
    } else void clickBackground(toggle, client, altKey ? canvas.canvasId : undefined);
  };

  return <GraphAppearanceProvider state={state} light={lightGrid}><CanvasEditingProvider value={editing}><div ref={viewport} tabIndex={-1} data-canvas-viewport data-canvas-mode={spatial ? '3d' : '2d'} data-canvas-view={activeView} data-canvas-id={canvas.canvasId} data-canvas-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y} data-canvas-bottom-inset={bottomInset}
    onPointerDownCapture={() => { cancelPan(); stopCameraFollow(canvas.canvasId); }}
    onWheelCapture={() => { cancelPan(); stopCameraFollow(canvas.canvasId); }}
    data-neighborhood-focus={activeNeighbor ?? undefined} data-canvas-scope={focus?.mode ?? 'all'} data-selected-id={selectedRelationId ?? selected?.id ?? ''} data-selected-kind={selectedRelationId ? 'relation' : selected?.kind ?? ''} data-selected-mode={multiMode ? 'multi' : selected || selectedRelationId ? 'single' : 'none'} data-selected-count={multiMode ? multiIds.size : selected || selectedRelationId ? 1 : 0}
    data-route-cache-hits={routed.stats?.cacheHits ?? 0} data-rerouted-edges={routed.stats?.rerouted ?? 0} data-route-fallbacks={routed.stats?.fallbacks ?? 0}
    data-route-version={routed.sequence} data-route-validated={routed.stats?.validated ?? 0} data-route-ready={spatial || Boolean(routed.stats)}
    data-pending-routes={routed.stats?.pending ?? 0}
    data-mounted-blocks={mounted.blocks.length} data-mounted-edges={mounted.edges.length}
    className="absolute inset-0 z-0 overflow-hidden touch-none select-none" style={{ userSelect: 'none', cursor: gesture?.type === 'pan' ? 'grabbing' : undefined }}
    onPointerDown={spatial ? undefined : backgroundDown} onPointerMove={spatial ? undefined : onPointerMove} onPointerUp={spatial ? undefined : onPointerUp}
    onPointerLeave={spatial ? undefined : scheduleDismiss}
    onPointerCancel={spatial ? undefined : () => updateGesture(null)} onLostPointerCapture={spatial ? undefined : () => updateGesture(null)}
    onContextMenu={spatial ? undefined : openContextMenu}
    onDragOver={(event) => { if (!spatial && event.dataTransfer.types.includes('application/x-qixue-document')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }} onDrop={spatial ? undefined : drop}>
    {activeView !== '2d' ? <GranularSpatialCanvas endpointPaths={endpointPaths} natural={spatialNatural} index={semanticIndex} projectedIndex={spatialRelations} scene={semanticScene} mode={activeView}
      canvasId={canvas.canvasId} canvasName={canvas.canvasName} selectedId={selectedRelationId ?? selected?.id ?? null}
      neighborhoodFocus={activeNeighbor} aiTargets={aiTargets} hoveredId={hover?.id} occlusions={screenOcclusions} onExpandRelation={expandRelation}
      selectedIds={semanticSelection} manualSelectedIds={selectedIds} editorOpen={Boolean(editing.session)}
      lightGrid={lightGrid} insets={{ left: insets.left, right: insets.right, bottom: bottomInset }}
      initialFrame={incomingFrame.current} onFrame={frame => { spatialFrame.current = frame; }} focusRequest={spatialFocus}
      onSelect={(id,toggle,point,alt) => {
        if(id && semanticIndex.relations.has(id)) openRelation(id,point,!toggle);
        else selectSpatialItem(id,toggle,point,alt);
      }}
      onToggle={id => { if(semanticIndex.relations.has(id)) toggleRelation(id); else if(semanticIndex.groupIds.has(id)) toggleGroup(id); }}
      onBeginMove={(block,pointerId,point)=>{
        if(activeView!=='layered'||editing.session||gestureRef.current)return false;
        const move=blockGesture(block,pointerId,point);
        if(!move)return false;
        updateGesture(move);clearHover();return true;
      }}
      onMoveBlock={(offset,done)=>{
        const move=gestureRef.current;
        if(move?.type!=='block')return;
        if(done){
          updateGesture(null);
          if(offset && (offset.x||offset.y))void commitBlockMove(move,offset);
        }else if(offset)updateGesture({...move,offset},true);
      }}
      onConnect={async(sourceNodeId,targetNodeId,directed)=>{
        const id=await onCreateEdge({sourceNodeId,targetNodeId,directed});
        if(id){setNewEdgeToReveal(id);await selectItem('edge',id,undefined,true);}
      }}
      onReconnect={commitReconnect}
      onContextMenu={(id,point,world,region) => {
        if(id && semanticIndex.relations.has(id)) { openRelation(id,point,false); return; }
        const block=natural.blocks.find(b=>b.id===id);
        const edge=id && semanticIndex.edgesById.get(id);
        void showGraphMenu(point,world,block?.kind==='node'?id:undefined,edge?edge.edgeId:undefined,region??(block?.kind==='node'?undefined:block));
      }}
      onHoverObject={(id,event) => {
        if(id && !semanticIndex.relations.has(id)){
          const kind=spatialKind(id);
          if(kind)showHover(kind,id,event);
        } else {clearHover();dismissPreview();}
      }}
      onLeaveObject={scheduleDismiss} /> : <>
    <CanvasReviewOverlay canvasId={canvas.canvasId} model={model} liveEdges={previewState.edges} view={view} />
    {dropActive && <div className="absolute inset-3 z-30 pointer-events-none rounded-2xl border-2 border-dashed border-blue-400/70 bg-blue-400/5" />}
    <div data-canvas-world className="absolute left-0 top-0 pointer-events-none" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: '0 0',
      '--neighbor-ring': 1.4 / view.zoom + 'px' } as CSSProperties}>
      {mounted.blocks.filter(block => block.kind !== 'node').sort((a, b) => a.depth - b.depth).map(block =>
        <CanvasRegion key={block.id} block={block} accent={groupAccent(block.id)} zoom={view.zoom} document={state.documents[block.id]?.kind === 'document'}
          active={planarAncestors.has(block.id) || hover?.id === block.id || hoveredEndpoints.has(block.id) || !!neighborhood?.neighbors.has(block.id)} selected={selectedIds.has(block.id)}
          focused={activeNeighbor === block.id} onBorderDown={event => blockDown(event, block)} onToggle={() => toggleGroup(block.id)}
          onSelect={event => {
            if (!event.ctrlKey && !event.metaKey) void clickItem('record', block.id, { x: event.clientX, y: event.clientY }, event.altKey);
          }} />)}
      <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width="1" height="1" style={{ zIndex: 100 }}>
        <defs>
          {Object.entries(edgeAccents).map(([level, color]) =>
            <marker key={level} id={`${paintId}-arrow-${level}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 L 2 5 z" fill={color} /></marker>)}
        </defs>
        {mounted.blocks.filter((block) => aiTargets.has(block.id)).map((block) => <g key={`ai:${block.id}`} data-ai-highlighted={block.id}><rect x={block.rect.x - 3} y={block.rect.y - 3} width={block.rect.width + 6} height={block.rect.height + 6} rx={12} fill="none" stroke={edgeAccents.ai} strokeWidth={2 / view.zoom} /></g>)}
        {renderedEdges.map((rendered, index) => {
          const { edge, kind, source, target, freeEnd } = rendered;
          const readingLabel = readingLabels.get(edge.edgeId);
          const label = readingLabel ?? rendered.label, scale = readingLabel ? readingScale : 1;
          const edgeSelected = selectedEdgeId === edge.edgeId || multiIds.has(edge.edgeId);
          const active = hover?.kind === 'edge' && hover.id === edge.edgeId || edgeSelected || hoverIncident.has(edge.edgeId);
          const incident = neighborhood?.incident.has(edge.edgeId);
          const aiHighlighted = aiTargets.has(edge.edgeId);
          const dragging = gesture?.type === 'link' && gesture.edgeId === edge.edgeId;
          const indicator = nearEnd?.edgeId === edge.edgeId ? rendered[nearEnd.end] : null;
          const arrowLevel = dragging ? 'drag' : aiHighlighted ? 'ai' : active ? 'active' : kind === 'outside' ? 'outside' : accentLevel(rendered.targetBlockId);
          const sourceColor = edgeAccents[accentLevel(rendered.sourceBlockId)], targetColor = edgeAccents[arrowLevel];
          const solid = dragging || aiHighlighted || active || kind === 'outside';
          const gradient = !solid && sourceColor !== targetColor && (source.x !== target.x || source.y !== target.y);
          const stroke = gradient ? `url(#${paintId}-edge-${index})` : solid ? targetColor : sourceColor;
          return <g key={edge.edgeId} data-canvas-interactive data-hover-id={edge.edgeId} data-hover-kind="edge" data-edge-id={edge.edgeId}
            data-neighbor-focus={activeNeighbor === edge.edgeId || undefined} data-selected={edgeSelected} data-preselected={hover?.kind === 'edge' && hover.id === edge.edgeId}
            data-hover-related={hoverIncident.has(edge.edgeId) || undefined} data-ai-highlighted={aiHighlighted ? edge.edgeId : undefined}
            data-aggregate-count={rendered.aggregateEdgeIds?.length ?? 1} data-route-fallback={rendered.route.fallback || undefined}
            data-route-provisional={rendered.route.provisional || undefined}
            data-edge-scope={rendered.scope} data-edge-kind={kind} data-reading-incident={incident} opacity={edgeOpacity(rendered)}
            onPointerEnter={(event) => edgeMove(event, rendered)} onPointerMove={(event) => edgeMove(event, rendered)} onPointerLeave={scheduleDismiss}
            onPointerDown={(event) => edgeDown(event, rendered)}>
            {gradient && <linearGradient id={`${paintId}-edge-${index}`} gradientUnits="userSpaceOnUse"
              x1={source.x} y1={source.y} x2={target.x} y2={target.y}>
              <stop offset="0" stopColor={sourceColor} /><stop offset="1" stopColor={targetColor} />
            </linearGradient>}
            <path data-edge-visible data-reconnect-preview={dragging || undefined} data-reconnect-preview-mode={dragging ? gesture.snap ? 'snapped' : 'free' : undefined} d={rendered.route.path} fill="none" stroke={stroke}
              vectorEffect="non-scaling-stroke"
              strokeWidth={active || aiHighlighted || incident ? 2.2 : 1.4} strokeDasharray={kind === 'outside' ? '5 5' : undefined} strokeLinecap="round" strokeLinejoin="round"
              markerEnd={edge.directed ? `url(#${paintId}-arrow-${arrowLevel})` : undefined}
              style={{ filter: active ? 'drop-shadow(0 0 3px #9bbff560)' : undefined }} />
            {freeEnd && <circle cx={freeEnd === 'target' ? target.x : source.x} cy={freeEnd === 'target' ? target.y : source.y} r={3 / view.zoom} fill={kind === 'outside' ? '#94a3b8' : '#93c5fd'} />}
            {indicator && !dragging && <circle data-edge-end-indicator cx={indicator.x} cy={indicator.y} r={7 / view.zoom} fill="#0b1220" stroke="#fbbf24" strokeWidth={2 / view.zoom} />}
            {dragging && gesture?.type === 'link' && <circle cx={gesture.end === 'source' ? source.x : target.x} cy={gesture.end === 'source' ? source.y : target.y} r={6 / view.zoom} fill="#34d399" />}
            {label && (incident !== false || active || aiHighlighted || editing.session?.target.id === edge.edgeId) &&
              (edge.edgeContent?.trim() || rendered.aggregateEdgeIds || active) && <g data-edge-label style={{ pointerEvents: 'all', cursor: 'pointer' }}>
              {Math.hypot(label.anchor.x - label.point.x, label.anchor.y - label.point.y) > Math.max(18, label.rect.height * .8) &&
                <line x1={label.anchor.x} y1={label.anchor.y} x2={label.point.x} y2={label.point.y} stroke="#7287a5" strokeOpacity=".5" strokeWidth="0.8" />}
              <rect className="canvas-edge-label-face" x={label.rect.x} y={label.rect.y} width={label.rect.width} height={label.rect.height} rx={6 * scale} fill="#0d1727" stroke={active ? '#9bbff580' : '#9bbff520'} />
              <foreignObject x={label.rect.x / scale} y={label.rect.y / scale} width={label.rect.width / scale} height={label.rect.height / scale} transform={scale === 1 ? undefined : `scale(${scale})`}>
                {rendered.aggregateEdgeIds || edge.membershipFor ? <div className="px-2 h-full overflow-hidden text-center text-slate-300"><CanvasTextPreview zoom={view.zoom * scale} textRole="edge" {...canvasTextMetrics('edge', view.zoom * scale)} center>{label.text}</CanvasTextPreview></div> :
                  <CanvasTextField target={{ kind: 'edge', id: edge.edgeId, field: 'edgeContent' }} value={edge.edgeContent} surface="canvas"
                    zoom={view.zoom * scale} fontSize={11} wrap maxLines={3}
                    className="px-2 h-full text-center text-[11px] leading-[22px] text-slate-300" placeholder="关系" onActivate={(ctrl) => selectByPointer('edge', edge.edgeId, ctrl)} />}
              </foreignObject>
            </g>}
          </g>;
        })}
        {/* Hit bands sit above every label, so the line you can see is always
            the line you can click. A label that covers another relation's path
            used to make that relation impossible to select in a dense cluster. */}
        {renderedEdges.map((rendered) => {
          const { edge } = rendered;
          const edgeSelected = selectedEdgeId === edge.edgeId || multiIds.has(edge.edgeId);
          return <g key={`hit:${edge.edgeId}`} data-canvas-interactive data-hover-id={edge.edgeId} data-hover-kind="edge" data-edge-id={edge.edgeId}
            data-selected={edgeSelected} data-route-fallback={rendered.route.fallback || undefined}
            data-route-provisional={rendered.route.provisional || undefined}
            data-aggregate-count={rendered.aggregateEdgeIds?.length ?? 1}
            onPointerEnter={(event) => edgeMove(event, rendered)} onPointerMove={(event) => edgeMove(event, rendered)} onPointerLeave={scheduleDismiss}
            onPointerDown={(event) => edgeDown(event, rendered)}>
            <path data-edge-hit data-edge-hit-layer d={rendered.route.path} fill="none" stroke="transparent" strokeWidth={14 / view.zoom}
              style={{ pointerEvents: 'stroke', cursor: nearEnd?.edgeId === edge.edgeId ? 'crosshair' : 'pointer' }} />
          </g>;
        })}
        <PlanarSubgraphRelations endpointPaths={endpointPaths} renderedEdges={renderedEdges} blocks={baseModel.blocks} rootId={canvas.canvasId} rootName={canvas.canvasName} bounds={baseModel.bounds}
          relations={semanticScene.relations} neighborhoodFocus={activeNeighbor} selectedId={selectedRelationId} zoom={view.zoom} light={lightGrid} activeInk={edgeAccents.active}
          hoveredId={hoveredPlanarRelationId} related={hoverIncident} onHover={id => {
            if (id) { clearHover(); dismissPreview(); }
            setHoveredPlanarRelationId(id);
          }}
          visibleArea={relationViewport} occlusions={relationOcclusions} onOpen={openRelation} onExpand={expandRelation} onToggle={toggleRelation} />
        {linkPreview && gesture?.type === 'link' && !gesture.edgeId && <path data-link-preview d={linkPreview.path} fill="none" stroke={gesture.snap ? edgeAccents.drag : edgeAccents.high} strokeWidth="2.5" strokeDasharray="6 4" markerEnd={gesture.directed ? `url(#${paintId}-arrow-${gesture.snap ? 'drag' : 'high'})` : undefined} />}
      </svg>
      {mounted.blocks.filter((block) => block.kind === 'node').map((block) => {
        const preselected = hover?.kind === 'node' && hover.id === block.id;
        const portsVisible = preselected || selectedIds.has(block.id) || gesture?.type === 'link';
        const connectionCount = connections.get(block.id) ?? 0;
        const level = connectionLevel(connectionCount);
        const pointSize = 8 / Math.max(view.zoom, .65);
        const titleLine = canvasTextMetrics('title', view.zoom).lineHeight;
        const paddingY = Math.min(8, Math.max(0, (block.rect.height - 2 - titleLine) / 2));
        const titleHeight = Math.min(block.rect.height - 2 - paddingY * 2,
          view.zoom < .55 ? titleLine : Math.max(nodeGeometry(previewState.nodes[block.id]).titleHeight, titleLine));
        return <div key={block.id} data-canvas-interactive data-node-id={block.id} data-hover-id={block.id} data-hover-kind="node"
          data-selected={selectedIds.has(block.id)} data-preselected={preselected} data-hover-related={hoveredEndpoints.has(block.id) || undefined}
          data-neighbor-focus={activeNeighbor === block.id || undefined} data-reading-neighbor={neighborhood?.neighbors.has(block.id) || undefined}
          data-connection-count={connectionCount} data-connection-level={level}
          className="canvas-node absolute pointer-events-auto cursor-grab active:cursor-grabbing"
          style={{ '--node-accent': edgeAccents[level], left: block.rect.x, top: block.rect.y, width: block.rect.width, height: block.rect.height, zIndex: 110 + block.depth } as CSSProperties}
          onPointerDown={(event) => blockDown(event, block)} onDragStart={(event) => event.preventDefault()}
          onPointerEnter={(event) => showHover('node', block.id, event, block)} onPointerMove={(event) => { if (!gestureRef.current) showHover('node', block.id, event, block); }} onPointerLeave={scheduleDismiss}>
          {state.nodes[block.id]?.design && <span data-design-badge className="absolute -top-2 right-2 rounded border border-slate-600 bg-slate-900 px-1 text-[10px] leading-4 text-blue-200 pointer-events-none">{DESIGN_LABELS[state.nodes[block.id].design!.type]}</span>}
          <div className={`h-full px-3 overflow-hidden rounded-xl flex flex-col ${block.content ? '' : 'justify-center'}`} style={{ paddingTop: paddingY, paddingBottom: paddingY }}>
            <CanvasTextField target={{ kind: 'node', id: block.id, field: 'name' }} value={block.name} surface="canvas" multiline={false}
              zoom={view.zoom} fontSize={14} maxLines={view.zoom < .55 ? 1 : undefined} wrap
              style={{ height: titleHeight, flexShrink: 0 }}
              className="canvas-node-title" placeholder="未命名节点" onActivate={(ctrl) => selectByPointer('node', block.id, ctrl)} />
            {block.content && <CanvasTextField target={{ kind: 'node', id: block.id, field: 'content' }} value={block.content} surface="canvas"
              zoom={view.zoom} fontSize={12} wrap
              className="canvas-node-summary mt-1 flex-1 min-h-0" onActivate={(ctrl) => selectByPointer('node', block.id, ctrl)} />}
          </div>
          {Array.from(connectionPoints.get(block.id) ?? []).map(([key, point]) => <span key={key} aria-hidden="true" data-node-connection-point
            className="canvas-node-connection-point" style={{ left: point.x - block.rect.x - 1, top: point.y - block.rect.y - 1, width: pointSize, height: pointSize, opacity: point.opacity }} />)}
          {/* One handle: there is no side to pick, so four handles would only
              ask a question the app already answers. */}
          {(() => {
            const snapped = gesture?.type === 'link' && gesture.snap?.id === block.id;
            return <button type="button" data-canvas-interactive data-port-node={block.id} data-port-side="auto" aria-label={`从${block.name}拖出关系`}
              data-snapped={Boolean(snapped)} className={`canvas-node-port absolute rounded-full transition-opacity ${portsVisible ? 'opacity-100' : 'opacity-0'}`}
              style={{ left: block.rect.width / 2 - 1 - 6 / view.zoom, top: -1 - 6 / view.zoom, width: 12 / view.zoom, height: 12 / view.zoom, cursor: 'crosshair' }}
              onPointerDown={(event) => startEdge(event, block)} />;
          })()}
        </div>;
      })}
    </div>
    </>}
    {!(spatial ? semanticScene.nodeIds.size || semanticScene.groupIds.size > 1 : model.blocks.length) && <div className="canvas-empty-view" style={{ left: insets.left, right: insets.right, bottom: bottomInset }}>
      {focus && natural.blocks.length > 0 ? <>
        <span role="status">当前范围内没有选中的对象</span>
        <button type="button" data-canvas-interactive onClick={() => {
          activateFocus(null);
          focusCanvas();
        }}>显示全部对象</button>
      </> : natural.blocks.length ? <>
        <span role="status">当前子图内容已收缩</span>
        <button type="button" data-canvas-interactive onClick={()=>setGroupExpanded(canvas.canvasId,true)}>展开根图内容</button>
      </> : <span role="status">右键创建节点，或从右侧拖入图文档</span>}
    </div>}
    {multiMode && <div className="absolute top-16 z-20 rounded border border-blue-400/30 bg-slate-950/80 px-3 py-1.5 text-xs text-blue-100 pointer-events-none" style={{ left: insets.left + 12 }}>多选 {multiIds.size} 项 · Ctrl 添加/取消 · Ctrl + 单击空白退出</div>}
    {!spatial&&otherTargets>0&&<div className="absolute top-16 left-1/2 text-xs text-amber-200 pointer-events-none">另有 {otherTargets} 处指定对象，未缩小整张画布</div>}
    {scopeNotice && <div role="status" data-canvas-scope-notice className="canvas-scope-notice" style={{ left: insets.left, right: insets.right, bottom: bottomInset + 12 }}><span>{scopeNotice}</span></div>}
    {selectionNotice && <div role="status" data-canvas-selection-notice className="absolute top-24 z-30 max-w-sm rounded-lg border border-amber-300/30 bg-slate-950/95 px-3 py-2 text-xs text-amber-100" style={{ right: insets.right + 16 }}>{selectionNotice}</div>}
    {editing.error && <div role="alert" data-canvas-edit-error className="absolute top-16 z-30 max-w-sm rounded-lg border border-red-400/40 bg-slate-950/95 px-3 py-2 text-xs text-red-200" style={{ right: insets.right + 16 }}>{editing.error}</div>}
    {createPortal(<div data-canvas-interactive data-canvas-toolbar className="canvas-toolbar fixed top-4 z-[170] flex flex-wrap items-center justify-end gap-1 p-1"
      style={{ right: controlInsets.right + 16, width: 'max-content', maxWidth: `calc(100% - ${controlInsets.left + controlInsets.right + 32}px)` }}>
      {!multiMode && selected && (selected.kind === 'node' || selected.kind === 'edge') &&
        <button type="button" data-canvas-edit-selected={selected.id} aria-label="编辑选中对象" title="编辑选中对象"
          onClick={() => void openDetail(selected.kind, selected.id, visibleCenter(), true)}><Pencil size={16} aria-hidden="true" /></button>}
      <CanvasDisplayOptions aggregation={crossAggregation} onAggregation={toggleCrossAggregation}
        edges={[
          { id: 'cross', label: '跨子图边', key: 'X', shown: showCrossEdges, onChange: setShowCrossEdges },
          { id: 'internal', label: '子图内边', key: 'I', shown: showInternalEdges, onChange: setShowInternalEdges },
        ]} />
      <button type="button" aria-label="另存为画布" title="另存为画布" onClick={onSaveCanvas}><Save size={16} aria-hidden="true" /></button>
      <CanvasSearch state={state} canvas={canvas} onLocate={id => { void navigateTo(id, true, false, true); }} />
    </div>,document.body)}
    {granularityPanel && (semanticIndex.groupIds.has(granularityPanel)||semanticIndex.relations.has(granularityPanel)) &&
      <GranularityPanel id={granularityPanel} index={semanticIndex} settings={granularity} name={nameOf}
        style={{right:controlInsets.right+16}} onChoose={id=>{if(semanticIndex.relations.has(id))openRelation(id);else {setGranularityPanel(id);void clickItem('record',id,visibleCenter());}}}
        onGroup={(id,patch)=>changeGranularity(old=>updateGroup(old,id,patch))}
        onRelation={setRelation}
        onLocate={id=>{void navigateTo(id,true,false,true);}} onClose={()=>{setGranularityPanel(null);focusCanvas();}}/>}
    {details.map((item) => {
      const detail = detailFor(item); if (!detail) return null;
      const isSelected = Boolean(item.pinned);
      return <CanvasDetailPanel key={`${item.kind}:${item.id}`} detail={detail} position={panelPosition(item)} size={detailSize} selected={isSelected}
        maxWidth={viewportSize.width - (spatial ? insets.left + insets.right : 0) - 16} maxHeight={(item.manual?viewportSize.height:visibleHeight) - (spatial && !item.manual ? 72 : 16)}
        edge={item.kind === 'edge' ? state.edges.find((edge) => edge.edgeId === item.id) : undefined}
        designDetails={item.kind === 'node' && state.nodes[item.id]?.design ? <DesignDetails data={state.nodes[item.id].design!} endpointName={id => natural.membership.has(id) ? endpointName(id) : '当前画布外的关联内容'} onEdit={() => onAction({ type: 'editDesign', origin: 'canvas', id: item.id })} /> : undefined}
        nodeOptions={nodeOptions} endpointName={endpointName} onEdgeChange={(patch) => onUpdateEdge(item.id, patch)}
        dependencyLinks={item.kind==='node' && <NodeDependencyLinks nodeId={item.id} edges={state.edges} options={nodeOptions} onLocate={id=>{void navigateTo(id,true,true,true);}} />}
        onActivate={() => activateDetail(item)} onClose={() => { void editing.finish().then((saved) => { if (!saved) return; popupRequest.current++; setPopup(null); clearHover(); }); }}
        onMove={(position) => {
          const offset = attachDetail(item.kind, item.id, { x: position.x,
            y: Math.max(8,Math.min(viewportSize.height-Math.min(detailSize.height,viewportSize.height-16)-8,position.y)) }, view, item.edgeAnchor);
          setPopup((old) => old?.id === item.id && old.kind === item.kind ? { ...old, position: offset, manual: true, pinned: true } : old);
        }}
        onResize={(size) => { setPopup(old=>old?.id===item.id&&old.kind===item.kind?{...old,manual:true,pinned:true}:old);
          setDetailSize((old) => old.width === size.width && old.height === size.height ? old : size); }} onEnter={clearDismiss} onLeave={scheduleDismiss} />;
    })}
    {menu && <GraphContextMenu position={menu.position} items={menu.items} onClose={() => setMenu(null)} />}
  </div></CanvasEditingProvider></GraphAppearanceProvider>;
}
