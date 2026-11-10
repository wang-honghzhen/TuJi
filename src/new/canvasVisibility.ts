import type { RenderBlock, RenderEdge } from '@/v3/layout';
import { routeBounds } from '@/v3/edgeGeometry';
import { RectangleIndex } from '@/v3/rectangleIndex';
import type { Rect } from '@/v3/types';

/** Rendering follows the physical canvas, including translucent UI overlays. */
export function canvasViewportBounds(view: { x: number; y: number; zoom: number }, size: { width: number; height: number }): Rect {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom };
}

export function indexVisibleObjects(blocks: RenderBlock[], edges: RenderEdge[]) {
  const blockIndex = new RectangleIndex(blocks.map(block => Object.assign({ ...block.rect }, { id: block.id })));
  const edgeIndex = new RectangleIndex(edges.map(edge => Object.assign(routeBounds(edge.route), { id: edge.edge.edgeId })));
  // Keep draw order without scanning every offscreen object on each pan. Dense
  // views still use a linear pass, avoiding a sort when most objects are visible.
  const orderedSelection = <T,>(items: T[], idOf: (item: T) => string) => {
    const positions = new Map<string, number[]>();
    items.forEach((item, index) => {
      const id = idOf(item), previous = positions.get(id);
      if (previous) previous.push(index); else positions.set(id, [index]);
    });
    return (ids: ReadonlySet<string>): T[] => {
      if (ids.size > items.length / 4) return items.filter(item => ids.has(idOf(item)));
      const selected: number[] = [];
      for (const id of ids) {
        const indexes = positions.get(id);
        if (indexes) for (const index of indexes) selected.push(index);
      }
      selected.sort((a, b) => a - b);
      return selected.map(index => items[index]);
    };
  };
  const selectBlocks = orderedSelection(blocks, block => block.id);
  const selectEdges = orderedSelection(edges, edge => edge.edge.edgeId);
  return (viewport: Rect, retained: ReadonlySet<string>) => {
    const ids = new Set([...blockIndex.query(viewport, 120), ...edgeIndex.query(viewport, 120)]
      .map(rect => (rect as Rect & { id: string }).id));
    retained.forEach(id => ids.add(id));
    return { blocks: selectBlocks(ids), edges: selectEdges(ids) };
  };
}
