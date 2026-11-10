import type { AppSnapshot, Task } from '../domain';
import { inheritedReadScope } from './inheritedReadScope';
import type { ContextStage, FrozenRead } from '../contextState';
import { checkFrozenStorage } from './graphReadLimits';

/** Projection receipts never revoke immutable snapshots. Unread pages retain their TTL. */
export function planFrozenReads(state:AppSnapshot,task:Task,stage:Pick<ContextStage,'entries'|'directoryAreas'|'frozenReadDrafts'|'retentionDraft'>){
  state=inheritedReadScope(state,task);
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const drafts:FrozenRead[]=[...new Map((stage.frozenReadDrafts??[]).map(r=>[r.id,r])).values()];
  const replacing=new Set(drafts.map(r=>r.id));
  const retained=(workspace.frozenReads??[]).filter(r=>r.expiresAt>Date.now()&&!replacing.has(r.id));
  checkFrozenStorage(retained,drafts);
  return {retained,drafts,reads:[...retained,...drafts]};
}
