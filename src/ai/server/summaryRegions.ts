import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import { randomUUID } from 'node:crypto';
import type { ContextStage, FrozenRead, PromptEntry, SummarySnapshot } from '../contextState';
import { AUTO_CONTEXT } from '../contextState';
import { inputCapacity } from '../memory';
import { descendants, summaryArchive } from './historyRepresentations';
import { summaryProjection, renderSummaryReferences } from './summaryBindings';
import { digest } from './directGraph';
import { contextProtection } from './contextProtection';
import { allRetainedCalls, isReceipted, originResultId, receiptFamily } from './readVisibility';
import { translateGraphPayload } from './graphReferences';
import { requestTokens } from './providers';
import { requireValue } from './errors';
import { GRAPH_READ_LIMITS } from './graphReadLimits';
import { contentKey, mapSummaryNavigation, partIdentity, partContents, partScope, summaryPath, row,
  type Row, type Region, type SummaryPart as Part, type SummaryRelation } from './summaryRegionContent';

export interface SummaryRegionMember {
  id:string; callIds:string[]; order:number; versions:Record<string,string>; parts:Part[]; pageIds:string[]; navigationAvailable?:boolean;
  callProofs?:Record<string,string[]>;
  dependencyIssue?:string;
}
export interface SummaryRegions {
  version:2; members:SummaryRegionMember[]; tokens:number; referenceTokens:number; budget:number;
  diagnostics:{migrated:number;evicted:number;builds:number;elapsedMs:number;resourceFailure?:string;resourceEvictions?:number};
}
export interface SummaryMaintenance {
  id:string;
  memo:Map<string,{members:SummaryRegionMember[];drafts:FrozenRead[]}>; evicted:Set<string>;
  limits?:{members:number;metadataBytes:number}; builds:number;
  deferred:Set<string>; resourceEvictions:number;
}
export const SUMMARY_REGION_LIMITS=Object.freeze({members:AUTO_CONTEXT.attachmentCacheEntries,metadataBytes:AUTO_CONTEXT.attachmentCacheMetadataBytes});
export const createSummaryMaintenance=():SummaryMaintenance=>({id:randomUUID(),memo:new Map(),evicted:new Set(),deferred:new Set(),builds:0,resourceEvictions:0});
const functions=new Set(['context_read_summary_tree','context_read_children','context_read_pages']);

export function rememberSummaryOrigin(call:ToolCallRecord,read:FrozenRead):void {
  if(!read.summaryOrigin?.pure)return;
  call.summaryOrigins=[...new Map([...(call.summaryOrigins??[]),{pointerId:read.id,roots:read.summaryOrigin.roots,
    versions:read.summaryOrigin.versions,parentId:read.summaryOrigin.parentId}].map(v=>[v.pointerId,v])).values()];
}

/** New maintenance roots never inherit the old resident-root escape hatch. */
export function summaryRegionScope(state:AppSnapshot,task:Task){
  const archive=summaryArchive(state,task);
  const roots:Array<{summary:SummarySnapshot;category:Region}>=[];

  const owners=new Map<string,{rootId:string;category:Region}>();
  for(const {summary,category} of roots)for(const id of descendants([summary.id],archive))owners.set(id,{rootId:summary.id,category});
  return {archive,owners,roots};
}

