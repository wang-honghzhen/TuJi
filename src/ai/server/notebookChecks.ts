import type { AppSnapshot, Task } from '../domain';
import { notebookWorkspace } from '../notebook';

/** Bind proposals to the notebook visible to their submitted request. */
export interface NotebookCheck {
  notebookId: string | null;
  bindingRevision: number;
}
export function captureNotebookCheck(state: AppSnapshot, task: Task): NotebookCheck {
  const session = state.sessions.find(s => s.id === task.sessionId);
  return { notebookId: notebookWorkspace(state, session)?.id ?? null, bindingRevision: session?.temporaryContext?.revision ?? 0 };
}
