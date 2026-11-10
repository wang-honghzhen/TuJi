import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, BookOpen, MessageSquarePlus, X } from 'lucide-react';
import { NewChatInput } from '@/new/components/NewChatInput';
import { GraphContextMenu } from '@/new/components/GraphContextMenu';
import { getSession, TASK_LABELS, useAiStore } from '../client';
import { AiSessionTitle } from './AiSessionBar';
import { AiInteractionView, AiMessageView, AiTaskActions, AiToolGroup, AiTurnTime } from './AiTaskView';
import type { ChatMessage, Task, ToolCallRecord } from '../domain';
import { conversationTimeline, conversationTurnLabels, inheritedTimeline } from './conversationTimeline';
import { AiTurnNavigation } from './AiTurnNavigation';
import { useChatScrollPosition } from './useChatScrollPosition';
import { AiWorkspacePanel } from './AiWorkspacePanel';
import { AiError, useAction } from './common';
import { historyTurns, isCompletedHistoryTask } from '../history';
import { sessionProgressRecords } from '../sessionContext';
import { openTemporarySession } from '../temporaryWindows';
import { ReviewAllActions } from './ChangeReviewActions';

/** Committed updates replace only the records they changed, so an untouched row keeps the very
 *  same record object and skips rendering entirely. */
const MemoMessage = memo(function MemoMessage({ message, canvasId, sessionId, onNavigate, continuation }:
  { message: ChatMessage; canvasId: string; sessionId?: string; onNavigate?: (refs: string[]) => void; continuation?:boolean }) {
  return <AiMessageView message={message} canvasId={canvasId} sessionId={sessionId} onNavigate={onNavigate} continuation={continuation} />;
});
const MemoTools = memo(function MemoTools({ calls, beforeCall }: { calls: ToolCallRecord[]; beforeCall?:(call:ToolCallRecord)=>ReactNode }) { return <AiToolGroup calls={calls} beforeCall={beforeCall}/>; });
const MemoTurnTime = memo(function MemoTurnTime({ task }: { task: Task }) { return <AiTurnTime task={task} />; });
const MemoTurnState = memo(function MemoTurnState({ task }: { task: Task }) {
  return <div className="ai-conversation-state" data-ai-turn-state={task.id}>
    {task.interaction ? <AiInteractionView task={task} /> : <p className="ai-muted" role="status">{task.error ?? task.waitReason ?? TASK_LABELS[task.status]}</p>}
    {task.status !== 'running' && <AiTaskActions task={task} allowRedo={false} />}
  </div>;
});

