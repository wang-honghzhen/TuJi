import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { GraphState } from '@/v3/types';
import type { PathKind } from '@/v3/paths';
import { connectionLevel, nodeConnectionCounts } from '@/v3/nodeConnections';

export const nodeAccents = { low: '#31c5ed', medium: '#9382ff', high: '#4d8fff' };
export const documentAccent = '#f4b65f';
export const subgraphAccent = '#bfdbfe';
const Appearance = createContext<GraphState | null>(null);

export function GraphAppearanceProvider({ state, children }: { state: GraphState; children: ReactNode }) {
  return <Appearance.Provider value={state}>{children}</Appearance.Provider>;
}

export function useGraphNameAppearance(id: string, kind?: PathKind) {
  const state = useContext(Appearance);
  const counts = useMemo(() => state ? nodeConnectionCounts(state.edges) : new Map<string, number>(), [state?.edges]);
  const actualKind = kind ?? (state?.nodes[id] ? 'node' : state?.documents[id]?.kind === 'document' ? 'document' :
    state?.canvases.some(canvas => canvas.canvasId === id) ? 'root' : 'subgraph');
  const count = actualKind === 'node' ? counts.get(id) ?? 0 : undefined;
  const level = count === undefined ? undefined : connectionLevel(count);
  const accent = level ? nodeAccents[level] : actualKind === 'document' ? documentAccent : subgraphAccent;
  return { kind: actualKind, count, level, accent, style: { '--graph-node-accent': accent } as CSSProperties };
}
