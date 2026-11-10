/** Host metadata, never sent as an extra provider function-schema field. */
export type ToolContextKind = 'read_data' | 'other';
export const TOOL_CONTEXT_KINDS: Readonly<Record<string, ToolContextKind>> = Object.freeze({
  context_read_task_attachments: 'read_data', workspace_view_artifact: 'read_data',
  web_search: 'read_data', web_fetch: 'read_data',
  graph_read: 'read_data', graph_read_directory: 'read_data', graph_read_subgraph: 'read_data',
  graph_read_node_content: 'read_data', graph_read_directory_content: 'read_data',
  graph_read_design_references: 'read_data', graph_search_node_content: 'read_data',
  graph_read_object_field: 'read_data', graph_read_node_edges: 'read_data',
  graph_read_external: 'read_data', graph_neighbors: 'read_data', graph_search: 'read_data',
  graph_outline: 'read_data', workspace_search_artifacts: 'read_data', workspace_read_artifact: 'read_data',
  workspace_search_history: 'read_data', context_read_pages: 'read_data', context_read_children: 'read_data',
  context_read_summary_tree: 'read_data', context_read_task:'read_data', context_read_steps:'read_data', context_restore_records:'read_data',
  graph_read_subgraph_edges:'read_data', graph_read_between_subgraphs:'read_data',
});
export const toolContextKind = (name: string): ToolContextKind => TOOL_CONTEXT_KINDS[name] ?? 'other';
export const isDataRead = (name: string): boolean => toolContextKind(name) === 'read_data';

/** These capabilities are independent of receipt eligibility and never provider schemas. */
export const DIRECTORY_REPLAY_TOOLS: Readonly<Record<string, 'directory' | 'directory_page'>> = Object.freeze({
  graph_read_directory: 'directory', context_read_pages: 'directory_page',
});
export const GRAPH_USAGE_TOOLS: Readonly<Record<string, 'read' | 'page' | 'write'>> = Object.freeze({
  graph_read_design_references: 'read', graph_search_node_content: 'read',
  graph_read: 'read', graph_read_subgraph: 'read', graph_read_node_content: 'read',
  graph_read_directory_content: 'read', graph_read_object_field: 'read', graph_read_node_edges: 'read',
  graph_read_external: 'read', graph_neighbors: 'read', graph_search: 'read',
  context_read_pages: 'page', graph_apply_changes: 'write', graph_read_subgraph_edges:'read', graph_read_between_subgraphs:'read',
});
