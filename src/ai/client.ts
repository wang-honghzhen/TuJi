import { create } from 'zustand';
import type { ApiError, AppSnapshot, ModelSelection, Session, Task } from './domain';
import { reconcileGraph } from '@/v3/graphReconciliation';
import { reconcileReadingProgress } from './presentationReading';

export interface InputDraft {
  text: string;
  artifactIds: string[];
  progressSelection?: import('./domain').ProgressSelection[];
  pendingMessageId?: string;
  modelSelection?: ModelSelection;
}

export interface CommandOptions { reportError?: boolean }

const emptyDraft = (): InputDraft => ({ text: '', artifactIds: [] });
const EMPTY_DRAFT = emptyDraft();

interface AiStore {
  snapshot: AppSnapshot | null;
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  error: string | null;
  view: 'canvas' | 'chat';
  activeSessionByCanvas: Record<string, string>;
  enteredSessionByCanvas: Record<string, string>;
  draftsBySession: Record<string, InputDraft>;
  selectedRefsByCanvas: Record<string, string[]>;
  inputRefsByCanvas: Record<string, string[]>;
  replyTargetRefsByCanvas: Record<string, string[]>;
  settingsOpen: boolean;
  setView: (view: 'canvas' | 'chat') => void;
  setActiveSession: (canvasId: string, sessionId: string) => void;
  clearActiveSession: (canvasId: string) => void;
  setDraft: (sessionId: string, draft: Partial<InputDraft>) => void;
  clearDraft: (sessionId: string) => void;
  setSelectedRefs: (canvasId: string, refs: string[]) => void;
  toggleInputRef: (canvasId: string, ref: string) => boolean;
  removeInputRef: (canvasId: string, ref: string) => void;
  setReplyTargetRefs: (canvasId: string, refs: string[]) => void;
  setSettingsOpen: (open: boolean) => void;
  clearError: () => void;
  refresh: () => Promise<void>;
  connect: () => () => void;
  command: <T = unknown>(action: string, payload?: unknown, options?: CommandOptions) => Promise<T>;
}

export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;
  constructor(error: ApiError, status: number) {
    super(error.error || `请求失败 (${status})`);
    this.name = 'ApiRequestError'; this.code = error.code; this.details = error.details; this.status = status;
  }
}

let connectionToken = '';
let tokenRequest: Promise<string> | undefined;
let stream: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let subscriptions = 0;
let generation = 0;
let reconnectAttempt = 0;

async function getConnectionToken(force = false): Promise<string> {
  if (force) connectionToken = '';
  if (connectionToken) return connectionToken;
  if (!tokenRequest) {
    tokenRequest = fetch('/api/qixue/connection', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('本地 AI 服务未连接，请使用项目启动命令启动应用。');
        const body = await response.json() as { token?: string };
        if (!body.token) throw new Error('本地服务没有返回有效连接信息。');
        connectionToken = body.token;
        return body.token;
      })
      .finally(() => { tokenRequest = undefined; });
  }
  return tokenRequest;
}

/** Long-running host actions: parsing/OCR, backups and restores are bounded by the server, not here. */
const LONG_ACTIONS = new Set(['artifact.upload', 'backup.export', 'backup.import']);
const COMMAND_TIMEOUT_MS = 120_000, LONG_COMMAND_TIMEOUT_MS = 3_600_000;

async function request<T>(url: string, init?: RequestInit, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
  const token = await getConnectionToken();
  // A request that never settles must not leave a component busy forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init?.signal ?? controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Qixue-Token': token, ...init?.headers },
    });
  } catch (cause) {
    throw controller.signal.aborted && !init?.signal
      ? new Error(`本地服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请检查运行服务后重试。`)
      : cause;
  } finally { clearTimeout(timer); }
  const body: unknown = await response.json().catch(() => ({ error: `服务返回 ${response.status}` }));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) connectionToken = '';
    const error = body as ApiError;
    throw new ApiRequestError(error, response.status);
  }
  return body as T;
}

/** Apply one committed transaction: only the records it changed are replaced, and every untouched
 *  record keeps its identity — which is what lets the conversation rows skip re-rendering. */
