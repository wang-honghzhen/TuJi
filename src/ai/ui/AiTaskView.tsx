import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, RotateCcw, Square, Wrench } from 'lucide-react';
import { ACTIVE_TASK_STATUSES, useAiStore } from '../client';
import type { ChangeSet, ChatMessage, Interaction, Task, ToolCallRecord } from '../domain';
import { AiError, AiModal, useAction } from './common';
import { webUrl } from '../webAccess';
import { reviewedCallResult, reviewFooter } from '../changeReview';
import { toolDescription } from '../toolDescriptions';
import { AiAttachmentChip } from './AiAttachmentChip';
import { AiTargetRefs } from './AiTargetRefs';

/** Pretty-printed patch bodies are only built while a patch is actually open: rendering every
 *  patch of every committed batch on each streamed token was the heaviest cost in a long chat. */
function PatchDetails({ label, before, after }: { label: string; before: unknown; after: unknown }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary className="ai-muted">{label}</summary>
    {open && <div className="ai-inherit-grid">
      <div><p className="ai-muted">修改前</p><pre className="ai-detail">{JSON.stringify(before, null, 2)}</pre></div>
      <div><p className="ai-muted">修改后</p><pre className="ai-detail">{JSON.stringify(after, null, 2)}</pre></div>
    </div>}
  </details>;
}

export function AiChangeDetails({ change }: { change: ChangeSet }) {
  const current=useAiStore(state=>state.snapshot?.changes.find(c=>c.id===change.id));
  const group=useAiStore(state=>state.snapshot?.canvasReviewStates?.[change.review?.canvasId??'']?.groups?.find(g=>g.id===(current??change).review?.groupId));
  change=current??change;
  const command = useAiStore((state) => state.command);
  const [undo, setUndo] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const action = useAction();
  const status = { proposed: '待执行', committed: '已执行', rejected: '已拒绝', superseded: '已过期', reverted: '已撤销' }[change.status];
  return <div className="ai-card ai-column" data-ai-change-id={change.id} data-ai-change-status={change.status}>
    <div className="ai-row ai-spread"><span className="ai-muted">画布操作 · {status}</span>{change.status === 'committed' && !change.review?.callId && <button className="ai-button" onClick={() => setUndo(true)} data-ai-undo><RotateCcw size={12} />撤销此批操作</button>}</div>
    {change.review?.callId && <div data-ai-review-result>{change.review.policy==='group'
      ? <p>整组{reviewFooter(change)?.state==='reverted'?'已回退':reviewFooter(change)?.state==='approved'?'已保留':'待决策（在画布中选择）'} · 共 {group?.changeSetIds.length??1} 次提交</p>
      : change.review.units.map(unit => <p key={unit.id}>{unit.label} · {unit.state === 'pending' ? '待决策（在画布中选择）' : unit.state === 'reverted' ? '已回退' : unit.source === 'window' ? '窗口到期自动批准' : '已批准'}</p>)}</div>}
    <p className="ai-muted">影响 {change.affectedRefs.length} 项对象 · {change.affectedCanvasIds.length} 个画布</p>
    {change.patches.map((patch, index) => <PatchDetails key={`${patch.collection}:${patch.id}:${index}`}
      label={`${patch.before === null || patch.before === undefined ? '创建' : patch.after === null || patch.after === undefined ? '删除' : '修改'} ${patch.collection} · ${patch.id}`}
      before={patch.before} after={patch.after} />)}
    {!change.patches.length && <details onToggle={event => setCommandsOpen((event.target as HTMLDetailsElement).open)}><summary className="ai-muted">操作请求</summary>{commandsOpen && <pre className="ai-detail">{JSON.stringify(change.commands, null, 2)}</pre>}</details>}
    <AiError text={change.error} />
    {undo && <AiModal title="撤销画布操作" onClose={() => setUndo(false)}><div className="ai-column"><p>将恢复这批操作之前的内容。系统会检查相关对象是否已被后续编辑；发生冲突时会停止撤销。</p><p className="ai-muted">影响对象：{change.affectedRefs.join('、') || '无'}</p><div className="ai-row"><button className="ai-button ai-button-danger" disabled={action.busy} onClick={() => void action.run(async () => { await command('changes.undo', { changeSetId: change.id }); setUndo(false); })}>确认撤销</button><button className="ai-button" onClick={() => setUndo(false)}>取消</button></div><AiError text={action.error} /></div></AiModal>}
  </div>;
}

