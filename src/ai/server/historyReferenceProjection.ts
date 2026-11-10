import type { AppSnapshot, Task } from '../domain';
import type { Coverage } from '../contextState';
import { allEvidence, receipt, historicalCallBody, historicalCallProjection, type Evidence } from './historyRepresentations';
import { historicalRecordView } from './historyRecordView';
import { projectReferenceFragment, referenceEdits, sliceReferenceEdits, type EmbeddedReferenceEdits, type ReferenceEdit } from './referenceFragments';
import { isReceipted, isWriteReceipted, visibleCall } from './readVisibility';
import { historicalGraphEncoder, translateGraphPayload } from './graphReferences';
import { promptReceipt } from './promptReceipts';

/** Project only verified application-owned record bodies. Archive text, versions and
 * page coordinates stay canonical; user text and document content remain opaque. */
export function historyReferenceProjection(state:AppSnapshot,task:Task,encode:(id:string)=>string) {
  const records=allEvidence(state,task),byId=new Map<string,Evidence[]>();
  for(const record of records)byId.set(record.id,[...(byId.get(record.id)??[]),record]);
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const calls=[...state.toolCalls,...state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked)
    .flatMap(s=>s.toolCalls??[])].filter(call=>byId.has(call.id)).map(c=>visibleCall(state,c));
  const notices=new Map([...workspace.taskNotices??[],...state.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked)
    .flatMap(s=>s.taskNotices??[])].map(n=>[n.id,n]));
  const cache=new Map<Evidence,ReferenceEdit[]>(),visiting=new Set<Evidence>();
  let activeEncode = encode;
  const withEncoder = <T,>(encoder:(id:string)=>string, project:()=>T):T => {
    const previous = activeEncode; activeEncode = encoder;
    try { return project(); } finally { activeEncode = previous; }
  };
  const activeFragments=new Set<string>();
  const embedded:EmbeddedReferenceEdits=(key,row)=>key==='content'?contentEdits(row):key==='serializedResult'?fragmentEdits(row):undefined;
  let fragmentSources:Map<string,Set<string>>|undefined;
  const fragments=()=>{
    if(fragmentSources)return fragmentSources;
    const groups=new Map<string,{shape:string;length:number;parts:Map<number,string>;invalid?:boolean}>();
    const collect=(value:unknown,pointer:string):void=>{
      if(Array.isArray(value)){value.forEach(item=>collect(item,pointer));return;}
      if(!value||typeof value!=='object')return;
      const row=value as Record<string,unknown>;
      if(typeof row.pointerId==='string')pointer=row.pointerId;
      const fragment=row.resultFragment as Record<string,unknown>|undefined;
      if(pointer&&typeof row.serializedResult==='string'&&fragment?.encoding==='json'&&Array.isArray(fragment.path)
        &&Number.isSafeInteger(fragment.offset)&&Number.isSafeInteger(fragment.totalLength)){
        const shape=JSON.stringify([fragment.path,fragment.totalLength]),key=JSON.stringify([pointer,shape]);
        const group=groups.get(key)??{shape,length:fragment.totalLength as number,parts:new Map<number,string>()};
        const offset=fragment.offset as number,previous=group.parts.get(offset);
        if(previous!==undefined&&previous!==row.serializedResult)group.invalid=true;
        group.parts.set(offset,row.serializedResult);groups.set(key,group);
      }
      Object.values(row).forEach(item=>collect(item,pointer));
    };
    for(const read of workspace.frozenReads??[])collect(read.pages,read.id);
    for(const call of calls)if(call.result)try{collect(JSON.parse(call.result),'');}catch{/* Malformed results have no recoverable fragments. */}
    fragmentSources=new Map();
    for(const group of groups.values()){
      let source='';
      for(const [offset,part] of [...group.parts].sort((a,b)=>a[0]-b[0])){
        if(offset!==source.length){group.invalid=true;break;}source+=part;
      }
      if(group.invalid||source.length!==group.length)continue;
      const sources=fragmentSources.get(group.shape)??new Set<string>();sources.add(source);fragmentSources.set(group.shape,sources);
    }
    return fragmentSources;
  };
  const fragmentEdits=(row:Record<string,unknown>):ReferenceEdit[]|undefined=>{
    const fragment=row.resultFragment as Record<string,unknown>|undefined;
    if(typeof row.serializedResult!=='string'||fragment?.encoding!=='json'||!Array.isArray(fragment.path)
      ||!Number.isSafeInteger(fragment.offset)||!Number.isSafeInteger(fragment.totalLength))return;
    const start=fragment.offset as number,end=start+row.serializedResult.length;
    if(start<0||end>(fragment.totalLength as number))return;
    const sources=[...(fragments().get(JSON.stringify([fragment.path,fragment.totalLength]))??[])]
      .filter(source=>source.slice(start,end)===row.serializedResult);
    if(sources.length!==1)return; // Never guess which complete value a fragment came from.
    const source=sources[0];
    if(activeFragments.has(source)||activeFragments.size>=32)return;
    activeFragments.add(source);
    try{return sliceReferenceEdits(referenceEdits(source,activeEncode,false,[],embedded),start,end);}
    finally{activeFragments.delete(source);}
  };
  const recordEdits=(record:Evidence):ReferenceEdit[]=>{
    const cached=cache.get(record);if(cached)return cached;
    // Historical reads normally point backwards. Malformed cycles never expand recursively.
    if(visiting.has(record)||visiting.size>=32)return [];
    visiting.add(record);
    try{
      const edits=withEncoder(historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order),
        ()=>referenceEdits(record.text,activeEncode,true,undefined,embedded));
      cache.set(record,edits);return edits;
    }finally{visiting.delete(record);}
  };
  const contentEdits=(row:Record<string,unknown>,coverage:Coverage[]=[]):ReferenceEdit[]|undefined=>{
    if(typeof row.recordId!=='string'||typeof row.content!=='string')return;
    for(const record of byId.get(row.recordId)??[]){
      if(row.sourceVersion!==undefined&&row.sourceVersion!==record.version)continue;
      const ranges=typeof row.start==='number'&&typeof row.end==='number'?[{start:row.start,end:row.end}]
        :coverage.filter(c=>c.recordId===record.id&&c.version===record.version);
      for(const {start,end} of ranges.length?ranges:[{start:0,end:record.text.length}]){
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>record.text.length)continue;
        const view=historicalRecordView(state,record,records,start,end);
        if(view.text===row.content)return view.referenceEdits(recordEdits(record));
      }
      // Derived receipts have different bytes from their immutable source. Match
      // only host-generated forms, including notices, before translating strings.
      if(row.content===record.projectionText||calls.some(call=>call.id===record.id&&[false,true]
        .some(group=>row.content===JSON.stringify(historicalCallProjection(state,call,group)))))
        return withEncoder(historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order),
          ()=>referenceEdits(row.content as string,activeEncode,true,undefined,embedded));
      if(row.sourceVersion===record.version&&calls.some(call=>call.id===record.id&&row.content===JSON.stringify(receipt(call))))
        return withEncoder(historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order),
          ()=>referenceEdits(row.content as string,activeEncode,false,[],embedded));
      if(row.sourceVersion===record.version)for(const call of calls.filter(c=>c.id===record.id)){
        const result=JSON.parse(record.text).result;
        const body=isReceipted(state,call)||call.name==='graph_apply_changes'&&!!state.contextRetention?.writeReceipts?.[call.originResultId??call.id]?{function:call.name,callId:call.id,arguments:call.arguments,
          result:JSON.parse(result),operationId:call.operationId,bodyOmitted:true}:historicalCallBody({...call,result});
        if(row.content===JSON.stringify(body))return withEncoder(historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order),
          ()=>referenceEdits(row.content as string,activeEncode,true,undefined,embedded));
      }
    }
  };
  // Only whole top-level timeline records can change shape. Archived reads and
  // fragments retain their string bodies and canonical offsets, even at full size.
  const compactRecord=(row:Record<string,unknown>,coverage:Coverage[]):Record<string,unknown>|undefined=>{
    if(typeof row.recordId!=='string'||typeof row.content!=='string'||row.start!==undefined||row.end!==undefined||row.resultTextPart!==undefined)return;
    const record=byId.get(row.recordId)?.find(r=>(row.sourceVersion===undefined||row.sourceVersion===r.version)
      &&coverage.some(c=>c.recordId===r.id&&c.version===r.version&&c.start===0&&c.end===r.text.length));
    if(!record)return;
    const project=historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order);
    const notice=notices.get(record.id);
    if(notice&&row.content===(record.projectionText??record.text)){
      const value=JSON.parse(row.content),edit=value.user_edit;
      if(!edit||typeof edit!=='object')return;
      if(edit.bodyOmitted===true){
        // The outer recordId and one recovery entry identify this historical
        // event; its exact timestamp remains in the archive (and history.at).
        const {summaryId:_summary,readWith:_read,...outer}=row;
        return {...outer,content:{user_edit:{kind:notice.kind,bodyOmitted:true}},
          readWith:'context_restore_records'};
      }
      return {...row,content:translateGraphPayload(value,project)};
    }
    const call=calls.find(c=>c.id===record.id&&(isWriteReceipted(state,c)||isReceipted(state,c))
      &&[false,true].some(group=>row.content===JSON.stringify(historicalCallProjection(state,c,group))));
    if(!call)return;
    const value=JSON.parse(call.result??'null');
    if(!value||typeof value!=='object'||Array.isArray(value)||value.bodyOmitted!==true)return;
    // Old persisted receipts may still carry callArguments. Drop it only here;
    // do not rewrite the ledger, execution arguments, or archived results.
    const {callArguments:_arguments,...result}=value;
    if(isWriteReceipted(state,call)){
      // Older ledgers omitted failure details. Recover only immutable outcome
      // evidence from the same archived call, never from today's canvas state.
      const original=JSON.parse(JSON.parse(record.text).result);
      if(original&&typeof original==='object'&&!Array.isArray(original))
        for(const key of ['details','executed','applied','repeated','replayed','nextAction','userReview'])
          if(!Object.hasOwn(result,key)&&Object.hasOwn(original,key))result[key]=original[key];
    }
    return {...row,content:translateGraphPayload(promptReceipt(call.name,{...result,function:call.name}),project)};
  };
  return (row:Record<string,unknown>,coverage:Coverage[],entryEncode=encode,compact=false)=>withEncoder(entryEncode,()=>{
    if(compact){const projected=compactRecord(row,coverage);if(projected)return projected;}
    const edits=contentEdits(row,coverage);
    if(edits?.length)row={...row,content:projectReferenceFragment(row.content as string,0,(row.content as string).length,edits)};
    const parts=fragmentEdits(row);
    return parts?.length?{...row,serializedResult:projectReferenceFragment(row.serializedResult as string,0,(row.serializedResult as string).length,parts)}:row;
  });
}
