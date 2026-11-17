import { canvasDirectory } from './canvas';
import { getHierarchyIndex } from './hierarchyIndex';
import { getCanvasPaths } from './paths';
import { getNaturalGeometry } from './regionLayout';
import { presentationGeometry, presentationPlacement } from './presentationLayout';
import { nodeGeometry } from './nodeGeometry';
import type { ProjectedRelation } from './relationProjection';
import type { CanvasRecord, GraphState, Point, Rect } from './types';
import { COLLAPSED_WIDTH, COLLAPSED_HEIGHT, RECORD_PADDING, RECORD_HEADER_HEIGHT } from './types';

export interface EndpointSegment {
  source: Point; target: Point; sourceId: string; targetId: string; weight: number;
}
export interface EndpointGeometry {
  segments: ReadonlyMap<ProjectedRelation, readonly EndpointSegment[]>;
  /** Visible inner cards are obstacles for cross-container connections. */
  obstacles: Array<{ owner: string; id: string; rect: Rect }>;
  nested: boolean;
}

/** Resolve endpoint offsets once per region. Candidate evaluation then only
 * translates these small records; it never builds a render model or routes. */
export function relationEndpointGeometry(state: GraphState, canvas: CanvasRecord, ids: readonly string[],
  sizes: ReadonlyMap<string, Rect>, relations: readonly ProjectedRelation[], view = true): EndpointGeometry {
  const hierarchy = getHierarchyIndex(state), parents = view ? new Map(getCanvasPaths(state, canvas).map(row => [row.id, row.parentId]))
    : new Map<string, string | undefined>([...(hierarchy.canvasParents.get(canvas.canvasId) ?? []), ...hierarchy.documentParents, ...hierarchy.nodeParents]);
  const natural = getNaturalGeometry(state), geometry = view ? presentationGeometry(state, canvas, natural) : natural;
  const folded = { x: 0, y: 0, width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
  const size = (id: string) => state.nodes[id] ? nodeGeometry(state.nodes[id]) : view && canvas.collapsed[id] ? folded
    : state.documents[id] ? geometry.document(id) : geometry.directory(canvas, id);
  const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const cache = new Map<string, { point: Point; id: string }>();
  const resolve = (owner: string, terminal: string) => {
    const key = JSON.stringify([owner, terminal]), saved = cache.get(key); if (saved) return saved;
    const fallback = { point: centre({ ...sizes.get(owner)!, x: 0, y: 0 }), id: owner };
    const chain: string[] = []; let current: string | undefined = terminal;
    while (current && current !== owner && chain.length < parents.size + 1) { chain.push(current); current = parents.get(current); }
    if (current !== owner) return fallback;
    let point: Point = { x: 0, y: 0 }, id = owner;
    for (const child of chain.reverse()) {
      if (view && canvas.collapsed[id]) break;
      const base = (state.documents[id]?.placements ?? canvas.placements)[child]; if (!base) return fallback;
      const placement = view ? presentationPlacement(canvas, child, id, base) : base;
      point = { x: point.x + RECORD_PADDING + placement.x, y: point.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + placement.y };
      id = child;
    }
    const result = { point: centre({ ...size(id), ...point }), id }; cache.set(key, result); return result;
  };
  const segments = new Map<ProjectedRelation, EndpointSegment[]>(); let nested = false;
  for (const relation of relations) {
    const pairs = relation.terminals?.length ? relation.terminals : [{ source: relation.source, target: relation.target, count: 1 }];
    const count = pairs.reduce((sum, pair) => sum + pair.count, 0);
    segments.set(relation, pairs.map(pair => {
      const source = resolve(relation.source, pair.source), target = resolve(relation.target, pair.target);
      nested ||= source.id !== relation.source || target.id !== relation.target;
      return { source: source.point, target: target.point, sourceId: source.id, targetId: target.id,
        weight: relation.weight * pair.count / count };
    }));
  }
  const obstacles: EndpointGeometry['obstacles'] = [];
  if (nested) for (const owner of ids) {
    const visit = (id: string, point: Point) => {
      if (state.nodes[id] || view && canvas.collapsed[id]) {
        if (id !== owner) obstacles.push({ owner, id, rect: { ...size(id), ...point } });
        return;
      }
      const children = canvasDirectory(canvas, id)?.childIds ?? (state.documents[id]
        ? [...state.documents[id].childNodeIds, ...state.documents[id].childDocumentIds] : []);
      for (const child of children) {
        if (view && canvas.excludedDocumentIds?.includes(child)) continue;
        const base = (state.documents[id]?.placements ?? canvas.placements)[child]; if (!base) continue;
        const placement = view ? presentationPlacement(canvas, child, id, base) : base;
        visit(child, { x: point.x + RECORD_PADDING + placement.x, y: point.y + RECORD_HEADER_HEIGHT + RECORD_PADDING + placement.y });
      }
    };
    visit(owner, { x: 0, y: 0 });
  }
  return { segments, obstacles, nested };
}
