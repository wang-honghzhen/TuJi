import { ATTACHMENT_TOOLS, attachmentRead } from './attachmentReads';
import { authorizedAttachments } from './attachmentCatalog';
import { TASK_ARCHIVE_TOOLS, directTaskArchiveRead } from './taskArchive';
import { assertDesignQuery, graphQueryDependency } from './graphQueries';
import { inheritedReadScope } from './inheritedReadScope';
import { rememberPageOrigin } from './readPageEvidence';
import { randomUUID } from 'node:crypto';
import type { AppSnapshot, Task, ToolCallRecord, SourceRef } from '../domain';
import type { Coverage, ExpansionPart, FrozenRead, Observation } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { effectiveArtifacts } from '../memory';
import { allEvidence, historyEntries, validArtifactSummary, summaryArchive } from './historyRepresentations';
import { graphIndex, observationChange } from './directGraph';
import { resultPages } from './resultPaging';
import { DomainError, requireValue } from './errors';
import { estimateTokens } from '../tokens';
import { directReadBudget, directReadBudgets, readCapacityReceipt, frozenPageCapacityReceipt } from './directReadBudget';
import { historicalRecordView, HISTORY_VIEW_VERSION } from './historyRecordView';
import { READ_FORMAT_VERSION, readCoverage, pageCoverage } from './readCoverage';
import { summaryProjection } from './summaryBindings';
import { repeatReadNotice } from './readRepetition';
import { frozenGraphReadHashes, rememberGraphReadHashes } from './graphReadDependencies';
import { relationDependency } from './graphRelationDependencies';
import { subgraphDependency } from './subgraphVersions';
import { summaryReadScope, assertSummaryRead } from './summaryReadScope';
import { readSummaryTree } from './summaryTreeRead';
import { isReceipted, rememberReadPage } from './readVisibility';
import { attachFrozenDirectoryEvidence } from './directoryEvidence';
import { isWebTool } from './webTools';
import { notebookWorkspace, notePayload } from '../notebook';
import { checkFrozenStorage } from './graphReadLimits';
import { rememberSummaryOrigin } from './summaryRegions';
import { rememberCanvasRead } from './canvasReadEvidence';
import { historyRecordDirectory } from './historyRecordDirectory';

