import type { AppSnapshot, Task } from '../domain';
import type { FrozenRead, PromptEntry } from '../contextState';
import type { DirectoryAreas } from './directoryCacheState';

/** Cache eviction changes display only; already issued page pointers survive until TTL. */
export function retainedDirectoryReads(state:AppSnapshot,task:Task,_next:DirectoryAreas,_receiptIds:readonly string[]=[],_entries:PromptEntry[]=[]):FrozenRead[]{
  return (state.workspaces.find(w=>w.id===task.workspaceId)?.frozenReads??[]).filter(read=>read.expiresAt>Date.now());
}
