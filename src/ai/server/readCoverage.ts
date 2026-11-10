export const READ_FORMAT_VERSION=6;
/** Shared public wording; page coverage does not change as later pages are delivered. */
export const PAGE_COVERAGE_INSTRUCTION='coverage.kind及读取参数界定本次选定范围。scope=page时，extent=full/partial/none表示本页单独覆盖该范围的全部/部分/无内容，不表示本页是否传完。多页快照有数据的每页均为partial，末页也保留partial和pagination；pagination标识分页片段，不是待补页清单。';
export type ReadKind='design_references'|'content_search'|'directory'|'subgraph'|'objects'|'neighbors'|'search'|'node_content'|'directory_content'|'object_field'|'node_edges'|'history'|'artifact'|'page'|'summary_tree'|'summary_children'|'web_search'|'web_fetch'|'subgraph_edges'|'between_subgraphs';
export type CoverageReason='pagination'|'oversized_object'|'directory_boundary'|'search_limit'|'capacity'|'source_partial'|'relations_deferred'|'content_fragment'|'tree_boundary';
export interface ReadCoverage {kind:ReadKind;extent:'full'|'partial'|'none';reasons:CoverageReason[];scope?:'page'}
export function readKind(tool:string):ReadKind {
  const kinds:Record<string,ReadKind>={workspace_read_artifact:'artifact',workspace_view_artifact:'artifact',workspace_search_artifacts:'artifact',context_read_task_attachments:'artifact',graph_read_design_references:'design_references',graph_search_node_content:'content_search',graph_read_directory:'directory',graph_read_subgraph:'subgraph',graph_read:'objects',
    graph_neighbors:'neighbors',graph_search:'search',graph_read_node_content:'node_content',graph_read_directory_content:'directory_content',graph_read_node_edges:'node_edges',graph_read_object_field:'object_field',
    graph_read_subgraph_edges:'subgraph_edges',graph_read_between_subgraphs:'between_subgraphs',context_read_task:'history',context_read_steps:'history',context_restore_records:'history',context_read_children:'history',context_read_summary_tree:'summary_tree',context_read_pages:'page',web_search:'web_search',web_fetch:'web_fetch'};
  return kinds[tool]??'page';
}
export function readCoverage(kind:ReadKind,reasons:CoverageReason[]=[],noData=false):ReadCoverage {
  return {kind,extent:noData?'none':reasons.length?'partial':'full',reasons:[...new Set(reasons)]};
}
export function pageCoverage(coverage:ReadCoverage,pages:number,noData=false):ReadCoverage {
  return {...readCoverage(coverage.kind,[...coverage.reasons,...(pages>1?['pagination' as const]:[])],noData),scope:'page'};
}
