/** Version preconditions are host state, never model-authored tool arguments. */
const expectedVersionTools=new Set(['workspace_update_handoff','workspace_update_work_notes','workspace_delete_work_notes',
  'graph_read_node_content','graph_read_directory_content','graph_read_object_field']);
export function withoutToolVersions(name:string,input:Record<string,unknown>):Record<string,unknown>{
  const args={...input};
  if(['workspace_read_artifact','workspace_view_artifact','workspace_search_artifacts'].includes(name))delete args.version;
  if(expectedVersionTools.has(name))delete args.expectedVersion;
  if(name==='workspace_update_work_notes')delete args.expectedRevision;
  if(name==='graph_read_node_edges'){
    delete args.expectedRelationVersion;
    if(Array.isArray(args.requests))args.requests=args.requests.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return value;
      const row={...value};delete row.expectedRelationVersion;return row;
    });
  }
  if(Array.isArray(args.sourceRefs))args.sourceRefs=args.sourceRefs.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    const row={...value};delete row.version;return row;
  });
  return args;
}

/** Only structured actionable entries are rewritten. User text and archived
 * argument strings remain literal; host receipts retain the original fences. */
export function publicReadEntries(value:unknown):unknown{
  if(Array.isArray(value))return value.map(publicReadEntries);
  if(!value||typeof value!=='object')return value;
  const row=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,publicReadEntries(item)]));
  if(typeof row.tool==='string'&&row.arguments&&typeof row.arguments==='object'&&!Array.isArray(row.arguments))
    row.arguments=withoutToolVersions(row.tool,row.arguments as Record<string,unknown>);
  return row;
}
