import type { RenderBlock, RenderEdge } from '@/v3/layout';
import type { RoutingModel } from '@/v3/routeContinuity';

export interface RoutingDelta {
  reset: boolean;
  blocks: RenderBlock[];
  removedBlocks: string[];
  edges: RenderEdge[];
  removedEdges: string[];
}
const blockKey = (b: RenderBlock) => JSON.stringify([b.id, b.rect, b.parentId, b.kind, b.collapsed, b.headerHeight]);
const edgeKey = (e: RenderEdge) => JSON.stringify([e.edge, e.kind, e.scope, e.source, e.target, e.sourceSide, e.targetSide,
  e.sourceBlockId, e.targetBlockId, e.arrowAt, e.freeEnd, e.routeSeed,
  e.route.path, e.route.provisional, e.route.fallback, e.route.retryable, e.route.gateways, e.label]);

/** Scan locally, but transfer only changed geometry. Node text never crosses the worker boundary. */
export class RoutingDeltaEncoder {
  private blocks = new Map<string, string>();
  private edges = new Map<string, string>();
  private previous?: RoutingModel;
  encode(model: RoutingModel, displayed: RenderEdge[]): RoutingDelta {
    const delta: RoutingDelta = { reset: !this.previous, blocks: [], removedBlocks: [], edges: [], removedEdges: [] };
    // Refinements and viewport moves use the same immutable projection. Its
    // worker already owns the routes it just returned; only edits need seeds.
    if (this.previous === model) return delta;
    const blocks = new Map<string, string>(), edges = new Map<string, string>(), seeds = new Map(displayed.map(e => [e.edge.edgeId, e]));
    for (const block of model.blocks) {
      const key = blockKey(block); blocks.set(block.id, key);
      if (key !== this.blocks.get(block.id)) delta.blocks.push({ ...block, name: '', content: undefined });
    }
    for (const raw of model.edges) {
      const seed = seeds.get(raw.edge.edgeId);
      const rendered = seed?.routeSeed && seed.scope === raw.scope && seed.kind === raw.kind &&
        seed.sourceBlockId === raw.sourceBlockId && seed.targetBlockId === raw.targetBlockId &&
        seed.edge.sourceNodeId === raw.edge.sourceNodeId && seed.edge.targetNodeId === raw.edge.targetNodeId &&
        seed.edge.routeStyle === raw.edge.routeStyle ? seed : raw;
      const edge: RenderEdge = { ...rendered, aggregateEdgeIds: undefined, edge: { ...raw.edge, edgeContent: raw.edge.edgeContent.trim().slice(0, 64) } };
      const key = edgeKey(edge); edges.set(edge.edge.edgeId, key);
      if (key !== this.edges.get(edge.edge.edgeId)) delta.edges.push(edge);
    }
    for (const id of this.blocks.keys()) if (!blocks.has(id)) delta.removedBlocks.push(id);
    for (const id of this.edges.keys()) if (!edges.has(id)) delta.removedEdges.push(id);
    this.blocks = blocks; this.edges = edges; this.previous = model; return delta;
  }
}

export class RoutingDeltaReceiver {
  private blocks = new Map<string, RenderBlock>();
  private edges = new Map<string, RenderEdge>();
  private snapshot?: RoutingModel;
  apply(delta: RoutingDelta): RoutingModel {
    if (this.snapshot && !delta.reset && !delta.blocks.length && !delta.edges.length &&
      !delta.removedBlocks.length && !delta.removedEdges.length) return this.snapshot;
    if (delta.reset) { this.blocks.clear(); this.edges.clear(); }
    delta.removedBlocks.forEach(id => this.blocks.delete(id)); delta.blocks.forEach(block => this.blocks.set(block.id, block));
    delta.removedEdges.forEach(id => this.edges.delete(id)); delta.edges.forEach(edge => this.edges.set(edge.edge.edgeId, edge));
    this.snapshot = { blocks: [...this.blocks.values()], edges: [...this.edges.values()], parentOf: new Map([...this.blocks.values()].map(b => [b.id, b.parentId])) };
    return this.snapshot;
  }
}

// A number references an edge in the preceding reply, preserving the new
// paint order without cloning its curve, control points and label again.
export type RoutingFrame = (RenderEdge | number)[] | null;

export class RoutingFrameEncoder {
  private previous = new Map<RenderEdge, number>();
  encode(edges: RenderEdge[]): RoutingFrame {
    if (this.previous.size === edges.length && edges.every((edge, i) => this.previous.get(edge) === i)) return null;
    const frame = edges.map(edge => this.previous.get(edge) ?? edge);
    this.previous = new Map(edges.map((edge, i) => [edge, i]));
    return frame;
  }
}

export class RoutingFrameReceiver {
  private previous: RenderEdge[] = [];
  private source?: RoutingModel['edges'];
  private originals = new Map<string, RenderEdge['edge']>();

  apply(frame: RoutingFrame, model: RoutingModel): RenderEdge[] {
    if (this.source !== model.edges) {
      this.source = model.edges;
      this.originals = new Map(model.edges.map(e => [e.edge.edgeId, e.edge]));
    } else if (!frame) return this.previous;
    // An edit to the full text may leave the worker's shortened copy
    // unchanged. Always rebind reused geometry to the current graph records.
    this.previous = (frame ?? this.previous).map(entry => {
      const rendered = typeof entry === 'number' ? this.previous[entry] : entry;
      const original = this.originals.get(rendered.edge.edgeId)!;
      return original === rendered.edge ? rendered : { ...rendered, edge: original };
    });
    return this.previous;
  }
}
