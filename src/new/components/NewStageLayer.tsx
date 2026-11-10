import { DESIGN_LABELS } from '@/v3/design';
import { DesignDetails } from './DesignDetails';
import { canvasDirectories, canvasDirectory, canvasDirectoryEntries } from '@/v3/canvas';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, Save } from 'lucide-react';
import { createPortal } from 'react-dom';
import { buildRenderModel, getCanvasNodeOptions, getFocusVisibleIds, type RenderBlock, type RenderEdge } from '@/v3/layout';
import { CONNECTION_SIDES, distanceToRoute, facingSide, makeEdgeRoute, nearestPort, placeEdgeLabel, pointOnRoute, portPoint, routeBounds, sideVector } from '@/v3/edgeGeometry';
import type { CanvasRecord, ConnectionSide, GraphState, Point } from '@/v3/types';
import type { CreateEdgeInput, EdgePatch } from '@/v3/storage';
import { nodeGeometry } from '@/v3/nodeGeometry';
import { previewBlockMove } from '@/v3/regionLayout';
import { CanvasRegion, type RegionSummary } from './CanvasRegion';
import { useSidebarInsets } from '../newUiStore';
import { loadCanvasViewport, saveCanvasViewport, flushCanvasViewport, type CanvasViewport } from '../canvasViewportStore';
import { CanvasDetailPanel, type CanvasDetail } from './CanvasDetailPanel';
import { CanvasEditingProvider, CanvasTextField, useCanvasEditing, type EditOccupancyCallback, type TextTarget } from './CanvasTextField';
import { CanvasTextPreview } from './CanvasTextPreview';
import { canvasTextMetrics } from '../canvasTextPresentation';
import { GraphContextMenu, type GraphMenuItem } from './GraphContextMenu';
import type { CanvasFocusRequest, GraphActionRequest } from '../graphActions';
import { useEdgeRouting } from '../useEdgeRouting';
import { canvasViewportBounds, indexVisibleObjects } from '../canvasVisibility';
import { usePlaybackStore } from '@/ai/presentationClient';
import { useAiStore } from '@/ai/client';
import { connectionLevel, nodeConnectionCounts } from '@/v3/nodeConnections';
import { CanvasReviewOverlay } from './CanvasReviewOverlay';

import { GraphAppearanceProvider, nodeAccents, documentAccent, subgraphAccent } from '../graphAppearance';
const edgeAccents = { ...nodeAccents, neutral: '#8ca3cf', active: '#cee3ff', ai: '#f6c453', outside: '#74839a', drag: '#75d7b0' };

interface Props {
  state: GraphState;
  canvas: CanvasRecord;
  graphRevision: number;
  onAddDocument: (id: string, world: Point) => void;
  onMoveBlock: (id: string, parentId: string, point: Point) => Promise<{ ok: boolean; graphRevision: number } | null>;
  onToggleCollapse: (id: string) => void;
  onCreateEdge: (input: CreateEdgeInput) => string | null | Promise<string | null>;
  onReconnectEdge: (edgeId: string, end: 'source' | 'target', nodeId: string) => Promise<{ ok: boolean; graphRevision: number } | null>;
  onUpdateEdge: (edgeId: string, patch: EdgePatch) => unknown;
  onEditText: (target: TextTarget, value: string) => boolean | Promise<boolean>;
  onEditOccupancy?: EditOccupancyCallback;
  onSelectionChange?: (refs: string[]) => void;
  onCreateTemporary?: (point: Point) => void;
  aiTargetRefs?: string[];
  composerBottomInset?: number;
  onSaveCanvas: () => void;
  onAction: (request: GraphActionRequest) => void;
  onOrganize?: (regionId: string) => void;
  onPlacementOccupancy?: (refId: string, active: boolean) => Promise<unknown>;
  focusRequest: CanvasFocusRequest | null;
}
type View = CanvasViewport;
type Snap = ReturnType<typeof nearestPort>;
type Gesture =
  | { type: 'pan'; pointerId: number; startClient: Point; startView: View }
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

