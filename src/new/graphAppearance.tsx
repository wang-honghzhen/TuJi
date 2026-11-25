import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { GraphState } from '@/v3/types';
import type { PathKind } from '@/v3/paths';
import { connectionLevel, nodeConnectionCounts, subgraphConnectionCounts } from '@/v3/nodeConnections';

export const nodeAccents = { low: '#31c5ed', medium: '#9382ff', high: '#4d8fff' };
export const lightNodeAccents = { low: '#08718c', medium: '#7450a8', high: '#235db2' };
export const documentAccent = '#f4b65f';
export const subgraphAccent = '#bfdbfe';
export const darkEdgeAccents = { ...nodeAccents, neutral: '#8ca3cf', active: '#cee3ff', ai: '#f6c453', outside: '#74839a', drag: '#75d7b0' };
export const lightEdgeAccents: typeof darkEdgeAccents = { ...lightNodeAccents,
  neutral: '#536980', active: '#153d74', ai: '#99580a', outside: '#526479', drag: '#087355' };
const namePalettes = {
  dark: { nodes: nodeAccents, document: documentAccent, directory: subgraphAccent },
  light: { nodes: lightNodeAccents, document: '#94691d', directory: '#557793' },
};

export interface GraphNameAppearance {
  kind: PathKind;
  count?: number;
  level?: ReturnType<typeof connectionLevel>;
  accent: string;
  style: CSSProperties;
}
export type GraphAppearanceResolver = (id: string, kind?: PathKind, light?: boolean) => GraphNameAppearance;

function nameStyle(kind: PathKind, count: number | undefined, light: boolean): GraphNameAppearance {
  const palette = light ? namePalettes.light : namePalettes.dark;
  const level = count === undefined ? undefined : connectionLevel(count);
  const accent = level ? palette.nodes[level] : kind === 'document' ? palette.document : palette.directory;
  return { kind, count, level, accent, style: { '--graph-node-accent': accent } as CSSProperties };
}
const fallback: GraphAppearanceResolver = (_id, kind = 'subgraph', light = false) =>
  nameStyle(kind, kind === 'node' || kind === 'subgraph' ? 0 : undefined, light);
const resolvers = new WeakMap<GraphState, GraphAppearanceResolver>();

function resolverFor(state: GraphState): GraphAppearanceResolver {
  const cached = resolvers.get(state);
  if (cached) return cached;
  const roots = new Set(state.canvases.map(canvas => canvas.canvasId));
  const directories = new Set(state.canvases.flatMap(canvas => Object.keys(canvas.directories)));
  const styles = new Map<string, GraphNameAppearance>();
  const resolve: GraphAppearanceResolver = (id, fallbackKind, light = false) => {
    const kind = Object.hasOwn(state.nodes,id) ? 'node' : Object.hasOwn(state.documents,id) ? state.documents[id].kind
      : roots.has(id) ? 'root' : directories.has(id) ? 'subgraph' : fallbackKind ?? 'subgraph';
    const count = kind === 'node' ? nodeConnectionCounts(state.edges).get(id) ?? 0
      : kind === 'subgraph' ? subgraphConnectionCounts(state).get(id) ?? 0 : undefined;
    const key = `${kind}/${count ?? ''}/${light}`;
    const existing = styles.get(key);
    if (existing) return existing;
    const value = nameStyle(kind, count, light);
    styles.set(key, value);
    return value;
  };
  resolvers.set(state, resolve);
  return resolve;
}

export function graphNameAppearance(state: GraphState, id: string, kind?: PathKind, light = false) {
  return resolverFor(state)(id, kind, light);
}
const Appearance = createContext<GraphAppearanceResolver>(fallback);

export function GraphAppearanceProvider({ state, light = false, children }: { state: GraphState | null; light?: boolean; children: ReactNode }) {
  const resolve = useMemo<GraphAppearanceResolver>(() => {
    const lookup = state ? resolverFor(state) : fallback;
    return light ? (id, kind, lightSurface = true) => lookup(id, kind, lightSurface) : lookup;
  }, [state, light]);
  return <Appearance.Provider value={resolve}>{children}</Appearance.Provider>;
}

export function useGraphAppearance(): GraphAppearanceResolver {
  return useContext(Appearance);
}
export function useGraphNameAppearance(id: string, kind?: PathKind, light?: boolean) {
  return useGraphAppearance()(id, kind, light);
}