function applyUpdate(update: { lastSeq: number; records: Array<{ collection: string; id: string; record?: unknown }>; meta?: Record<string, unknown> }) {
  const current = useAiStore.getState().snapshot;
  // A delta is only meaningful on top of a snapshot we already have.
  if (!current) { void useAiStore.getState().refresh().catch(() => undefined); return; }
  if (update.lastSeq <= current.lastSeq) return;
  let snapshot: AppSnapshot = { ...current, lastSeq: Math.max(current.lastSeq, update.lastSeq) };
  const byCollection = new Map<string, Array<{ id: string; record?: unknown }>>();
  for (const item of update.records) {
    const bucket = byCollection.get(item.collection); if (bucket) bucket.push(item); else byCollection.set(item.collection, [item]);
  }
  for (const [collection, items] of byCollection) {
    const list = (snapshot as unknown as Record<string, Array<{ id: string }>>)[collection];
    if (!Array.isArray(list)) continue;
    let next: Array<{ id: string }>;
    if (items.length <= 8) {
      // Streaming usually changes one row; copying and finding it is cheaper
      // than constructing an index for the entire conversation.
      next = [...list];
      for (const item of items) {
        const index = next.findIndex(record => record.id === item.id);
        if (item.record === undefined) { if (index >= 0) next.splice(index, 1); }
        else if (index >= 0) next[index] = item.record as { id: string };
        else next.push(item.record as { id: string });
      }
    } else {
      // Map keeps existing rows in order and appends new (or deleted then
      // re-added) rows, avoiding a full history scan for each batch entry.
      const rows = new Map(list.map(record => [record.id, record]));
      for (const item of items) {
        if (item.record === undefined) rows.delete(item.id);
        else rows.set(item.id, item.record as { id: string });
      }
      next = [...rows.values()];
    }
    snapshot = { ...snapshot, [collection]: next } as AppSnapshot;
  }
  if (update.meta) snapshot = { ...snapshot, ...update.meta } as AppSnapshot;
  if (snapshot.graph && snapshot.graph !== current.graph) snapshot.graph = reconcileGraph(current.graph, snapshot.graph);
  const active = { ...useAiStore.getState().activeSessionByCanvas };
  for (const canvasId of Object.keys(active)) {
    if (!snapshot.sessions.some(session => session.id === active[canvasId] && session.mode !== 'temporary' && session.lifecycle !== 'deleted')) delete active[canvasId];
  }
  reconcileReadingProgress(snapshot);
  useAiStore.setState({ snapshot, activeSessionByCanvas: active, enteredSessionByCanvas: { ...active } });
}

function acceptSnapshot(snapshot: AppSnapshot) {
  const current = useAiStore.getState().snapshot;
  // A late HTTP response must not overwrite newer streamed state.
  if (current && snapshot.lastSeq < current.lastSeq) return;
  if (snapshot.graph) snapshot.graph = reconcileGraph(current?.graph, snapshot.graph);
  const active = { ...useAiStore.getState().activeSessionByCanvas };
  const viableSessions = snapshot.sessions.filter((session) => session.mode !== 'temporary' && session.lifecycle !== 'deleted');
  for (const [canvasId, sessionId] of Object.entries(active)) {
    if (!viableSessions.some((session) => session.id === sessionId)) delete active[canvasId];
  }
  reconcileReadingProgress(snapshot);
  useAiStore.setState({ snapshot, activeSessionByCanvas: active, enteredSessionByCanvas: { ...active } });
}

async function openStream(myGeneration: number) {
  if (!subscriptions || myGeneration !== generation) return;
  try {
    const token = await getConnectionToken();
    const snapshot = await request<AppSnapshot>('/api/qixue/snapshot');
    if (!subscriptions || myGeneration !== generation) return;
    acceptSnapshot(snapshot);
    stream?.close();
    const after = useAiStore.getState().snapshot?.lastSeq ?? 0;
    stream = new EventSource(`/api/qixue/events?after=${after}&token=${encodeURIComponent(token)}`);
    stream.addEventListener('update', (event) => {
      try {
        applyUpdate(JSON.parse((event as MessageEvent<string>).data) as { lastSeq: number; records: Array<{ collection: string; id: string; record?: unknown }>; meta?: Record<string, unknown> });
        reconnectAttempt = 0;
        useAiStore.setState({ connection: 'connected', error: null });
      } catch {
        useAiStore.setState({ error: '收到无效的增量状态，正在重新同步。' });
        void useAiStore.getState().refresh().catch(() => undefined);
      }
    });
    stream.addEventListener('snapshot', (event) => {
      try {
        acceptSnapshot(JSON.parse((event as MessageEvent<string>).data) as AppSnapshot);
        reconnectAttempt = 0;
        useAiStore.setState({ connection: 'connected', error: null });
      } catch {
        useAiStore.setState({ error: '收到无效的会话状态，正在重新同步。' });
        void useAiStore.getState().refresh().catch(() => undefined);
      }
    });
    stream.onopen = () => {
      reconnectAttempt = 0;
      useAiStore.setState({ connection: 'connected', error: null });
    };
    stream.onerror = () => {
      stream?.close();
      stream = undefined;
      scheduleReconnect(myGeneration);
    };
  } catch (error) {
    useAiStore.setState({ error: error instanceof Error ? error.message : '无法连接本地服务。' });
    scheduleReconnect(myGeneration);
  }
}

function scheduleReconnect(myGeneration: number) {
  if (!subscriptions || myGeneration !== generation) return;
  useAiStore.setState({ connection: 'reconnecting' });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(() => { void openStream(myGeneration); }, delay);
}

