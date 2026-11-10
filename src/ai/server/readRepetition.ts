import type { AppSnapshot, Task, ToolCallRecord } from '../domain';

/** Measure a short repeat window against nearby receipts; never persist a read/progress ledger. */
export function repeatReadNotice(state:AppSnapshot,task:Task,call:ToolCallRecord,pointerId:string,page:number) {
  const nearby=state.toolCalls.filter(c=>c.taskId===task.id&&c.id!==call.id&&c.presentedAt!==undefined).slice(-32);
  const windowStart=Math.max(0,nearby.length-8);
  const reads=nearby.flatMap((c,index)=>{
    if(c.status!=='completed')return [];
    try{const r=JSON.parse(c.result??'{}');return r.status==='ok'&&typeof r.pointerId==='string'&&Number.isInteger(r.page)
      ?[{callId:c.id,pointerId:r.pointerId,page:r.page,index}]:[];}catch{return [];}
  });
  const previous=reads.filter(r=>r.pointerId===pointerId&&r.page===page);
  if(!previous.length)return;
  const seen=new Set<string>();let repeats=0;
  for(const r of [...reads,{pointerId,page,index:nearby.length}]){const key=JSON.stringify([r.pointerId,r.page]);if(seen.has(key)&&r.index>=windowStart)repeats++;seen.add(key);}
  const samePage=previous.filter(r=>r.index>=windowStart).length>=2;
  if(!samePage&&repeats<3)return;
  return {reason:samePage?'same_page':'repeated_pages',callIds:previous.map(c=>c.callId),
    instruction:'近期连续重读已成功返回的冻结页，本次仍提供原文。请先结合现有摘要和后续回执核对已取得的事实；只有缺少具体细节才继续读对应页，已有事实足够时继续分析或完成任务，不因历史partial或旧失败重新遍历整套分页。'};
}
