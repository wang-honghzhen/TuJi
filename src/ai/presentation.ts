import type { AppSnapshot, ChangeSet, ChatMessage, PresentationPart, ToolCallRecord } from './domain';
import { reviewFooter } from './changeReview';
import { hiddenPresentationCall } from './modelVisibility';

/** Whitespace formats one reply; execution boundaries and br own public segmentation. */
export function presentationSpans(text:string,complete:boolean):Array<{start:number;end:number;sealed:boolean}>{
  return text.trim()?[{start:0,end:text.length,sealed:complete}]:[];
}

function actionText(call:ToolCallRecord,changes:ChangeSet[]=[]):string {
  let result:Record<string,unknown>={};try{result=JSON.parse(call.result??'{}');}catch{/* A malformed receipt cannot prove success. */}
  if(call.status==='rejected'||result.status==='error')return '操作未成功';
  if(result.executed===false||result.status==='blocked')return '本次操作未执行';
  if(call.status==='waiting')return '等待确认后继续';
  if(call.status!=='completed')return '正在处理';
  if(call.name==='graph_apply_changes') {
    const change=changes.find(c=>c.id===result.changeSetId),foot=change?reviewFooter(change):result.userReview as {state?:string;items?:Array<{state:string}>}|undefined;
    const items=change?.review?.callId?change.review.units:(foot as {items?:Array<{state:string}>}|undefined)?.items;
    const review=foot?.state&&foot.state!=='mixed'?`（${foot.state==='reverted'?'已回退':foot.state==='approved'?'已保留':change?.review?.policy==='group'?'整组待决定':'待决定'}）`
      :items?.length?`（待决策 ${items.filter(i=>i.state==='pending').length}，保留 ${items.filter(i=>i.state==='approved').length}，回退 ${items.filter(i=>i.state==='reverted').length}）`:'';
    return result.status==='committed'?'已提交修改'+review:'已收到修改结果';
  }
  if(call.name==='graph_propose_changes')return '已生成修改方案，等待提交';
  if(call.name==='ui_focus')return '已定位相关对象';
  if(call.name==='workspace_update_work_notes')return '已更新会话笔记';
  if(call.name==='workspace_update_handoff')return '已追加任务笔记';
  if(call.name==='context_view')return '已查看摘要';
  if(call.name==='graph_read_directory')return '已读取目录';
  if(call.name==='graph_search'||call.name==='workspace_search_artifacts'||call.name==='web_search')return '已取得搜索结果';
  if(call.name==='workspace_read_artifact')return result.status==='partial'?'附件文本未完整提取，可查看页面图像':'已读取附件正文';
  if(call.name==='workspace_view_artifact')return '已取得附件页面图像';
  if(call.name==='context_read_task_attachments')return (result.protection as {accepted?:boolean}|undefined)?.accepted?'已读取附件清单并保护至任务结束':'已读取附件清单';
  if(call.name==='web_fetch')return '已取得网页读取结果';
  if(call.name.startsWith('graph_read')||call.name==='graph_neighbors'||call.name.startsWith('context_read'))
    return result.status==='partial'?'已取得部分资料':'已取得本次读取结果';
  return '已收到操作结果';
}
export interface PresentationRow {id:string;user:boolean;body:string;status:boolean;calls?:ToolCallRecord[];message?:ChatMessage}
/** Preserve source order and render tool activity even when the part also contains a reply. */
export function presentationRows(state:(Pick<AppSnapshot,'messages'|'toolCalls'>&Partial<Pick<AppSnapshot,'changes'>>)|null|undefined,part:PresentationPart|undefined) {
  const rows:PresentationRow[]=[];
  for(const event of part?.events??[]){
    const message=state?.messages.find(m=>m.id===event.messageId),body=message?.text.slice(event.start??0,event.end)??'';
    if(body.trim()||message?.role==='user'&&(message.attachments?.length||message.targetRefs.length)){rows.push({id:event.id,user:event.kind==='user',body,status:false,message:message?{...message,text:body}:undefined});continue;}
    if(event.kind!=='tools'&&event.kind!=='focus')continue;
    const calls=(event.calls?.length?event.calls:event.callId?state?.toolCalls.filter(c=>c.id===event.callId)??[]:[])
      .filter(c=>!['task_finish','ui_present'].includes(c.name)&&!hiddenPresentationCall(c));
    if(!calls.length)continue;
    const prior=rows.at(-1);
    if(prior?.calls)prior.calls.push(...calls);
    else rows.push({id:event.id,user:false,body:'',status:true,calls:[...calls]});
  }
  for(const row of rows)if(row.calls)row.body=[...new Set(row.calls.map(c=>actionText(c,state?.changes)))].join('；');
  return rows;
}
