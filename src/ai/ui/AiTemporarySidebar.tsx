import { useState } from 'react';
import { useAiStore } from '../client';
import type { Session, TemporaryMode } from '../domain';
import { isDesktopTemporary, isIndependentTemporary, temporaryLabel, temporaryMode, temporaryModeDescriptions } from '../temporaryModes';
import { AiChatPage } from './AiChatPage';
import { AiHistoryPicker } from './AiHistoryPicker';
import { AiError, useAction } from './common';
export { UtilityPanel as AiTemporarySidebar } from '@/desktop/UtilityPanel';

export function TemporaryChat({ session }: { session: Session }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command);
  const enteredId = useAiStore(s => s.enteredSessionByCanvas[session.canvasId]);
  const current = snapshot?.sessions.find(s => s.id === enteredId && s.mode !== 'temporary' && s.lifecycle === 'active');
  const [choosing, setChoosing] = useState(false);
  const action = useAction(), mode = temporaryMode(session) ?? 'minimal';
  const desktop = isDesktopTemporary(session), independent = isIndependentTemporary(session);
  const locked = independent || !!session.temporaryContext?.lockedAt || !!snapshot?.tasks.some(t => t.sessionId === session.id);
  const busySource = snapshot?.tasks.some(t => t.sessionId === current?.id && t.status !== 'completed');
  const workspace = snapshot?.workspaces.find(w => w.id === session.workspaceId);
  const sourceId = session.temporaryContext?.sourceSessionId;
  const sourceTitle = snapshot?.sessions.find(s => s.id === sourceId)?.title ?? '来源会话已不可用';
  const configure = (next: TemporaryMode, ids: string[] = []) => command('temporary.configure', { sessionId: session.id, mode: next,
    sourceSessionId: current?.id, currentSessionId: current?.id, orderedTasks: ids.map(taskId => ({ sessionId: current!.id, taskId })), expectedRevision: session.temporaryContext?.revision ?? 1 });
  return <>
    <AiChatPage sessionId={session.id} canvasId={session.canvasId}
      headingSubtitle={mode !== 'minimal' && <span className="ai-temporary-source" data-ai-memory-source={sourceId}>记忆来源：{sourceTitle}</span>}
      headingActions={independent ? <span className="utility-mode-label" title={temporaryModeDescriptions.minimal}>{desktop ? `极简 · ${temporaryLabel(session)}` : '极简'}</span> :
        <select className="ai-button ai-temporary-select" aria-label="临时会话模式" data-ai-temporary-select value={mode} disabled={action.busy || locked}
          title={temporaryModeDescriptions[mode] + (locked ? ' 已开始对话，模式已锁定。' : '')} onChange={event => {
            const next = event.target.value as TemporaryMode;
            if (next === 'custom') setChoosing(true); else void action.run(() => configure(next));
          }}>
          <option value="minimal">极简</option><option value="branch" disabled={!current || busySource}>分支</option><option value="custom" disabled={!current}>自定义</option>
        </select>} />
    <AiError text={action.error} />
    {choosing && <AiHistoryPicker canvasId={session.canvasId} initialSourceId={current?.id} singleSource allowAdd={!locked && !!current}
      busy={action.busy} error={action.error} initial={sourceId === current?.id ? (workspace?.sessionContext?.taskOrder ?? []).map(taskId => ({ sessionId: sourceId!, taskId })) : []}
      onClose={() => setChoosing(false)} onApply={selection => void action.run(async () => { await configure('custom', selection.map(t => t.taskId)); setChoosing(false); })} />}
  </>;
}
