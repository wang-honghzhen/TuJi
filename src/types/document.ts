/** List-facing projection of a graph document. */
export interface DocumentMeta {
  documentId: string;
  documentName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: string;
  stats: {
    nodeCount: number;
    edgeCount: number;
    /** Containers (directories) within the document. */
    subgraphCount: number;
  };
}
