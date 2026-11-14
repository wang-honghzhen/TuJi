import { useAiStore } from './client';
import type { Session } from './domain';
import { panelCommand } from '@/desktop/panelState';

let opening: Promise<Session> | undefined;
/** Each explicit creation gets a tab in the shared panel, up to three per canvas. */
export function openTemporarySession(canvasId: string, options: { sourceSessionId?: string; taskIds?: string[]; point?: { x: number; y: number } } = {}): Promise<Session> {
  if (opening) return opening;
  opening = (async () => {
    const store = useAiStore.getState();
    const sourceSessionId = store.snapshot?.sessions.find(s => s.id === store.enteredSessionByCanvas[canvasId]
      && s.canvasId === canvasId && s.mode !== 'temporary' && s.lifecycle !== 'deleted')?.id;
    const busy=store.snapshot?.tasks.some(t=>t.sessionId===sourceSessionId&&t.status!=='completed');
    const session = await store.command<Session>('session.create', { canvasId, mode: 'temporary', title: '临时会话',
      temporaryMode:options.taskIds!==undefined?'custom':sourceSessionId&&!busy?'branch':'minimal',
      ...(options.taskIds !== undefined ? { sourceSessionId:options.sourceSessionId, orderedTasks: options.taskIds.map(taskId=>({sessionId:options.sourceSessionId,taskId})) }
        : { sourceSessionId }) });
    await panelCommand('open-panel', { tab: session.id });
    return session;
  })().finally(() => { opening = undefined; });
  return opening;
}

const activity = new Map<string,number>();
export function touchTemporarySession(sessionId:string) {
  if(Date.now()-(activity.get(sessionId)??0)<30000)return;
  activity.set(sessionId,Date.now());
  void useAiStore.getState().command('temporary.touch',{sessionId},{reportError:false}).catch(()=>{});
}

export async function closeTemporarySession(id: string, next = 'notebook') {
  await useAiStore.getState().command('temporary.close', { sessionId: id });
  useAiStore.setState(state => { const draftsBySession = { ...state.draftsBySession }; delete draftsBySession[id]; return { draftsBySession }; });
  await panelCommand('forget-tab', { id, next });
}