const visible=summaryReadScope;
export function directContextRead(state:AppSnapshot,task:Task,call:ToolCallRecord,args:Record<string,unknown>):Record<string,unknown> {
  state=inheritedReadScope(state,task);
  const w=state.workspaces.find(w=>w.id===task.workspaceId)!;
  if(ATTACHMENT_TOOLS.has(call.name)||call.name==='context_read_pages'&&w.frozenReads?.some(r=>r.id===args.pointerId&&r.attachmentRead))return attachmentRead(state,task,call,args);
  if(['context_read_children','context_read_summary_tree'].includes(call.name)&&typeof args.summaryId==='string'){
    const file=authorizedAttachments(state,task).find(f=>`attachment:${f.ref.id}:${f.ref.version}`===args.summaryId
      ||summaryArchive(state,task).some(s=>s.id===args.summaryId&&s.semanticType==='artifact'&&s.artifactId===f.ref.id&&s.artifactVersion===f.ref.version));
    if(file){
      if(args.summaryId===`attachment:${file.ref.id}:${file.ref.version}`)return attachmentRead(state,task,call,{artifactId:file.ref.id,version:file.ref.version,budget:args.budget});
      return {status:'ok',bodyOmitted:true,instruction:'附件摘要已停用，请从原文件读取',readWith:file.entry.readWith,viewWith:file.entry.viewWith};
    }
  }
  if(TASK_ARCHIVE_TOOLS.has(call.name)||call.name==='context_read_pages'&&w.frozenReads?.some(r=>r.id===args.pointerId&&r.kind==='task_archive'))return directTaskArchiveRead(state,task,call,args);
  if(call.name==='context_read_summary_tree')return readSummaryTree(state,task,call,args,(read,result)=>
    recordUse(state,task,call,read.observation.refs,read.targetVersions!,[],read.sources,result));
  if(call.name==='context_read_children'&&Array.isArray(args.requests)){
    const initialBudget=directReadBudget(state,task,call,args.budget);
    let remaining=initialBudget-32,sources:SourceRef[]=[];
    const results:Record<string,unknown>[]=[];
    const blockedItem=(item:Record<string,unknown>,requiredTokens?:number,minimumOnly=false)=>{
      const limits=directReadBudgets(state,task,call,item.budget),spent=Math.max(0,initialBudget-remaining);
      // Child calls use the remaining batch budget for admission, but that is not
      // a budget chosen by the model. Diagnose against its original arguments.
      const contextRemainingTokens=Math.max(0,limits.contextRemainingTokens-spent);
      const diagnosticLimits={...limits,availableTokens:Math.max(0,Math.min(limits.availableTokens,remaining)),
        groupRemainingTokens:Math.max(0,Math.min(limits.groupRemainingTokens,remaining)),contextRemainingTokens,
        nextResponseTokens:Math.min(limits.nextResponseTokens,contextRemainingTokens)};
      return readCapacityReceipt(call,item,diagnosticLimits.availableTokens,requiredTokens,{limits:diagnosticLimits,minimumOnly});
    };
    const requests=args.requests as Array<Record<string,unknown>>;
    for(const item of requests){
      let result:Record<string,unknown>;
      if(remaining<256)result=blockedItem(item,256,true);
      else try{
        result=directContextRead(state,task,call,{...item,budget:Math.min(Number(item.budget??remaining),remaining)});
        if(result.code==='READ_GROUP_CAPACITY')result=blockedItem(item,typeof result.requiredTokens==='number'?result.requiredTokens:undefined,result.requiredTokensAreMinimum===true);
        sources.push(...call.resultSources??[]);
      }catch(error){result={summaryId:item.summaryId,status:'error',message:error instanceof Error?error.message:String(error),
        ...(error instanceof DomainError?{code:error.code,...(error.details===undefined?{}:{details:error.details})}:{})};}
      // Failures and exceptions are also public text in the next request.
      results.push(result);remaining-=estimateTokens(JSON.stringify(result));
    }
    const response={status:results.every(r=>r.status==='ok')?'ok':'partial',results};
    const alternatives=results.map(result=>result.nextAction==='retry_unread_in_next_response'?{...result,
      blockingReason:'context_headroom',nextAction:'restore_context_capacity',
      instruction:'计入本批全部回执后持续余量不足；先维护上下文或恢复容量，保留原读取入口。'}:result);
    // Bound every possible final combination before choosing recommendations.
    // Summed row estimates plus the complete envelope are conservative, so changing
    // an earlier hint cannot increase the final cost past this fixed bound.
    const envelopeTokens=estimateTokens(JSON.stringify({...response,results:[]}))+results.length;
    const maximumResponseTokens=envelopeTokens+results.reduce((sum,result,index)=>sum+Math.max(
      estimateTokens(JSON.stringify(result)),estimateTokens(JSON.stringify(alternatives[index]))),0);
    results.forEach((result,index)=>{
      if(result.nextAction!=='retry_unread_in_next_response')return;
      const limits=directReadBudgets(state,task,call,requests[index].budget);
      const nextAvailable=Math.min(limits.nextResponseTokens,Math.max(0,limits.contextRemainingTokens-maximumResponseTokens));
      if(typeof result.requiredTokens!=='number'||result.requiredTokensAreMinimum===true||result.requiredTokens>nextAvailable)results[index]=alternatives[index];
    });
    call.resultSources=[...new Map(sources.map(s=>[JSON.stringify(s),s])).values()];return response;
  }
  if(call.name==='context_read_pages'){
    const evidence=allEvidence(state,task),permitted=new Set(evidence.map(r=>r.id));
    const read=w.frozenReads?.find(r=>r.id===args.pointerId)
      ??state.workspaces.flatMap(owner=>owner.frozenReads??[]).find(r=>r.id===args.pointerId&&isWebTool(r.kind)&&permitted.has(r.callId));
    requireValue(read&&read.expiresAt>Date.now(),'分页快照不存在或已经过期，请重新读取','CURSOR_EXPIRED');
    requireValue(read.readFormatVersion===READ_FORMAT_VERSION&&read.coverage,'读取格式已更新，请从原入口重新读取','CURSOR_EXPIRED');
    const page=Number(args.page);requireValue(Number.isInteger(page)&&page>=1&&page<=read.pages.length,'页码无效');
    const summaryTree=read.kind==='summary_tree'||read.kind==='summary_children';
    if(summaryTree){requireValue(read.canvasId===task.canvasId,'摘要分页不属于当前画布','OUT_OF_SCOPE');assertSummaryRead(state,task,read.targetVersions??{});}
    if(isWebTool(read.kind))requireValue(permitted.has(read.callId),'联网读取来源不在当前会话继承范围','OUT_OF_SCOPE');
    if(read.kind==='history'){
      requireValue(read.historyViewVersion===HISTORY_VIEW_VERSION,'历史读取格式已更新，请从原文或摘要入口重新读取','CURSOR_EXPIRED');
      const scope=visible(state,task);
      requireValue(read.observation.refs.every(id=>scope.allowed.has(id)||permitted.has(id))&&read.sources.filter(s=>s.kind==='message').every(s=>permitted.has(s.id)),'历史来源已撤销','OUT_OF_SCOPE');
      requireValue(!!read.targetVersions&&Object.entries(read.targetVersions).every(([id,version])=>scope.archive.some(s=>s.id===id&&s.version===version&&scope.allowed.has(id))
        ||scope.records.some(r=>r.id===id&&r.version===version)),'历史来源版本已变化，请重新读取','STALE_SOURCE');
    }
    if(read.kind==='artifact')requireValue(read.sources.filter(s=>s.kind==='artifact').every(s=>effectiveArtifacts(state,task).some(f=>f.ref.id===s.id&&f.ref.version===s.version&&f.artifact)),'附件来源已撤销或原版本不可用','OUT_OF_SCOPE');
    const notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
    const note=read.noteBinding&&notebook?.id===read.noteBinding.notebookId?notebook.workNotes.find(n=>n.id===read.noteBinding!.noteId):undefined;
    if(read.kind==='note')requireValue(note,'笔记已删除或来源已撤销','OUT_OF_SCOPE');
    if(read.kind==='graph_read_design_references')assertDesignQuery(state,task);
    const graph=read.kind.startsWith('graph_');
    const readHashes=graph?frozenGraphReadHashes(read,page):undefined;
    const change=graph?observationChange(state,read.snapshotObservation??read.observation):{changes:[]};
    const unknown=graph&&!read.pageObservations?.[page-1],data=read.pages[page-1],stale=unknown||change.changes.length>0||!!note&&note.version!==read.noteBinding!.version;
    const sources=read.pageSources?.[page-1]??[];
    if(graph){
      const index=graphIndex(state,task.canvasId),edges=new Set(index.edges.map(edge=>edge.edgeId));
      const failedRefs=sources.filter(source=>source.kind==='edge'?!edges.has(source.id):!index.rows.get(source.id)?.readable).map(source=>source.id);
      for(const key of Object.keys(readHashes??{})){const q=graphQueryDependency(key);if(q){
        if(q.query.arguments.designTypes!==undefined)assertDesignQuery(state,task);
        const targets=[...(Array.isArray(q.query.arguments.refs)?q.query.arguments.refs as string[]:[]),...(typeof q.query.arguments.refId==='string'?[q.query.arguments.refId]:[]),...[q.query.arguments.sourceRefId,q.query.arguments.targetRefId].filter((v):v is string=>typeof v==='string')];
        if(q.canvasId!==task.canvasId||targets.some(ref=>!index.rows.get(ref)?.readable))failedRefs.push(...targets.length?targets:[q.canvasId]);
      }const query=relationDependency(key)??subgraphDependency(key);
        if(query&&(query.canvasId!==task.canvasId||query.refId!==index.rootId&&!index.rows.get(query.refId)?.readable))failedRefs.push(query.refId);}
      requireValue(read.canvasId===task.canvasId&&!failedRefs.length,'分页来源已不在当前画布读取范围，请重新读取','OUT_OF_SCOPE',
        {failedRefs,executed:false,nextAction:'reread_current_canvas'});
    }
    const result={status:data.status==='blocked'?'partial':'ok',pointerId:read.id,page,totalPages:read.pages.length,hasMorePages:page<read.pages.length,isLastPage:page===read.pages.length,data,coverage:pageCoverage(read.coverage,read.pages.length,data.status==='blocked'),
      sources,...(graph?{freshness:unknown?'unknown':stale?'stale':'current'}:{}),...(!unknown?{stale}:{}),...(page===1&&read.recordDirectory?{recordDirectory:read.recordDirectory}:{}),...(read.searchSelection?{selection:read.searchSelection}:{}),...(unknown?{notice:'无法确认冻结页相对当前源的版本；证据不足，不能作为当前版本已读依据。'}:stale?{notice:'这是冻结版本的原文，可用于历史比较；仅需当前版本时重新读取。'}:{}),...(page<read.pages.length?{nextCursor:{pointerId:read.id,page:page+1}}:{})};
    const requiredTokens=estimateTokens(JSON.stringify(result)),limits=directReadBudgets(state,task,call,args.budget??read.pageBudget),budget=limits.availableTokens;
    if(requiredTokens>limits.maximumTokens)return frozenPageCapacityReceipt(call,args,budget,requiredTokens,limits.maximumTokens);
    if(requiredTokens>budget)return readCapacityReceipt(call,args,budget,requiredTokens,{limits});
    const repeatNotice=graph||read.kind==='history'?repeatReadNotice(state,task,call,read.id,page):undefined;
    if(repeatNotice&&estimateTokens(JSON.stringify({...result,repeatNotice}))<=budget)Object.assign(result,{repeatNotice});
    call.resultSources=summaryTree?read.sources:sources;
    call.frozenSourceCallId=read.callId;
    call.readOriginIds=[...read.originResultIds??[]];
    rememberReadPage(call,read.id,page,readHashes);
    rememberPageOrigin(call,read,page);
    rememberSummaryOrigin(call,read);
    if(graph)rememberCanvasRead(call,read,page);
    attachFrozenDirectoryEvidence(call,read,page);
    if(readHashes&&!unknown)rememberGraphReadHashes(task,readHashes,stale);
    if(read.kind==='history'||summaryTree)recordUse(state,task,call,read.observation.refs,read.targetVersions!,read.pageCoverage?.[page-1]??[],summaryTree?read.sources:sources,result);
    else if(graph&&read.pageObservations?.[page-1]){
      const observation=structuredClone(read.pageObservations[page-1]);observation.id=`observation:${randomUUID()}`;observation.callId=call.id;
      observation.historical=stale;
      (w.observations??=[]).push(observation);
    }
    return result;
  }
  const v=visible(state,task);
  if(call.name==='context_view'){
    const operations=args.operations as Array<Record<string,unknown>>;
    return{status:'ok',results:operations.map(op=>{
      requireValue(op.action==='inspect'&&typeof op.summaryId==='string','仅支持按摘要入口检查；历史请使用已有读取入口','INVALID_ARGUMENT');
      const summary=v.archive.find(s=>s.id===op.summaryId&&v.allowed.has(s.id));
      requireValue(summary,'摘要不在当前保留结构中','OUT_OF_SCOPE');return{...summaryProjection(state,task,summary),children:summary.children.length,readWith:'context_read_children'};
    })};
  }
  const id=String(args.summaryId),summary=v.archive.find(s=>s.id===id);
  const notebook=notebookWorkspace(state,state.sessions.find(s=>s.id===task.sessionId));
  const note=notebook?.workNotes.find(n=>n.id===id);
  const permittedIds=new Set([...historyEntries(state,task).protectedCoverage,...v.archive.filter(s=>v.allowed.has(s.id)).flatMap(s=>s.coverage)].map(c=>c.recordId));
  const allowedRecords=v.records.filter(r=>r.taskId===task.id||permittedIds.has(r.id));
  const projections:Array<{recordId:string;recordLength:number;start:number;view:ReturnType<typeof historicalRecordView>}>=[];
  const recordBody=(r:typeof v.records[number],start:number,end:number)=>{
    if(r.representation==='receipt')return {
      recordId:r.id,taskId:r.taskId,bodyOmitted:true,content:r.projectionText??r.text,
      readWith:{tool:'context_restore_records',arguments:{recordIds:[r.id]}}};
    const view=historicalRecordView(state,r,allowedRecords,start,end);projections.push({recordId:r.id,recordLength:r.text.length,start,view});
    return{recordId:r.id,taskId:r.taskId,start,end:start+view.text.length,content:view.text,
      ...(view.viewedContent?{viewedContent:view.viewedContent}:{})};
  };
  let contents:unknown[]=[],sources:SourceRef[]=[],coverage:Coverage[]=[],kind='history';
  if(note){
    kind='note';contents=[{...notePayload(note),start:0,end:note.text.length}];
    sources=[{kind:'note',id:note.id,version:note.version}];
  }else if(summary){
    const permittedArtifact=summary.semanticType==='artifact'&&effectiveArtifacts(state,task).some(f=>f.artifact&&validArtifactSummary(summary,f.artifact,v.archive));
    requireValue(v.allowed.has(id)||permittedArtifact,'摘要不在当前合法保留结构中','OUT_OF_SCOPE');
    coverage=summary.coverage;sources=summary.sourceRefs;
    if(summary.semanticType==='artifact')kind='artifact';
    if(summary.children.length)contents=summary.children.map(child=>{const s=v.archive.find(s=>s.id===child);requireValue(s,'子摘要版本不可用','STALE_SUMMARY');return summaryProjection(state,task,s);});
    else if(summary.semanticType==='artifact'){
      kind='artifact';const a=effectiveArtifacts(state,task).find(f=>f.ref.id===summary.artifactId&&f.ref.version===summary.artifactVersion)?.artifact;
      requireValue(a,'附件原版本不可用','NOT_FOUND');contents=summary.coverage.map(c=>{const chunk=a.chunks.find(ch=>ch.id===c.recordId);requireValue(chunk,'原文范围不可用','NOT_FOUND');return{artifactId:a.id,version:a.version,start:chunk.start+c.start,end:chunk.start+c.end,content:chunk.text.slice(c.start,c.end)};});
    }else contents=summary.coverage.map(c=>{const r=v.records.find(r=>r.id===c.recordId&&r.version===c.version);requireValue(r,'历史来源不可用','NOT_FOUND');return recordBody(r,c.start,c.end);});
  }else{
    const raw=v.records.find(r=>r.id===id);
    const selection=historyEntries(state,task);
    const allowedRaw=raw&&(raw.taskId===task.id||selection.protectedCoverage.some(c=>c.recordId===id)||v.archive.some(s=>v.allowed.has(s.id)&&s.coverage.some(c=>c.recordId===id)));
    if(raw&&allowedRaw){
      contents=[recordBody(raw,0,raw.text.length)];coverage=[{recordId:raw.id,taskId:raw.taskId,version:raw.version,start:0,end:raw.text.length}];sources=raw.sources;
    }else{
    const artifact=effectiveArtifacts(state,task).find(f=>`attachment:${f.ref.id}:${f.ref.version}`===id)?.artifact;
    requireValue(artifact,'读取入口不存在或不在当前范围','OUT_OF_SCOPE');kind='artifact';
    const summaries=v.archive.filter(s=>validArtifactSummary(s,artifact,v.archive)),children=new Set(summaries.flatMap(s=>s.children));
    contents=summaries.length?summaries.filter(s=>!children.has(s.id)).map(s=>summaryProjection(state,task,s)):artifact.chunks.map(c=>({artifactId:artifact.id,version:artifact.version,start:c.start,end:c.end,content:c.text}));
    sources=[{kind:'artifact',id:artifact.id,version:artifact.version}];
    }
  }
  const limits=directReadBudgets(state,task,call,args.budget),budget=limits.availableTokens;
  if(budget<256)return readCapacityReceipt(call,args,budget,256,{limits,minimumOnly:true});
  const pointerId=`read:${randomUUID()}`;
  const resultCoverage=readCoverage(kind==='artifact'?'artifact':'history',kind==='artifact'&&sources.some(s=>s.kind==='artifact'&&effectiveArtifacts(state,task).some(f=>f.ref.id===s.id&&f.artifact?.status!=='ready'))?['source_partial']:[]);
  const frame=(data:Record<string,unknown>,page:number,totalPages:number,refs:SourceRef[])=>({status:'ok',summaryId:id,pointerId,page,totalPages,hasMorePages:page<totalPages,isLastPage:page===totalPages,data,sources:refs,coverage:pageCoverage(resultCoverage,totalPages),...(page<totalPages?{nextCursor:{pointerId,page:page+1}}:{})});
  const actualCoverage=(data:unknown):Coverage[]=>{
    const spans:Coverage[]=[];
    const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
      const row=value as Record<string,unknown>;
      if(typeof row.recordId==='string'&&typeof row.start==='number'&&typeof row.end==='number'){
        const c=coverage.find(c=>c.recordId===row.recordId);if(c)spans.push({...c,start:row.start,end:row.end});
      }
      if(typeof row.summaryId==='string'){const s=v.archive.find(s=>s.id===row.summaryId&&row.content===summaryProjection(state,task,s).content);if(s)spans.push(...s.coverage);}
      Object.values(row).forEach(visit);
    };visit(data);return spans;
  };
  const actualSources=(data:unknown):SourceRef[]=>{
    const refs:SourceRef[]=[];
    const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;const row=value as Record<string,unknown>;
      if(typeof row.artifactId==='string'&&typeof row.version==='number'&&typeof row.start==='number'&&typeof row.end==='number')refs.push({kind:'artifact',id:row.artifactId,version:row.version,start:row.start,end:row.end});
      if(typeof row.noteId==='string'&&typeof row.version==='number'&&typeof row.start==='number'&&typeof row.end==='number')refs.push({kind:'note',id:row.noteId,version:row.version,start:row.start,end:row.end});
      if(typeof row.recordId==='string'&&!row.bodyOmitted)refs.push(...(v.records.find(r=>r.id===row.recordId)?.sources??[]));
      if(typeof row.summaryId==='string')refs.push(...(v.archive.find(s=>s.id===row.summaryId)?.sourceRefs??[]));
      Object.values(row).forEach(visit);
    };visit(data);return [...new Map(refs.map(s=>[JSON.stringify(s),s])).values()];
  };
  let pageBudget=Math.floor(Math.min(AUTO_CONTEXT.pageTokens,budget-180)),pages:Record<string,unknown>[]=[],pageSources:SourceRef[][]=[];
  const sourceCoordinates=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(sourceCoordinates);return;}if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>;
    if(typeof row.recordId==='string'&&typeof row.start==='number'&&typeof row.end==='number'){
      const p=projections.find(p=>p.recordId===row.recordId&&p.start<=Number(row.start)&&p.start+p.view.text.length>=Number(row.end));
      if(p)Object.assign(row,p.view.sourceRange(row.start-p.start,row.end-p.start));
    }
    Object.values(row).forEach(sourceCoordinates);
  };
  const originalNavigation=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(originalNavigation);return;}if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>;
    const p=typeof row.recordId==='string'&&typeof row.content==='string'
      ?projections.find(p=>p.recordId===row.recordId&&typeof row.start==='number'&&typeof row.end==='number'
        &&row.start>=p.start&&row.end<=p.view.sourceRange(0,p.view.text.length).end):undefined;
    if(p){
      // Add navigation after packing: repeating a raw record ID inside readWith
      // must not turn an otherwise readable text row into serialized JSON chunks.
      row.readWith={tool:'context_read_children',arguments:{summaryId:p.recordId}};
      row.recordEnd=row.end===p.recordLength;
    }
    // Large application metadata can already require lossless JSON fragments.
    // Its path identifies one actual source row; never guess from user text.
    const fragment=row.resultFragment as {path?:unknown[];offset?:number;totalLength?:number}|undefined;
    if(typeof row.serializedResult==='string'&&fragment?.path?.length===2&&fragment.path[0]==='items'
      &&Number.isSafeInteger(fragment.path[1])){
      const source=contents[fragment.path[1] as number] as Record<string,unknown>|undefined;
      const projection=source&&projections.find(p=>p.recordId===source.recordId&&p.start===source.start);
      if(projection){
        row.readWith={tool:'context_read_children',arguments:{summaryId:projection.recordId}};
        row.recordEnd=typeof fragment.offset==='number'&&fragment.offset+row.serializedResult.length===fragment.totalLength
          &&projection.view.sourceRange(0,projection.view.text.length).end===projection.recordLength;
      }
    }
    Object.values(row).forEach(originalNavigation);
  };
  while(pageBudget>=128){pages=resultPages(structuredClone({items:contents}),pageBudget);pages.forEach(sourceCoordinates);pages.forEach(originalNavigation);pageSources=pages.map(actualSources);
    if(pages.every((p,i)=>estimateTokens(JSON.stringify(frame(p,i+1,pages.length,pageSources[i])))+16<=budget))break;
    pageBudget=Math.floor(pageBudget*.75);
  }
  if(pageBudget<128)return readCapacityReceipt(call,args,budget,undefined,{limits});
  const targetVersions=kind==='history'?{[id]:summary?.version??v.records.find(r=>r.id===id)!.version}:{};
  const observation:Observation={id:`observation:${randomUUID()}`,taskId:task.id,canvasId:task.canvasId,directories:{},paths:{},refs:[id],completeDirectories:[],sources};
  const origins=coverage.filter(c=>!isReceipted(state,c.recordId)&&state.toolCalls.concat(state.snapshots.flatMap(s=>s.toolCalls??[])).some(call=>call.id===c.recordId)).map(c=>c.recordId);
  call.readOriginIds=[...new Set([...(call.readOriginIds??[]),...origins])];
  const read:FrozenRead={id:pointerId,taskId:task.id,callId:call.id,originResultIds:call.readOriginIds,canvasId:task.canvasId,kind,readFormatVersion:READ_FORMAT_VERSION,coverage:resultCoverage,pages,pageSources,pageCoverage:pages.map(actualCoverage),targetVersions,observation,createdAt:new Date().toISOString(),expiresAt:Date.now()+86400000,sources,historyViewVersion:HISTORY_VIEW_VERSION};
  const result=frame(pages[0],1,pages.length,pageSources[0]);
  const recordDirectory=kind==='history'?historyRecordDirectory(contents,coverage,pages,result,budget):undefined;
  if(recordDirectory){read.recordDirectory=recordDirectory;Object.assign(result,{recordDirectory});}
  const summaries=contents.filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object'
    &&typeof (value as Record<string,unknown>).summaryId==='string'&&typeof (value as Record<string,unknown>).content==='string');
  if(summaries.length&&summaries.length===contents.length){
    const ids=[...new Set([...(summary?[summary.id]:[]),...summaries.map(s=>String(s.summaryId))])];
    read.summaryOrigin={pure:true,roots:summary?[summary.id]:summaries.map(s=>String(s.summaryId)),parentId:summary?.children.length?summary.id:undefined,
      versions:Object.fromEntries(ids.map(id=>[id,v.archive.find(s=>s.id===id)!.version]))};
    rememberSummaryOrigin(call,read);
  }
  if(note){read.noteBinding={notebookId:notebook!.id,noteId:note.id,version:note.version};checkFrozenStorage(w.frozenReads??[],[read]);}
  (w.frozenReads??=[]).push(read);call.resultSources=pageSources[0];
  rememberReadPage(call,pointerId,1);
  rememberPageOrigin(call,read,1);
  if(kind==='history')recordUse(state,task,call,[id],targetVersions,read.pageCoverage![0],pageSources[0],result);
  return result;
}
function recordUse(state:AppSnapshot,task:Task,call:ToolCallRecord,targets:string[],targetVersions:Record<string,string>,coverage:Coverage[],sources:SourceRef[],result:Record<string,unknown>){
  const w=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const part:ExpansionPart={targets,targetVersions,coverage,sources,historyViewVersion:HISTORY_VIEW_VERSION,messages:[{role:'user',content:JSON.stringify({historical_read:{callId:call.id,...result}})}]};
  const prior=w.expansionUses?.find(u=>u.callId===call.id);if(prior){prior.targets=[...new Set([...prior.targets,...targets])];prior.coverage.push(...coverage);prior.messages.push(...part.messages);prior.sources.push(...sources);(prior.parts??=[]).push(part);return;}
  (w.expansionUses??=[]).push({presented:false,callId:call.id,order:call.sequence??state.lastSeq,targets:[...targets],coverage:[...coverage],sources:[...sources],
    messages:[...part.messages],parts:[part]});
}