export interface ChatSelection { taskIds: string[]; onChange: (ids: string[]) => void; maxRounds?: number; allowAdd?: boolean }
export function AiChatPage({ canvasId, onNavigate, sessionId, selection, headingExtra, headingActions, headingSubtitle, onHeadingPointerDown, hideHeading = false }: {
  canvasId: string; onNavigate?: (refs: string[]) => void; sessionId?: string; selection?: ChatSelection;
  headingExtra?: ReactNode; headingActions?: ReactNode; headingSubtitle?: ReactNode; onHeadingPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  hideHeading?: boolean;
}) {
  const snapshot = useAiStore((state) => state.snapshot);
  const activeId = useAiStore((state) => state.activeSessionByCanvas[canvasId]);
  const session = sessionId ? snapshot?.sessions.find(s => s.id === sessionId) : getSession(snapshot, canvasId, activeId);
  const error = useAiStore((state) => state.error);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [multiSelecting, setMultiSelecting] = useState(false), [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [progressSelecting,setProgressSelecting]=useState(false),[progressRecords,setProgressRecords]=useState<string[]>([]);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number; taskId?: string }>();
  const selectionAction = useAction(), bookmarkAction = useAction();
  const picking: ChatSelection | undefined = selection ?? (multiSelecting ? { taskIds: selectedIds, onChange: setSelectedIds } : undefined);
  const selectedTasks = new Set(picking?.taskIds ?? []);
  const [following, setFollowing] = useState(!selection);
  const history = useRef<HTMLDivElement>(null);
  const jumping = useRef(false), jumpTimer = useRef<ReturnType<typeof setTimeout>>();
  // A streamed answer re-renders this page with a new snapshot many times per second. The live
  // timeline must follow the growing text, but the earlier, already-finished turns only change
  // when a task reaches a terminal state — so they are rebuilt against that structure only.
  const timeline = snapshot && session ? conversationTimeline(snapshot, session.id) : [];
  const earlierKey = snapshot && session ? `${snapshot.tasks.filter(task => task.sessionId === session.id).map(task => `${task.id}:${task.status}`).join(',')}|${snapshot.messages.length}|${snapshot.events.length}` : '';
  const earlier = useMemo(() => snapshot && session ? historyTurns(snapshot, session.id).filter(turn => !turn.local) : [], [earlierKey, session?.id]);
  const turnOrder = [...new Set(timeline.map(entry => entry.kind === 'message' ? entry.message.taskId : entry.kind === 'tool' ? entry.call.taskId : entry.task.id))].join('|');
  const userPreviews = timeline.flatMap(entry => entry.kind === 'message' && entry.message.role === 'user' ? [`${entry.message.id}:${entry.message.text.slice(0, 240)}`] : []).join('|');
  const turnLabels = useMemo(() => snapshot && session ? conversationTurnLabels(snapshot, session, earlier, timeline) : [],
    [session, snapshot?.tasks, snapshot?.snapshots, snapshot?.chatTurnBookmarks, snapshot?.workspaces.find(w=>w.id===session?.workspaceId)?.sessionContext?.settled?.revision, turnOrder, userPreviews]);
  const hasComposer = !selection && !multiSelecting && !progressSelecting;
  const readingPosition = useChatScrollPosition(history, `${session?.id}:${turnLabels.map(turn => turn.taskId).join('|')}`);
  const previousTurn = turnLabels[turnLabels.findIndex(turn => turn.taskId === readingPosition.taskId) - 1];
  const finishJump = () => { clearTimeout(jumpTimer.current); jumping.current = false; };
  const jumpToTurn = (taskId: string) => {
    const element = history.current;
    const anchor = [...element?.querySelectorAll<HTMLElement>('[data-ai-turn-anchor]') ?? []].find(value => value.dataset.aiTurnAnchor === taskId);
    if (!element || !anchor) return;
    clearTimeout(jumpTimer.current); jumping.current = true; setFollowing(false); setMenuPosition(undefined);
    element.scrollTo({ top: element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 20,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    jumpTimer.current = setTimeout(finishJump, 180);
  };
  useEffect(() => () => clearTimeout(jumpTimer.current), []);
  useEffect(() => { setFollowing(!selection && !multiSelecting); }, [session?.id, !!selection, multiSelecting]);
  useEffect(() => { setMultiSelecting(false); setSelectedIds([]); setProgressSelecting(false); setProgressRecords([]); setMenuPosition(undefined); finishJump(); bookmarkAction.setError(''); }, [session?.id, canvasId]);
  useEffect(() => { if (following && !menuPosition && history.current) history.current.scrollTop = history.current.scrollHeight; }, [snapshot?.lastSeq, following, session?.id, !!menuPosition]);
  const pick = (taskId: string, messages: ChatMessage[]) => {
    if (!picking) return null;
    const complete = messages.filter(m => m.status === 'complete'), ids = complete.map(m => m.id);
    const checked = picking.taskIds.includes(taskId);
    const disabled = !checked && (picking.allowAdd === false || !ids.length || selectedTasks.size >= (picking.maxRounds ?? Infinity)
      || !snapshot || !session || !isCompletedHistoryTask(snapshot, session.id, taskId));
    return <label className="ai-history-pick" data-ai-pick-turn={taskId}><input type="checkbox" checked={checked} disabled={disabled}
      onChange={() => picking.onChange(checked ? picking.taskIds.filter(id => id !== taskId) : [...picking.taskIds, taskId])} />
      选择这一轮{!checked && disabled ? '（当前不可添加）' : ''}</label>;
  };
  const progressOptions=progressSelecting&&snapshot&&session?sessionProgressRecords(snapshot,session.id):[];
  const progressPick=(record:{id:string})=>progressSelecting&&progressOptions.some(r=>r.id===record.id&&r.complete)
    ? <label className="ai-history-pick"><input type="checkbox" checked={progressRecords.includes(record.id)} data-ai-pick-progress={record.id}
      onChange={()=>setProgressRecords(old=>old.includes(record.id)?old.filter(id=>id!==record.id):[...old,record.id])}/>携带此记录及其完整步骤</label>:null;
  const independentProgress=(taskId:string)=>progressSelecting&&progressOptions.filter(r=>r.taskId===taskId&&!['message','tool_call'].includes(r.kind)).map(record=>{
    const content=record.content as Record<string,unknown>;
    return <div key={record.id} className="ai-card ai-pre" data-ai-independent-progress={record.id}>{progressPick(record)}
      {String(content.progress??content.note??JSON.stringify(content))}</div>;
  });
  const renderedTasks = new Set<string>();
  return <section className="ai-chat-page" data-ai-chat-page data-ai-selection-mode={!!picking}
    onContextMenu={event => {
      if ((event.target as Element).closest('input,textarea,select,[contenteditable=true],a,[data-graph-menu]')) return;
      const dialog = (event.target as Element).closest('[role=dialog]');
      if (dialog && event.currentTarget.contains(dialog)) return;
      const target = (event.target as Element).closest<HTMLElement>('[data-ai-turn-id],[data-ai-turn-tick]');
      const taskId = target?.dataset.aiTurnId ?? target?.dataset.aiTurnTick;
      if (!taskId && (selection || session?.mode === 'temporary')) return;
      event.preventDefault(); event.stopPropagation();
      setMenuPosition({ x: event.clientX, y: event.clientY, taskId });
    }}>
    {!hideHeading && <header className="ai-chat-heading" onPointerDown={onHeadingPointerDown}>
      <div className="ai-chat-title-group"><AiSessionTitle title={session?.title ?? '新会话'} />{headingExtra}</div>
      <div className="ai-chat-tools">
      {!selection && session?.mode !== 'temporary' && <><button className="ai-icon-button" title="固定要求与工作笔记" aria-label="工作笔记" disabled={!session} onClick={() => setWorkspaceOpen(true)}><BookOpen size={16} /></button></>}
      {headingActions}</div>{headingSubtitle&&<div className="ai-chat-heading-subtitle">{headingSubtitle}</div>}</header>}
    {!selection && !multiSelecting && session?.mode !== 'temporary' && <ReviewAllActions canvasId={canvasId} surface="chat" />}
    <div className="ai-chat-body" data-has-turns={session?.mode!=='temporary'&&!!turnLabels.length} data-composer={hasComposer}>
    {session?.mode!=='temporary'&&<AiTurnNavigation key={session?.id} turns={turnLabels} active={readingPosition.taskId} onJump={jumpToTurn} />}
    <div ref={history} className="ai-chat-history new-scroll" onWheel={finishJump} onTouchStart={finishJump} onScroll={() => {
      setMenuPosition(undefined); const element = history.current;
      if (jumping.current) { clearTimeout(jumpTimer.current); jumpTimer.current = setTimeout(finishJump, 180); }
      else if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
    }}>
      <div className="ai-conversation" data-ai-conversation>
      <AiError text={error} />
      <AiError text={bookmarkAction.error} />
      {earlier.map(turn => <div className="ai-chat-inherited-turn" key={`history:${turn.key}`} data-ai-turn-id={turn.taskId} data-ai-turn-anchor={turn.taskId}>
        {pick(turn.taskId, turn.messages)}{independentProgress(turn.taskId)}
        <p className="ai-muted" data-ai-history-source={turn.key}>来自会话「{turn.sourceTitle}」· 所选记录，可能存在未选轮次</p>
        {inheritedTimeline(snapshot!, turn).map(entry => entry.kind === 'message'
          ? <div key={entry.key}>{progressPick(entry.message)}<MemoMessage sessionId={session?.id} canvasId={canvasId} message={entry.message} onNavigate={picking || session?.mode === 'temporary' ? undefined : onNavigate} continuation={entry.continuation} /></div>
          : entry.kind === 'tool' ? <MemoTools key={entry.key} calls={entry.calls??[entry.call]} beforeCall={progressSelecting?progressPick:undefined}/> : null)}
        {turn.operations.map(change => <p key={`history-operation:${change.id}`} className="ai-muted" data-ai-history-operation={change.id}>
          画布操作 · {({ committed: '成功执行', reverted: '已撤销', proposed: '仅提议', rejected: '未执行', superseded: '提议已失效' })[change.status]}
          {(() => { const review = snapshot?.changes.find(c => c.id === change.id)?.review; return review?.callId
            ? ` · 待决策 ${review.units.filter(u => u.state === 'pending').length} / 批准 ${review.units.filter(u => u.state === 'approved').length} / 回退 ${review.units.filter(u => u.state === 'reverted').length}` : ''; })()}
        </p>)}
        {turn.notes.map(note => <p key={`history-note:${note.id}:${note.version}`} className="ai-muted ai-pre">历史笔记：{note.text}</p>)}
      </div>)}
      {!session && <p className="ai-muted">请在画布的会话视图中选择一个会话。</p>}
      {session && !timeline.length && !earlier.length && <p className="ai-muted">此会话暂无消息，输入问题开始聊天。</p>}
      {timeline.map(entry => {
        const taskId = entry.kind === 'message' ? entry.message.taskId : entry.kind === 'tool' ? entry.call.taskId : entry.task.id;
        const first = !renderedTasks.has(taskId); renderedTasks.add(taskId);
        return <div className="ai-chat-entry" key={entry.key} data-ai-turn-id={taskId} data-ai-turn-anchor={first ? taskId : undefined}>{first && pick(taskId, snapshot!.messages.filter(m => m.taskId === taskId))}{first&&independentProgress(taskId)}
        {entry.kind==='message'&&progressPick(entry.message)}
        {entry.kind === 'message'
        ? <MemoMessage sessionId={session?.id} message={entry.message} canvasId={canvasId} onNavigate={picking || session?.mode === 'temporary' ? undefined : onNavigate} continuation={entry.continuation} />
        : entry.kind === 'tool' ? <MemoTools key={entry.key} calls={entry.calls??[entry.call]} beforeCall={progressSelecting?progressPick:undefined}/>
        : entry.kind === 'compaction' ? <div className="ai-compaction-status" role="status" data-ai-compaction={entry.status}>{({running:'正在压缩上下文…',completed:'上下文已压缩',failed:'上下文压缩失败，原始记录已保留',cancelled:'上下文压缩已中断',skipped:'上下文整理结束，继续保留原始记录'})[entry.status]}</div>
        : entry.kind === 'time' ? <MemoTurnTime key={entry.key} task={entry.task} />
        : !selection && <MemoTurnState key={entry.key} task={entry.task} />}</div>;
      })}
      </div>
    </div>
    {!readingPosition.atLatest && previousTurn && <button type="button" className="ai-chat-scroll-button ai-chat-previous" data-ai-scroll-previous
      aria-label="跳到上一轮对话" title="上一轮对话" onClick={() => jumpToTurn(previousTurn.taskId)}><ArrowUp size={18} aria-hidden="true" /></button>}
    {!readingPosition.atLatest && hasComposer && <button type="button" className="ai-chat-scroll-button ai-chat-latest" data-ai-scroll-latest
      aria-label="跳到最新消息" title="回到最新消息" onClick={() => { finishJump(); setFollowing(true); if (history.current) history.current.scrollTop = history.current.scrollHeight; }}><ArrowDown size={18} aria-hidden="true" /></button>}
    </div>
    {multiSelecting && <div className="ai-chat-selection-toolbar" data-ai-chat-selection-toolbar>
      <span>已选 {selectedTasks.size} 轮</span>
      <button className="ai-button ai-button-primary" data-ai-create-temporary-from-selection disabled={!selectedIds.length || selectionAction.busy}
        onClick={() => void selectionAction.run(async () => {
          await openTemporarySession(canvasId, { sourceSessionId: session!.id, taskIds: selectedIds });
          setMultiSelecting(false); setSelectedIds([]);
        })}><MessageSquarePlus size={15} />以此创建临时会话</button>
      <button className="ai-icon-button" aria-label="取消多选" onClick={() => { setMultiSelecting(false); setSelectedIds([]); }}><X size={16} /></button>
      <AiError text={selectionAction.error} />
    </div>}
    {progressSelecting && <div className="ai-chat-selection-toolbar" data-ai-progress-selection-toolbar>
      <span>已选 {progressRecords.length} 条记录</span>
      <button className="ai-button ai-button-primary" disabled={!progressRecords.length} onClick={()=>{
        if(!snapshot||!session)return;
        const chosen=progressOptions.filter(record=>progressRecords.includes(record.id));
        const taskIds=[...new Set(chosen.map(r=>r.taskId))];
        useAiStore.getState().setDraft(session.id,{progressSelection:taskIds.map(taskId=>({taskId,recordIds:chosen.filter(r=>r.taskId===taskId).map(r=>r.id)}))});
        setProgressSelecting(false);setProgressRecords([]);
      }}>随下一条消息携带</button>
      <button className="ai-button" onClick={()=>{setProgressSelecting(false);setProgressRecords([]);}}>取消</button>
    </div>}
    {hasComposer && <div className="ai-chat-composer"><NewChatInput canvasId={canvasId} sessionId={sessionId} /></div>}
    {session && workspaceOpen && <AiWorkspacePanel session={session} onClose={() => setWorkspaceOpen(false)} />}
    {menuPosition && <GraphContextMenu position={menuPosition} onClose={() => setMenuPosition(undefined)}
      items={[
        ...(!selection && session?.temporaryContext?.mode!=='minimal' ? [{key:'selectProgress',label:progressSelecting?'取消选择任务片段':'选择任务片段随消息携带',disabled:!session,
          run:()=>{setProgressSelecting(value=>!value);setProgressRecords([]);setMultiSelecting(false);setSelectedIds([]);}}]:[]),
        ...(menuPosition.taskId ? [{ key: 'bookmarkChatTurn', label: turnLabels.find(turn => turn.taskId === menuPosition.taskId)?.starred ? '取消标注' : '标注', disabled: !session || bookmarkAction.busy,
          run: () => { const taskId = menuPosition.taskId!; void bookmarkAction.run(async () => {
            await useAiStore.getState().command('chat.bookmark', { sessionId: session!.id, taskId, starred: !turnLabels.find(turn => turn.taskId === taskId)?.starred }, { reportError: false });
          }); } }] : []),
        ...(!selection && session?.mode !== 'temporary' ? [{ key: 'selectChatHistory', label: multiSelecting ? '取消选择聊天记录' : '选择聊天记录', disabled: !session || selectionAction.busy,
          run: () => { setMultiSelecting(value => !value); setSelectedIds([]); selectionAction.setError(''); } }] : [])
      ]} />}
  </section>;
}
