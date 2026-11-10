import type { RenderBlock, RenderEdge } from '@/v3/layout';
import type { RoutingModel } from '@/v3/routeContinuity';

export interface RoutingDelta {
  reset: boolean;
  blocks: RenderBlock[];
  removedBlocks: string[];
  edges: RenderEdge[];
  removedEdges: string[];
}
const blockKey = (b: RenderBlock) => JSON.stringify([b.id, b.rect, b.parentId, b.kind, b.collapsed]);
const edgeKey = (e: RenderEdge) => JSON.stringify([e.edge, e.kind, e.source, e.target, e.sourceSide, e.targetSide,
  e.sourceBlockId, e.targetBlockId, e.arrowAt, e.freeEnd, e.routeSeed,
  e.route.path, e.route.provisional, e.route.fallback, e.route.retryable, e.route.gateways, e.label]);

/** Scan locally, but transfer only changed geometry. Node text never crosses the worker boundary. */
export class RoutingDeltaEncoder {
  private blocks = new Map<string, string>();
  private edges = new Map<string, string>();
  private initialized = false;
  encode(model: RoutingModel, displayed: RenderEdge[]): RoutingDelta {
    const delta: RoutingDelta = { reset: !this.initialized, blocks: [], removedBlocks: [], edges: [], removedEdges: [] };
    const blocks = new Map<string, string>(), edges = new Map<string, string>(), seeds = new Map(displayed.map(e => [e.edge.edgeId, e]));
    for (const block of model.blocks) {
      const key = blockKey(block); blocks.set(block.id, key);
      if (key !== this.blocks.get(block.id)) delta.blocks.push({ ...block, name: '', content: undefined });
    }
    for (const raw of model.edges) {
      const seed = seeds.get(raw.edge.edgeId), rendered = seed?.routeSeed ? seed : raw;
      const edge: RenderEdge = { ...rendered, aggregateEdgeIds: undefined, edge: { ...raw.edge, edgeContent: raw.edge.edgeContent.trim().slice(0, 64) } };
      const key = edgeKey(edge); edges.set(edge.edge.edgeId, key);
      if (key !== this.edges.get(edge.edge.edgeId)) delta.edges.push(edge);
    }
    for (const id of this.blocks.keys()) if (!blocks.has(id)) delta.removedBlocks.push(id);
    for (const id of this.edges.keys()) if (!edges.has(id)) delta.removedEdges.push(id);
    this.blocks = blocks; this.edges = edges; this.initialized = true; return delta;
  }
}

export class RoutingDeltaReceiver {
  private blocks = new Map<string, RenderBlock>();
  private edges = new Map<string, RenderEdge>();
  apply(delta: RoutingDelta): RoutingModel {
    if (delta.reset) { this.blocks.clear(); this.edges.clear(); }
    delta.removedBlocks.forEach(id => this.blocks.delete(id)); delta.blocks.forEach(block => this.blocks.set(block.id, block));
    delta.removedEdges.forEach(id => this.edges.delete(id)); delta.edges.forEach(edge => this.edges.set(edge.edge.edgeId, edge));
    return { blocks: [...this.blocks.values()], edges: [...this.edges.values()], parentOf: new Map([...this.blocks.values()].map(b => [b.id, b.parentId])) };
  }
}
