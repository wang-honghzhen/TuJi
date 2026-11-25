import { useId, useMemo, useState, type CSSProperties, type FocusEvent, type ReactElement } from 'react';
import { attachmentPoint, makeEdgeRoute, sideAttachment } from '@/v3/edgeGeometry';
import type { RenderBlock, RenderEdge } from '@/v3/layout';
import { RectangleIndex } from '@/v3/rectangleIndex';
import type { ConnectionSide, Point, Rect } from '@/v3/types';
import type { SubgraphRelation } from '../canvasGranularity';
import { prepareRelationCurve, relationLabel, relationLabelBounds } from '../planarRelationLabel';
import { useGraphAppearance } from '../graphAppearance';
import type { EndpointPaths } from '../neighborhoodPaths';
import { EdgePathLabels } from './EdgePathLabels';
import './planar-subgraph-relations.css';

interface Props {
  blocks: RenderBlock[];
  rootId: string;
  rootName: string;
  bounds: Rect;
  relations: SubgraphRelation[];
  endpointPaths?: ReadonlyMap<string, EndpointPaths>;
  renderedEdges: RenderEdge[];
  selectedId: string | null;
  neighborhoodFocus?: string | null;
  zoom: number;
  light: boolean;
  activeInk: string;
  visibleArea: Rect;
  occlusions: readonly Rect[];
  hoveredId: string | null;
  related: ReadonlySet<string>;
  onHover: (id: string | null) => void;
  onExpand: (id: string) => void;
  onOpen: (id: string, point?: Point, clicked?: boolean) => void;
  onToggle: (id: string) => void;
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const opposite: Record<ConnectionSide, ConnectionSide> = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
function contains(a: Rect, b: Rect) {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
}

// A nested pair has both ports on the same side of its rectangles. Invert
// the outer port's tangent so the curve travels inside the enclosing region.
function ports(a: Rect, b: Rect) {
  const outerFirst = contains(a,b);
  if (!outerFirst && !contains(b,a)) {
    const from = attachmentPoint(a, center(b)), to = attachmentPoint(b, center(a));
    return { from: sideAttachment(a,from.side,from.at), to: sideAttachment(b,to.side,to.at), fromSide: from.side, toSide: to.side };
  }
  const [outer,inner] = outerFirst ? [a,b] : [b,a];
  const gaps: Array<[ConnectionSide,number]> = [
    ['left',inner.x - outer.x], ['right',outer.x + outer.width - inner.x - inner.width],
    ['top',inner.y - outer.y], ['bottom',outer.y + outer.height - inner.y - inner.height],
  ];
  gaps.sort((one,two) => one[1] - two[1]);
  const side = gaps[0][0], mid = center(inner), at = side === 'left' || side === 'right' ? mid.y : mid.x;
  return { from: sideAttachment(a,side,at), to: sideAttachment(b,side,at),
    fromSide: outerFirst ? opposite[side] : side, toSide: outerFirst ? side : opposite[side] };
}

export function PlanarSubgraphRelations({ blocks, rootId, rootName, bounds, relations, endpointPaths, renderedEdges, selectedId, neighborhoodFocus, zoom, light, activeInk, visibleArea, occlusions, hoveredId, related, onHover, onExpand, onOpen, onToggle }: Props) {
  const gradientPrefix = useId().replace(/:/g, '');
  const appearance = useGraphAppearance();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { rootRect, paths } = useMemo(() => {
    const rootRect = { x: bounds.x - 26, y: bounds.y - 34, width: bounds.width + 52, height: bounds.height + 60 };
    const groups = new Map(blocks.filter(b => b.kind !== 'node').map(b => [b.id, { rect: b.rect, name: b.name }]));
    groups.set(rootId, { rect: rootRect, name: rootName });
    const lanes = new Map<string, string[]>();
    const keyOf = (r: SubgraphRelation) => JSON.stringify([r.sourceSubgraphId,r.targetSubgraphId].sort());
    for (const r of relations) {
      const key = keyOf(r), list = lanes.get(key);
      if (list) list.push(r.id); else lanes.set(key,[r.id]);
    }
    const laneOffsets = new Map<string, number>();
    for (const list of lanes.values()) {
      list.sort().forEach((id, i) => laneOffsets.set(id, i - (list.length - 1) / 2));
    }
    const paths = relations.flatMap(relation => {
      const source = groups.get(relation.sourceSubgraphId), target = groups.get(relation.targetSubgraphId);
      if (!source || !target) return [];
      const { from,to,fromSide,toSide } = ports(source.rect,target.rect);
      const lane = laneOffsets.get(relation.id)!;
      const route = makeEdgeRoute(from,to,fromSide,toSide,lane,1,relation.sourceSubgraphId < relation.targetSubgraphId);
      const title = source.name + (relation.directed ? ' → ' : ' — ') + target.name + ' · ' + relation.relationCount + ' 条关系'
        + (relation.summary ? ' · ' + relation.summary : '');
      return [{ relation, route, from, to, curve: prepareRelationCurve(route.segments[0]), title }];
    });
    return { rootRect, paths };
  }, [blocks, rootId, rootName, bounds, relations]);
  const nodes = useMemo(() => new RectangleIndex(blocks.filter(b => b.kind === 'node').map(b => b.rect)), [blocks]);
  const labels = useMemo(() => {
    const counts = new RectangleIndex();
    return paths.map(({ relation, curve }) => {
      const width = Math.max(18, String(relation.relationCount).length * 7 + 8);
      const w = width / zoom, h = 16 / zoom;
      let position = relationLabel(curve, visibleArea, occlusions, w, h);
      if (position) {
        const box = relationLabelBounds(position, w, h);
        if (nodes.collides(box) || counts.collides(box)) {
          const x = Math.max(curve.bounds.x, visibleArea.x), y = Math.max(curve.bounds.y, visibleArea.y);
          const right = Math.min(curve.bounds.x + curve.bounds.width, visibleArea.x + visibleArea.width);
          const bottom = Math.min(curve.bounds.y + curve.bounds.height, visibleArea.y + visibleArea.height);
          const route = { x, y, width: right - x, height: bottom - y }, gap = Math.hypot(w,h);
          const masks = [...occlusions, ...nodes.query(route, gap)];
          const occupied = counts.query(route, gap);
          position = relationLabel(curve, visibleArea, [...masks, ...occupied], w, h)
            ?? (occupied.length ? relationLabel(curve, visibleArea, masks, w, h) : undefined);
        }
        if (position) counts.add(relationLabelBounds(position, w, h));
      }
      return { width, position };
    });
  }, [paths, nodes, visibleArea, occlusions, zoom]);
  const rootInk = appearance(rootId, 'root', light).accent;
  const accent = light ? '#97500e' : '#f3c473';
  const includesRoot = relations.some(r => r.sourceSubgraphId === rootId || r.targetSubgraphId === rootId);
  const hoveredPair = hoveredId && relations.find(r => r.id === hoveredId);
  const rootHighlighted = hoveredPair && (hoveredPair.sourceSubgraphId === rootId || hoveredPair.targetSubgraphId === rootId);
  // All count buttons paint above all curve hit bands at crossings.
  const counts: ReactElement[] = [];
  const lines = paths.map(({ relation:r, route, from, to, title }, index) => {
    const { width, position } = labels[index];
    const source = appearance(r.sourceSubgraphId, undefined, light).accent;
    const target = appearance(r.targetSubgraphId, undefined, light).accent;
    const gradient = source !== target && (from.x !== to.x || from.y !== to.y);
    const paintId = `${gradientPrefix}-pair-${index}`;
    const shared = {
      'data-neighbor-focus': neighborhoodFocus === r.id || undefined,
      'data-selected': selectedId === r.id,
      'data-hover-related': related.has(r.id) || undefined,
      'data-active': hoveredId === r.id || focusedId === r.id || related.has(r.id) || undefined,
      'data-canvas-interactive': true,
      style: { cursor:'pointer', '--relation-count-color': `color-mix(in srgb, ${source}, ${target})` } as CSSProperties,
      onPointerEnter: () => onHover(r.id),
      onPointerLeave: () => onHover(null),
      onFocus: (event: FocusEvent<SVGElement>) => { if (event.currentTarget.matches(':focus-visible')) setFocusedId(r.id); },
      onBlur: () => setFocusedId(null),
    };
    if (position) counts.push(<g key={r.id} {...shared} className="planar-relation-count" data-planar-relation-expand={r.id}
      transform={`translate(${position.x},${position.y}) rotate(${position.angle}) scale(${1/zoom})`} pointerEvents="all"
      role="button" tabIndex={0} aria-label={`展开 ${title}`}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onHover(null); setFocusedId(null); onExpand(r.id); }}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault(); e.stopPropagation(); onHover(null); setFocusedId(null); onExpand(r.id);
      }}>
      <title>{`展开 ${r.relationCount} 条原始关系`}</title>
      <rect x={-width/2} y="-8" width={width} height="16" rx="6" fill={light?'#f7fbfa':'#14242d'} />
      <text textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize="11">{r.relationCount}</text>
    </g>);
    return <g key={r.id} {...shared} className="planar-relation" data-subgraph-relation-id={r.id} data-semantic-relation={r.id} data-count={r.relationCount}
      data-source-group={r.sourceSubgraphId} data-target-group={r.targetSubgraphId} data-relation-count={r.relationCount} data-directed={r.directed}
      data-member-ids={JSON.stringify(r.memberEdgeIds)}
      role="button" tabIndex={0} aria-label={title}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onOpen(r.id,{ x:e.clientX,y:e.clientY },!e.ctrlKey && !e.metaKey); }}
      onDoubleClick={e => { e.stopPropagation(); onToggle(r.id); }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onOpen(r.id,{ x:e.clientX,y:e.clientY },false); }}
      onKeyDown={e => {
        if(e.shiftKey||e.ctrlKey||e.metaKey||e.altKey)return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation();
          if(e.key==='Enter')onOpen(r.id);else onToggle(r.id);
        }
      }}>
      <title>{title}</title>
      {gradient && <defs><linearGradient id={paintId} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
        <stop offset="0%" stopColor={source}/><stop offset="100%" stopColor={target}/>
      </linearGradient></defs>}
      <path d={route.path} fill="none" stroke="transparent" strokeWidth={14/zoom} pointerEvents="stroke"/>
      <path className="planar-relation-line" d={route.path} fill="none" stroke={gradient ? `url(#${paintId})` : source} pointerEvents="none"
        vectorEffect="non-scaling-stroke" />
      {[from, to].map((point, i) => <circle key={i} className="planar-relation-endpoint" color={i === 0 ? source : target} aria-hidden="true" pointerEvents="none"
        cx={point.x} cy={point.y} r={4 / Math.max(zoom, .65)} strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
    </g>;
  });
  return <g data-planar-subgraph-relations style={{ '--relation-active': activeInk, '--relation-selected': accent,
    '--relation-rest-opacity': light ? .49 : .38, '--relation-count-opacity': light ? .64 : .56 } as CSSProperties}>
    {includesRoot && <g pointerEvents="none" fill={rootInk} opacity={rootHighlighted ? 1 : .75}>
      <rect {...rootRect} fill="none" rx="12" stroke={rootInk} strokeWidth={rootHighlighted ? 2 : 1} strokeDasharray={rootHighlighted ? undefined : '4 5'} vectorEffect="non-scaling-stroke"/>
      <text x={rootRect.x + 10/zoom} y={rootRect.y + 16/zoom} fontSize={12/zoom}>{rootName}</text>
    </g>}
    {lines}
    {endpointPaths?.size ? <EdgePathLabels paths={endpointPaths} zoom={zoom} light={light} frame={visibleArea}
      lines={[...renderedEdges.map(e => ({ id: e.edge.edgeId, source: e.source, target: e.target })),
        ...paths.map(p => ({ id: p.relation.id, source: p.from, target: p.to }))]}
      obstacles={[...nodes.rects, ...occlusions, ...renderedEdges.flatMap(e => e.label ? [e.label.rect] : []),
        ...labels.flatMap(({position,width}) => position ? [relationLabelBounds(position, width/zoom, 16/zoom)] : [])]} /> : null}
    {counts}
  </g>;
}