/** Only actual returned summary cards/fragments qualify; names and source references alone do not. */
function readMember(state:AppSnapshot,task:Task,call:ToolCallRecord,scope:ReturnType<typeof summaryRegionScope>,verifyArchive=false):SummaryRegionMember|undefined {
  if(!functions.has(call.name)||call.status!=='completed'||call.presentedAt===undefined||!verifyArchive&&isReceipted(state,call))return;
  let result:Row;try{result=JSON.parse(call.result!);}catch{return;}
  const parts:Part[]=[],versions:Record<string,string>={},workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const visit=(value:Row):boolean=>{
    if(Array.isArray(value.results))return value.results.length>0&&value.results.every(v=>row(v)&&visit(v));
    if(!['ok','partial'].includes(String(value.status))||!row(value.data))return false;
    const frozen=workspace.frozenReads?.find(r=>r.id===value.pointerId);
    const origin=call.summaryOrigins?.find(o=>o.pointerId===value.pointerId)
      ??(frozen?.summaryOrigin?.pure?{pointerId:frozen.id,...frozen.summaryOrigin}:undefined);
    const ids:string[]=[];
    const inspect=(v:unknown):boolean=>{
      if(Array.isArray(v))return v.every(inspect);if(!row(v))return true;
      if('recordId'in v||'noteId'in v||'artifactId'in v&&'content'in v)return false;
      if(typeof v.serializedResult==='string')return !!origin;
      if(typeof v.summaryId==='string'&&typeof v.content==='string'){
        const s=scope.archive.find(s=>s.id===v.summaryId);if(!s)return false;ids.push(s.id);
        if(!v.resultTextPart&&v.content!==summaryProjection(state,task,s).content)return false;
      }
      return Object.values(v).every(inspect);
    };
    if(!inspect(value.data)||!ids.length&&!origin)return false;
    const targets=origin?.roots??(typeof value.summaryId==='string'?[value.summaryId]:ids.slice(0,1));
      if(!targets.length||[...targets,...ids].some(id=>!scope.owners.has(id)))return false;
    const root=targets.find(id=>scope.archive.some(s=>s.id===id));if(!root)return false;
    for(const id of [...ids,...targets]){const s=scope.archive.find(s=>s.id===id);if(s)versions[id]=origin?.versions[id]??s.version;}
    Object.assign(versions,origin?.versions);
      const owner=scope.owners.get(root)!;
    const parentId=typeof value.data.summaryId==='string'?value.data.summaryId:origin?.parentId
      ??(!row(value.data.tree)&&typeof value.summaryId==='string'&&scope.archive.some(s=>s.id===value.summaryId)?value.summaryId:undefined);
      parts.push({rootId:root,rootIds:targets,category:owner.category,data:structuredClone(value.data),parentId,
      ...(Number.isInteger(value.page)&&Number.isInteger(value.totalPages)?{page:{number:Number(value.page),total:Number(value.totalPages),
        status:String(value.status),hasMorePages:value.hasMorePages===true,isLastPage:value.isLastPage===true,coverage:value.coverage}}:{}),
      ...(row(value.nextCursor)?{continuation:{tool:'context_read_pages',arguments:structuredClone(value.nextCursor)}}:{})});
    return true;
  };
  if(!visit(result))return;
  return {id:`summary-member:${originResultId(call)}`,callIds:[originResultId(call)],
    order:call.firstDelivery?.sequence??call.sequence??Date.parse(call.createdAt),versions,parts,pageIds:[],navigationAvailable:true};
}

