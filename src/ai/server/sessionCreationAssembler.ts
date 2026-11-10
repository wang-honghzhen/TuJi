import type { AppSnapshot, Session } from '../domain';
import { ensureSessionContext, settleSessionContext } from '../sessionContext';

/** Synchronous and model-free. Runtime supplies the same capacity pipeline used during execution. */
export type SessionCreationAssembler = (state: AppSnapshot, session: Session) => void;

export function assembleCreatedSession(state: AppSnapshot, session: Session, assemble?: SessionCreationAssembler): void {
  const workspace = state.workspaces.find(w => w.id === session.workspaceId)!;
  ensureSessionContext(state, workspace);
  if (session.temporaryContext?.mode !== 'minimal') assemble?.(state, session);
  settleSessionContext(state, session.id);
}
