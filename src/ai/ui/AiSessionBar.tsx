import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { GitBranch } from 'lucide-react';
import { getSession, useAiStore } from '../client';
import type { OrderedTaskSelection, Session } from '../domain';
import { SESSION_TITLE_LIMIT } from '../domain';
import { AiError, AiModal, useAction } from './common';
import { AiHistoryPicker } from './AiHistoryPicker';

interface Preview { contentHash: string; artifacts: unknown[]; residentTaskIds: string[]; excludedTaskIds: string[];
  historicalSummaryCounts: Record<string,number>; promptReuse:{eligible:boolean;reused:boolean;fingerprint?:string} }
export function AiCreateSessionDialog({ canvasId, onClose, initialParentId, onCreated }: {
  canvasId: string; onClose: () => void; initialParentId?: string; onCreated?: (sessionId: string) => void;
}) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command), setActive = useAiStore(s => s.setActiveSession);
  const [title, setTitle] = useState('');
  const [selections, setSelections] = useState<OrderedTaskSelection[]>([]);
  const [choosing, setChoosing] = useState(!!initialParentId);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const action = useAction();
  const parents = snapshot?.sessions.filter(s => s.canvasId === canvasId && s.mode !== 'temporary' && s.lifecycle !== 'deleted') ?? [];
  const isRoot = !parents.length, key = JSON.stringify(selections);
  useEffect(() => {
    let live = true; setPreview(undefined); setError('');
    if (selections.length) void command<Preview>('inheritance.preview', { canvasId, orderedTasks: selections })
      .then(value => { if (live) setPreview(value); }).catch(cause => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [key, canvasId, retry, command]);
  if (choosing) return <AiHistoryPicker canvasId={canvasId} initial={selections}
    initialSourceId={selections.length ? undefined : initialParentId}
    onApply={chosen => { setSelections(chosen); setChoosing(false); }} onClose={() => setChoosing(false)} />;
  return <AiModal title={isRoot ? '创建根会话' : '创建子会话'} onClose={onClose}>
    <div className="ai-column">
      <label className="ai-label">会话名称（最多 {SESSION_TITLE_LIMIT} 字）
        <input className="ai-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={SESSION_TITLE_LIMIT}
          placeholder="留空则由第一条消息命名" data-ai-session-title /></label>
      {!isRoot && <>
        <button className="ai-button" onClick={() => setChoosing(true)}>选择聊天记录</button>
        {selections.map((selection,index) => <div className="ai-row ai-spread" key={selection.taskId}>
          <span>{index+1}. {parents.find(s => s.id === selection.sessionId)?.title} · 任务
            {preview && ` · ${preview.residentTaskIds.includes(selection.taskId)?'进入上下文':'仅保留档案'} · 已用历史摘要 ${preview.historicalSummaryCounts[selection.taskId]??0}/2 次`}</span>
          <button className="ai-button" onClick={() => setSelections(old => old.filter(s => s.taskId !== selection.taskId))}>移除</button>
        </div>)}
        <p className="ai-muted">{preview ? `将保存 ${selections.length} 个任务档案；初始上下文携带 ${preview.residentTaskIds.length} 个任务，${preview.excludedTaskIds.length} 个因容量退出。所选任务关联 ${preview.artifacts.length} 个附件。` : selections.length ? '正在校验所选内容…' : '请选择来源会话。'}
          {preview?.promptReuse?.eligible?'所选任务和顺序与来源上下文完全相同，将复用提示词快照。':'按列表顺序装配任务，未选任务不会补入。'}创建后保留独立快照。{new Set(selections.map(s=>s.sessionId)).size===1?'单来源子会话复制 AI 笔记和固定要求，之后独立维护。':'多来源子会话不携带 AI 笔记和固定要求。'}</p>
      </>}
      <AiError text={error || action.error} />
      {(error || action.error) && selections.length > 0 && <button className="ai-button" disabled={action.busy} onClick={() => { setPreview(undefined); action.setError(''); setRetry(n => n + 1); }}>重新预览</button>}
      <div className="ai-row"><button className="ai-button" onClick={onClose}>取消</button>
        <button className="ai-button ai-button-primary" data-ai-create-child-confirm={!isRoot || undefined} data-ai-create-root-confirm={isRoot || undefined}
          disabled={action.busy || !snapshot || !isRoot && (!selections.length || !preview || !!error)}
          onClick={() => void action.run(async () => {
            const session = await command<Session>('session.create', { canvasId, title: title.trim(), orderedTasks: selections,
              ...(preview ? { expectedPreviewHash: preview.contentHash, ...(preview.promptReuse?.eligible?{expectedForkFingerprint:preview.promptReuse.fingerprint}:{}) } : {}) });
            if (onCreated) onCreated(session.id); else setActive(canvasId, session.id); onClose();
          })}>{action.busy ? '正在创建…' : isRoot ? '创建根会话' : '创建子会话'}</button></div>
    </div>
  </AiModal>;
}

export function AiSessionTitle({ title }: { title: string }) {
  const label = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useEffect(() => {
    const element = label.current; if (!element) return;
    const measure = () => setOverflow(Math.max(0, element.firstElementChild!.scrollWidth - element.clientWidth));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [title]);
  return <span ref={label} className="ai-session-title" data-ai-title-overflow={overflow > 0} style={{ '--ai-title-shift': `${-overflow}px`, '--ai-title-duration': `${Math.max(3, overflow / 28)}s` } as CSSProperties}>
    <span>{title}</span>
  </span>;
}

export function AiSessionBar({ canvasId }: { canvasId: string }) {
  const snapshot = useAiStore(state => state.snapshot);
  const activeId = useAiStore(state => state.activeSessionByCanvas[canvasId]);
  const session = getSession(snapshot, canvasId, activeId);
  return <div className="ai-session-bar" data-ai-session-bar><AiSessionTitle title={session?.title ?? '未选择会话'} /></div>;
}

export function AiCreateChildButton({ canvasId }: { canvasId: string }) {
  const snapshot = useAiStore(state => state.snapshot);
  const activeId = useAiStore(state => state.activeSessionByCanvas[canvasId]);
  const session = getSession(snapshot, canvasId, activeId);
  const [create, setCreate] = useState(false);
  return <>
    {session && session.mode !== 'temporary' && session.lifecycle === 'active' && <button type="button" className="ai-icon-button" title="创建子会话" aria-label="创建子会话" data-ai-create-child onClick={() => setCreate(true)}><GitBranch size={15} /></button>}
    {create && session && <AiCreateSessionDialog key={session.id} canvasId={canvasId} initialParentId={session.id} onClose={() => setCreate(false)} />}
  </>;
}