export function AiInteractionView({ task }: { task: Task }) {
  const interaction = task.interaction;
  return interaction ? <InteractionContent key={`${interaction.id}:${interaction.version}`} task={task} interaction={interaction} /> : null;
}

function InteractionContent({ task, interaction }: { task: Task; interaction: Interaction }) {
  const command = useAiStore((state) => state.command);
  const snapshot = useAiStore((state) => state.snapshot);
  const [answer, setAnswer] = useState('');
  const action = useAction();
  const proposed = snapshot?.changes.find((change) => change.id === interaction.changeSetId);
  const submit = (value: string) => void action.run(async () => {
    await command('interaction.reply', { taskId: task.id, interactionId: interaction.id, version: interaction.version, answer: value });
  });
  if (interaction.kind === 'structure') return <div className="ai-card ai-column" data-ai-interaction="structure">
    <p>此目录调整需要在图文档管理入口处理。继续任务将跳过原来的剪切、复制选择。</p>
    <button className="ai-button" disabled={action.busy} onClick={() => submit('跳过目录调整，继续当前任务')}>继续当前任务</button>
    <AiError text={action.error} />
  </div>;
  return <div className="ai-card ai-column" style={{ borderColor: '#854d0e' }} data-ai-interaction={interaction.kind}>
    <h3>{interaction.kind === 'budget' ? '任务已到达预算上限' : 'AI 需要你的答复'}</h3>
    <p className="ai-pre">{interaction.question}</p>
    {proposed && <AiChangeDetails change={proposed} />}
    {interaction.options.length > 0 && <div className="ai-row">{interaction.options.map((option) => <button key={option} className="ai-button" disabled={action.busy} data-ai-interaction-choice onClick={() => submit(option)}>{option}</button>)}</div>}
    {interaction.kind === 'question' && <div className="ai-column"><textarea className="ai-input" rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="填写你的答复" aria-label="答复 AI 问题" /><button className="ai-button ai-button-primary" disabled={action.busy || !answer.trim()} onClick={() => submit(answer.trim())}><Check size={13} />提交答复</button></div>}
    <p className="ai-muted">此答复绑定当前问题与版本。</p><AiError text={action.error} />
  </div>;
}

export function AiTaskActions({ task, allowRedo = true }: { task: Task; allowRedo?: boolean }) {
  const command = useAiStore((state) => state.command);
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const run = (name: string) => void action.run(async () => { await command(`task.${name}`, { taskId: task.id }); });
  const active = ACTIVE_TASK_STATUSES.includes(task.status);
  return <><div className="ai-task-actions">
    {active && <button className="ai-button" disabled={action.busy} onClick={() => run(task.status==='paused'||task.pauseRequested?'resume':'pause')}><Square size={11} />{task.status==='paused'||task.pauseRequested?'继续':'暂停'}</button>}
    {allowRedo && task.status==='completed' && <button className="ai-button" disabled={action.busy} onClick={() => setConfirm(true)}>重新执行任务</button>}
  </div><AiError text={action.error} />
    {confirm && <AiModal title="重新执行任务" onClose={() => setConfirm(false)}><div className="ai-column"><p>将创建新的执行任务，并基于当前画布重新处理原始请求。原任务已完成的修改仍然保留，新任务可能继续产生修改。</p><div className="ai-row"><button className="ai-button ai-button-primary" disabled={action.busy} onClick={() => void action.run(async () => { await command('task.redo', { taskId: task.id }); setConfirm(false); })}>确认重新执行</button><button className="ai-button" onClick={() => setConfirm(false)}>取消</button></div><AiError text={action.error} /></div></AiModal>}
  </>;
}

