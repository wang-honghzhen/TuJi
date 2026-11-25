import { useMemo } from 'react';
import type { Point, Rect } from '../../v3/types';
import { RectangleIndex } from '../../v3/rectangleIndex';
import type { EndpointPaths } from '../neighborhoodPaths';
import { createCaptionMeasurer } from '../spatialGeometry/shellTitles';

export interface PathLine { id: string; source: Point; target: Point; hideSource?: boolean; hideTarget?: boolean }
interface Props {
  paths: ReadonlyMap<string, EndpointPaths>;
  lines: PathLine[];
  obstacles: readonly Rect[];
  frame: Rect;
  light: boolean;
  zoom?: number;
}

function wrapCaption(text: string, width: number, measure: ReturnType<typeof createCaptionMeasurer>) {
  if (measure(text).advance <= width) return [text];
  const rows: string[] = [];
  let row = '';
  for (const char of text) {
    if (row && measure(row + char).advance > width) {
      rows.push(row);
      row = '';
    }
    row += char;
  }
  rows.push(row);
  return rows;
}

/** World and screen-space views share the same pixel-sized captions and port leaders. */
export function EdgePathLabels({ paths, lines, obstacles, frame, light, zoom = 1 }: Props) {
  const measure = useMemo(() => createCaptionMeasurer('11px system-ui, sans-serif'), [paths]);
  const occupied = new RectangleIndex([...obstacles], 96 / zoom);
  const labeledPorts = new Set<string>();
  const ink = light ? '#314b60' : '#c8d8e8', halo = light ? '#f6fafc' : '#101b28';
  const inFrame = (p: Point) => p.x >= frame.x && p.x <= frame.x + frame.width && p.y >= frame.y && p.y <= frame.y + frame.height;
  return <g pointerEvents="none">{lines.flatMap(line => {
    const label = paths.get(line.id);
    if (!label) return [];
    return (['source', 'target'] as const).map(end => {
      const at = line[end], peer = line[end === 'source' ? 'target' : 'source'];
      if ((end === 'source' ? line.hideSource : line.hideTarget) || !inFrame(at)) return null;
      const caption = end === 'target' && (line.hideSource || !inFrame(peer)) ? label.fullTarget : label[end];
      // Parallel edges attached to the very same port can share its caption.
      const port = JSON.stringify([Math.round(at.x * zoom), Math.round(at.y * zoom), caption]);
      if (labeledPorts.has(port)) return null;
      labeledPorts.add(port);
      const rows = wrapCaption(caption, Math.min(320, frame.width * zoom - 6), measure);
      const width = (Math.max(...rows.map(row => measure(row).advance)) + 6) / zoom;
      const height = 16 * rows.length / zoom, gap = 7 / zoom;
      const horizontal = peer.x > at.x ? 1 : -1;
      let best: Rect | undefined, cost = Infinity;
      for (const away of [1, -1, 3, -3, 6, -6]) {
        for (const side of [horizontal, -horizontal, 0]) {
          const left = at.x + (side === 0 ? -width / 2 : side > 0 ? gap : -width - gap);
          const x = Math.max(frame.x, Math.min(left, frame.x + frame.width - width));
          const top = at.y + away * gap - (away < 0 ? height : 0);
          const y = Math.max(frame.y, Math.min(top, frame.y + frame.height - height));
          const box = { x, y, width, height };
          const overlap = occupied.query(box).reduce((sum, r) => sum +
            (Math.min(x + width, r.x + r.width) - Math.max(x, r.x)) *
            (Math.min(y + height, r.y + r.height) - Math.max(y, r.y)), 0);
          if (overlap < cost) { cost = overlap; best = box; }
          if (cost === 0) break;
        }
        if (cost === 0) break;
      }
      const box = best!;
      occupied.add(box);
      return <g key={JSON.stringify([line.id,end])} data-edge-path={line.id} data-path-end={end}>
        <line x1={at.x} y1={at.y} x2={Math.max(box.x,Math.min(at.x,box.x+width))}
          y2={Math.max(box.y,Math.min(at.y,box.y+height))} stroke={ink} strokeOpacity=".55" strokeWidth={1 / zoom} />
        <text x={box.x + 3 / zoom} y={box.y + 12 / zoom}
          style={{ font: `${11 / zoom}px system-ui, sans-serif`, fill: ink, stroke: halo, strokeWidth: 3 / zoom, paintOrder: 'stroke', strokeLinejoin: 'round' }}>
          {rows.map((row,i) => <tspan key={i} x={box.x + 3 / zoom} dy={i ? 16 / zoom : 0}>{row}</tspan>)}
        </text>
      </g>;
    });
  })}</g>;
}