export function NewStageLayer({ state, canvas, graphRevision, onAddDocument, onMoveBlock, onToggleCollapse, onCreateEdge, onReconnectEdge, onUpdateEdge, onEditText, onEditOccupancy, onSelectionChange, onCreateTemporary, aiTargetRefs = [], composerBottomInset = 210, onSaveCanvas, onAction, onOrganize, onPlacementOccupancy, focusRequest }: Props) {
  const storedPlayback=usePlaybackStore(s=>s.byCanvas[canvas.canvasId]);
  const playbackAvailable=useAiStore(s=>!canvas.isDraft&&!!s.activeSessionByCanvas[canvas.canvasId]&&!!s.snapshot?.tasks.some(t=>t.id===storedPlayback?.taskId&&t.sessionId===s.activeSessionByCanvas[canvas.canvasId]));
  const playback=playbackAvailable?storedPlayback:undefined;
  const presentationPaused=useAiStore(s=>{const task=s.snapshot?.tasks.find(t=>t.id===playback?.taskId);return !!(task?.pauseRequested||task?.presentation?.playbackPaused);});
  const insets = useSidebarInsets();
  const controlInsets = useSidebarInsets({ reserveExpandButtons: true });
  const paintId = useId().replace(/:/g, '');
  const connections = useMemo(() => nodeConnectionCounts(state.edges), [state.edges]);
  const accentLevel = (id?: string) => id && state.nodes[id] ? connectionLevel(connections.get(id) ?? 0) : 'neutral';
  const natural = useMemo(() => buildRenderModel(state, canvas, { zoom: 1, ignoreCollapse: true, skipEdges: true }), [state, canvas]);
  const initialView = () => ({ x: insets.left + 48 - natural.bounds.x, y: 80 - natural.bounds.y, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => loadCanvasViewport(canvas.canvasId, initialView()));
  const viewRef = useRef(view);
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
  const [showOutsideEdges, setShowOutsideEdges] = useState(true);
  const [selected, setSelected] = useState<Hover | null>(null);
  const [multiMode, setMultiMode] = useState(false);
  const [multiIds, setMultiIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ position: Point; items: GraphMenuItem[] } | null>(null);
  const selectedIds = useMemo(() => multiMode ? new Set([...multiIds].filter((id) => !state.edges.some((edge) => edge.edgeId === id))) :
    new Set(selected && selected.kind !== 'edge' ? [selected.id] : []), [selected, multiMode, multiIds, state.edges]);
  const selectedEdgeId = selected?.kind === 'edge' ? selected.id : null;
  const [focus, setFocus] = useState<Focus | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
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
  const aiTargets = new Set(aiTargetRefs);
  const pointer = useRef<Point | null>(null);
  const previousEntries = useRef<{ canvasId: string; ids: Set<string> } | null>(null);
  const previousLod = useRef<Set<string>>(new Set());
  const selectionCallback = useRef(onSelectionChange); selectionCallback.current = onSelectionChange;
  const selectionKey = JSON.stringify(multiMode ? [...multiIds].sort() : selected ? [selected.id] : []);
  useEffect(() => { selectionCallback.current?.(JSON.parse(selectionKey) as string[]); }, [canvas.canvasId, selectionKey]);

  const updateView = useCallback((update: (old: View) => View, coalesce = false) => {
    const next = update(viewRef.current);
    viewRef.current = next;
    if (coalesce) {
      if (viewFrame.current === null) viewFrame.current = requestAnimationFrame(() => { viewFrame.current = null; setView(viewRef.current); saveCanvasViewport(viewportCanvasId.current, viewRef.current); });
    } else {
      if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); viewFrame.current = null;
      setView(next); saveCanvasViewport(viewportCanvasId.current, next);
    }
  }, []);
  useEffect(() => () => { if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); }, []);
  useLayoutEffect(() => {
    if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current); viewFrame.current = null;
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
  const zoomAt = useCallback((screen: Point, factor: number) => {
    clearEnd();
    if (viewRef.current.zoom * factor < .65) setRevealed(new Set());
    updateView((old) => {
      const zoom = Math.max(0.12, Math.min(3, old.zoom * factor));
      return { x: screen.x - (screen.x - old.x) * zoom / old.zoom,
        y: screen.y - (screen.y - old.y) * zoom / old.zoom, zoom };
    });
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
  const clearHover = () => { clearDismiss(); hoverTarget.current = null; setHover(null); clearEnd(); };
  const dismissPreview = () => { previewRequest.current++; setPopup(old => old?.pinned ? old : null); };
  const scheduleDismiss = () => { clearEnd(); clearDismiss(); dismissTimer.current = setTimeout(() => {
    hoverTarget.current = null; setHover(null); dismissPreview();
  }, 250); };
  const bottomInset = Math.max(0, composerBottomInset);
  const visibleHeight = Math.max(180, viewportSize.height - bottomInset);
  const visibleCenter = () => ({ x: (insets.left + viewportSize.width - insets.right) / 2, y: Math.max(100, visibleHeight / 2) });

  const regionSummaries = useMemo(() => {
    const summaries = new Map<string, RegionSummary>();
    natural.blocks.filter(b => b.kind !== 'node').forEach(b => summaries.set(b.id, { nodeCount: 0, regionCount: 0, preview: [] }));
    for (const block of natural.blocks) {
      let parent = natural.parentOf.get(block.id);
      while (parent) {
        const summary = summaries.get(parent);
        if (summary) {
          if (block.kind === 'node') { summary.nodeCount++; if (summary.preview.length < 12) summary.preview.push(block); }
          else summary.regionCount++;
        }
        parent = natural.parentOf.get(parent);
      }
    }
    return summaries;
  }, [natural]);
  const nodeOptions = useMemo(() => getCanvasNodeOptions(state, canvas), [state, canvas]);
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
  const visibleIds = useMemo(() => focus ? getFocusVisibleIds(previewState, previewCanvas, selectedIds, focus.mode) : undefined,
    [previewState, previewCanvas, focus, selectedIds]);
  const forcedIds = useMemo(() => new Set([...(visibleIds ?? []), ...revealed]), [visibleIds, revealed]);
  const projectionRef = useRef<ReturnType<typeof buildRenderModel>>();
  const baseModel = useMemo(() => {
    const next = buildRenderModel(previewState, previewCanvas, { zoom: view.zoom, showOutsideEdges, deferRouting: true,
      previousLod: previousLod.current, visibleIds, focusIds: forcedIds });
    const old = projectionRef.current;
    const sameRect = (a: RenderBlock, b: RenderBlock) => a.id === b.id && a.name === b.name && a.content === b.content && a.collapsed === b.collapsed &&
      a.kind === b.kind && a.parentId === b.parentId && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.width === b.rect.width && a.rect.height === b.rect.height;
    if (old && old.membership === next.membership && old.blocks.length === next.blocks.length && old.blocks.every((b, i) => sameRect(b, next.blocks[i])) &&
      old.edges.length === next.edges.length && old.edges.every((e, i) => e.edge === next.edges[i].edge && e.kind === next.edges[i].kind &&
        e.source.x === next.edges[i].source.x && e.source.y === next.edges[i].source.y && e.target.x === next.edges[i].target.x && e.target.y === next.edges[i].target.y)) return old;
    projectionRef.current = next; return next;
  }, [previewState, previewCanvas, view.zoom, showOutsideEdges, visibleIds, forcedIds]);
  const viewportRect = useMemo(() => canvasViewportBounds(view, viewportSize), [view, viewportSize]);
  const routeOptions = useMemo(() => ({ viewport: viewportRect, labels: true,
    expandedEdgeIds: [...multiIds, ...(selectedEdgeId ? [selectedEdgeId] : []), ...(hover?.kind === 'edge' ? [hover.id] : []),
      ...(popup?.kind === 'edge' ? [popup.id] : []), ...(gesture?.type === 'link' && gesture.edgeId ? [gesture.edgeId] : [])] }),
    [viewportRect, multiIds, selectedEdgeId, hover?.kind === 'edge' ? hover.id : null, popup?.kind === 'edge' ? popup.id : null, gesture?.type === 'link' ? gesture.edgeId : null]);
  const routed = useEdgeRouting(baseModel, routeOptions, Boolean(gesture), canvas.canvasId);
  const model = useMemo(() => ({ ...baseModel, edges: routed.edges }), [baseModel, routed.edges]);
  const visibility = useMemo(() => indexVisibleObjects(model.blocks, model.edges), [model.blocks, model.edges]);
  const mounted = useMemo(() => visibility(viewportRect, new Set([...selectedIds, ...multiIds,
    ...(selected ? [selected.id] : []), ...(hover ? [hover.id] : []), ...(gesture?.type === 'block' ? [gesture.id] : []),
    ...(gesture?.type === 'link' ? [gesture.edgeId, gesture.snap?.id].filter((id): id is string => Boolean(id)) : []), ...(editing.session ? [editing.session.target.id] : [])])),
    [visibility, viewportRect, selectedIds, multiIds, selected, hover, gesture, editing.session?.target.id]);
  const located=useRef('');
  const explicitLocation=useRef(0);
  const [otherTargets,setOtherTargets]=useState(0);
  const targetKey=aiTargetRefs.join('\0');
  useLayoutEffect(()=>setOtherTargets(0),[targetKey,canvas.canvasId,playback?.cursor]);
  useLayoutEffect(()=>{
    const key=JSON.stringify([canvas.canvasId,playback?.taskId,playback?.cursor,targetKey,playback?.locate??0]);
    if(!targetKey||located.current===key||gestureRef.current||editing.session)return;
    const explicit=!!playback?.locate&&explicitLocation.current!==playback.locate;
    if(!explicit&&(playback?.cameraFollow===false||presentationPaused&&playback?.mode!=='review'))return;
    if(explicit){
      // An explicit location request can reveal a folded/filtered object without changing graph data.
      if(focus){setFocus(null);return;}
      const ids=aiTargetRefs.flatMap(id=>{const edge=state.edges.find(e=>e.edgeId===id);return edge?[edge.sourceNodeId,edge.targetNodeId]:[id];});
      const needed=new Set<string>();for(const id of ids){if(!natural.membership.has(id))continue;needed.add(id);let parent=natural.parentOf.get(id);while(parent&&!needed.has(parent)){needed.add(parent);parent=natural.parentOf.get(parent);}}
      if([...needed].some(id=>!revealed.has(id))){setRevealed(old=>new Set([...old,...needed]));return;}
    }
    const blocks=model.blocks,byId=new Map(blocks.map(b=>[b.id,b]));
    const find=(id:string)=>{let block=natural.blocks.find(b=>b.id===id),seen=new Set<string>();
      while(block&&!byId.has(block.id)&&!seen.has(block.id)){seen.add(block.id);block=natural.blocks.find(b=>b.id===block!.parentId);}return block?byId.get(block.id):undefined;};
    const targets=aiTargetRefs.flatMap(id=>{const block=find(id);if(block)return [block];const edge=model.edges.find(e=>e.edge.edgeId===id);return edge?[find(edge.sourceBlockId??edge.edge.sourceNodeId),find(edge.targetBlockId??edge.edge.targetNodeId)].filter((b):b is RenderBlock=>!!b):[];});
    if(!targets.length){setOtherTargets(0);return;}
    located.current=key;if(explicit)explicitLocation.current=playback!.locate;
    const first=targets[explicit?((playback!.locate-1)%targets.length):0].rect,near=targets.filter(b=>Math.hypot(b.rect.x-first.x,b.rect.y-first.y)*viewRef.current.zoom<Math.max(300,viewportSize.width-insets.left-insets.right));
    setOtherTargets(targets.length-near.length);
    const x=Math.min(...near.map(b=>b.rect.x)),y=Math.min(...near.map(b=>b.rect.y)),right=Math.max(...near.map(b=>b.rect.x+b.rect.width)),bottom=Math.max(...near.map(b=>b.rect.y+b.rect.height));
    const left=insets.left+36,top=68,width=Math.max(180,viewportSize.width-insets.left-insets.right-72),height=Math.max(150,viewportSize.height-composerBottomInset-100),v=viewRef.current;
    if(x*v.zoom+v.x>=left&&right*v.zoom+v.x<=left+width&&y*v.zoom+v.y>=top&&bottom*v.zoom+v.y<=top+height)return;
    const zoom=Math.min(v.zoom,Math.max(.55,Math.min(width/Math.max(1,right-x),height/Math.max(1,bottom-y))));
    const dx=x*zoom+v.x<left?left-x*zoom:right*zoom+v.x>left+width?left+width-right*zoom:v.x;
    const dy=y*zoom+v.y<top?top-y*zoom:bottom*zoom+v.y>top+height?top+height-bottom*zoom:v.y;
    updateView(()=>({zoom,x:dx,y:dy}));
  },[targetKey,canvas.canvasId,playback?.taskId,playback?.cursor,playback?.locate,playback?.cameraFollow,playback?.mode,model.blocks,model.edges,presentationPaused,revealed,focus,!!gesture,!!editing.session]);
  useEffect(() => { previousLod.current = model.lodCollapsed; }, [model.lodCollapsed]);

  const fit = () => {
    const element = viewport.current;
    if (!element) return;
    const rect = natural.bounds;
    const top = 70; const bottom = Math.max(top + 100, element.clientHeight - bottomInset - 16);
    const zoom = natural.blocks.length ? Math.min(1.5, Math.max(0.9, 1.12 * Math.min((element.clientWidth - insets.left - insets.right - 100) / Math.max(rect.width, 200), (bottom - top - 48) / Math.max(rect.height, 140)))) : 1;
    updateView(() => ({ x: (insets.left + element.clientWidth - insets.right) / 2 - (rect.x + rect.width / 2) * zoom,
      y: (top + bottom) / 2 - (rect.y + rect.height / 2) * zoom, zoom }));
  };
  useEffect(() => {
    let active = true;
    void editing.finish().then((saved) => {
      if (!active) return;
      previousLod.current = new Set(); setFocus(null); setMenu(null); setRevealed(new Set());
      if (saved) { setSelected(null); setMultiMode(false); setMultiIds(new Set()); }
      updateGesture(null); clearHover(); popupRequest.current++; setPopup(null);
    });
    return () => { active = false; };
  }, [canvas.canvasId]);
  useEffect(() => {
    const exists = (id: string) => natural.membership.has(id) || state.edges.some((edge) => edge.edgeId === id && !edge.removed);
    setSelected((old) => old && !exists(old.id) ? null : old);
    setPopup((old) => old && !exists(old.id) ? null : old);
    setMultiIds((old) => [...old].every(exists) ? old : new Set([...old].filter(exists)));
  }, [natural, state.edges]);
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
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || (!element.contains(target) && !target.closest('[data-canvas-detail], [data-canvas-popup], [data-layout-organize-overlay]'))) return;
      event.preventDefault();
      if (gestureRef.current) return;
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-delta * 0.0015));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { updateGesture(null); clearHover(); dismissPreview(); return; }
      if (event.ctrlKey && ['Minus', 'Equal', 'NumpadSubtract', 'NumpadAdd'].includes(event.code)) {
        event.preventDefault();
        if (!gestureRef.current) zoomAt({ x: (insets.left + element.clientWidth - insets.right) / 2, y: Math.max(100, (element.clientHeight - bottomInset) / 2) }, ['Minus', 'NumpadSubtract'].includes(event.code) ? 1 / 1.15 : 1.15);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || gestureRef.current || editable(event.target) || editable(document.activeElement)) return;
      const movement: Record<string, Point> = { a: { x: 42, y: 0 }, w: { x: 0, y: 42 }, s: { x: 0, y: -42 }, d: { x: -42, y: 0 } };
      const delta = movement[event.key.toLowerCase()];
      if (!delta) return;
      event.preventDefault(); updateView((old) => ({ ...old, x: old.x + delta.x, y: old.y + delta.y }));
    };
    const onBlur = () => { updateGesture(null); clearHover(); dismissPreview(); };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey); window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onBlur); };
  }, [zoomAt, updateView, insets.left, insets.right, bottomInset]);
  useEffect(() => () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  useEffect(() => {
    if (!hover || gesture || hoverTarget.current?.id !== hover.id || hoverTarget.current.kind !== hover.kind) return;
    const exists = hover.id === canvas.canvasId || (hover.kind === 'edge' ? model.edges.some((edge) => edge.edge.edgeId === hover.id)
      : hover.kind === 'node' ? natural.membership.has(hover.id) : model.blocks.some((block) => block.id === hover.id));
    if (!exists) { clearHover(); return; }
    const frame = requestAnimationFrame(() => {
      // Pointer events can change targets before React commits the next hover.
      // An older frame must not dismiss the preview opened by that event.
      if (hoverTarget.current?.id !== hover.id || hoverTarget.current.kind !== hover.kind) return;
      if (!pointer.current) return;
      const hit = document.elementFromPoint(pointer.current.x, pointer.current.y);
      if (hit?.closest('[data-canvas-detail], [data-canvas-popup]')) return;
      const item = hit?.closest('[data-hover-id]');
      let id = item?.getAttribute('data-hover-id') ?? (hit === viewport.current ? canvas.canvasId : null);
      if (hit?.hasAttribute('data-edge-hit')) {
        const edge = model.edges.find(edge => edge.edge.edgeId === id);
        if (edge) id = nearestEdge(edge, worldPoint(pointer.current)).edge.edgeId;
      }
      if (id !== hover.id) { clearHover(); dismissPreview(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [view, model, gesture, hover?.kind, hover?.id]);

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
    const width = Math.min(detailSize.width, Math.max(230, viewportSize.width - 16));
    const height = Math.min(detailSize.height, Math.max(150, visibleHeight - 16));
    const x = cursor.x + 16 + width <= viewportSize.width - 8 ? cursor.x + 16 : cursor.x - width - 16;
    const y = cursor.y + 16 + height <= visibleHeight - 8 ? cursor.y + 16 : cursor.y - height - 16;
    return { x: Math.max(8, Math.min(viewportSize.width - width - 8, x)),
      y: Math.max(8, Math.min(visibleHeight - height - 8, y)) };
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
  useEffect(() => {
    const altPreview = (event: KeyboardEvent) => {
      if (event.key !== 'Alt' || event.repeat || gestureRef.current || !pointer.current || editable(document.activeElement)) return;
      const hit = document.elementFromPoint(pointer.current.x, pointer.current.y);
      if (!hit || !viewport.current?.contains(hit)) return;
      const target = hit.closest('[data-hover-id]');
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
  const selectItem = async (kind: Hover['kind'], id: string, cursor?: Point, force = false): Promise<boolean> => {
    if (multiMode && !force) return false;
    if (editing.session?.target.id !== id && !await editing.finish()) return false;
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
    setSelected(old => old?.id === item.id && old.kind === item.kind ? old : { ...item });
    return true;
  };
  const selectByPointer = async (kind: Hover['kind'], id: string, ctrlKey = false, cursor?: Point): Promise<boolean> => {
    if (ctrlKey) {
      if (!await editing.finish()) return false;
      popupRequest.current++;
      setPopup(old => old?.kind === kind && old.id === id ? old : null);
      const added = useAiStore.getState().toggleInputRef(canvas.canvasId, id);
      setSelected(null); setMultiMode(true);
      setMultiIds((old) => { const next = new Set(old); if (added) next.add(id); else next.delete(id); return next; });
      return false;
    }
    if (multiMode) return false;
    return selectItem(kind, id, cursor);
  };
  const clickItem = async (kind: Hover['kind'], id: string, cursor: Point, altKey = false, force = false) => {
    if (multiMode && !force) {
      if (!await editing.finish()) return;
      popupRequest.current++;
      setPopup(old => old?.kind === kind && old.id === id ? old : null);
    } else if (!await selectItem(kind, id, cursor, force)) return;
    if (altKey) await openDetail(kind, id, cursor, true);
  };
  const capture = (event: ReactPointerEvent, next: Gesture) => {
    event.preventDefault(); event.stopPropagation();
    if (next.type !== 'edgePress') clearHover();
    viewport.current?.setPointerCapture(event.pointerId); updateGesture(next);
  };
  const backgroundDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-canvas-interactive]'))) return;
    capture(event, { type: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startView: viewRef.current });
  };
  const blockDown = (event: ReactPointerEvent, block: RenderBlock) => {
    if (event.button !== 0) return;
    const kind = block.kind === 'node' ? 'node' : 'record';
    if (event.ctrlKey) { event.preventDefault(); event.stopPropagation(); selectByPointer(kind, block.id, true); return; }
    const pos = previewState.documents[block.parentId]?.placements[block.id] ?? previewCanvas.placements[block.id];
    if (!pos) return;
    capture(event, { type: 'block', kind, pointerId: event.pointerId, id: block.id, parentId: block.parentId,
      startClient: { x: event.clientX, y: event.clientY }, startLocal: pos, zoom: view.zoom, offset: { x: 0, y: 0 } });
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
   *  the user aimed at. Only a press pays for this — a hover keeps the band it
   *  entered, so moving the pointer stays a cheap operation. */
  const nearestEdge = (rendered: RenderEdge, world: Point, slack = 8): RenderEdge => {
    let best = rendered, bestDistance = distanceToRoute(rendered.route, world), tried = 0;
    for (const other of renderedEdges) {
      if (other === rendered || other.kind !== rendered.kind || tried >= 12) continue;
      const bounds = routeBounds(other.route);
      if (world.x < bounds.x - slack || world.x > bounds.x + bounds.width + slack ||
        world.y < bounds.y - slack || world.y > bounds.y + bounds.height + slack) continue;
      tried += 1;
      const distance = distanceToRoute(other.route, world);
      if (distance < bestDistance - .5) { best = other; bestDistance = distance; }
    }
    return best;
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
      setMenu({ position: { x: event.clientX, y: event.clientY }, items: rendered.aggregateEdgeIds.map(id => {
        const edge = state.edges.find(e => e.edgeId === id)!;
        return { key: id, label: `${endpointName(edge.sourceNodeId)} ${edge.directed ? '→' : '—'} ${endpointName(edge.targetNodeId)}${edge.edgeContent ? ` · ${edge.edgeContent.slice(0, 35)}` : ''}`,
          run: () => { if (event.ctrlKey) void selectByPointer('edge', id, true);
            else void clickItem('edge', id, { x: event.clientX, y: event.clientY }, event.altKey); } };
      }) }); return;
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
      if (event.target instanceof Element && !event.target.closest('[data-canvas-interactive]')) showHover('record', canvas.canvasId, event);
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
        const move: PendingMove = { token: ++moveSequence.current, canvasId: canvas.canvasId, id: current.id, parentId: current.parentId,
          point: { x: current.startLocal.x + dx, y: current.startLocal.y + dy } };
        // Keep the dropped position visible until the acknowledged graph revision arrives.
        setPendingMoves(old => [...old, move]);
        try {
          const result = await onMoveBlock(move.id, move.parentId, move.point);
          setPendingMoves(old => result?.ok ? old.map(item => item.token === move.token ? { ...item, committedRevision: result.graphRevision } : item)
            : old.filter(item => item.token !== move.token));
        } catch { setPendingMoves(old => old.filter(item => item.token !== move.token)); }
      }
      else void clickItem(current.kind, current.id, cursor, event.altKey);
    } else if (current.type === 'edgePress') {
      if (!current.cancelled) void clickItem('edge', current.edgeId, cursor, event.altKey);
    } else if (current.type === 'link' && current.hasLeft) {
      const snap = nearestPort(model.blocks.filter((block) => block.kind === 'node'), worldPoint({ x: event.clientX, y: event.clientY }), view.zoom, current.otherId);
      if (snap) {
        if (current.edgeId && current.end) {
          const change: PendingReconnect = { token: ++moveSequence.current, canvasId: canvas.canvasId,
            edgeId: current.edgeId, end: current.end, nodeId: snap.id };
          setPendingReconnects(old => [...old, change]);
          void selectItem('edge', current.edgeId, cursor);
          try {
            const result = await onReconnectEdge(change.edgeId, change.end, change.nodeId);
            setPendingReconnects(old => result?.ok ? old.map(item => item.token === change.token ? { ...item, committedRevision: result.graphRevision } : item)
              : old.filter(item => item.token !== change.token));
          } catch { setPendingReconnects(old => old.filter(item => item.token !== change.token)); }
        }
        else if (current.sourceId && current.sourceSide) {
          try {
            const id = await onCreateEdge({ sourceNodeId: current.sourceId, targetNodeId: snap.id, directed: current.directed });
            if (id) await selectItem('edge', id, cursor, true);
          } catch { /* The mutation owner exposes errors; no edge is selected before a commit. */ }
        }
      }
    } else if (current.type === 'pan' && Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y) < 3 && await editing.finish()) {
      setSelected(null); setMultiMode(false); setMultiIds(new Set());
      popupRequest.current++;
      if (event.altKey) await openDetail('record', canvas.canvasId, cursor, true);
      else setPopup(null);
    }
  };
  const navigateTo = async (id: string, forceSelect = false) => {
    if (id === canvas.canvasId) { fit(); return; }
    const block = natural.blocks.find((item) => item.id === id);
    if (!block) { if (state.edges.some((edge) => edge.edgeId === id)) selectItem('edge', id, undefined, forceSelect); return; }
    if (!await editing.finish()) return;
    popupRequest.current++;
    setPopup(old => old?.id === id ? old : null);
    clearHover(); setFocus(null);
    const ancestors = new Set<string>([id]); let parent = natural.parentOf.get(id);
    while (parent) { ancestors.add(parent); parent = natural.parentOf.get(parent); }
    setRevealed(ancestors);
    const zoom = Math.max(.78, view.zoom); const center = visibleCenter();
    const nextView = { zoom, x: center.x - (block.rect.x + block.rect.width / 2) * zoom, y: center.y - (block.rect.y + block.rect.height / 2) * zoom };
    updateView(() => nextView);
    if (!multiMode || forceSelect) {
      if (forceSelect) { setMultiMode(false); setMultiIds(new Set()); }
      const kind = block.kind === 'node' ? 'node' : 'record';
      const screen = detailPosition(kind, id, center);
      setSelected({ kind, id, position: attachDetail(kind, id, screen, nextView) });
    }
  };
  useEffect(() => { if (focusRequest) navigateTo(focusRequest.id, focusRequest.forceSelect); }, [focusRequest?.sequence]);
  const openContextMenu = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('[data-canvas-detail], [data-canvas-popup], [data-graph-dialog], [data-graph-menu]') || editable(target)) return;
    event.preventDefault();
    if (Date.now() < suppressContextUntil.current || gestureRef.current?.type === 'link' || target.closest('[data-port-node]')) return;
    const point = worldPoint({ x: event.clientX, y: event.clientY });
    const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
    const edgeId = target.closest('[data-edge-id]')?.getAttribute('data-edge-id');
    const region = model.blocks.filter((block) => block.kind !== 'node' && point.x >= block.rect.x && point.x <= block.rect.x + block.rect.width &&
      point.y >= block.rect.y && point.y <= block.rect.y + block.rect.height).sort((a, b) => b.depth - a.depth)[0];
    const parentId = nodeId ? model.blocks.find((block) => block.id === nodeId)?.parentId ?? canvas.canvasId : region?.id ?? canvas.canvasId;
    const menuPosition = { x: event.clientX, y: event.clientY };
    if (!await editing.finish()) return;
    const action = (request: Omit<GraphActionRequest, 'origin'>) => () => onAction({ ...request, origin: 'canvas' });
    const items: GraphMenuItem[] = [
      { key: 'createNode', label: '创建节点', run: action({ type: 'createNode', parentId, point }) },
      { key: 'createEdge', label: '创建边', run: action({ type: 'createEdge', sourceId: nodeId ?? undefined }) },
      { key: 'createSubgraph', label: '创建子图', run: action({ type: 'createSubgraph', parentId, point }) },
    ];
    if (onCreateTemporary) items.push({ key: 'createTemporary', label: '创建临时会话', run: () => onCreateTemporary(menuPosition) });
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
  const activateFocus = (mode: Focus['mode']) => {
    setFocus(old => old?.mode === mode ? null : { mode }); clearHover();
    if (focus?.mode !== mode && selectedIds.size && view.zoom < 0.9) zoomAt(visibleCenter(), 0.9 / view.zoom);
  };
  const toggleRecord = (block: RenderBlock) => {
    clearHover();
    if (block.collapsed && !canvas.collapsed[block.id]) {
      zoomAt({ x: view.x + block.anchor.x * view.zoom, y: view.y + block.anchor.y * view.zoom }, Math.max(1.1, 0.8 / view.zoom));
    } else { onToggleCollapse(block.id); if (block.collapsed && view.zoom < 0.78) zoomAt({ x: view.x + block.anchor.x * view.zoom, y: view.y + block.anchor.y * view.zoom }, 0.78 / view.zoom); }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDropActive(false);
    const id = event.dataTransfer.getData('application/x-qixue-document');
    if (id) onAddDocument(id, worldPoint({ x: event.clientX, y: event.clientY }));
  };

  const endpointName = (id: string) => state.nodes[id]?.name ?? state.documents[id]?.name ?? state.canvases.flatMap((item) => canvasDirectoryEntries(item)).find(([key]) => key === id)?.[1].name ?? id;
  const detailFor = (hover: Hover): CanvasDetail | null => {
    if (hover.kind === 'record' && hover.id === canvas.canvasId) return { kind: 'record', id: canvas.canvasId, title: canvas.canvasName,
      accent: subgraphAccent, meta: canvas.mode === 'design' ? '设计画布' : '探索画布',
      content: `${natural.blocks.filter(block => block.kind === 'node').length} 个节点 · ${state.edges.filter(edge => !edge.removed && natural.membership.has(edge.sourceNodeId) && natural.membership.has(edge.targetNodeId)).length} 条关系` };
    if (hover.kind === 'node') { const node = state.nodes[hover.id]; return node ? { kind: 'node', id: node.nodeId, title: node.name, content: node.content, meta: node.design ? DESIGN_LABELS[node.design.type] : undefined, accent: nodeAccents[connectionLevel(connections.get(node.nodeId) ?? 0)] } : null; }
    if (hover.kind === 'edge') {
      const edge = state.edges.find((item) => item.edgeId === hover.id); if (!edge) return null;
      const rendered = model.edges.find((item) => item.edge.edgeId === hover.id);
      return { kind: 'edge', id: edge.edgeId, title: `${endpointName(edge.sourceNodeId)} ${edge.directed ? '→' : '—'} ${endpointName(edge.targetNodeId)}`, content: edge.edgeContent, accent: edgeAccents[accentLevel(rendered?.sourceBlockId ?? edge.sourceNodeId)],
        targetAccent: edgeAccents[accentLevel(rendered?.targetBlockId ?? edge.targetNodeId)], meta: `${rendered?.kind === 'outside' ? '另一端在画布外' : rendered?.kind === 'filtered' ? '另一端在画布内，当前被过滤' : '画布内关系'}\n连接点：自动（由当前布局决定）` };
    }
    const block = model.blocks.find((item) => item.id === hover.id) ?? natural.blocks.find((item) => item.id === hover.id);
    return block ? { kind: 'record', id: block.id, title: block.name, accent: state.documents[block.id]?.kind === 'document' ? documentAccent : subgraphAccent, content: state.documents[block.id]?.metadata.description ?? canvasDirectory(canvas, block.id)?.description ?? '', meta: block.collapsed ? '已折叠' : '已展开' } : null;
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
    const priority = (id: string) => id === selectedEdgeId || multiIds.has(id) ? 2 : hover?.kind === 'edge' && hover.id === id ? 1 : 0;
    return priority(a.edge.edgeId) - priority(b.edge.edgeId);
  });
  // Use routed endpoints, including live move/reconnect previews. Shared
  // attachment points get one dot instead of accumulating a brighter halo.
  const connectionPoints = new Map<string, Map<string, Point>>();
  for (const rendered of renderedEdges) {
    for (const end of ['source', 'target'] as const) {
      const reconnecting = gesture?.type === 'link' && gesture.edgeId === rendered.edge.edgeId && gesture.end === end;
      const id = reconnecting ? gesture.snap?.id : rendered[`${end}BlockId`];
      if (!id || !state.nodes[id]) continue;
      const point = rendered[end];
      const points = connectionPoints.get(id) ?? new Map<string, Point>();
      points.set(`${point.x.toFixed(2)},${point.y.toFixed(2)}`, point);
      connectionPoints.set(id, points);
    }
  }
  const details = popup ? [popup] : [];

  return <GraphAppearanceProvider state={state}><CanvasEditingProvider value={editing}><div ref={viewport} data-canvas-viewport data-canvas-id={canvas.canvasId} data-canvas-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y} data-canvas-bottom-inset={bottomInset}
    onPointerDownCapture={()=>usePlaybackStore.getState().set(canvas.canvasId,{cameraFollow:false})}
    onWheelCapture={()=>usePlaybackStore.getState().set(canvas.canvasId,{cameraFollow:false})}
    data-selected-id={selected?.id ?? ''} data-selected-kind={selected?.kind ?? ''} data-selected-mode={multiMode ? 'multi' : selected ? 'single' : 'none'} data-selected-count={multiMode ? multiIds.size : selected ? 1 : 0}
    data-route-cache-hits={routed.stats?.cacheHits ?? 0} data-rerouted-edges={routed.stats?.rerouted ?? 0} data-route-fallbacks={routed.stats?.fallbacks ?? 0}
    data-route-version={routed.sequence} data-route-validated={routed.stats?.validated ?? 0} data-route-ready={Boolean(routed.stats)}
    data-pending-routes={routed.stats?.pending ?? 0}
    data-mounted-blocks={mounted.blocks.length} data-mounted-edges={mounted.edges.length}
    className="absolute inset-0 z-0 overflow-hidden touch-none select-none" style={{ userSelect: 'none', cursor: gesture?.type === 'pan' ? 'grabbing' : undefined }}
    onPointerDown={backgroundDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    onPointerLeave={scheduleDismiss}
    onPointerCancel={() => updateGesture(null)} onLostPointerCapture={() => updateGesture(null)}
    onContextMenu={openContextMenu}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-qixue-document')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }} onDrop={drop}>
    <CanvasReviewOverlay canvasId={canvas.canvasId} model={model} view={view} />
    {dropActive && <div className="absolute inset-3 z-30 pointer-events-none rounded-2xl border-2 border-dashed border-blue-400/70 bg-blue-400/5" />}
    {model.blocks.length === 0 && <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-sm text-slate-500">从右侧选择或拖入图文档</div>}
    <div data-canvas-world className="absolute left-0 top-0 pointer-events-none" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: '0 0' }}>
      {mounted.blocks.filter(block => block.kind !== 'node').sort((a, b) => a.depth - b.depth).map(block =>
        <CanvasRegion key={block.id} block={block} zoom={view.zoom} document={state.documents[block.id]?.kind === 'document'}
          active={selectedIds.has(block.id) || hover?.id === block.id} selected={selectedIds.has(block.id)} disabled={Boolean(focus)}
          summary={regionSummaries.get(block.id) ?? { nodeCount: 0, regionCount: 0, preview: [] }} edges={state.edges}
          onPointerDown={event => blockDown(event, block)}
          onSelect={event => { if (event.detail === 0) selectByPointer('record', block.id, false, { x: event.clientX, y: event.clientY }); }} onToggle={() => toggleRecord(block)}
          onEnter={event => showHover('record', block.id, event, block)} onLeave={scheduleDismiss} />)}
      <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width="1" height="1" style={{ zIndex: 100 }}>
        <defs>
          {Object.entries(edgeAccents).map(([level, color]) =>
            <marker key={level} id={`${paintId}-arrow-${level}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 L 2 5 z" fill={color} /></marker>)}
          {renderedEdges.map((rendered, index) => <linearGradient key={rendered.edge.edgeId} id={`${paintId}-edge-${index}`} gradientUnits="userSpaceOnUse"
            x1={rendered.source.x} y1={rendered.source.y} x2={rendered.target.x} y2={rendered.target.y}>
            <stop offset="0" stopColor={edgeAccents[accentLevel(rendered.sourceBlockId)]} />
            <stop offset="1" stopColor={edgeAccents[accentLevel(rendered.targetBlockId)]} />
          </linearGradient>)}
        </defs>
        {mounted.blocks.filter((block) => aiTargets.has(block.id)).map((block) => <g key={`ai:${block.id}`} data-ai-highlighted={block.id}><rect x={block.rect.x - 3} y={block.rect.y - 3} width={block.rect.width + 6} height={block.rect.height + 6} rx={12} fill="none" stroke="#f6c453" strokeWidth={2 / view.zoom} /></g>)}
        {renderedEdges.map((rendered, index) => {
          const { edge, kind, source, target, freeEnd, label } = rendered;
          const edgeSelected = selectedEdgeId === edge.edgeId || multiIds.has(edge.edgeId);
          const active = hover?.kind === 'edge' && hover.id === edge.edgeId || edgeSelected;
          const aiHighlighted = aiTargets.has(edge.edgeId);
          const dragging = gesture?.type === 'link' && gesture.edgeId === edge.edgeId;
          const indicator = nearEnd?.edgeId === edge.edgeId ? rendered[nearEnd.end] : null;
          const arrowLevel = dragging ? 'drag' : aiHighlighted ? 'ai' : active ? 'active' : kind === 'outside' ? 'outside' : accentLevel(rendered.targetBlockId);
          const stroke = dragging || aiHighlighted || active || kind === 'outside' ? edgeAccents[arrowLevel]
            : source.x === target.x && source.y === target.y ? edgeAccents[accentLevel(rendered.sourceBlockId)] : `url(#${paintId}-edge-${index})`;
          return <g key={edge.edgeId} data-canvas-interactive data-hover-id={edge.edgeId} data-hover-kind="edge" data-edge-id={edge.edgeId}
            data-selected={edgeSelected} data-preselected={hover?.kind === 'edge' && hover.id === edge.edgeId} data-ai-highlighted={aiHighlighted ? edge.edgeId : undefined}
            data-aggregate-count={rendered.aggregateEdgeIds?.length ?? 1} data-route-fallback={rendered.route.fallback || undefined}
            data-route-provisional={rendered.route.provisional || undefined}
            opacity={(selectedEdgeId || hover?.kind === 'edge') && !active ? .4 : 1}
            onPointerEnter={(event) => edgeMove(event, rendered)} onPointerMove={(event) => edgeMove(event, rendered)} onPointerLeave={scheduleDismiss}
            onPointerDown={(event) => edgeDown(event, rendered)}>
            <path data-edge-visible data-reconnect-preview={dragging || undefined} data-reconnect-preview-mode={dragging ? gesture.snap ? 'snapped' : 'free' : undefined} d={rendered.route.path} fill="none" stroke={stroke}
              vectorEffect="non-scaling-stroke"
              strokeWidth={active || aiHighlighted ? 2.2 : 1.4} strokeDasharray={kind === 'outside' ? '5 5' : undefined} strokeLinecap="round" strokeLinejoin="round"
              markerEnd={edge.directed ? `url(#${paintId}-arrow-${arrowLevel})` : undefined}
              style={{ filter: active ? 'drop-shadow(0 0 3px #9bbff560)' : undefined }} />
            {freeEnd && kind !== 'filtered' && <circle cx={freeEnd === 'target' ? target.x : source.x} cy={freeEnd === 'target' ? target.y : source.y} r={3 / view.zoom} fill={kind === 'outside' ? '#94a3b8' : '#93c5fd'} />}
            {indicator && !dragging && <circle data-edge-end-indicator cx={indicator.x} cy={indicator.y} r={7 / view.zoom} fill="#0b1220" stroke="#fbbf24" strokeWidth={2 / view.zoom} />}
            {dragging && gesture?.type === 'link' && <circle cx={gesture.end === 'source' ? source.x : target.x} cy={gesture.end === 'source' ? source.y : target.y} r={6 / view.zoom} fill="#34d399" />}
            {label && (edge.edgeContent?.trim() || rendered.aggregateEdgeIds || active) && <g data-edge-label style={{ pointerEvents: 'all', cursor: 'pointer' }}>
              {Math.hypot(label.anchor.x - label.point.x, label.anchor.y - label.point.y) > Math.max(18, label.rect.height * .8) &&
                <line x1={label.anchor.x} y1={label.anchor.y} x2={label.point.x} y2={label.point.y} stroke="#7287a5" strokeOpacity=".5" strokeWidth="0.8" />}
              <rect x={label.rect.x} y={label.rect.y} width={label.rect.width} height={label.rect.height} rx="6" fill="#0d1727" stroke={active ? '#9bbff580' : '#9bbff520'} />
              <foreignObject x={label.rect.x} y={label.rect.y} width={label.rect.width} height={label.rect.height}>
                {rendered.aggregateEdgeIds || edge.membershipFor ? <div className="px-2 h-full overflow-hidden text-center text-slate-300"><CanvasTextPreview zoom={view.zoom} textRole="edge" {...canvasTextMetrics('edge', view.zoom)} center>{label.text}</CanvasTextPreview></div> :
                  <CanvasTextField target={{ kind: 'edge', id: edge.edgeId, field: 'edgeContent' }} value={edge.edgeContent} surface="canvas"
                    zoom={view.zoom} fontSize={11} wrap maxLines={3}
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
        {focus && renderedEdges.filter(edge => edge.kind === 'filtered' && edge.freeEnd).map(rendered => {
          const end = rendered.freeEnd!;
          const id = end === 'source' ? rendered.edge.sourceNodeId : rendered.edge.targetNodeId;
          const point = rendered[end], other = rendered[end === 'source' ? 'target' : 'source'];
          const angle = Math.atan2(point.y - other.y, point.x - other.x) * 180 / Math.PI;
          return <g key={`nav:${rendered.edge.edgeId}`} data-canvas-interactive data-edge-nav={id} data-edge-nav-end={end}
            data-hover-id={id} data-hover-kind="node" role="button" tabIndex={0} aria-label={`选中节点：${endpointName(id)}`}
            className="canvas-edge-nav" transform={`translate(${point.x} ${point.y}) rotate(${angle}) scale(${1 / view.zoom})`}
            style={{ pointerEvents: 'all', cursor: 'pointer' }}
            onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
            onClick={event => { event.stopPropagation();
              if (event.ctrlKey) void selectByPointer('node', id, true);
              else void clickItem('node', id, { x: event.clientX, y: event.clientY }, event.altKey, true);
            }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation();
              void clickItem('node', id, { x: view.x + point.x * view.zoom, y: view.y + point.y * view.zoom }, event.altKey, true); } }}
            onPointerEnter={event => showHover('node', id, event)} onPointerMove={event => showHover('node', id, event)} onPointerLeave={scheduleDismiss}>
            <title>{`选中节点：${endpointName(id)}`}</title>
            <circle r="11" fill="#101e32" stroke="#93c5fd" strokeWidth="1.25" />
            <path d="M -5 0 H 5 M 0 -5 L 5 0 L 0 5" fill="none" stroke="#dbeafe" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </g>;
        })}
        {linkPreview && gesture?.type === 'link' && !gesture.edgeId && <path data-link-preview d={linkPreview.path} fill="none" stroke={gesture.snap ? '#75d7b0' : nodeAccents.high} strokeWidth="2.5" strokeDasharray="6 4" markerEnd={gesture.directed ? `url(#${paintId}-arrow-${gesture.snap ? 'drag' : 'high'})` : undefined} />}
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
          data-selected={selectedIds.has(block.id)} data-preselected={preselected}
          data-connection-count={connectionCount} data-connection-level={level}
          className="canvas-node absolute pointer-events-auto cursor-grab active:cursor-grabbing"
          style={{ '--node-accent': nodeAccents[level], left: block.rect.x, top: block.rect.y, width: block.rect.width, height: block.rect.height, zIndex: 110 + block.depth } as CSSProperties}
          onPointerDown={(event) => blockDown(event, block)} onDragStart={(event) => event.preventDefault()}
          onPointerEnter={(event) => showHover('node', block.id, event, block)} onPointerMove={(event) => { if (!gestureRef.current) showHover('node', block.id, event, block); }} onPointerLeave={scheduleDismiss}>
          {state.nodes[block.id]?.design && <span data-design-badge className="absolute -top-2 right-2 rounded border border-slate-600 bg-slate-900 px-1 text-[10px] leading-4 text-blue-200 pointer-events-none">{DESIGN_LABELS[state.nodes[block.id].design!.type]}</span>}
          <div className="h-full px-3 overflow-hidden rounded-xl flex flex-col" style={{ paddingTop: paddingY, paddingBottom: paddingY }}>
            <CanvasTextField target={{ kind: 'node', id: block.id, field: 'name' }} value={block.name} surface="canvas" multiline={false}
              zoom={view.zoom} fontSize={14} maxLines={view.zoom < .55 ? 1 : undefined} wrap
              style={{ height: titleHeight, flexShrink: 0 }}
              className="canvas-node-title" placeholder="未命名节点" onActivate={(ctrl) => selectByPointer('node', block.id, ctrl)} />
            <CanvasTextField target={{ kind: 'node', id: block.id, field: 'content' }} value={block.content ?? ''} surface="canvas"
              zoom={view.zoom} fontSize={12} wrap
              className="canvas-node-summary mt-1 flex-1 min-h-0" placeholder="Alt + 单击查看或编辑内容" onActivate={(ctrl) => selectByPointer('node', block.id, ctrl)} />
          </div>
          {Array.from(connectionPoints.get(block.id) ?? []).map(([key, point]) => <span key={key} aria-hidden="true" data-node-connection-point
            className="canvas-node-connection-point" style={{ left: point.x - block.rect.x - 1, top: point.y - block.rect.y - 1, width: pointSize, height: pointSize }} />)}
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
    {multiMode && <div className="absolute top-16 z-20 rounded border border-blue-400/30 bg-slate-950/80 px-3 py-1.5 text-xs text-blue-100 pointer-events-none" style={{ left: insets.left + 12 }}>多选 {multiIds.size} 项 · Ctrl 添加/取消 · 单击空白退出</div>}
    {otherTargets>0&&<div className="absolute top-16 left-1/2 text-xs text-amber-200 pointer-events-none">另有 {otherTargets} 处指定对象，未缩小整张画布</div>}
    {editing.error && <div role="alert" data-canvas-edit-error className="absolute top-16 z-30 max-w-sm rounded-lg border border-red-400/40 bg-slate-950/95 px-3 py-2 text-xs text-red-200" style={{ right: insets.right + 16 }}>{editing.error}</div>}
    {createPortal(<div data-canvas-interactive data-canvas-toolbar className="canvas-toolbar fixed top-4 z-[170] flex flex-wrap items-center justify-end gap-1 p-1"
      style={{ right: controlInsets.right + 16, width: 'max-content', maxWidth: `calc(100% - ${controlInsets.left + controlInsets.right + 32}px)` }}>
      <button type="button" data-canvas-filter="selected" aria-pressed={focus?.mode === 'selected'} className={`px-2 py-1.5 rounded-lg text-xs ${focus?.mode === 'selected'?'text-blue-200 bg-blue-500/20 ring-1 ring-blue-400/40':'text-slate-300 hover:bg-white/10'}`} onClick={() => activateFocus('selected')}>仅选中</button>
      <button type="button" data-canvas-filter="neighbors" aria-pressed={focus?.mode === 'neighbors'} className={`px-2 py-1.5 rounded-lg text-xs ${focus?.mode === 'neighbors'?'text-blue-200 bg-blue-500/20 ring-1 ring-blue-400/40':'text-slate-300 hover:bg-white/10'}`} onClick={() => activateFocus('neighbors')}>邻域</button>
      <button type="button" className="p-2 rounded-lg hover:bg-white/10" title="适应画布" onClick={fit}><Maximize2 size={15} /></button>
      <button type="button" className={`px-2 py-1.5 rounded-lg text-xs ${showOutsideEdges ? 'text-blue-200 bg-blue-500/15' : 'text-slate-400 hover:bg-white/10'}`} onClick={() => setShowOutsideEdges((old) => !old)} title="切换画布外的边">画布外边</button>
      <button type="button" className="p-2 rounded-lg hover:bg-white/10" title="另存为画布" onClick={onSaveCanvas}><Save size={15} /></button>
    </div>,document.body)}
    {details.map((item) => {
      const detail = detailFor(item); if (!detail) return null;
      const isSelected = Boolean(item.pinned);
      return <CanvasDetailPanel key={`${item.kind}:${item.id}`} detail={detail} position={panelPosition(item)} size={detailSize} selected={isSelected}
        maxWidth={viewportSize.width - 16} maxHeight={(item.manual?viewportSize.height:visibleHeight) - 16}
        edge={item.kind === 'edge' ? state.edges.find((edge) => edge.edgeId === item.id) : undefined}
        designDetails={item.kind === 'node' && state.nodes[item.id]?.design ? <DesignDetails data={state.nodes[item.id].design!} endpointName={id => natural.membership.has(id) ? endpointName(id) : '当前画布外的关联内容'} onEdit={() => onAction({ type: 'editDesign', origin: 'canvas', id: item.id })} /> : undefined}
        nodeOptions={nodeOptions} endpointName={endpointName} onEdgeChange={(patch) => onUpdateEdge(item.id, patch)}
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
