import { useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, RefObject } from 'react';
import type { RenderBlock } from '@/v3/layout';
import type { Point } from '@/v3/types';
import { createSpatialProjection } from './spatialProjection';

export interface SpatialEditActions {
  onBeginMove: (block: RenderBlock, pointerId: number, client: Point) => boolean;
  onMoveBlock: (offset: Point | null, done: boolean) => void;
  onMenu: (client: Point, world: Point, id: string | null, region?: RenderBlock) => void;
  onConnect: (source: string, target: string, directed: boolean) => Promise<void>;
  onReconnect: (edge: string, end: 'source' | 'target', node: string) => Promise<unknown>;
}
export interface LinkHandle { end: 'create' | 'source' | 'target'; owner: string; fixedId: string; fixed: Point; at: Point }
interface Contact {
  start: Point; last: Point; id: string | null; button: number; moved: boolean; toggle: boolean;
  mode: 'pan' | 'orbit' | 'block' | 'link'; editing: boolean; handle?: LinkHandle; directed: boolean;
}
interface Props extends SpatialEditActions {
  observeOnly?: boolean;
  moveBlocks?: boolean;
  surface: RefObject<SVGSVGElement>;
  projection: ReturnType<typeof createSpatialProjection>;
  blocks: ReadonlyMap<string, RenderBlock>;
  menuRegionAt?: (point: Point) => RenderBlock | undefined;
  heightOf: (id: string) => number;
  handles: readonly LinkHandle[];
  pan: (dx: number, dy: number) => void;
  orbit: (dx: number, dy: number, pivotId?: string | null) => void;
  pinch: (center: Point, ratio: number, dx: number, dy: number) => void;
  onSelect: (id: string | null, toggle?: boolean, client?: Point, altKey?: boolean) => void;
  onHoverEdge: (id: string | null) => void;
  onHoverObject: (id: string | null, event: PointerEvent) => void;
  onLeaveObject: () => void;
}
const clientPoint = (event: { clientX: number; clientY: number }) => ({ x: event.clientX, y: event.clientY });

