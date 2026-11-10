import type { DesignNodeData, Point } from '@/v3/types';
import type { StructureCommand } from '@/v3/structure';
import type { CreateEdgeInput } from '@/v3/storage';

export interface GraphActionRequest {
  type: 'editDesign' | 'createNode' | 'createEdge' | 'createSubgraph' | 'group' | 'move' | 'deleteNode' | 'deleteEdge' | 'deleteSubgraph' | 'deleteDocument' | 'replaceDocument' | 'registerDocument' | 'importDocument';
  origin: 'canvas' | 'directory' | 'library';
  parentId?: string;
  ids?: string[];
  id?: string;
  sourceId?: string;
  point?: Point;
}
export type GraphMutation = StructureCommand | { type: 'createEdge'; input: CreateEdgeInput } | { type: 'updateDesignNode'; id: string; design: DesignNodeData; expectedDesign?: DesignNodeData };
export interface GraphMutationResult { ok: boolean; id?: string; error?: string; pending?: boolean }
export interface CanvasFocusRequest { id: string; sequence: number; forceSelect?: boolean }
