export type CanvasMode = 'explore' | 'design';
export type DesignNodeType = 'proposal' | 'combination' | 'flow' | 'general';
export interface DesignNodeData {
  type: DesignNodeType;
  /** Optional evaluation of a combination. Other types use the node body. */
  pros?: string;
  cons?: string;
  memberIds?: string[];
  subjectIds?: string[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface Placement extends Point {
  source: 'auto' | 'manual';
  /** Trusted user placement time; automatic moves retain this historical intent. */
  lastManualAt?: number;
  manualAnchor?: Point;
}

export interface GraphRecord {
  mode?: CanvasMode;
  documentId: string;
  kind: 'document' | 'subgraph';
  name: string;
  childNodeIds: string[];
  childDocumentIds: string[];
  placements: Record<string, Placement>;
  rev: number;
  metadata: {
    createdAt: string;
    updatedAt: string;
    version: string;
    description?: string;
  };
}

export interface GraphNodeRecord {
  design?: DesignNodeData;
  nodeId: string;
  name: string;
  content: string;
  provisional?: boolean;
}

export interface CanvasDirectory {
  name: string;
  childIds: string[];
  description?: string;
}

export interface CanvasRecord {
  /** Absent on legacy records means exploration. Fixed at creation. */
  mode?: CanvasMode;
  canvasId: string;
  canvasName: string;
  updatedAt: string;
  /** The canvas itself owns the top-level contents; no independent root entity. */
  childIds: string[];
  directories: Record<string, CanvasDirectory>;
  placements: Record<string, Placement>;
  collapsed: Record<string, true>;
  /** Branches removed from this canvas only; original document ownership is retained. */
  excludedDocumentIds?: string[];
  /** Retained node references after a shared document layer is dissolved; these do not own the node. */
  nodeReferenceIds?: string[];
  isDraft?: boolean;
}

export type ConnectionSide = 'top' | 'right' | 'bottom' | 'left';

/** How the renderer draws one edge. Curves are the default because a node's
 *  position is the user's, and a smooth route reads as "a relation" instead of
 *  "a pipe". Orthogonal is an explicit per-edge choice. */
export type EdgeRouteStyle = 'curve' | 'orthogonal';

export interface GraphEdge {
  /** Generated from combination membership; edit members on the combination. */
  membershipFor?: string;
  edgeId: string;
  edgeContent: string;
  directed: boolean;
  sourceNodeId: string;
  targetNodeId: string;
  /** Missing means curve. */
  routeStyle?: EdgeRouteStyle;
  removed?: boolean;
}

export interface GraphState {
  /** Version of the canonical region layout and manual-position provenance. */
  layoutVersion?: number;
  documents: Record<string, GraphRecord>;
  nodes: Record<string, GraphNodeRecord>;
  canvases: CanvasRecord[];
  edges: GraphEdge[];
}

/** Minimum node dimensions; all occupied bounds come from nodeGeometry. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const RECORD_MIN_WIDTH = 260;
export const RECORD_HEADER_HEIGHT = 52;
export const RECORD_PADDING = 24;
export const COLLAPSED_WIDTH = 240;
export const COLLAPSED_HEIGHT = 112;
export const BLOCK_GAP = 48;
