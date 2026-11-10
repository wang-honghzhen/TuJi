import type { AppSnapshot, Note, Session, Workspace } from './domain';
import { estimateTokens } from './tokens';
import { sectionBudgets } from './memory';

export function notePayload(note:Note){return{noteId:note.id,version:note.version,type:note.type,content:note.text,sourceRefs:note.sourceRefs,replaces:note.id};}
export function sameNoteContent(a:Note,b:Note):boolean {
  return JSON.stringify([a.text,a.type,a.sourceRefs])===JSON.stringify([b.text,b.type,b.sourceRefs]);
}

/** Selection navigation does not change this binding; only a committed selection does. */
export function notebookWorkspace(state: AppSnapshot, session: Session | undefined): Workspace | undefined {
  if (session?.temporaryContext?.mode === 'minimal') return undefined;
  const owner = session?.mode === 'temporary'
    ? state.sessions.find(value => value.id === session.temporaryContext?.sourceSessionId && value.lifecycle !== 'deleted')
    : session;
  return state.workspaces.find(value => value.id === owner?.workspaceId);
}
export function notebookUsage(state: AppSnapshot, workspace: Workspace) {
  const used = estimateTokens(JSON.stringify(workspace.workNotes.map(note => ({role:'user',content:JSON.stringify({work_note:notePayload(note)})}))));
  return {ordinary:used,exception:0,used,limit:sectionBudgets(state).work_notes};
}
