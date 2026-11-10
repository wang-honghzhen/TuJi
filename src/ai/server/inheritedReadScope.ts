import type { AppSnapshot, Task } from '../domain';
const scope = Symbol('session-read-scope');
type Scoped = AppSnapshot & {[scope]?:{workspaceId:string;root:AppSnapshot}};
/** Shallow view: writes reach only this reader's ledger; preview spreads keep the scope. */
export function inheritedReadScope(state:AppSnapshot,task:Pick<Task,'workspaceId'>):AppSnapshot {
  const current=(state as Scoped)[scope];if(current?.workspaceId===task.workspaceId)return state;
  const root=current?.root??state,workspace=root.workspaces.find(w=>w.id===task.workspaceId);
  if(!workspace?.readRetention)return root;
  const memories=root.snapshots.filter(s=>workspace.snapshotIds.includes(s.id)&&!s.revoked);
  const inheritedIds=new Set(memories.flatMap(s=>s.toolCalls??[]).map(c=>c.id));
  const localTasks=new Set(root.tasks.filter(t=>t.workspaceId===workspace.id).map(t=>t.id));
  return {...root,contextRetention:workspace.readRetention,toolCalls:root.toolCalls.filter(c=>!inheritedIds.has(c.id)||localTasks.has(c.taskId)),
    snapshots:[...root.snapshots.filter(s=>!workspace.snapshotIds.includes(s.id)),...memories],[scope]:{workspaceId:workspace.id,root}} as Scoped;
}