export function AiMessageView({ message, canvasId, sessionId, onNavigate, continuation=false }: { message: ChatMessage; canvasId: string; sessionId?: string; onNavigate?: (refs: string[]) => void; continuation?:boolean }) {
  const setTargets = useAiStore((state) => state.setReplyTargetRefs);
  const setView = useAiStore((state) => state.setView);
  const snapshot=useAiStore(s=>s.snapshot);
  const viewer=snapshot?.sessions.find(s=>s.id===sessionId)??snapshot?.sessions.find(s=>s.workspaceId===message.workspaceId);
  const workspace=snapshot?.workspaces.find(w=>w.id===viewer?.workspaceId);
  const available=[...snapshot?.artifacts.filter(a=>a.workspaceId===viewer?.workspaceId)??[],
    ...snapshot?.snapshots.filter(m=>workspace?.snapshotIds.includes(m.id)&&!m.revoked).flatMap(m=>m.artifacts??[])??[]];
  const attachments=message.role==='user'?(message.attachments??message.sourceRefs.filter(r=>r.kind==='artifact'&&r.start===undefined&&r.page===undefined)):[];
  const navigate = () => { setTargets(canvasId, message.targetRefs); setView('canvas'); onNavigate?.(message.targetRefs); };
  return <div className={`ai-message ai-message-${message.role}${continuation?' ai-message-continuation':''}`} data-ai-message-id={message.id} data-ai-message-phase={message.phase} data-ai-message-status={message.status}>
    {(!continuation||message.status!=='complete')&&<div className="ai-message-heading">{!continuation&&<span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '提示'}</span>}{message.status === 'streaming' && <span role="status">正在生成…</span>}{message.status === 'incomplete' && <span>回复未完成</span>}</div>}
    {message.role==='user'&&<AiTargetRefs refs={message.targetRefs} canvasId={canvasId} names={message.targetNames} onLocate={refs=>{setTargets(canvasId,refs);setView('canvas');onNavigate?.(refs);}}/>}
    {!!attachments.length&&<div className="ai-row" data-ai-message-attachments>{attachments.map(ref=>{const artifact=available.find(a=>a.id===ref.id&&a.version===ref.version&&a.status!=='deleted');return artifact&&viewer?<AiAttachmentChip key={`${ref.id}:${ref.version}`} artifact={artifact} sessionId={viewer.id} loadThumbnail={false}/>:<span key={`${ref.id}:${ref.version}`} className="ai-chip">附件不可用</span>;})}</div>}
    {(message.text||!attachments.length)&&<div className="ai-pre">{message.text || (message.status === 'streaming' ? '…' : message.targetRefs.length ? '已定位相关画布内容。' : '（空记录）')}</div>}
    {message.role!=='user'&&message.targetRefs.length > 0 && <button className="ai-message-locate" onClick={navigate}><ArrowUpRight size={13} />定位 {message.targetRefs.length} 项对象</button>}
    {message.sourceRefs.length > 0 && <details style={{ marginTop: 6 }}><summary className="ai-muted">来源（{message.sourceRefs.length}）</summary><div className="ai-column">{message.sourceRefs.map((source, index) => <div key={`${source.kind}:${source.id}:${index}`} className="ai-muted">{source.kind} · {source.id} · v{source.version}{source.page ? ` · 第 ${source.page} 页` : ''}{source.start !== undefined ? ` · 字符 ${source.start}–${source.end ?? ''}` : ''}</div>)}</div></details>}
  </div>;
}

