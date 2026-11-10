import type { AppSnapshot, ToolCallRecord } from './domain';

const compact=(value:unknown,limit=100)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,limit):'';
export function graphTargetName(snapshot:Pick<AppSnapshot,'graph'>|null|undefined,ref:string,canvasId?:string):string {
  const graph=snapshot?.graph,canvas=graph?.canvases.find(c=>c.canvasId===canvasId);
  const name=graph?.nodes[ref]?.name??graph?.documents[ref]?.name??canvas?.directories[ref]?.name
    ??graph?.canvases.find(c=>c.canvasId===ref)?.canvasName;
  if(name)return name;
  const edge=graph?.edges.find(e=>e.edgeId===ref);
  if(edge)return `${graph?.nodes[edge.sourceNodeId]?.name??'起点'} → ${graph?.nodes[edge.targetNodeId]?.name??'终点'}`;
  return ref;
}

/** Summaries describe the requested scope and delivered result, without dumping bodies. */
export function toolDescription(call:ToolCallRecord,snapshot?:AppSnapshot|null):string {
  let args:Record<string,any>={},result:Record<string,any>={};
  try{args=JSON.parse(call.arguments);}catch{/* Keep invalid calls inspectable. */}
  try{result=JSON.parse(call.result??'{}');}catch{/* No result yet. */}
  const task=snapshot?.tasks.find(t=>t.id===call.taskId);
  const name=(ref:unknown)=>{
    if(typeof ref!=='string')return '';
    const raw=snapshot?.canvasGraphReferences[task?.canvasId??'']?.aliases[ref]??ref;
    return compact(graphTargetName(snapshot,raw,task?.canvasId),70);
  };
  const refs=Array.isArray(args.refs)?args.refs:args.refId?[args.refId]:Array.isArray(args.requests)?args.requests.map((r:any)=>r.refId):[];
  const scope=refs.length?refs.slice(0,3).map(name).join('、')+(refs.length>3?` 等 ${refs.length} 项`:''):'';
  const artifact=typeof args.artifactId==='string'?[...snapshot?.artifacts??[],...snapshot?.snapshots.flatMap(s=>s.artifacts??[])??[]].find(a=>a.id===args.artifactId&&(!call.attachmentRead?.versions[a.id]||a.version===call.attachmentRead.versions[a.id])):undefined;
  const file=compact(artifact?.name??'附件',90);
  let description=scope;
  if(call.name==='graph_read_directory')description=`${scope||'当前画布'} · ${args.mode==='children'?'直属子图目录':'子图目录树'}`;
  else if(call.name==='graph_read_subgraph')description=`${scope||'当前画布'} · 直属节点与关系`;
  else if(call.name==='graph_read_object_field')description=[scope,({name:'名称',path:'路径',design:'设计信息'} as Record<string,string>)[args.field]??compact(args.field)].filter(Boolean).join(' · ');
  else if(call.name==='graph_read_node_content'||call.name==='graph_read_directory_content')description=`${scope} · ${args.start!==undefined?`字符 ${args.start}–${args.end}`:'正文'}`;
  else if(call.name==='workspace_read_artifact')description=`${file} · ${args.startPage!==undefined||args.endPage!==undefined?`物理页 ${args.startPage??1}–${args.endPage??'后续页'}`:args.startLine!==undefined?`提取文本行 ${args.startLine}–${args.endLine??'后续行'}`:args.chunkIds?`${args.chunkIds.length} 个分片`:'提取文本'}`;
  else if(call.name==='workspace_view_artifact')description=`${file} · ${artifact?.mimeType==='application/pdf'?`物理页 ${(args.pages??[1]).join('、')}`:'查看图像'}${args.crop?' · 局部裁剪':''}`;
  else if(call.name==='context_read_task_attachments')description=`${args.taskId?'指定任务':'当前提示词范围'}的附件清单${result.protection?.accepted?' · 已保护至本任务结束':''}`;
  else if(call.name.includes('search'))description=[args.query?`“${compact(args.query)}”`:'',scope].filter(Boolean).join(' · ');
  else if(call.name==='web_fetch')description=compact(args.url,150);
  else if(call.name==='context_read_pages')description=`资料 ${compact(args.pointerId)} · 第 ${args.page??1} 页`;
  else if(call.name==='context_restore_records')description=`恢复 ${Array.isArray(args.recordIds)?args.recordIds.length:1} 条历史原文`;
  else if(call.name==='graph_propose_changes')description=`准备 ${Array.isArray(args.commands)?args.commands.length:0} 项画布修改${compact(args.summary)?` · ${compact(args.summary)}`:''}`;
  else if(call.name==='graph_apply_changes'){
    const change=snapshot?.changes.find(c=>c.operationId===call.operationId||c.id===args.changeSetId||c.id===result.changeSetId);
    description=change?`${change.commands.length} 项修改 · 涉及 ${change.affectedRefs.length} 项对象`:'提交画布修改';
  }
  else if(call.name==='workspace_update_work_notes')description=compact(args.title)||'保存供后续任务复用的会话笔记';
  else if(call.name==='workspace_update_handoff')description='向任务进度追加本任务用到的笔记';
  else if(call.name==='interaction_ask')description=compact(args.question,160);
  else if(call.name==='context_read_task'||call.name==='context_read_steps')description=compact(args.taskId)||'读取历史任务的执行记录';
  else if(call.name.startsWith('context_read'))description=compact(args.summaryId)||'展开所需摘要资料';
  const counts:string[]=[];
  if(Number.isSafeInteger(result.page)&&Number.isSafeInteger(result.totalPages))counts.push(`第 ${result.page}/${result.totalPages} 页`);
  if(Array.isArray(result.data?.items))counts.push(`${result.data.items.length} 项结果`);
  if(Array.isArray(result.data?.edges)&&result.data.edges.length)counts.push(`${result.data.edges.length} 条关系`);
  if(call.status==='rejected'||result.status==='error'||result.status==='blocked'){
    const reason=compact(result.message??result.reason??result.error?.message,160);
    if(reason)counts.push(reason);
  }
  return [description,...counts].filter(Boolean).join(' · ');
}