/** Page identity describes immutable content and boundaries, never the originating call. */
function summaryNavigation(state:AppSnapshot,task:Task,maintenance:SummaryMaintenance,drafts:FrozenRead[]){
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,keys=new Map<string,string>();
  const source=(id:string)=>drafts.find(r=>r.id===id)??workspace.frozenReads?.find(r=>r.id===id);
  const key=(id:string,seen=new Set<string>()):string=>{
    const cached=keys.get(id);if(cached)return cached;
    const read=source(id);if(!read?.summaryOrigin?.pure||seen.has(id))return `unavailable:${id}`;
    const next=new Set(seen);next.add(id);
    const value=contentKey({origin:read.summaryOrigin,targetVersions:read.targetVersions,format:read.readFormatVersion,
      pages:mapSummaryNavigation(read.pages,child=>key(child,next)),pageCoverage:read.pageCoverage});
    keys.set(id,value);return value;
  };
  const normalize=(member:SummaryRegionMember,fromActualCall=false)=>{
    const result=structuredClone(member);
    const fingerprints=result.parts.map(p=>partIdentity(p,key)).sort();
    result.id=`summary-member:${contentKey([result.versions,fingerprints])}`;
    result.callProofs??={};
    for(const id of result.callIds){
      if(!result.callProofs[id]){
        if(fromActualCall)result.callProofs[id]=fingerprints;
        else {
          const call=allRetainedCalls(state).find(c=>originResultId(c)===id);
          const original=call&&readMember(state,task,call,summaryRegionScope(state,task),true);
          if(original)result.callProofs[id]=original.parts.map(p=>partIdentity(p,key)).sort();
        }
      }
      if(!result.callProofs[id]?.length||!result.callProofs[id].every(proof=>fingerprints.includes(proof)))
        result.dependencyIssue='摘要缓存缺少与原始调用一致的交付证明，不能从缓存本身推定已读。';
    }
    return result;
  };
  const relocate=(member:SummaryRegionMember,resident:boolean)=>{
    const result=structuredClone(member),used=new Set<string>();
    const replace=(id:string):string=>{
      const read=source(id);
      if(!read?.summaryOrigin?.pure||!resident&&read.expiresAt<=Date.now()){result.navigationAvailable=false;return id;}
      const identity=key(id),next=`read:summary-region-${digest([maintenance.id,identity])}`;
      used.add(next);
      if(!drafts.some(r=>r.id===next)){
        const copy:FrozenRead={...structuredClone(read),id:next,callId:`summary-region:${identity}`,originResultIds:undefined,
          kind:'summary_children',summaryView:true,expiresAt:Date.now()+GRAPH_READ_LIMITS.ttlMs};
        drafts.push(copy);keys.set(next,identity);copy.pages=mapSummaryNavigation(copy.pages,replace) as Row[];
      }
      return next;
    };
    result.parts=mapSummaryNavigation(result.parts,replace) as Part[];
    result.pageIds=[...used];return result;
  };
  return {key,normalize,relocate};
}

/** Render only shown cards and edges. Archive ancestry provides placement, never unseen text. */
export function renderSummaryRegions(state:AppSnapshot,task:Task,members:SummaryRegionMember[]):PromptEntry[]{
  const scope=summaryRegionScope(state,task);
  const groups=new Map<string,{category:Region;rootId:string;rows:Map<string,Row>;navigation:Map<string,Row>;
    relations:Map<string,SummaryRelation>;scopes:Map<string,Row>}>();
  const groupFor=(id:string)=>{
    const owner=scope.owners.get(id);if(!owner)return;
    const key=`${owner.category}:${owner.rootId}`,group=groups.get(key)??{...owner,rows:new Map<string,Row>(),navigation:new Map<string,Row>(),
      relations:new Map<string,SummaryRelation>(),scopes:new Map<string,Row>()};
    groups.set(key,group);return group;
  };
  for(const member of members)for(const part of member.parts){
    const group=groupFor(part.rootId);if(!group)continue;
    const shownScope=partScope(part);group.scopes.set(contentKey(shownScope),shownScope);
    for(const relation of partContents(part).relations)group.relations.set(contentKey([relation.parentId,relation.childId]),relation);
    const visit=(value:unknown)=>{
      if(Array.isArray(value)){value.forEach(visit);return;}if(!row(value))return;
      if(typeof value.serializedResult==='string'){
        group.rows.set(`fragment:${digest([part.rootId,value])}`,{...value,sourceSummaries:part.rootIds??[part.rootId]});return;
      }
      if(typeof value.summaryId==='string'&&typeof value.content==='string'){
        const summary=scope.archive.find(s=>s.id===value.summaryId&&member.versions[s.id]===s.version);if(!summary)return;
        const target=groupFor(summary.id);if(!target)return;
        const partial=value.resultTextPart!==undefined;
        const card:Row=partial?structuredClone(value):{...summaryProjection(state,task,summary)};
        const shown=Array.isArray(value.children)?value.children.filter(row).map(c=>String(c.summaryId)):[];
        if(shown.length)card.shownChildren=shown;
        if(value.childrenPage)card.childrenPage=value.childrenPage;
        const key=partial?`${summary.id}:part:${digest(value)}`:summary.id,previous=target.rows.get(key);
        if(previous?.shownChildren)card.shownChildren=[...new Set([...(previous.shownChildren as string[]),...shown])];
        if(!card.childrenPage&&previous?.childrenPage)card.childrenPage=previous.childrenPage;
        if(summary.children.length)card.childrenState=(card.shownChildren as string[]|undefined)?.length===summary.children.length?'complete':'partial';
        target.rows.set(key,card);
        if(Array.isArray(value.children))value.children.forEach(visit);return;
      }
      Object.values(value).forEach(visit);
    };visit(part.data);
    if(part.continuation)group.navigation.set(digest(part.continuation),part.continuation);
  }
  for(const group of groups.values()){
    const targets=[...new Set([...group.scopes.values()].flatMap(s=>typeof s.parentId==='string'?[s.parentId]:[])
      .concat([...group.rows.values()].flatMap(r=>typeof r.summaryId==='string'?[r.summaryId]:[])))];
    for(const target of targets){
      const path=summaryPath(group.rootId,target,scope.archive);
      for(const [i,id] of path.entries()){
        if(![...group.rows.values()].some(r=>r.summaryId===id))group.rows.set(id,{summaryId:id,bodyState:'unexpanded',childrenState:'partial'});
        if(i){const edge={parentId:path[i-1],childId:id,navigationOnly:true as const},key=contentKey([edge.parentId,id]);
          if(!group.relations.has(key))group.relations.set(key,edge);}
      }
    }
  }
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([id,g])=>({id:`summary-region:${id}`,category:g.category,lifecycle:'region',coverage:[],
    messages:[{role:'user',content:JSON.stringify({summary_expansion:{rootId:g.rootId,nodes:[...g.rows.values()],
      relations:[...g.relations.values()],readScopes:[...g.scopes.values()],
      ...(g.navigation.size?{continueReading:[...g.navigation.values()]}:{})}})}]}));
}