export const toolLabels: Record<string, string> = {
  web_search: '联网搜索', web_fetch: '读取网页', task_finish: '结束回复', br: '换段',
  context_view: '查看摘要状态', context_read_pages: '读取资料分页', context_read_children: '读取摘要子项', context_read_summary_tree: '读取摘要树',
  context_read_task: '读取任务档案', context_read_steps: '读取完整步骤', context_restore_records: '恢复历史原文',
  context_read_task_attachments:'读取任务附件清单', workspace_read_artifact:'读取附件正文', workspace_view_artifact:'查看附件图像', workspace_search_artifacts: '检索附件', workspace_update_work_notes: '更新会话笔记', workspace_update_handoff: '追加任务笔记',
  ui_present: '发送进展', ui_focus: '定位对象', interaction_ask: '询问用户',
  graph_read: '读取图内容', graph_read_directory: '读取画布目录', graph_read_subgraph: '读取子图内容',
  graph_read_node_content: '读取节点正文', graph_read_directory_content: '读取子图说明', graph_read_object_field: '读取对象字段',
  graph_neighbors: '读取邻接关系', graph_search: '检索图内容', graph_search_node_content: '检索节点正文',
  graph_read_node_edges: '读取节点关联边', graph_read_subgraph_edges: '读取子图内部边', graph_read_between_subgraphs: '读取子图之间的边',
  graph_read_design_references: '读取设计引用', graph_propose_changes: '规划图修改', graph_apply_changes: '修改画布',
};
export function AiToolView({ call }: { call: ToolCallRecord }) {
  const snapshot = useAiStore(state => state.snapshot);
  if(call.name==='task_finish')return null;
  call = snapshot ? { ...call, result: reviewedCallResult(snapshot, call) } : call;
  let changeId: string | undefined;
  if (call.name === 'graph_apply_changes') { try { changeId = JSON.parse(call.arguments).changeSetId; } catch { /* Keep malformed requests visible. */ } }
  const change = snapshot?.changes.find(change => change.id === changeId);
  let resultStatus: string | undefined;
  let webMessage: string | undefined;
  const links = new Map<string, string>();
  let capacity: { code?: string; displayedCount?: number; remainingCount?: number; instruction?: string } | undefined;
  try { const result = JSON.parse(call.result ?? '{}'); resultStatus = result.status;
    if (['web_search','web_fetch'].includes(call.name) || ['web_search','web_fetch'].includes(result.coverage?.kind)) {
      webMessage = typeof result.message === 'string' ? result.message : result.bodyOmitted ? '正文已按上下文保留规则移除。' : undefined;
      const addLink = (row: { url?: unknown; title?: unknown }) => {
        const url = webUrl(row.url); if (url) links.set(url, typeof row.title === 'string' && row.title ? row.title : url);
      };
      if (call.name === 'web_fetch') addLink(JSON.parse(call.arguments));
      for (const row of result.data?.webLinks ?? []) if (row && typeof row === 'object') addLink(row);
      for (const row of result.data?.items ?? []) if (row && typeof row === 'object') { if (row.metadata) addLink(row.metadata); addLink(row); }
    }
    if (['CANVAS_CAPACITY', 'OBJECT_TOO_LARGE'].includes(result.code)) capacity = result;
    else if (result.viewAdmission?.status !== 'ok' && result.viewAdmission) capacity = { displayedCount: result.viewAdmission.displayedCount,
      remainingCount: result.viewAdmission.notDisplayedCount, instruction: '图修改已完整提交；部分正文尚未装入AI画布视图。' };
  } catch { /* Keep malformed receipts visible. */ }
  const success = call.status === 'completed' && !['failed', 'unavailable', 'not_found', 'partial', 'blocked', 'error'].includes(resultStatus ?? '');
  return <details className="ai-tool-entry" data-ai-tool-call-id={call.id} data-ai-tool-name={call.name}>
    <summary><Wrench size={13} /><span className="ai-tool-title"><span>{toolLabels[call.name] ?? call.name}</span><span className="ai-tool-description">{toolDescription(call,snapshot)}</span></span><span className="ai-tool-status" data-status={call.status}>{({ prepared: '执行中', waiting: '等待答复', completed: success ? '已完成' : resultStatus === 'partial' ? '部分完成' : '未成功', rejected: '未执行' })[call.status]}</span></summary>
    <div className="ai-tool-detail"><p className="ai-muted">{call.status === 'completed' ? success ? '成功执行' : resultStatus === 'partial' ? '部分执行成功' : resultStatus === 'blocked' ? '未执行' : '执行未成功' : call.status === 'waiting' ? '等待答复' : call.status === 'rejected' ? '执行未成功' : '等待执行结果'}</p>{capacity && <p className="ai-muted">{capacity.displayedCount !== undefined ? `已装入 ${capacity.displayedCount} 个，未装入 ${capacity.remainingCount ?? 0} 个。` : ''}{capacity.instruction}</p>}{webMessage && <p className="ai-muted">{webMessage}</p>}
      {links.size > 0 && <div className="ai-column" data-ai-web-sources>{[...links].map(([url,title]) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" style={{overflowWrap:'anywhere'}}>{title}</a>)}</div>}
      {change && <AiChangeDetails change={change} />}</div>
  </details>;
}

export function AiToolGroup({calls,beforeCall}:{calls:ToolCallRecord[];beforeCall?:(call:ToolCallRecord)=>ReactNode}){
  const visible=calls.filter(c=>c.name!=='task_finish');
  if(!visible.length)return null;
  const active=visible.some(c=>c.status==='prepared'||c.status==='waiting');
  return <section className="ai-tool-group" data-ai-tool-group aria-label="工具调用">
    <div className="ai-tool-group-heading"><Wrench size={13}/><span>工具调用 · {visible.length} 项</span>{active&&<span role="status">执行中…</span>}</div>
    {visible.map(call=><div key={call.id}>{beforeCall?.(call)}<AiToolView call={call}/></div>)}
  </section>;
}

export function AiTurnTime({ task }: { task: Task }) {
  const end = task.finishedAt ?? task.updatedAt;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(task.createdAt)) / 1000));
  const duration = seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
  const stamp = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return <div className="ai-turn-time" data-ai-turn-time={task.id}><time dateTime={task.createdAt}>{stamp(task.createdAt)}</time><span>→</span><time dateTime={end}>{stamp(end)}</time><span>· {task.status === 'completed' ? '用时' : '未完成，用时'} {duration}</span></div>;
}
