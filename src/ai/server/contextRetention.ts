import type { AppSnapshot, Task } from '../domain';
import { inheritedReadScope } from './inheritedReadScope';
import type { ContextBuildOptions } from '../contextState';
import { estimateTokens } from '../tokens';
import { selectHistory, validSummary } from './historyRepresentations';
import { HISTORY_VIEW_VERSION } from './historyRecordView';
import { contextProtection, eligibleRead } from './contextProtection';
import { allRetainedCalls, isReceipted, originResultId, receiptFamily } from './readVisibility';
import { isDataRead } from './toolContextKinds';
import { sourceChanges } from './sourceFreshness';
import { canvasObservationChanges } from './contextFreshness';
import { eligibleWriteReceipt, writeReceiptEntry } from './writeReceipts';
export function staleReadResult(state:AppSnapshot,task:Task,call:import('../domain').ToolCallRecord):boolean {
  // Summary content is immutable historical material, never a live-source claim.
  if(call.summaryOrigins?.length)return false;
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  return (call.resultSources??[]).some(source=>source.tracking!=='historical'&&sourceChanges(state,task,[source],false).length>0)
    ||(workspace.observations??[]).some(observation=>(observation.callId===call.id||observation.callId===originResultId(call))
      &&canvasObservationChanges(state,observation).length>0);
}
export const directoryReadResult=(call:import('../domain').ToolCallRecord)=>call.name==='graph_read_directory'||call.canvasOrigins?.some(o=>o.request.tool==='graph_read_directory')===true;

/** A selective, side-effect-free plan; residency is not permanent result visibility. */
export function contextRetention(state: AppSnapshot, task: Task, options: ContextBuildOptions = {}) {
  state=inheritedReadScope(state,task);
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const completed = options.phase === 'task_end';
  const history = selectHistory(state, task, workspace.contextStage?.residentRoots, completed);
  const taskIds = new Set([...history.turns.map(t => t.taskId), ...history.roots.flatMap(s => s.coverage.map(c => c.taskId)), task.id]);
  const allowed = new Set(history.records.map(r => r.id));
  const calls = allRetainedCalls(state).filter(c => taskIds.has(c.taskId) && (allowed.has(c.id) || c.taskId === task.id));
  const protection = contextProtection(state, task, taskIds);
  const selected = new Set(options.receiptIds ?? []);
  const candidates = calls.filter(c => eligibleRead(c, state, protection.hardProtectedCalls));
  const clean = options.mode === 'refactor' || options.mode === 'compact';
  const capacity = options.maintenanceIntent !== 'notice';
  const writeReceiptIds = clean && capacity ? calls.filter(c => eligibleWriteReceipt(state, c, protection.protectedCalls)
    && state.contextRetention?.writeReceipts?.[originResultId(c)]?.receipt !== writeReceiptEntry(state, c)?.receipt).map(originResultId) : [];
  const groups = new Map<string, typeof calls>();
  for (const c of calls) { const group = groups.get(c.stepId) ?? []; group.push(c); groups.set(c.stepId, group); }
  const stepTokens = new Map([...groups].map(([id, group]) => [id, estimateTokens(JSON.stringify(group.map(c => [c.name, c.arguments, c.result])))]));
  if(clean)for(const call of candidates){
    const stale=staleReadResult(state,task,call),directory=directoryReadResult(call);
    if(stale||directory||capacity&&!protection.recentSteps.has(call.stepId))selected.add(originResultId(call));
  }
  for (const id of selected) if (!candidates.some(c => originResultId(c) === id) && !isReceipted(state, id)) selected.delete(id);
  const checked=new Set<string>();
  for(const id of [...selected]){
    if(checked.has(id))continue;
    const family=[...receiptFamily(state,[id])];family.forEach(member=>checked.add(member));
    const requiresVersionCleanup=family.some(member=>selected.has(member)&&calls.some(c=>originResultId(c)===member
      &&(staleReadResult(state,task,c)||directoryReadResult(c))));
    const blocked=family.some(member=>protection.hardProtectedCalls.has(member))
      ||capacity&&!requiresVersionCleanup&&family.some(member=>protection.protectedCalls.has(member));
    for(const member of family)if(blocked)selected.delete(member);else selected.add(member);
  }
  const omittedReadCalls = new Set<string>();
  for (const use of workspace.expansionUses ?? []) {
    const parts = use.parts;
    if (!parts || parts.some(p => p.historyViewVersion !== HISTORY_VIEW_VERSION
      || p.coverage.some(c => !history.records.some(r => r.id === c.recordId && r.version === c.version && c.end <= r.text.length))
      || Object.entries(p.targetVersions).some(([id, version]) => !history.records.some(r => r.id === id && r.version === version)
        && !history.archive.some(s => s.id === id && s.version === version && validSummary(s, history.records, history.archive))))) omittedReadCalls.add(use.callId);
  }
  const readCallIds = new Set(calls.filter(c => isDataRead(c.name) && !isReceipted(state, c) && !selected.has(originResultId(c))).map(c => c.id));
  return { history, taskIds, calls, readCallIds, receiptIds: [...selected], writeReceiptIds, protection,
    readSteps: new Set(calls.filter(c => readCallIds.has(c.id)).map(c => c.stepId)),
    recentSteps: [...protection.recentSteps], requiredSteps: protection.protectedSteps, omittedReadCalls, stepTokens };
}