export function prepareSummaryRegions(state:AppSnapshot,task:Task,maintenance:SummaryMaintenance,
  referenceBase:PromptEntry[],encode:(id:string)=>string,collectReads=true){
  const started=Date.now(),workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,scope=summaryRegionScope(state,task);
  const protection=contextProtection(state,task),calls=allRetainedCalls(state);
  const visible=new Set(collectReads?workspace.contextStage?.entries.flatMap(e=>e.readCallIds??[])??[]:[]);
  const key=digest([scope.roots.map(r=>[r.summary.id,r.summary.version]),workspace.contextStage?.summaryRegions,
    calls.filter(c=>visible.has(c.id)).map(c=>[c.id,c.result,c.presentedAt,c.summaryOrigins]),workspace.frozenReads?.map(r=>[r.id,r.expiresAt]),state.graphRevision]);
  let cached=maintenance.memo.get(key);
  if(!cached){
    const drafts:FrozenRead[]=[],navigation=summaryNavigation(state,task,maintenance,drafts);
    const residentCalls=new Set(workspace.contextStage?.summaryRegions?.members.flatMap(m=>m.callIds));
    const raw=(workspace.contextStage?.summaryRegions?.members??[]).map(m=>navigation.normalize(m));
    for(const call of calls)if(visible.has(call.id)){
      const member=readMember(state,task,call,scope);if(member&&!raw.some(m=>m.callIds.includes(originResultId(call))))raw.push(navigation.normalize(member,true));
    }
    const handled=new Set<string>(),logical=new Map<string,SummaryRegionMember>();
    for(const original of raw){
      if(original.callIds.some(id=>handled.has(id)))continue;
      const family=[...receiptFamily(state,original.callIds)],related=raw.filter(m=>m.callIds.some(id=>family.includes(id)));
      if(family.some(id=>!isReceipted(state,id)&&!related.some(m=>m.callIds.includes(id))))continue;
      const member:SummaryRegionMember={...structuredClone(original),
        callIds:[...new Set(related.flatMap(m=>m.callIds))].sort(),order:Math.max(...related.map(m=>m.order)),
        parts:[...new Map(related.flatMap(m=>m.parts).map(p=>[partIdentity(p,navigation.key),p])).values()],
        versions:Object.assign({},...related.map(m=>m.versions)),callProofs:Object.assign({},...related.map(m=>m.callProofs))};
      member.callIds.forEach(id=>handled.add(id));
      const normalized=navigation.normalize(member),previous=logical.get(normalized.id);
      if(previous){previous.callIds=[...new Set([...previous.callIds,...normalized.callIds])].sort();
        previous.order=Math.max(previous.order,normalized.order);Object.assign(previous.callProofs!,normalized.callProofs);}
      else logical.set(normalized.id,normalized);
    }
    const members=[...logical.values()].map(m=>navigation.relocate(m,m.callIds.some(id=>residentCalls.has(id))));
    cached={members,drafts};maintenance.memo.set(key,cached);maintenance.builds++;
  }
  const limits=maintenance.limits??SUMMARY_REGION_LIMITS,budget=Math.floor(inputCapacity(state)*AUTO_CONTEXT.attachmentCacheShare);
  const costs=(members:SummaryRegionMember[])=>{
    const entries=renderSummaryRegions(state,task,members),provider={...state.provider,...task.modelSelection};
    const count=(entries:PromptEntry[])=>requestTokens(provider,{messages:entries.flatMap(e=>e.messages.map(m=>({...m,
      content:JSON.stringify(renderSummaryReferences(translateGraphPayload(JSON.parse(m.content),encode)))}))),tools:[]})
      -requestTokens(provider,{messages:[],tools:[]});
    return {tokens:count(entries),referenceTokens:count(entries.filter(e=>e.category==='references')),referenceBase:count(referenceBase),entries};
  };
  const hard=(m:SummaryRegionMember)=>m.callIds.some(id=>protection.hardProtectedCalls.has(id));
  const oldCalls=new Set(workspace.contextStage?.summaryRegions?.members.flatMap(m=>m.callIds));
  const resident=(m:SummaryRegionMember)=>m.callIds.some(id=>oldCalls.has(id));
  const chosen:SummaryRegionMember[]=[],receipts=new Set<string>(),relocated=new Set<string>(),relaxed=new Set<string>();
  let error:string|undefined,evicted=0;
  const candidates=[...cached.members].sort((a,b)=>Number(resident(b)&&hard(b))-Number(resident(a)&&hard(a))
    ||b.order-a.order||a.id.localeCompare(b.id));
  for(const original of candidates){
    const m=structuredClone(original),family=[...receiptFamily(state,m.callIds)];
    if(maintenance.deferred.has(m.id)&&!resident(m))continue;
    for(const part of m.parts)part.category=scope.owners.get(part.rootId)?.category??part.category;
    const pinned=hard(m);
    const valid=m.parts.every(p=>(p.rootIds??[p.rootId]).every(id=>scope.owners.has(id)))&&Object.entries(m.versions).every(([id,v])=>scope.archive.some(s=>s.id===id&&s.version===v));
    const blocked=family.some(id=>protection.immovableCalls.has(id)&&protection.hardReasons[id]?.some(r=>r==='other_task'||r==='undelivered'||r==='related_dependency'));
    const mayRemove=family.every(id=>!protection.hardProtectedCalls.has(id));
    const proposed=[...chosen,m],cost=costs(proposed);
    const fits=valid&&!m.dependencyIssue&&m.navigationAvailable!==false&&!blocked&&!maintenance.evicted.has(m.id)&&proposed.length<=limits.members
      &&Buffer.byteLength(JSON.stringify(proposed))<=limits.metadataBytes&&cost.tokens<=budget
      &&cost.referenceTokens<=budget;
    if(fits){chosen.push(m);for(const id of family){receipts.add(id);relocated.add(id);}continue;}
    if(resident(m)&&pinned){error=m.dependencyIssue??(valid?'受保护的摘要展开超过区域容量或无法完整承接，无法在保留依赖的同时完成整理。'
      :'受保护的摘要来源已退出保留范围，需释放对应读取依赖。');chosen.push(m);continue;}
    if(mayRemove){for(const id of family){receipts.add(id);relaxed.add(id);}maintenance.evicted.add(m.id);evicted++;}
  }
  // An incompatible new copy must not make an installed, protected member disappear.
  for(const prior of workspace.contextStage?.summaryRegions?.members??[])if(hard(prior)
    &&prior.callIds.some(id=>protection.hardProtectedCalls.has(id)&&!chosen.some(m=>m.callIds.includes(id)))){
    chosen.push(structuredClone(prior));error??='受保护的摘要副本依赖无法完整承接，需先释放对应读取依赖。';
  }
  const cost=costs(chosen),wantedPages=new Set(chosen.flatMap(m=>m.pageIds));
  const drafts=cached.drafts.filter(d=>wantedPages.has(d.id));
  const regions:SummaryRegions={version:2,members:chosen,tokens:cost.tokens,referenceTokens:cost.referenceTokens,budget,
    diagnostics:{migrated:relocated.size,evicted,builds:maintenance.builds,elapsedMs:Date.now()-started,resourceEvictions:maintenance.resourceEvictions}};
  return {regions,entries:cost.entries,drafts,receiptIds:[...receipts],relocatedIds:[...relocated],relaxedIds:[...relaxed],error};
}

