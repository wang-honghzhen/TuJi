import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { GitBranch } from 'lucide-react';
import { getSession, useAiStore } from '../client';
import type { OrderedTaskSelection, Session } from '../domain';
import { SESSION_TITLE_LIMIT } from '../domain';
import { AiError, AiModal, useAction } from './common';
import { AiHistoryPicker } from './AiHistoryPicker';
import { historyTurns } from '../history';

interface Preview { contentHash: string; artifacts: unknown[]; residentTaskIds: string[]; excludedTaskIds: string[];
  historicalSummaryCounts: Record<string,number>; promptReuse:{eligible:boolean;reused:boolean;fingerprint?:string} }
export function AiCreateSessionDialog({ canvasId, onClose, initialParentId, onCreated }: {
  canvasId: string; onClose: () => void; initialParentId?: string; onCreated?: (sessionId: string) => void;
}) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command), setActive = useAiStore(s => s.setActiveSession);
  const [title, setTitle] = useState('');
  const [selections, setSelections] = useState<OrderedTaskSelection[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const action = useAction();
  const parents = snapshot?.sessions.filter(s => s.canvasId === canvasId && s.mode !== 'temporary' && s.lifecycle !== 'deleted') ?? [];
  const parent = parents.find(session => session.id === initialParentId);
  const isRoot = !initialParentId && !parents.length, key = JSON.stringify(selections);
  const tooLong = Array.from(title.trim()).length > SESSION_TITLE_LIMIT;
  const unavailableParent = !!initialParentId && !!snapshot && !parent;
  const canCreate = !!snapshot && !action.busy && !tooLong && !unavailableParent && (!selections.length || (!!preview && !error));
  const sourceIds = useMemo(() => [...new Set(selections.map(item => item.sessionId))], [selections]);
  const taskTitles = useMemo(() => {
    const titles = new Map<string, string>();
    const sources = new Map(selections.map(item => [item.taskId, item.sessionId]));
    if (snapshot) for (const sessionId of sourceIds) {
      for (const turn of historyTurns(snapshot, sessionId)) {
        if (sources.get(turn.taskId) !== sessionId) continue;
        const message = turn.messages.find(m => m.id === turn.rootMessageId);
        if (message) titles.set(turn.taskId, message.text);
      }
    }
    return titles;
  }, [snapshot, sourceIds, selections]);
  const changeSelection = (selected: OrderedTaskSelection[]) => {
    if (JSON.stringify(selected) !== key) { setPreview(undefined); setError(''); action.setError(''); setSelections(selected); }
    setChoosing(false);
  };
  useEffect(() => {
    let live = true; setPreview(undefined); setError('');
    if (selections.length) void command<Preview>('inheritance.preview', { canvasId, parentSessionId: initialParentId, orderedTasks: selections })
      .then(value => { if (live) setPreview(value); }).catch(cause => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [key, canvasId, initialParentId, retry, command]);
  if (choosing) return <AiHistoryPicker canvasId={canvasId} initial={selections}
    initialSourceId={selections.length ? undefined : initialParentId}
    onApply={changeSelection} onClose={() => setChoosing(false)} />;
  const createLabel = isRoot ? '创建根会话' : '创建子会话';
  return <AiModal className="ai-session-create" title={createLabel} onClose={onClose} dismissible={!action.busy}
    footer={<><button type="button" className="ai-button" onClick={onClose} disabled={action.busy}>取消</button>
      <button type="submit" form="session-create-form" className="ai-button ai-button-primary" disabled={!canCreate}
        data-ai-create-child-confirm={!isRoot || undefined} data-ai-create-root-confirm={isRoot || undefined}>{action.busy ? '正在创建…' : createLabel}</button></>}>
    <form id="session-create-form" className="ai-session-create-form" onSubmit={event => {
      event.preventDefault();
      if (canCreate) void action.run(async () => {
        const session = await command<Session>('session.create', { canvasId, title: title.trim(), parentSessionId: initialParentId, orderedTasks: selections,
          ...(selections.length && preview ? { expectedPreviewHash: preview.contentHash, ...(preview.promptReuse?.eligible ? { expectedForkFingerprint: preview.promptReuse.fingerprint } : {}) } : {}) });
        if (onCreated) onCreated(session.id); else setActive(canvasId, session.id); onClose();
      });
    }}>
      {parent && <p className="ai-session-parent"><GitBranch size={15} aria-hidden="true" />父会话 <strong>{parent.title}</strong></p>}
      <label className="ai-label"><span className="ai-session-name-label">会话名称 <small>{Array.from(title.trim()).length} / {SESSION_TITLE_LIMIT}</small></span>
        <input className="ai-input" value={title} onChange={e => setTitle(e.target.value)} disabled={action.busy}
          placeholder="留空时使用第一条消息命名" data-ai-session-title /></label>
      {!isRoot && <section className="ai-session-memory">
        <div className="ai-session-memory-header"><div><h3>继承聊天记录</h3>
          <p className="ai-muted">{selections.length ? `已选择 ${selections.length} 个任务` : '可选。留空即可从新的上下文开始。'}</p></div>
          <button type="button" className="ai-button" data-ai-choose-history disabled={action.busy} onClick={() => setChoosing(true)}>
            {selections.length ? '调整选择' : '选择记录'}</button></div>
        {!!selections.length && <ol>{selections.map(selection => {
          const text = taskTitles.get(selection.taskId) ?? '任务';
          return <li key={selection.taskId}><div><strong>{text}</strong><small>{parents.find(s => s.id === selection.sessionId)?.title}
            {preview && ` · ${preview.residentTaskIds.includes(selection.taskId) ? '进入上下文' : '仅保留档案'} · 已用历史摘要 ${preview.historicalSummaryCounts[selection.taskId] ?? 0}/2 次`}</small></div>
            <button type="button" className="ai-button" disabled={action.busy} onClick={() => changeSelection(selections.filter(s => s.taskId !== selection.taskId))}>移除</button></li>;
        })}</ol>}
        {!!selections.length && <p className="ai-muted" role="status">{preview
          ? `${preview.residentTaskIds.length} 个任务进入初始上下文，${preview.excludedTaskIds.length} 个仅保留档案，关联 ${preview.artifacts.length} 个附件。${sourceIds.length === 1 ? '同时复制来源会话的 AI 笔记和固定要求。' : '笔记和固定要求将从空白开始。'}${preview.promptReuse.eligible ? '将复用来源提示词快照。' : ''}`
          : error ? '' : '正在校验所选内容…'}</p>}
      </section>}
      <AiError text={unavailableParent ? '父会话已不可用，请重新选择。' : tooLong ? `会话名称最多 ${SESSION_TITLE_LIMIT} 个字符` : error || action.error} />
      {(error || action.error) && selections.length > 0 && <button type="button" className="ai-button" disabled={action.busy} onClick={() => { setPreview(undefined); action.setError(''); setRetry(n => n + 1); }}>重新预览</button>}
    </form>
  </AiModal>;
}

export function AiRenameSessionDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const command = useAiStore(state => state.command);
  const [title, setTitle] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  const name = title.trim();
  const tooLong = Array.from(name).length > SESSION_TITLE_LIMIT;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <AiModal title="重命名会话" onClose={onClose} dismissible={!action.busy}>
    <form className="ai-column" onSubmit={event => {
      event.preventDefault();
      if (!name || tooLong || name === session.title) return;
      void action.run(async () => {
        await command('session.update', { sessionId: session.id, title: name });
        onClose();
      });
    }}>
      <label className="ai-label">会话名称（最多 {SESSION_TITLE_LIMIT} 字）
        <input ref={input} className="ai-input" data-ai-rename-session-title value={title} disabled={action.busy}
          onChange={event => { setTitle(event.target.value); action.setError(''); }} /></label>
      <AiError text={tooLong ? `会话名称最多 ${SESSION_TITLE_LIMIT} 个字符` : action.error} />
      <div className="ai-row"><button type="button" className="ai-button" disabled={action.busy} onClick={onClose}>取消</button>
        <button type="submit" className="ai-button ai-button-primary" data-ai-rename-session-confirm
          disabled={action.busy || !name || tooLong || name === session.title}>{action.busy ? '正在保存…' : '保存'}</button></div>
    </form>
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
