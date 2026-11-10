import { randomUUID } from 'node:crypto';
import type { AppSnapshot, Task } from '../domain';
import type { FrozenRead } from '../contextState';
import { inputCapacity } from '../memory';
import { digest, graphIndex, observationChange, observe } from './directGraph';
import { DomainError, requireValue } from './errors';
import { READ_FORMAT_VERSION } from './readCoverage';
import { checkFrozenStorage, GRAPH_READ_LIMITS } from './graphReadLimits';
import { frozenPageRevoked } from './readVisibility';
import { retainedDirectoryReads } from './directoryPageLifecycle';
import { translateGraphPayload } from './graphReferences';
import { collectDirectoryReplaySources, collectDirectoryUsageEvidence, filterDirectoryUsageEvidence, type DirectoryReplayRequest, type GraphUsageEvidence } from './directoryEvidence';
import { cacheDirectoryPayload, mainDirectoryPayload, directoryMessageTokens, prepareContextDirectory, prepareDirectoryView } from './contextDirectory';
import { DIRECTORY_POLICY_VERSION, DIRECTORY_CACHE_LIMITS, type CacheDirectoryEntry, type CacheDirectoryRenderGroup,
  type DirectoryAreas, type DirectoryMaintenance, type DirectoryView } from './directoryCacheState';
import type { DirectoryNode } from './directoryRead';

