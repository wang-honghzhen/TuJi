import { createHash } from 'node:crypto';
import { allReviewDecisions,REVIEW_INSTRUCTION,reviewDecisionText } from '../changeReview';
import type { SummaryObjectBinding,SummarySnapshot } from '../contextState';
import type { AppSnapshot,SourceRef,Task } from '../domain';
import { digest,graphIndex } from './directGraph';
import { requireValue } from './errors';
import { entity } from './graph';
import { translateGraphPayload } from './graphReferences';
import { READ_FORMAT_VERSION } from './readCoverage';
import { visibleCallResult } from './readVisibility';

const marker=/\[\[ref:([a-f0-9]{16})\]\]/g;
/** Catalog entries come from structured source references, never guessed from object names. */
export function summaryBindingCatalog(state:AppSnapshot,material:unknown,sources:SourceRef[],inherited:SummaryObjectBinding[]=[]):SummaryObjectBinding[] {
  const bindings=new Map<string,SummaryObjectBinding>();
  const add=(kind:SummaryObjectBinding['kind'],id:string,version?:string|number)=>{
    if(version===undefined&&[...bindings.values()].some(b=>b.kind===kind&&b.id===id))return;
    const key=createHash('sha256').update(JSON.stringify([kind,id,version])).digest('hex').slice(0,16);
    bindings.set(key,{key,kind,id,...(version===undefined?{}:{version})});
  };
  // Existing markers are immutable identities. A versioned binding must not erase
  // an unversioned marker still used by another child summary.
  inherited.forEach(b=>bindings.set(b.key,b));
  for(const s of sources)if(s.kind==='node'||s.kind==='document'||s.kind==='edge')add(s.kind,s.id,s.version);
  const record=(value:unknown)=>{
    if(Array.isArray(value)){value.forEach(record);return;}
    if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>;
    // Only parse application-owned execution wrappers, not arbitrary JSON quoted in a node or user text.
    if(typeof row.recordId==='string'&&typeof row.text==='string'){
      let wrapper:Record<string,unknown>;try{wrapper=JSON.parse(row.text);}catch{return;}
      if(typeof wrapper.function!=='string')return;
      for(const field of ['arguments','result']){
        let payload:unknown=wrapper[field];if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch{continue;}}
        translateGraphPayload(payload,(id,hint)=>{
          const read=hint==='result'?state.workspaces.flatMap(w=>w.frozenReads??[]).find(r=>r.id===id):undefined;
          if(read)add('read',id,read.readFormatVersion);
          else if(state.graph?.nodes[id])add('node',id);
          else if(state.graph?.edges.some(e=>e.edgeId===id))add('edge',id);
          else if(state.graph?.documents[id]||state.graph?.canvases.some(c=>c.directories[id]))add('document',id);
          return id;
        });
      }
    }
  };
  record(material);return [...bindings.values()];
}

/** Repair cursor spelling only in derived summaries, using verified structured references. */
export function bindSummaryReadReferences(text:string,catalog:SummaryObjectBinding[]):string {
  // A model may put a known object ID (or a read UUID without its prefix) in a
  // marker instead of the catalog key. Repair only exact, unambiguous identities.
  text=text.replace(/\[\[ref:([^\]]*)\]\]/g,(token:string,key:string)=>{
    if(catalog.some(b=>b.key===key))return token;
    const matches=catalog.filter(b=>b.id===key||b.kind==='read'&&b.id===`read:${key}`);
    return matches.length===1?`[[ref:${matches[0].key}]]`:token;
  });
  const reads=new Map<string,SummaryObjectBinding[]>();
  for(const b of catalog)if(b.kind==='read')reads.set(b.id,[...(reads.get(b.id)??[]),b]);
  for(const candidates of reads.values()){
    // A literal ID carries no version. Repeated copies of one identity are safe;
    // multiple versions or keys must remain unbound instead of choosing the first.
    if(new Set(candidates.map(b=>JSON.stringify([b.key,b.kind,b.id,b.version]))).size!==1)continue;
    const b=candidates[0];
    const escaped=b.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    text=text.replace(new RegExp(`(?<![a-zA-Z0-9:_-])${escaped}(?![a-zA-Z0-9:_-])`,'g'),`[[ref:${b.key}]]`);
  }
  return text;
}