export function evictSummaryRegion(state:AppSnapshot,task:Task,stage:ContextStage,maintenance:SummaryMaintenance):boolean {
  const hard=contextProtection(state,task).hardProtectedCalls;
  const member=stage.summaryRegions?.members.filter(m=>!m.callIds.some(id=>hard.has(id))&&!maintenance.evicted.has(m.id))
    .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))[0];
  if(!member)return false;maintenance.evicted.add(member.id);return true;
}

/** Resource fitting can defer a newly protected return, but cannot undo an installed relocation. */
export function relieveSummaryResources(state:AppSnapshot,task:Task,stage:ContextStage,maintenance:SummaryMaintenance):boolean {
  if(evictSummaryRegion(state,task,stage,maintenance)){maintenance.resourceEvictions++;return true;}
  const oldCalls=new Set(state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.summaryRegions?.members.flatMap(m=>m.callIds));
  const candidate=stage.summaryRegions?.members.filter(m=>!m.callIds.some(id=>oldCalls.has(id))&&!maintenance.deferred.has(m.id))
    .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))[0];
  if(!candidate)return false;maintenance.deferred.add(candidate.id);return true;
}

export function summaryRegionBudget(state:AppSnapshot,task:Task,stage:ContextStage){
  const provider={...state.provider,...task.modelSelection};
  const count=(entries:PromptEntry[])=>requestTokens(provider,{messages:entries.flatMap(e=>e.wireMessages??e.messages),tools:[]})
    -requestTokens(provider,{messages:[],tools:[]});
  const entries=stage.entries.filter(e=>e.id.startsWith('summary-region:'));
  const tokens=count(entries),referenceTokens=count(entries.filter(e=>e.category==='references'));
  const budget=Math.floor(inputCapacity(state)*AUTO_CONTEXT.attachmentCacheShare);
  return {tokens,referenceTokens,budget,over:tokens>budget};
}

