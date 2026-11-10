import type { AppSnapshot, MemorySnapshot, Session, Workspace } from '../domain';
import type { ToolDefinition } from './providers';
import type { ContextStage, Coverage } from '../contextState';
import { allEvidence, artifactEvidence, currentEntries, fullCoverage, snapshotEvidence, summaryArchive } from './historyRepresentations';
import { effectiveArtifacts } from '../memory';
import { canvasGraphReferences, emptyGraphReferences, graphReferenceCodec, seedAddressableReferences, sessionGraphReferences } from './graphReferences';
import { projectPromptEntries } from './promptProjection';
import { promptRouteSignature } from './promptPrefix';
import { toolDefinitions } from './tools';
import { webAccessEnabled } from '../webAccess';
import { hash } from './repository';
import { inheritedReadScope } from './inheritedReadScope';
import { RULES_ID } from './automaticContext';
import { residentSessionTaskIds } from '../sessionContext';
import { authorizedAttachments } from './attachmentCatalog';

/** Public protocol material only; opaque provider continuation stays in Runtime. */
export interface PromptFork {
  version: 1; sourceSessionId: string; fingerprint: string; createdAt: string;
  stage: ContextStage; tools: ToolDefinition[]; requiredCoverage: Coverage[];
  requiredArtifacts: Array<{id:string;version:number;hash:string}>;
  requiredSummaries: Array<{id:string;version:string}>;
  requiredCalls: string[];
  taskIds: string[];
  reused?: boolean; fallbackReason?: string;
}
const covers = (available: Coverage[], target: Coverage) => {
  let end = target.start;
  for (const span of available.filter(c => c.recordId === target.recordId && c.version === target.version).sort((a,b)=>a.start-b.start)) {
    if (span.start > end) break; end = Math.max(end, span.end);
  }
  return end >= target.end;
};
export function sourceTools(state: AppSnapshot, session: Session): ToolDefinition[] {
  const task = state.tasks.filter(t=>t.sessionId===session.id).at(-1);
  return state.provider.supportsTools ? toolDefinitions({ write:true,graph:true,design:state.graph?.canvases.find(c=>c.canvasId===session.canvasId)?.mode==='design',
    temporary:false,notes:true,web:webAccessEnabled(state.provider),attachments:!!task&&authorizedAttachments(state,task).length>0 }) : [];
}
/** Must run in a transaction or a detached preview; may reserve aliases for the sealed final turn. */
export function capturePromptFork(state: AppSnapshot, source: Session): PromptFork | undefined {
  const workspace = state.workspaces.find(w=>w.id===source.workspaceId)!;
  const latest = state.tasks.filter(t=>t.sessionId===source.id).at(-1);
  if (!latest || latest.status !== 'completed' || !workspace.contextStage?.entries.length || !state.graph) return;
  if(workspace.contextStage.taskId!==latest.id&&workspace.contextStage.afterTaskId!==latest.id)return;
  if(!workspace.contextStage.eventIds.includes(RULES_ID)
    ||state.messages.some(m=>m.taskId===latest.id&&m.status==='streaming')
    ||state.toolCalls.some(c=>c.taskId===latest.id&&!['completed','rejected'].includes(c.status)))return;
  state=inheritedReadScope(state,latest);
  const stage = structuredClone(workspace.contextStage), records = allEvidence(state,latest);
  const refs = sessionGraphReferences(state,source.id,true)!;
  seedAddressableReferences(refs, records.map(r=>({ id:r.id,prefix:r.id===state.messages.find(m=>m.id===r.id)?.id?'m' as const:state.toolCalls.some(c=>c.id===r.id)?'t' as const:'s' as const })));
  seedAddressableReferences(refs, state.toolCalls.filter(c=>c.taskId===latest.id).flatMap(c=>[{prefix:'o' as const,id:c.operationId},{prefix:'o' as const,id:c.stepId}]));
  const codec=graphReferenceCodec(state.graph!,canvasGraphReferences(state,source.canvasId,true)??emptyGraphReferences(),refs);
  for(const entry of currentEntries(state,latest)) if(!entry.coverage.every(c=>covers(stage.entries.flatMap(e=>e.coverage),c))){
    if(!stage.eventIds.includes(entry.id)){stage.entries.push(entry);stage.eventIds.push(entry.id);}
  }
  for(const message of state.messages.filter(m=>m.taskId===latest.id&&m.role==='assistant'&&m.status==='complete'&&!m.presentationCallId&&!m.stepId&&m.phase!=='status')){
    const record=records.find(r=>r.id===message.id);if(!record||covers(stage.entries.flatMap(e=>e.coverage),fullCoverage(record)))continue;
    const entryId=`sealed:${message.id}:${message.version}`;
    stage.entries.push({id:entryId,category:'current_protocol',coverage:[fullCoverage(record)],messages:[{role:'assistant',content:message.text}]});stage.eventIds.push(entryId);
  }
  stage.afterTaskId=latest.id;
  projectPromptEntries(state,latest,stage,codec.encode,()=>{});
  // These fields are evaluations of a particular request, never inherited executable plans.
  delete stage.retentionDraft; delete stage.pendingNoticeAttempt; delete stage.lastRequest;
  delete stage.invalidatedReason; delete stage.recoveryRequired; delete stage.compactionAttempt;
  for(const entry of stage.entries) for(const message of [...entry.messages,...entry.wireMessages??[]]) {
    delete message.responseItems; delete message.reasoningContent;
  }
  const coverage=stage.entries.flatMap(e=>e.coverage), archive=summaryArchive(state,latest);
  const visited=new Set<string>();
  const includeSummary=(id:string)=>{if(visited.has(id))return;visited.add(id);const s=archive.find(s=>s.id===id);if(s){coverage.push(...s.coverage);s.children.forEach(includeSummary);}};
  const visit=(value:unknown):void=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>;if(typeof row.summaryId==='string')includeSummary(row.summaryId);Object.values(row).forEach(visit);};
  for(const entry of stage.entries)for(const message of entry.messages)try{visit(JSON.parse(message.content));}catch{/* Opaque natural text. */}
  const requiredCoverage=[...new Map(coverage.map(c=>[JSON.stringify(c),c])).values()];
  const artifacts=effectiveArtifacts(state,latest,stage.residentTaskIds).flatMap(a=>a.artifact?[a.artifact]:[]);
  const requiredArtifacts=artifacts.map(a=>({id:a.id,version:a.version,hash:a.hash}));
  const requiredSummaries=archive.filter(s=>visited.has(s.id)).map(s=>({id:s.id,version:s.version}));
  const requiredCalls=[...new Set([...stage.entries.flatMap(e=>e.readCallIds??[]),...stage.summaryRegions?.members.flatMap(m=>m.callIds)??[],...stage.canvasRefresh?.members.flatMap(m=>m.callIds)??[]])];
  const available=[...records,...artifactEvidence(artifacts)].map(fullCoverage);
  if(!requiredCoverage.every(c=>covers(available,c)))return;
  const tools=sourceTools(state,source);
  if(stage.toolsSignature!==hash(tools)||stage.routeSignature!==promptRouteSignature({...state.provider,...latest.modelSelection}))return;
  const fingerprint=hash([stage.entries,requiredCoverage,requiredArtifacts,requiredSummaries,requiredCalls,stage.routeSignature,tools]);
  return {version:1,sourceSessionId:source.id,fingerprint,createdAt:new Date().toISOString(),stage,tools,requiredCoverage,requiredArtifacts,requiredSummaries,requiredCalls,
    taskIds:residentSessionTaskIds(state,source.id)};
}
export function forkEligibility(fork:PromptFork|undefined, memory:MemorySnapshot, state?:Pick<AppSnapshot,'changes'>, selectedTaskIds=memory.sourceTaskIds) {
  if(!fork)return false;
  if (JSON.stringify(selectedTaskIds) !== JSON.stringify(fork.taskIds)) return false;
  const evidence=snapshotEvidence(memory.messages,memory.toolCalls??[],memory.progressEvents??[],memory.notes,'',state,memory.taskNotices??[]);
  const available=[...evidence,...artifactEvidence(memory.artifacts??[])].map(fullCoverage);
  return fork.requiredCoverage.every(span=>covers(available,span))
    &&fork.requiredArtifacts.every(a=>memory.artifacts?.some(m=>m.id===a.id&&m.version===a.version&&m.hash===a.hash))
    &&fork.requiredSummaries.every(s=>memory.summaries?.some(m=>m.id===s.id&&m.version===s.version))
    &&fork.requiredCalls.every(id=>memory.toolCalls?.some(c=>c.id===id));
}
export function installPromptFork(state:AppSnapshot,workspace:Workspace,source:Session,memory:MemorySnapshot,force=false) {
  const original=state.workspaces.find(w=>w.id===source.workspaceId)!;
  // Rebuilt children start from complete frozen records; only exact forks share visibility state.
  workspace.readRetention={version:1,revision:0,receipts:{}};
  const calls=new Set((memory.toolCalls??[]).flatMap(c=>[c.id,c.originResultId??c.id]));
  workspace.frozenReads=structuredClone((original.frozenReads??[]).filter(r=>calls.has(r.callId)));
  workspace.expansionUses=structuredClone((original.expansionUses??[]).filter(u=>calls.has(u.callId)));
  const fork=capturePromptFork(state,source),selected=workspace.sessionContext?.taskOrder??memory.sourceTaskIds;
  const destinationRouteMatches=!!fork&&fork.stage.routeSignature===promptRouteSignature(state.provider);
  workspace.inheritanceStatus={sourceSessionId:source.id,eligible:destinationRouteMatches&&forkEligibility(fork,memory,state,selected),reused:false,
    ...(fork?{fingerprint:fork.fingerprint}:{}),reason:!fork?'来源没有兼容的已提交提示词快照':!destinationRouteMatches?'新会话默认模型路由与来源任务不同':!forkEligibility(fork,memory,state,selected)?force?'来源快照依赖不完整，按可用历史装配':'所选任务顺序或内容不等于来源当前上下文':undefined};
  if(!workspace.inheritanceStatus.eligible||!fork)return false;
  workspace.promptFork=fork;
  workspace.readRetention=structuredClone(original.readRetention??state.contextRetention??{version:1,revision:0,receipts:{}});
  workspace.frozenReads=structuredClone(original.frozenReads??[]);
  workspace.observations=structuredClone(original.observations??[]);
  if(state.sessions.find(s=>s.id===workspace.sessionId)?.mode!=='temporary'){
    workspace.pinnedNotes=structuredClone(original.pinnedNotes);workspace.workNotes=structuredClone(original.workNotes);
  }
  workspace.canvasView=structuredClone(original.canvasView);
  return true;
}