export function usedSummaryBindings(text:string,catalog:SummaryObjectBinding[]):SummaryObjectBinding[] {
  const keys=[...new Set([...text.matchAll(/\[\[ref:([^\]]*)\]\]/g)].map(m=>m[1]))];
  requireValue(keys.every(key=>catalog.some(b=>b.key===key)),'摘要引用了未提供的对象绑定','INVALID_SUMMARY_REFERENCE');
  return keys.map(key=>catalog.find(b=>b.key===key)!);
}


/** Binding identifies the historical object; it never grants access or certifies its current body. */
export function summaryProjection(state:AppSnapshot,task:Task,summary:SummarySnapshot) {
  const decisions=allReviewDecisions(state).filter(d=>d.action==='revert'&&summary.coverage.some(c=>{
    const text=reviewDecisionText(d);return c.recordId===d.id&&c.version===digest(text)&&c.start===0&&c.end===text.length;
  }));
  let bindings=summary.objectBindings??[],content=summary.text;
  if(content.includes('read:')){
    const records=new Set(summary.coverage.map(c=>c.recordId));
    const material=state.toolCalls.filter(c=>records.has(c.id)).map(c=>({recordId:c.id,text:JSON.stringify({function:c.name,arguments:c.arguments,result:visibleCallResult(state,c)})}));
    const catalog=summaryBindingCatalog(state,material,[],bindings);
    content=bindSummaryReadReferences(content,catalog);
    const used=new Set([...content.matchAll(marker)].map(m=>m[1]));
    bindings=[...bindings,...catalog.filter(b=>b.kind==='read'&&used.has(b.key)&&!bindings.some(old=>old.key===b.key))];
  }
  const index=bindings.length&&state.graph?.canvases.some(c=>c.canvasId===task.canvasId)?graphIndex(state,task.canvasId):undefined;
  return {summaryId:summary.id,semanticType:summary.semanticType,summaryType:summary.children.length?'normal':'leaf',contentState:'summary',readWith:'context_read_children',content,
    ...(decisions.length?{userReviews:decisions.map(d=>JSON.parse(reviewDecisionText(d)).user_canvas_decision),reviewInstruction:REVIEW_INSTRUCTION}:{}),
    ...(bindings.length?{bindingEvidence:'identity_only',objectBindings:bindings.map(b=>{
      if(b.kind==='read'){
        const read=state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads?.find(r=>r.id===b.id);
        const stateOfRead=!read||read.canvasId!==task.canvasId?'unavailable':read.expiresAt<=Date.now()||read.readFormatVersion!==READ_FORMAT_VERSION?'expired':'available';
        return {key:b.key,kind:'read',...(stateOfRead==='available'?{pointerId:b.id}:{}),state:stateOfRead};
      }
      const value=state.graph?entity(state.graph,b.id):null;
      const readable=!!index&&(index.rows.has(b.id)||index.edges.some(e=>e.edgeId===b.id));
      const status=!value?'deleted':!readable?'out_of_scope':'available';
      return {key:b.key,...(readable?{refId:b.id}:{}),state:status};
    })}:{})};
}

/** Applied after structural alias translation, only to explicitly bound summary objects. */
export function renderSummaryReferences(value:unknown):unknown {
  if(Array.isArray(value))return value.map(renderSummaryReferences);
  if(!value||typeof value!=='object')return value;
  const row=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,renderSummaryReferences(v)]));
  if(typeof row.summaryId==='string'&&typeof row.content==='string'&&Array.isArray(row.objectBindings)){
    const bindings=row.objectBindings as Array<{key:string;kind?:string;refId?:string;pointerId?:string;state:string}>;
    row.content=row.content.replace(marker,(_token:string,key:string)=>{
      const b=bindings.find(b=>b.key===key);
      if(!b)return '〔历史对象引用不可用〕';
      if(b.kind==='read')return b.pointerId?`〔${b.pointerId}〕`:b.state==='expired'?'〔分页快照已过期〕':'〔分页快照不可用〕';
      if(b.state==='deleted')return '〔历史对象已删除〕';
      if(b.state==='out_of_scope'||!b.refId)return '〔历史对象不在当前范围〕';
      if(b.state==='unavailable')return `〔${b.refId}，来源版本无法确认〕`;
      return `〔${b.refId}${b.state==='changed'?'，版本已变化':''}〕`;
    });
    // A paged text fragment can split a marker. Keep its keys so fragments can
    // still be interpreted together; only complete rendered summaries can drop
    // this bookkeeping. Identity-only states remain visible in both cases.
    if (row.resultTextPart === undefined) row.objectBindings = [...new Map(bindings.map(({key: _key, ...binding}) =>
      [JSON.stringify(binding), binding])).values()];
  }
  return row;
}
