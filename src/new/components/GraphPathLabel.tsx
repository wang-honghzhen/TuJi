import type { PathKind, PathSegment } from '@/v3/paths';
import { useGraphNameAppearance } from '../graphAppearance';
import type { HTMLAttributes } from 'react';

export function GraphNameLabel({ id, name, kind, className = '', style, ...props }: {
  id: string; name: string; kind?: PathKind;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'id'>) {
  const appearance = useGraphNameAppearance(id, kind);
  return <span {...props} data-path-id={id} data-path-kind={appearance.kind} data-connection-count={appearance.count}
    data-connection-level={appearance.level} className={`graph-name-label ${className}`} style={{ ...appearance.style, ...style }}>{name}</span>;
}

export function GraphPathLabel({ segments }: { segments: PathSegment[] }) {
  return <span data-graph-path>{segments.map((segment, index) => <span key={segment.id}>
    {index > 0 && <span className="text-slate-500"> / </span>}
    <GraphNameLabel {...segment} />
  </span>)}</span>;
}
