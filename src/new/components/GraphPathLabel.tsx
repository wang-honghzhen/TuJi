import type { GraphState } from '@/v3/types';
import { canvasDirectory } from '@/v3/canvas';
import type { PathKind, PathSegment } from '@/v3/paths';
import { useGraphNameAppearance } from '../graphAppearance';
import type { HTMLAttributes } from 'react';

export function GraphNameLabel({ id, name, kind, className = '', style, children, ...props }: {
  id: string; name: string; kind?: PathKind;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'id'>) {
  const appearance = useGraphNameAppearance(id, kind);
  return <span {...props} data-path-id={id} data-path-kind={appearance.kind} data-connection-count={appearance.count}
    data-connection-level={appearance.level} className={`graph-name-label ${className}`} style={{ ...appearance.style, ...style }}>{children ?? name}</span>;
}

export function GraphPathLabel({ segments }: { segments: PathSegment[] }) {
  return <span data-graph-path>{segments.map((segment, index) => <span key={segment.id}>
    {index > 0 && <span className="text-slate-500"> / </span>}
    <GraphNameLabel {...segment} />
  </span>)}</span>;
}

/** Persisted references can also point to deleted objects or to an edge description. */
export function GraphReferenceLabel({ id, name, graph, canvasId }: { id: string; name: string; graph?: GraphState | null; canvasId: string }) {
  if (!graph) return <>{name}</>;
  const canvas = graph.canvases.find(c => c.canvasId === canvasId);
  if (graph.nodes[id] || graph.documents[id] || canvas && (id === canvas.canvasId || canvasDirectory(canvas, id))) {
    return <GraphNameLabel id={id} name={name} />;
  }
  const edge = graph.edges.find(item => item.edgeId === id);
  if (edge) {
    const endpoint = (key: string) => graph.nodes[key]?.name ?? graph.documents[key]?.name ?? (canvas && canvasDirectory(canvas, key)?.name);
    const source = endpoint(edge.sourceNodeId), target = endpoint(edge.targetNodeId);
    const prefix = name.startsWith('关系 · ') ? '关系 · ' : '';
    if (source && target && name === prefix + source + ' → ' + target) return <>{prefix}
      <GraphNameLabel id={edge.sourceNodeId} name={source} /> → <GraphNameLabel id={edge.targetNodeId} name={target} /></>;
  }
  return <>{name}</>;
}
