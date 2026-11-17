import type { AppSnapshot, Session, TemporaryMode } from './domain';

export const TEMPORARY_IDLE_MS = 60 * 60 * 1000;
export const TEMPORARY_LIMIT = 3;
// A namespace, never a user-visible canvas. Desktop chats survive canvas changes.
export const DESKTOP_TEMPORARY_CANVAS = 'desktop:temporary';
export const GLOBAL_TEMPORARY_CANVAS = 'global:temporary';
export const isDesktopTemporary = (session: Session | undefined) =>
  session?.mode === 'temporary' && session.temporaryContext?.scope === 'desktop';
export const isGlobalTemporary = (session: Session | undefined) =>
  session?.mode === 'temporary' && session.temporaryContext?.scope === 'global';
export const isIndependentTemporary = (session: Session | undefined) => isDesktopTemporary(session) || isGlobalTemporary(session);
export const SHARED_NOTE_REMINDER = '本笔记与来源会话共享。不要轻易写入；仅将需要交回来源会话的结论、结果或必要注意事项写入共享笔记。';
export const temporaryMode = (session: Session | undefined): TemporaryMode | undefined =>
  session?.mode === 'temporary' ? session.temporaryContext?.mode ?? 'custom' : undefined;
export type TemporaryLabelType = TemporaryMode | 'desktop';
export const temporaryLabelType = (session: Session): TemporaryLabelType => isDesktopTemporary(session) ? 'desktop' : temporaryMode(session) ?? 'custom';
export const temporaryNumber = (session: Session) => session.temporaryContext?.number ?? session.temporaryContext?.desktopNumber;
const temporaryPrefixes: Record<TemporaryLabelType, string> = { minimal: '极简', branch: '分支', custom: '自定义', desktop: '悬浮窗' };
export const temporaryLabel = (session: Session) => temporaryPrefixes[temporaryLabelType(session)] + (temporaryNumber(session) ?? '');

/** Allocate against every surviving session, including other canvases and hidden tabs. */
export function nextTemporaryNumber(sessions: Session[], type: TemporaryLabelType, excludingId?: string): number {
  const used = new Set(sessions.filter(session => session.id !== excludingId && session.mode === 'temporary'
    && session.lifecycle !== 'deleted' && temporaryLabelType(session) === type).map(temporaryNumber));
  let number = 1; while (used.has(number)) number++;
  return number;
}

/** Preserve valid persisted identities before filling legacy gaps, once per service startup. */
export function normalizeTemporaryNumbers(sessions: Session[]): boolean {
  const active = sessions.filter(session => session.mode === 'temporary' && session.lifecycle !== 'deleted')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Map<TemporaryLabelType, Set<number>>(), missing: Session[] = [];
  let changed = false;
  for (const session of active) {
    const type = temporaryLabelType(session), number = temporaryNumber(session);
    const occupied = used.get(type) ?? new Set<number>(); used.set(type, occupied);
    if (number === undefined || !Number.isSafeInteger(number) || number < 1 || occupied.has(number)) { missing.push(session); continue; }
    occupied.add(number);
    if (session.temporaryContext?.number !== number) { session.temporaryContext!.number = number; changed = true; }
  }
  for (const session of missing) {
    const occupied = used.get(temporaryLabelType(session))!;
    let number = 1; while (occupied.has(number)) number++;
    occupied.add(number);
    session.temporaryContext ??= { revision: 1, mode: 'custom' };
    session.temporaryContext.number = number;
    changed = true;
  }
  return changed;
}
export const isMinimalSession = (session: Session | undefined) => temporaryMode(session) === 'minimal';
export const hasUnfinishedTask = (state: AppSnapshot, sessionId: string) => state.tasks.some(t => t.sessionId === sessionId && t.status !== 'completed');
export function touchTemporary(session: Session, at = Date.now()) {
  if (session.mode !== 'temporary') return;
  session.temporaryContext ??= { revision: 1, mode: 'custom' };
  session.temporaryContext.lastActiveAt = new Date(at).toISOString();
  session.temporaryContext.expiresAt = new Date(at + TEMPORARY_IDLE_MS).toISOString();
}
export const temporaryModeDescriptions: Record<TemporaryMode, string> = {
  minimal: '普通问答，仅支持上传图片；启用联网配置时可搜索网页。不携带画布、笔记或其他会话记忆。记忆中每满十次对话进行压缩，压缩后携带最近五轮对话，完整聊天记录仍可回看。',
  branch: '继承主会话当前携带的任务与提示词快照，可修改画布，共享 AI 笔记和固定要求。来源任务结束后可启用。',
  custom: '按所选顺序继承主会话的已完成任务，可修改画布，共享 AI 笔记和固定要求；选择与当前上下文完全相同时复用提示词快照。',
};
