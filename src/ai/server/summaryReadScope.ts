import type { AppSnapshot, Task } from '../domain';
import type { SummarySnapshot } from '../contextState';
import { allEvidence, descendants, historyEntries, summaryArchive, validSummary } from './historyRepresentations';
import { requireValue } from './errors';

export function summaryReadScope(state:AppSnapshot,task:Task){
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!,archive=summaryArchive(state,task);
  const selection=historyEntries(state,task,workspace.contextStage?.residentRoots),records=allEvidence(state,task);
  const roots=[...selection.roots.map(s=>s.id),...(workspace.contextStage?.residentRoots??[]).filter(id=>{
    const s=archive.find(s=>s.id===id);return s&&validSummary(s,records,archive);
  }),...archive.filter(s=>s.semanticType==='task'&&s.coverage.every(c=>c.taskId===task.id)&&validSummary(s,records,archive)).map(s=>s.id)];
  const allowed=descendants(roots,archive),byId=new Map(archive.map(s=>[s.id,s]));
  const available=(summary:SummarySnapshot)=>summary.semanticType==='task'&&allowed.has(summary.id);
  return {archive,records,allowed,byId,available};
}

/** Summary IDs are immutable; this protects source access and frozen identities, not a mutable tree revision. */
export function assertSummaryRead(state:AppSnapshot,task:Task,versions:Record<string,string>){
  const scope=summaryReadScope(state,task);
  for(const [id,version] of Object.entries(versions)){
    const summary=scope.byId.get(id);
    requireValue(summary&&scope.available(summary),'摘要或其来源已不可访问，请重新读取当前入口','OUT_OF_SCOPE');
    requireValue(summary.version===version,'摘要快照身份已变化，请重新读取当前入口','STALE_SUMMARY');
  }
}