export function validateSummaryRelocations(state:AppSnapshot,task:Task,stage:ContextStage):void {
  if(stage.summaryRegions)requireValue(!summaryRegionBudget(state,task,stage).over,'摘要展开超过当前区域预算','CONTEXT_CAPACITY');
  if(!stage.retentionDraft)return;
  const scope=summaryRegionScope(state,task);
  const drafts=stage.frozenReadDrafts??[],navigation=summaryNavigation(state,task,createSummaryMaintenance(),drafts);
  const oldRegions=state.workspaces.find(w=>w.id===task.workspaceId)?.contextStage?.summaryRegions;
  const hard=contextProtection(state,task).hardProtectedCalls;
  const protectedIds=oldRegions?.members.flatMap(m=>m.callIds.filter(id=>hard.has(id)))??[];
  const proof=[...new Set([...stage.retentionDraft.relocatedReceiptIds??[],...protectedIds])];
  const calls=new Map(allRetainedCalls(state).map(c=>[originResultId(c),c]));
  for(const id of proof){
    const member=stage.summaryRegions?.members.find(m=>m.callIds.includes(id));
    requireValue(!protectedIds.includes(id)||member,'已迁入的受保护摘要缺少承接内容','PROTECTED_READ');
    // Already receipted source-family records need no new body placement.
    requireValue(isReceipted(state,id)||member&&member.parts.every(p=>(p.rootIds??[p.rootId]).every(id=>scope.owners.has(id)))
      &&Object.entries(member.versions).every(([key,v])=>scope.archive.some(s=>s.id===key&&s.version===v)),
      '摘要迁移来源或承接范围已变化','STALE_CONTEXT_PLAN');
    if(!member)continue;
    const prior=oldRegions?.members.find(m=>m.callIds.includes(id));
    const original=prior?navigation.normalize(prior):calls.get(id)&&readMember(state,task,calls.get(id)!,scope);
    requireValue(original&&!original.dependencyIssue,'摘要迁移缺少来源承接凭据','STALE_CONTEXT_PLAN');
    const expected=original.callProofs?.[id]??original.parts.map(p=>partIdentity(p,navigation.key));
    const actual=new Set(member.parts.map(p=>partIdentity(p,navigation.key)));
    requireValue(expected.length>0&&expected.every(key=>actual.has(key))&&expected.every(key=>member.callProofs?.[id]?.includes(key)),
      '摘要迁移未完整承接已交付范围','STALE_CONTEXT_PLAN');
  }
  for(const id of stage.summaryRegions?.members.flatMap(m=>m.pageIds)??[]){
    const page=stage.frozenReadDrafts?.find(r=>r.id===id)??state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads?.find(r=>r.id===id);
    requireValue(page?.summaryView&&page.summaryOrigin?.pure&&page.expiresAt>Date.now(),'摘要迁移分页已失效','STALE_CONTEXT_PLAN');
  }
  if(proof.length)for(const entry of renderSummaryRegions(state,task,stage.summaryRegions?.members??[]))
    requireValue(stage.entries.some(e=>e.id===entry.id&&JSON.stringify(e.messages)===JSON.stringify(entry.messages)),
      '摘要区域承接内容不完整','STALE_CONTEXT_PLAN');
  // Check source claims directly against the actual region, not just against a second render.
  const areas=stage.entries.filter(e=>e.id.startsWith('summary-region:')).map(e=>JSON.parse(e.messages[0].content).summary_expansion as Row);
  const nodes=areas.flatMap(a=>(a.nodes as Row[])??[]),relations=areas.flatMap(a=>(a.relations as SummaryRelation[])??[]);
  const scopes=new Set(areas.flatMap(a=>((a.readScopes as Row[])??[]).map(contentKey)));
  for(const member of stage.summaryRegions?.members??[])for(const part of member.parts){
    const contents=partContents(part);
    requireValue(scopes.has(contentKey(partScope(part)))&&contents.relations.every(r=>relations.some(e=>!e.navigationOnly&&e.parentId===r.parentId&&e.childId===r.childId)),
      '摘要区域缺少已交付关系或分页范围','STALE_CONTEXT_PLAN');
    for(const card of contents.cards){
      const present=nodes.some(n=>n.summaryId===card.summaryId&&n.content===card.content&&n.resultTextPart===card.resultTextPart);
      requireValue(present,'摘要区域缺少已交付正文片段','STALE_CONTEXT_PLAN');
    }
    for(const fragment of contents.fragments)requireValue(nodes.some(n=>n.serializedResult===fragment.serializedResult&&contentKey(n.resultFragment)===contentKey(fragment.resultFragment)),
      '摘要区域缺少已交付序列化片段','STALE_CONTEXT_PLAN');
  }
}
