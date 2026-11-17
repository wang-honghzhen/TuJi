import { parentPort } from 'node:worker_threads';
import { layoutRelationships } from '@/v3/relationshipLayout';
import type { GraphState } from '@/v3/types';
import type { RelationshipLayoutOptions } from '@/v3/relationshipLayout';
import type { LayoutGeometryReply } from './layoutProtocol';
parentPort?.on('message', (request: { graph: GraphState; options: RelationshipLayoutOptions }) => {
  try {
    const result = layoutRelationships(request.graph, request.options);
    const reply: LayoutGeometryReply = { layoutVersion: result.state.layoutVersion, stats: result.stats,
      documents: Object.values(result.state.documents).filter(doc => JSON.stringify(doc.placements) !== JSON.stringify(request.graph.documents[doc.documentId]?.placements))
        .map(doc => ({ id: doc.documentId, placements: doc.placements, rev: doc.rev, updatedAt: doc.metadata.updatedAt })),
      canvases: result.state.canvases.filter(canvas => {
        const old = request.graph.canvases.find(c => c.canvasId === canvas.canvasId);
        return JSON.stringify([canvas.placements, canvas.presentationPlacements]) !== JSON.stringify([old?.placements, old?.presentationPlacements]);
      }).map(canvas => ({ id: canvas.canvasId, placements: canvas.placements, presentationPlacements: canvas.presentationPlacements, updatedAt: canvas.updatedAt })) };
    parentPort!.postMessage({ result: reply });
  }
  catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