export function useSpatialPointer({ surface, projection, blocks, menuRegionAt, heightOf, handles, pan, orbit, pinch, observeOnly, moveBlocks = true,
  onBeginMove, onMoveBlock, onMenu, onConnect, onReconnect, onSelect, onHoverEdge, onHoverObject, onLeaveObject }: Props) {
  const contacts = useRef(new Map<number, Contact>());
  const suppressMenu = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState<{ from: Point; to: Point; snapped: boolean } | null>(null);
  const screen = (client: Point): Point => {
    const r = surface.current!.getBoundingClientRect();
    return { x: client.x - r.left, y: client.y - r.top };
  };
  const pick = (target: EventTarget | null) => {
    if (!(target instanceof Element) || !surface.current?.contains(target)) return null;
    const item = target.closest('[data-space-object]');
    if (item) return { id: item.getAttribute('data-space-object')!, edge: item.matches('[data-spatial-edge], [data-spatial-edge-label], [data-semantic-relation]') };
    return null;
  };
  const showMenu = (client: Point, id: string | null) => {
    if (observeOnly) {
      if (id) onSelect(id, false, client, true);
      return;
    }
    const point = screen(client), block = id ? blocks.get(id) : undefined;
    let region = block?.kind === 'node' ? blocks.get(block.parentId) : block;
    if (!id && menuRegionAt) region = menuRegionAt(point);
    else if (!block && !menuRegionAt) {
      // Several horizontal planes can cover one pixel. Find the foremost containing
      // region, preferring its innermost child when they share a plane.
      for (const candidate of blocks.values()) {
        if (candidate.kind === 'node') continue;
        const y = heightOf(candidate.id);
        if (region && (heightOf(region.id) > y || heightOf(region.id) === y && region.depth > candidate.depth)) continue;
        const p = projection.onPlane(point, y), r = candidate.rect;
        if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) region = candidate;
      }
    }
    onMenu(client, projection.onPlane(point, region ? heightOf(region.id) : 0), id, region);
  };
  const blockOffset = (contact: Contact, end: Point): Point => {
    const y = heightOf(contact.id!), a = projection.onPlane(screen(contact.start), y), b = projection.onPlane(screen(end), y);
    return { x: b.x - a.x, y: b.y - a.y };
  };
  const targetNode = (client: Point, handle: LinkHandle) => {
    const target = pick(document.elementFromPoint(client.x, client.y));
    const block = target && blocks.get(target.id);
    return block?.kind === 'node' && block.id !== handle.fixedId ? block : null;
  };
  const cancel = () => {
    if ([...contacts.current.values()].some(p => p.editing)) onMoveBlock(null, true);
    const ids = [...contacts.current.keys()]; contacts.current.clear();
    for (const id of ids) if (surface.current?.hasPointerCapture(id)) surface.current.releasePointerCapture(id);
    setDragging(false); setLink(null);
  };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button < 0 || event.button > 2) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const client = clientPoint(event), item = pick(event.target);
    const end = (event.target as Element).closest('[data-spatial-handle]')?.getAttribute('data-spatial-handle');
    const handle = handles.find(h => h.end === end);
    const button = event.button, toggle = event.ctrlKey || event.metaKey;
    const orbitShortcut = button === 0 && event.altKey || button === 1 && event.shiftKey;
    let mode: Contact['mode'] = 'orbit';
    if (!orbitShortcut) {
      if (button !== 0 || event.shiftKey) mode = 'pan';
      else if (handle && !toggle) mode = 'link';
      else if (!observeOnly && moveBlocks && item && blocks.has(item.id) && !item.edge && !toggle) mode = 'block';
    }
    contacts.current.set(event.pointerId, { start: client, last: client, button, id: item?.id ?? null, mode, toggle, handle,
      moved: false, editing: false, directed: false });
    if (contacts.current.size > 1) {
      for (const p of contacts.current.values()) {
        if (p.editing) onMoveBlock(null, true);
        p.editing = false; p.mode = 'orbit'; p.moved = true;
      }
      setLink(null);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const p = contacts.current.get(event.pointerId), client = clientPoint(event);
    if (!p) {
      const item = pick(event.target); onHoverEdge(item?.edge ? item.id : null);
      onHoverObject(item?.id ?? null, event);
      return;
    }
    event.stopPropagation();
    if (!p.moved && Math.hypot(client.x - p.start.x, client.y - p.start.y) < 4) return;
    if (!p.moved) onLeaveObject();
    p.moved = true; setDragging(true); onHoverEdge(null);
    const dx = client.x - p.last.x, dy = client.y - p.last.y;
    const other = [...contacts.current.values()].find(q => q !== p);
    if (other) {
      const prev = Math.hypot(p.last.x - other.last.x, p.last.y - other.last.y);
      const next = Math.hypot(client.x - other.last.x, client.y - other.last.y);
      pinch(screen({ x: (p.last.x + other.last.x) / 2, y: (p.last.y + other.last.y) / 2 }),
        prev > 2 && next > 2 ? next / prev : 1, dx / 2, dy / 2);
    } else if (p.mode === 'block') {
      const block = p.id && blocks.get(p.id);
      if (block && !p.editing) p.editing = onBeginMove(block, event.pointerId, p.start);
      if (p.editing) onMoveBlock(blockOffset(p, client), false);
    } else if (p.mode === 'link' && p.handle) {
      const node = targetNode(client, p.handle);
      p.directed ||= (event.buttons & 3) === 3;
      setLink({ from: p.handle.fixed, to: screen(client), snapped: !!node });
    } else if (p.mode === 'pan') pan(dx, dy);
    else orbit(dx, dy, p.id);
    p.last = client;
  };
  const release = (event: PointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const p = contacts.current.get(event.pointerId); if (!p) return;
    contacts.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!contacts.current.size) setDragging(false);
    const client = clientPoint(event);
    if (p.editing) onMoveBlock(cancelled ? null : blockOffset(p, client), true);
    else if (p.mode === 'link' && p.handle) {
      setLink(null);
      const node = !cancelled && p.moved && targetNode(client, p.handle);
      if (node) {
        const h = p.handle, operation = h.end === 'create' ? onConnect(h.fixedId, node.id, p.directed) : onReconnect(h.owner, h.end, node.id);
        void operation.catch(() => { /* The graph command reports the failure in the workspace. */ });
      }
    } else if (p.button === 2) {
      suppressMenu.current = performance.now() + 650;
      if (!cancelled && !p.moved) showMenu(client, p.id);
    } else if (!cancelled && !p.moved && p.button === 0 && p.mode !== 'pan') onSelect(p.id, p.toggle, client, event.altKey);
  };
  const contextMenu = (event: MouseEvent<SVGSVGElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (contacts.current.size || performance.now() < suppressMenu.current) return;
    const el = event.target as Element, r = el.getBoundingClientRect();
    const client = event.clientX || event.clientY ? clientPoint(event) : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    showMenu(client, pick(el)?.id ?? null);
  };
  return { contacts, dragging, link, down, move, release, contextMenu, cancel };
}