export const useAiStore = create<AiStore>((set, get) => ({
  snapshot: null,
  connection: 'disconnected',
  error: null,
  view: 'canvas',
  activeSessionByCanvas: {},
  enteredSessionByCanvas: {},
  draftsBySession: {},
  selectedRefsByCanvas: {},
  inputRefsByCanvas: {},
  replyTargetRefsByCanvas: {},
  settingsOpen: false,
  setView: (view) => set({ view }),
  setActiveSession: (canvasId, sessionId) => set((state) => ({ activeSessionByCanvas: { ...state.activeSessionByCanvas, [canvasId]: sessionId },
    enteredSessionByCanvas: { ...state.enteredSessionByCanvas, [canvasId]: sessionId },
    replyTargetRefsByCanvas: { ...state.replyTargetRefsByCanvas, [canvasId]: [] } })),
  clearActiveSession: canvasId => set(state => {
    const active = { ...state.activeSessionByCanvas }, entered = { ...state.enteredSessionByCanvas };
    delete active[canvasId]; delete entered[canvasId];
    return { activeSessionByCanvas: active, enteredSessionByCanvas: entered,
      replyTargetRefsByCanvas: { ...state.replyTargetRefsByCanvas, [canvasId]: [] } };
  }),
  setDraft: (sessionId, draft) => set((state) => ({ draftsBySession: { ...state.draftsBySession,
    [sessionId]: { ...(state.draftsBySession[sessionId] ?? emptyDraft()), ...draft } } })),
  clearDraft: (sessionId) => set((state) => ({ draftsBySession: { ...state.draftsBySession, [sessionId]: emptyDraft() } })),
  setSelectedRefs: (canvasId, refs) => set((state) => ({ selectedRefsByCanvas: { ...state.selectedRefsByCanvas, [canvasId]: [...refs] } })),
  toggleInputRef: (canvasId, ref) => {
    const refs = get().inputRefsByCanvas[canvasId] ?? [], added = !refs.includes(ref);
    set(state => ({ inputRefsByCanvas: { ...state.inputRefsByCanvas, [canvasId]: added ? [...refs, ref] : refs.filter(id => id !== ref) } }));
    return added;
  },
  removeInputRef: (canvasId, ref) => set(state => ({ inputRefsByCanvas: { ...state.inputRefsByCanvas,
    [canvasId]: (state.inputRefsByCanvas[canvasId] ?? []).filter(id => id !== ref) } })),
  setReplyTargetRefs: (canvasId, refs) => set((state) => ({ replyTargetRefsByCanvas: { ...state.replyTargetRefsByCanvas, [canvasId]: [...refs] } })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  clearError: () => set({ error: null }),
  refresh: async () => {
    try { acceptSnapshot(await request<AppSnapshot>('/api/qixue/snapshot')); }
    catch (error) {
      set({ error: error instanceof Error ? error.message : '状态同步失败。' });
      throw error;
    }
  },
  connect: () => {
    subscriptions += 1;
    if (subscriptions === 1) {
      generation += 1;
      set({ connection: 'connecting' });
      void openStream(generation);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscriptions = Math.max(0, subscriptions - 1);
      if (!subscriptions) {
        generation += 1;
        stream?.close(); stream = undefined;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        set({ connection: 'disconnected' });
      }
    };
  },
  command: async <T,>(action: string, payload?: unknown, options?: CommandOptions): Promise<T> => {
    try {
      const result = await request<T>('/api/qixue/command', { method: 'POST', body: JSON.stringify({ action, payload: payload ?? {} }) },
        LONG_ACTIONS.has(action) ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
      // Do not report an acknowledged mutation as failed merely because its state refresh disconnects.
      if (!['context.preview', 'inheritance.preview', 'backup.export', 'settings.background.read'].includes(action)) await get().refresh().catch(() => undefined);
      return result;
    } catch (error) {
      if (options?.reportError !== false) set({ error: error instanceof Error ? error.message : '操作失败。' });
      throw error;
    }
  },
}));

export function getSession(snapshot: AppSnapshot | null, canvasId: string, activeSessionId?: string): Session | undefined {
  return snapshot?.sessions.find((session) => session.mode !== 'temporary' && session.id === activeSessionId && session.canvasId === canvasId && session.lifecycle !== 'deleted');
}

export function sessionTasks(snapshot: AppSnapshot | null, sessionId?: string): Task[] {
  return (snapshot?.tasks ?? []).filter((task) => task.sessionId === sessionId);
}

export const ACTIVE_TASK_STATUSES: Task['status'][] = ['queued', 'running', 'waiting_resource', 'waiting_user', 'waiting_retry', 'waiting_reconcile', 'waiting_presentation', 'paused'];
export function activeTask(snapshot: AppSnapshot | null, sessionId?: string): Task | undefined {
  return sessionTasks(snapshot, sessionId).find((task) => ACTIVE_TASK_STATUSES.includes(task.status));
}

export function getDraft(sessionId?: string): InputDraft {
  return sessionId ? (useAiStore.getState().draftsBySession[sessionId] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
}

export const TASK_LABELS: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', waiting_resource: '等待共享编辑资源', waiting_user: '等待你的答复',
  waiting_presentation: '等待展示完成', paused: '已暂停',
  // `waiting_reconcile` is still listed for reading old records; the runtime never assigns it.
  waiting_retry: '等待重试', waiting_reconcile: '正在核对操作结果', completed: '已完成',
};
