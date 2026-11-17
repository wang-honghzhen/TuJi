import type { Repository } from './repository';
import { requireValue, text } from './errors';

/** Reading UI state lives in the project database, independent of the desktop HTTP port. */
export function claimPresentationAutoFocus(repo: Repository, payload: Record<string, unknown>): { claimed: boolean } {
  const partId = text(payload.partId, '回复段落', 1000);
  const canvasId = text(payload.canvasId, '画布', 1000);
  const sessionId = text(payload.sessionId, '会话', 1000);
  const part = repo.state.presentationParts?.find(value => value.id === partId);
  const task = part && repo.state.tasks.find(value => value.id === part.taskId);
  const session = repo.state.sessions.find(value => value.id === sessionId);
  requireValue(part && part.seq > 0 && part.targets.length && task?.sessionId === sessionId
    && session?.canvasId === canvasId && session.lifecycle !== 'deleted', '引用段落不属于当前画布会话');
  if (repo.state.presentationAutoFocus?.[partId]) return { claimed: false };
  return repo.transaction(state => {
    const handled = state.presentationAutoFocus ??= {};
    if (handled[partId]) return { claimed: false };
    handled[partId] = true;
    repo.event(session.workspaceId, 'presentation.autoFocus.handled', { partId });
    return { claimed: true };
  });
}
