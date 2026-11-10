import { create } from 'zustand';
import { useAiStore } from './client';
import type { Session } from './domain';

export interface TemporaryWindow {
  x: number; y: number; width: number; height: number; hidden: boolean;
}
interface TemporaryWindows {
  windows: Record<string, TemporaryWindow>;
  focusedId?: string;
  update: (id: string, patch: Partial<TemporaryWindow>) => void;
  focus: (id: string) => void;
  remove: (id: string) => void;
}

export function fitTemporaryWindow(value: TemporaryWindow): TemporaryWindow {
  const width = Math.min(Math.max(360, value.width), window.innerWidth - 16);
  const height = Math.min(Math.max(360, value.height), window.innerHeight - 16);
  return { ...value, width, height, x: Math.max(8, Math.min(value.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(value.y, window.innerHeight - height - 8)) };
}

export function defaultTemporaryWindow(index = 0): TemporaryWindow {
  return fitTemporaryWindow({ x: window.innerWidth - 520 - index * 28, y: 28 + index * 28,
    width: 500, height: Math.min(720, window.innerHeight - 56), hidden: false });
}

export const useTemporaryWindows = create<TemporaryWindows>((set) => ({
  windows: {},
  update: (id, patch) => set(state => ({ windows: { ...state.windows,
    [id]: fitTemporaryWindow({ ...(state.windows[id] ?? defaultTemporaryWindow()), ...patch }) } })),
  focus: focusedId => set({ focusedId }),
  remove: id => set(state => { const windows = { ...state.windows }; delete windows[id]; return { windows }; }),
}));

let opening: Promise<Session> | undefined;
/** Each explicit creation gets its own isolated window, up to three per canvas. */
export function openTemporarySession(canvasId: string, options: { sourceSessionId?: string; taskIds?: string[]; point?: { x: number; y: number } } = {}): Promise<Session> {
  if (opening) return opening;
  opening = (async () => {
    const store = useAiStore.getState(), ui = useTemporaryWindows.getState();
    const sessions = store.snapshot?.sessions.filter(s => s.canvasId === canvasId && s.mode === 'temporary' && s.lifecycle === 'active') ?? [];
    const sourceSessionId = store.snapshot?.sessions.find(s => s.id === store.enteredSessionByCanvas[canvasId]
      && s.canvasId === canvasId && s.mode !== 'temporary' && s.lifecycle !== 'deleted')?.id;
    const busy=store.snapshot?.tasks.some(t=>t.sessionId===sourceSessionId&&t.status!=='completed');
    const session = await store.command<Session>('session.create', { canvasId, mode: 'temporary', title: '临时会话',
      temporaryMode:options.taskIds!==undefined?'custom':sourceSessionId&&!busy?'branch':'minimal',
      ...(options.taskIds !== undefined ? { sourceSessionId:options.sourceSessionId, orderedTasks: options.taskIds.map(taskId=>({sessionId:options.sourceSessionId,taskId})) }
        : { sourceSessionId }) });
    const bounds = defaultTemporaryWindow(sessions.length);
    ui.update(session.id, { ...bounds, ...(options.point ? { x: options.point.x + 16, y: options.point.y } : {}) });
    ui.focus(session.id);
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

export async function closeTemporarySession(id: string) {
  await useAiStore.getState().command('temporary.close', { sessionId: id });
  useAiStore.setState(state => { const draftsBySession = { ...state.draftsBySession }; delete draftsBySession[id]; return { draftsBySession }; });
  useTemporaryWindows.getState().remove(id);
}
