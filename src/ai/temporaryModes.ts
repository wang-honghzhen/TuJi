import type { AppSnapshot, Session, TemporaryMode } from './domain';

export const TEMPORARY_IDLE_MS = 60 * 60 * 1000;
export const TEMPORARY_LIMIT = 3;
export const SHARED_NOTE_REMINDER = '本笔记与来源会话共享。不要轻易写入；仅将需要交回来源会话的结论、结果或必要注意事项写入共享笔记。';
export const temporaryMode = (session: Session | undefined): TemporaryMode | undefined =>
  session?.mode === 'temporary' ? session.temporaryContext?.mode ?? 'custom' : undefined;
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
