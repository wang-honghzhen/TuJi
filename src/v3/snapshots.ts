import { canvasDirectory } from './canvas';
import { graphIdAllocator } from './ids';
import type { CanvasRecord, GraphState, Placement } from './types';
import { modeOf, remapDesign } from './design';

/** Mutates only the caller's uncommitted state; all copied identities are new. */
export function copyAsSubgraph(state: GraphState, sourceCanvas: CanvasRecord, sourceId: string, destinationCanvas?: CanvasRecord,
  renamed = new Map<string, string>()): string {
  const visiting = new Set<string>(); const now = new Date().toISOString();
  const allocate = graphIdAllocator(state);
  const visit = (id: string): string => {
    if (visiting.has(id)) throw new Error('无法复制成环的目录');
    if (renamed.has(id)) throw new Error('无法复制包含重复归属的目录');
    visiting.add(id);
    const node = state.nodes[id]; const record = state.documents[id]; const directory = canvasDirectory(sourceCanvas, id);
    if (!node && !record && !directory) throw new Error('复制内容不存在');
    const fresh = allocate(destinationCanvas && !node ? `canvas-dir:${destinationCanvas.canvasId}:` : '');
    renamed.set(id, fresh);
    if (node) state.nodes[fresh] = { ...node, nodeId: fresh };
    else {
      const children = directory?.childIds ?? [...record.childDocumentIds, ...record.childNodeIds];
      const positions = directory ? sourceCanvas.placements : record.placements;
      const copied = children.map(visit);
      const placements = Object.fromEntries(children.map((child, index) => [copied[index], { ...(positions[child] ?? { x: 0, y: 0, source: 'auto' }) }])) as Record<string, Placement>;
      const name = directory?.name ?? record.name; const description = directory?.description ?? record.metadata.description;
      if (destinationCanvas) {
        destinationCanvas.directories[fresh] = { name, description, childIds: copied };
        Object.assign(destinationCanvas.placements, placements);
      } else state.documents[fresh] = { documentId: fresh, kind: 'subgraph', mode: record ? modeOf(record) : modeOf(sourceCanvas), name,
        childNodeIds: copied.filter((child) => Boolean(state.nodes[child])), childDocumentIds: copied.filter((child) => !state.nodes[child]),
        placements, rev: 1, metadata: { createdAt: now, updatedAt: now, version: '3.0', description } };
    }
    visiting.delete(id); return fresh;
  };
  const root = visit(sourceId);
  for (const fresh of renamed.values()) if (state.nodes[fresh]?.design) state.nodes[fresh].design = remapDesign(state.nodes[fresh].design, Object.fromEntries(renamed));
  // Crossing relationships stay with the originals. A snapshot copies internal relationships only.
  const edges = state.edges.filter((edge) => !edge.removed && !edge.membershipFor && renamed.has(edge.sourceNodeId) && renamed.has(edge.targetNodeId)).map((edge) => {
    const edgeId = allocate(); renamed.set(edge.edgeId, edgeId);
    return { ...edge, edgeId, sourceNodeId: renamed.get(edge.sourceNodeId)!, targetNodeId: renamed.get(edge.targetNodeId)! };
  });
  state.edges.push(...edges); return root;
}