export type { DirectoryAreas, DirectoryMaintenance } from './directoryCacheState';
export function directoryReplayKey(request: DirectoryReplayRequest): string {
  return digest([request.schemaVersion,request.canvasId,request.rootRefId,request.mode,request.requestedBudget]);
}
function snapshotKey(state:AppSnapshot,task:Task):string {
  return digest([state.graphRevision,task.canvasId,state.graph?.canvases.find(c=>c.canvasId===task.canvasId),
    state.sessions.find(s=>s.id===task.sessionId)?.mode]);
}
export function createDirectoryMaintenance(state:AppSnapshot,task:Task):DirectoryMaintenance {
  return {id:randomUUID(),snapshotKey:snapshotKey(state,task),replayMemo:new Map(),usageEvidenceMemo:new Map(),evictedReplayKeys:new Set(),
    diagnostics:{replayCount:0,replayFailures:0,replayMs:0,elapsedMs:0,evictions:0,mainReused:false}};
}
export function directoryNodes(tree:DirectoryNode):Map<string,DirectoryNode> {
  const result=new Map<string,DirectoryNode>();
  const visit=(node:DirectoryNode)=>{requireValue(!result.has(node.refId),'目录视图含重复节点或循环','DIRECTORY_INVARIANT');result.set(node.refId,node);node.children?.forEach(visit);};
  visit(tree);return result;
}
const pageInfo=(node:DirectoryNode)=>node.childrenPage as {totalChildren:number;readWith?:{arguments?:{pointerId?:string}}}|undefined;
const complete=(node:DirectoryNode)=>Array.isArray(node.children)||node.childrenState==='leaf';
const childIds=(node:DirectoryNode)=>(node.children??[]).map(c=>c.refId).sort();
/** Only displayed cards, edges, completeness and navigation count. Frozen pages are not inspected. */
export function coversDirectoryTrees(b:DirectoryNode,a:DirectoryNode):boolean {
  const nodes=directoryNodes(b);
  for(const row of directoryNodes(a).values()){
    const other=nodes.get(row.refId);
    if(!other||row.directoryVersion!==other.directoryVersion||row.kind!==other.kind||row.name!==other.name
      ||row.nameState!==other.nameState||digest(row.nameReadWith??null)!==digest(other.nameReadWith??null))return false;
    if(row.children){
      if(!other.children||JSON.stringify(childIds(row))!==JSON.stringify(childIds(other)))return false;
      if(row.children.some(child=>!other.children!.some(c=>c.refId===child.refId)))return false;
    }
    if(row.childrenState==='leaf'&&!complete(other))return false;
    const page=pageInfo(row);
    if(page&&!complete(other)&&(!pageInfo(other)||pageInfo(other)!.totalChildren!==page.totalChildren))return false;
  }
  return true;
}
function mergeNode(a:DirectoryNode,b:DirectoryNode):DirectoryNode|undefined {
  if(a.refId!==b.refId||a.directoryVersion!==b.directoryVersion||a.name!==b.name||a.kind!==b.kind
    ||a.nameState!==b.nameState||digest(a.nameReadWith??null)!==digest(b.nameReadWith??null))return;
  if(a.children&&b.children){
    if(JSON.stringify(childIds(a))!==JSON.stringify(childIds(b)))return;
    const merged:DirectoryNode[]=[];
    for(const child of a.children){const row=mergeNode(child,b.children.find(c=>c.refId===child.refId)!);if(!row)return;merged.push(row);}
    const result:DirectoryNode={...structuredClone(a),children:merged};delete result.childrenPage;delete result.childrenState;return result;
  }
  if(a.children||a.childrenState==='leaf')return structuredClone(a);
  if(b.children||b.childrenState==='leaf')return structuredClone(b);
  const pa=pageInfo(a),pb=pageInfo(b);
  if(pa&&pb&&pa.totalChildren!==pb.totalChildren)return;
  return structuredClone(pa?a:b);
}
function usedEvidence(entries:GraphUsageEvidence[],view:DirectoryView):GraphUsageEvidence[] {
  const visible=new Set(directoryNodes(view.tree).keys()),byId=new Map<string,GraphUsageEvidence>();
  for(const item of entries)if(item.canvasId===view.canvasId&&visible.has(item.subgraphId)){
    const prior=byId.get(item.subgraphId);
    if(!prior||(item.sequence??Infinity)<(prior.sequence??Infinity)||item.sequence===prior.sequence&&item.eventId<prior.eventId)byId.set(item.subgraphId,item);
  }
  return [...byId.values()].sort((a,b)=>a.subgraphId.localeCompare(b.subgraphId));
}
export function compareDirectoryEviction(a:CacheDirectoryEntry,b:CacheDirectoryEntry):number {
  return Number(a.usageEvidence.length>0)-Number(b.usageEvidence.length>0)
    ||(a.firstEnteredOrder??a.pendingEnteredOrder??Number.MAX_SAFE_INTEGER)-(b.firstEnteredOrder??b.pendingEnteredOrder??Number.MAX_SAFE_INTEGER)
    ||a.id.localeCompare(b.id);
}
/** Capacity cleanup removes one whole logical member; rebuilding uses this cycle's memo. */
export function evictOneDirectoryCache(maintenance:DirectoryMaintenance,areas:DirectoryAreas):boolean {
  const entry=[...areas.cache.entries].sort(compareDirectoryEviction).find(e=>!maintenance.evictedReplayKeys.has(directoryReplayKey(e.replay)));
  if(!entry)return false;excludeReplay(maintenance,directoryReplayKey(entry.replay));maintenance.diagnostics.evictions++;return true;
}
export const evictDirectoryCacheEntry = evictOneDirectoryCache;
function excludeReplay(maintenance:DirectoryMaintenance,key:string):void {
  maintenance.evictedReplayKeys.add(key);
  maintenance.usageEvidenceMemo.delete(key);
  for(const memoKey of maintenance.replayMemo.keys())if(memoKey.startsWith(key+':'))maintenance.replayMemo.delete(memoKey);
}
function retainedDrafts(tree:DirectoryNode,drafts:FrozenRead[]):FrozenRead[]{
  const ids=new Set([...directoryNodes(tree).values()].flatMap(n=>{const id=pageInfo(n)?.readWith?.arguments?.pointerId;return id?[id]:[];}));
  return drafts.filter(d=>ids.has(d.id));
}
function groupView(state:AppSnapshot,task:Task,group:CacheDirectoryRenderGroup):CacheDirectoryRenderGroup {
  const nodes=[...directoryNodes(group.tree).values()],index=graphIndex(state,task.canvasId);
  const observation=observe(state,task,index,nodes.map(n=>n.refId),nodes.filter(complete).map(n=>n.refId),true);observation.sources=[];
  return {...group,observation,drafts:retainedDrafts(group.tree,group.drafts)};
}
/** Safe grafting requires the immediate parent to already show its complete child list. */
export function mergeDirectoryGroups(state:AppSnapshot,task:Task,groups:CacheDirectoryRenderGroup[],budget:number):CacheDirectoryRenderGroup[]{
  let result=structuredClone(groups);const index=graphIndex(state,task.canvasId);
  const order=[...result].sort((a,b)=>b.currentPath.length-a.currentPath.length||a.id.localeCompare(b.id));
  for(const original of order){
    const a=result.find(g=>g.id===original.id);if(!a)continue;
    const parentId=index.rows.get(a.rootRefId)?.parentId;if(!parentId)continue;
    const options:Array<{b:CacheDirectoryRenderGroup;merged:CacheDirectoryRenderGroup;tokens:number}>=[];
    for(const b of result){
      if(a===b||a.canvasId!==b.canvasId||b.memberEntryIds.some(id=>a.memberEntryIds.includes(id)))continue;
      const parent=directoryNodes(b.tree).get(parentId);
      if(!parent?.children||parent.childrenState==='omitted'||pageInfo(parent)||!parent.children.some(c=>c.refId===a.rootRefId))continue;
      const clone=structuredClone(b),position=directoryNodes(clone.tree).get(parentId)!;
      const at=position.children!.findIndex(c=>c.refId===a.rootRefId),merged=mergeNode(position.children![at],a.tree);if(!merged)continue;
      position.children![at]=merged;
      clone.memberEntryIds=[...b.memberEntryIds,...a.memberEntryIds].sort();clone.drafts=[...b.drafts,...a.drafts];
      if(!coversDirectoryTrees(clone.tree,a.tree)||!coversDirectoryTrees(clone.tree,b.tree))continue;
      const next=result.filter(g=>g!==a&&g!==b).concat(clone),tokens=directoryMessageTokens(cacheDirectoryPayload(next));
      if(tokens<=budget)options.push({b,merged:groupView(state,task,clone),tokens});
    }
    options.sort((x,y)=>x.tokens-y.tokens||x.b.id.localeCompare(y.b.id));
    if(options[0])result=result.filter(g=>g!==a&&g!==options[0].b).concat(options[0].merged);
  }
  return result.sort((a,b)=>a.id.localeCompare(b.id));
}
export interface PrepareDirectoryAreasOptions {
  prior?:DirectoryAreas; receiptIds?:string[]; capacity?:number;
  mainBudget?:number; cacheBudget?:number; maintenance?:DirectoryMaintenance;
  maxEntries?:number; maxMetadataBytes?:number;
}
export function prepareDirectoryAreas(state:AppSnapshot,task:Task,options:PrepareDirectoryAreasOptions={}) {
  const started=performance.now(),capacity=options.capacity??inputCapacity(state);
  const mainBudget=options.mainBudget??Math.floor(capacity*.05),cacheBudget=Math.min(options.cacheBudget??Math.floor(capacity*.02),options.maintenance?.cacheTokenLimit??Infinity);
  const maintenance=options.maintenance??createDirectoryMaintenance(state,task);
  requireValue(maintenance.snapshotKey===snapshotKey(state,task),'目录维护快照已变化，请重新计算','STALE_CONTEXT_PLAN');
  const prior=options.prior,oldMain=(maintenance.mainMemo?.budget===mainBudget?maintenance.mainMemo.region:undefined)??prior?.main;
  const reusable=oldMain&&(!prior||prior.policyVersion===DIRECTORY_POLICY_VERSION)&&oldMain.canvasId===task.canvasId
    &&directoryMessageTokens(mainDirectoryPayload(oldMain.data))<=mainBudget&&!observationChange(state,oldMain.observation).changes.length
    &&oldMain.drafts.every(d=>d.readFormatVersion===READ_FORMAT_VERSION&&!observationChange(state,d.snapshotObservation??d.observation).changes.length);
  const main={...(reusable?structuredClone(oldMain):prepareContextDirectory(state,task,mainBudget)),canvasId:task.canvasId,budget:mainBudget};
  const renewed=new Map<string,string>();
  for(const draft of main.drafts)if(draft.expiresAt<=Date.now()||draft.pages.some((_,i)=>frozenPageRevoked(state,draft.id,i+1))){
    const previous=draft.id;draft.id=`read:directory-${digest([maintenance.id,previous]).slice(0,32)}`;draft.expiresAt=Date.now()+86400000;
    draft.callId=`directory-view:${maintenance.id}`;renewed.set(previous,draft.id);
  }
  if(renewed.size)main.data=translateGraphPayload(main.data,id=>renewed.get(id)??id);
  main.tokens=directoryMessageTokens(mainDirectoryPayload(main.data));main.observation.taskId=task.id;
  maintenance.diagnostics.mainReused=!!reusable;
  maintenance.mainMemo={budget:mainBudget,region:structuredClone(main)};
  const currentEvidence=collectDirectoryUsageEvidence(state,task),candidates=new Map<string,CacheDirectoryEntry>();
  const evidenceKey=(value:GraphUsageEvidence)=>JSON.stringify([value.canvasId,value.subgraphId,value.eventId,value.kind]);
  // Validate against the current legal history once, including carried facts whose bodies were summarized.
  const legalEvidence=new Map(filterDirectoryUsageEvidence(state,task,[...currentEvidence,
    ...(prior?.cache.entries??[]).flatMap(entry=>entry.usageEvidence),
    ...[...maintenance.usageEvidenceMemo.values()].flat()]).map(value=>[evidenceKey(value),value]));
  const validatedEvidence=(values:GraphUsageEvidence[])=>values.flatMap(value=>{
    const legal=legalEvidence.get(evidenceKey(value));return legal?[legal]:[];
  });
  const nextEnteredOrder=prior?.cache.nextEnteredOrder??0;
  for(const old of prior?.cache.entries??[])if(old.replay.canvasId===task.canvasId)candidates.set(directoryReplayKey(old.replay),structuredClone(old));
  for(const source of collectDirectoryReplaySources(state,task,options.receiptIds??[])){
    const key=directoryReplayKey(source.request),entry=candidates.get(key);
    if(entry){entry.auditOrigins=[...new Set([...entry.auditOrigins,source.originCallId])].slice(-16);continue;}
    candidates.set(key,{id:`directory-cache:${key.slice(0,24)}`,replay:source.request,pendingFirstDelivery:true,usageEvidence:[],auditOrigins:[source.originCallId]});
  }
  let pendingOrder=Math.max(nextEnteredOrder,...[...candidates.values()].map(e=>(e.pendingEnteredOrder??e.firstEnteredOrder??-1)+1));
  for(const [key,entry] of [...candidates].sort(([a],[b])=>a.localeCompare(b))){
    if(maintenance.evictedReplayKeys.has(key)){candidates.delete(key);continue;}
    if(entry.firstEnteredOrder===undefined&&entry.pendingEnteredOrder===undefined)entry.pendingEnteredOrder=pendingOrder++;
  }
  const views=new Map<string,DirectoryView>();let entries:CacheDirectoryEntry[]=[];
  const remove=(entry:CacheDirectoryEntry,evicted=false)=>{
    entries=entries.filter(e=>e!==entry);views.delete(entry.id);excludeReplay(maintenance,directoryReplayKey(entry.replay));
    if(evicted)maintenance.diagnostics.evictions++;
  };
  const maxEntries=options.maxEntries??DIRECTORY_CACHE_LIMITS.entries,maxMetadataBytes=options.maxMetadataBytes??DIRECTORY_CACHE_LIMITS.metadataBytes;
  const entryMetadataBytes=()=>Buffer.byteLength(JSON.stringify(entries));
  const mergeCoverage=()=>{
    entries.sort((a,b)=>Number(b.firstEnteredOrder!==undefined)-Number(a.firstEnteredOrder!==undefined)||a.id.localeCompare(b.id));
    for(const entry of [...entries])if(coversDirectoryTrees(main.data as DirectoryNode,views.get(entry.id)!.tree))remove(entry);
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;){
      const a=entries[i],b=entries[j],av=views.get(a.id)!,bv=views.get(b.id)!;
      if(coversDirectoryTrees(av.tree,bv.tree)){a.usageEvidence=usedEvidence([...a.usageEvidence,...b.usageEvidence],av);remove(b);}
      else if(coversDirectoryTrees(bv.tree,av.tree)){b.usageEvidence=usedEvidence([...b.usageEvidence,...a.usageEvidence],bv);remove(a);i--;break;}
      else j++;
    }
  };
  for(const [key,entry] of candidates){
    if(cacheBudget<=0){excludeReplay(maintenance,key);continue;}
    const request=entry.replay,budget=Math.min(request.requestedBudget,cacheBudget),memoKey=`${key}:${budget}`;
    if(!maintenance.replayMemo.has(memoKey)){
      const replayStarted=performance.now();
      try{
        requireValue(request.schemaVersion===1&&['children','recursive'].includes(request.mode)&&Number.isFinite(request.requestedBudget)&&request.requestedBudget>0,'不支持的目录展开请求','INVALID_DIRECTORY_REPLAY');
        maintenance.diagnostics.replayCount++;
        const view=prepareDirectoryView(state,task,{rootRefId:request.rootRefId,mode:request.mode,budget,viewId:`${maintenance.id}:${key}`,payload:v=>cacheDirectoryPayload([v])});
        maintenance.replayMemo.set(memoKey,view);
      }catch(error){
        if(!(error instanceof DomainError)||!['OUT_OF_SCOPE','INVALID_DIRECTORY_REPLAY','READ_RESOURCE_LIMIT'].includes(error.code))throw error;
        maintenance.replayMemo.set(memoKey,null);maintenance.diagnostics.replayFailures++;excludeReplay(maintenance,key);
      }finally{maintenance.diagnostics.replayMs+=performance.now()-replayStarted;}
    }
    const view=maintenance.replayMemo.get(memoKey);if(!view)continue;
    entry.usageEvidence=usedEvidence(validatedEvidence([...entry.usageEvidence,
      ...(maintenance.usageEvidenceMemo.get(key)??[]),...currentEvidence]),view);views.set(entry.id,view);entries.push(entry);
    if(coversDirectoryTrees(main.data as DirectoryNode,view.tree)){remove(entry);continue;}
    for(const other of [...entries])if(other!==entry&&views.has(entry.id)){
      const otherView=views.get(other.id)!;
      const otherCovers=coversDirectoryTrees(otherView.tree,view.tree),entryCovers=coversDirectoryTrees(view.tree,otherView.tree);
      const favorOther=Number(other.firstEnteredOrder!==undefined)>Number(entry.firstEnteredOrder!==undefined)
        ||(other.firstEnteredOrder!==undefined)===(entry.firstEnteredOrder!==undefined)&&other.id<entry.id;
      if(otherCovers&&(!entryCovers||favorOther)){other.usageEvidence=usedEvidence([...other.usageEvidence,...entry.usageEvidence],otherView);remove(entry);}
      else if(entryCovers){entry.usageEvidence=usedEvidence([...entry.usageEvidence,...other.usageEvidence],view);remove(other);}
    }
    // Enforce a bounded private working set too, not merely the eventual persisted set.
    // The same whole-tree ranking applies when a host-resource bound is reached.
    if(entries.length>maxEntries||entryMetadataBytes()>maxMetadataBytes){
      while(entries.length&&(entries.length>maxEntries||entryMetadataBytes()>maxMetadataBytes))remove([...entries].sort(compareDirectoryEviction)[0],true);
    }
    let memoBytes=[...maintenance.replayMemo.values()].reduce((n,v)=>n+(v?Buffer.byteLength(JSON.stringify(v)):0),0);
    // Reserve one maximum-sized replay for the next preparation, bounding the transient peak.
    while(entries.length&&memoBytes>GRAPH_READ_LIMITS.workspaceBytes-GRAPH_READ_LIMITS.snapshotBytes){
      remove([...entries].sort(compareDirectoryEviction)[0],true);
      memoBytes=[...maintenance.replayMemo.values()].reduce((n,v)=>n+(v?Buffer.byteLength(JSON.stringify(v)):0),0);
    }
  }
  // Remove only fully covered views. Equality prefers existing identities, then stable IDs.
  mergeCoverage();
  const independent=()=>entries.map(e=>views.get(e.id)!);
  const tokens=()=>entries.length?directoryMessageTokens(cacheDirectoryPayload(independent())):0;
  while(entries.length&&(tokens()>cacheBudget||entries.length>maxEntries||entryMetadataBytes()>maxMetadataBytes))remove([...entries].sort(compareDirectoryEviction)[0],true);
  let renderGroups=mergeDirectoryGroups(state,task,entries.map(e=>({...structuredClone(views.get(e.id)!),id:e.id,memberEntryIds:[e.id]})),cacheBudget);
  // A merge can make a third display redundant; its requests must not revive next cycle.
  for(let i=0;i<renderGroups.length;i++)for(let j=i+1;j<renderGroups.length;){
    const a=renderGroups[i],b=renderGroups[j],ab=coversDirectoryTrees(a.tree,b.tree),ba=coversDirectoryTrees(b.tree,a.tree);
    if(!ab&&!ba){j++;continue;}
    const keep=ab?a:b,drop=ab?b:a;
    const evidence=entries.filter(e=>drop.memberEntryIds.includes(e.id)).flatMap(e=>e.usageEvidence);
    for(const entry of entries.filter(e=>keep.memberEntryIds.includes(e.id)))entry.usageEvidence=usedEvidence([...entry.usageEvidence,...evidence],views.get(entry.id)!);
    for(const entry of [...entries])if(drop.memberEntryIds.includes(entry.id))remove(entry);
    renderGroups=renderGroups.filter(g=>g!==drop);
    if(drop===a){i--;break;}
  }
  const groupMetadataBytes=()=>Buffer.byteLength(JSON.stringify({entries,groups:renderGroups.map(({id,memberEntryIds,canvasId,rootRefId,currentPath})=>({id,memberEntryIds,canvasId,rootRefId,currentPath}))}));
  while(entries.length&&groupMetadataBytes()>maxMetadataBytes){
    remove([...entries].sort(compareDirectoryEviction)[0],true);
    renderGroups=mergeDirectoryGroups(state,task,entries.map(e=>({...structuredClone(views.get(e.id)!),id:e.id,memberEntryIds:[e.id]})),cacheBudget);
  }
  let drafts=[...main.drafts,...renderGroups.flatMap(g=>g.drafts)];
  const currentAreas=():DirectoryAreas=>({policyVersion:DIRECTORY_POLICY_VERSION,main,cache:{entries,renderGroups,budget:cacheBudget,nextEnteredOrder}});
  const retained=()=>retainedDirectoryReads(state,task,currentAreas(),options.receiptIds??[]).filter(r=>!drafts.some(d=>d.id===r.id));
  // Optional cache cannot prevent a valid main directory from being installed.
  while(true){
    try{checkFrozenStorage(retained(),drafts);break;}
    catch(error){
      if(!(error instanceof DomainError)||error.code!=='READ_RESOURCE_LIMIT'||!entries.length)throw error;
      remove([...entries].sort(compareDirectoryEviction)[0],true);
      renderGroups=mergeDirectoryGroups(state,task,entries.map(e=>({...structuredClone(views.get(e.id)!),id:e.id,memberEntryIds:[e.id]})),cacheBudget);
      drafts=[...main.drafts,...renderGroups.flatMap(g=>g.drafts)];
    }
  }
  const areas=currentAreas();
  // Deduplication transfers facts to the surviving request. Preserve those facts through
  // another fitting pass against the original stage, without reviving removed members.
  // Each stored list is a subset of the already bounded final entry metadata.
  const survivingKeys=new Set(entries.map(entry=>directoryReplayKey(entry.replay)));
  for(const key of maintenance.usageEvidenceMemo.keys())if(!survivingKeys.has(key))maintenance.usageEvidenceMemo.delete(key);
  for(const entry of entries){
    const key=directoryReplayKey(entry.replay);
    if(entry.usageEvidence.length)maintenance.usageEvidenceMemo.set(key,structuredClone(entry.usageEvidence));
    else maintenance.usageEvidenceMemo.delete(key);
  }
  maintenance.diagnostics.elapsedMs+=performance.now()-started;
  return {areas,mainPayload:mainDirectoryPayload(main.data),cachePayload:renderGroups.length?cacheDirectoryPayload(renderGroups):undefined,
    drafts,observations:[main.observation,...renderGroups.map(g=>g.observation)],diagnostics:{...maintenance.diagnostics}};
}
