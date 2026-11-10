import { attachmentLimits, attachmentBatchError } from '@/ai/attachments';
import { isMinimalSession } from '@/ai/temporaryModes';
import { AiAttachmentChip } from '@/ai/ui/AiAttachmentChip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Paperclip, BookOpen, Square, Play, X } from 'lucide-react';
import { presentationOwner, taskParts, usePlaybackStore } from '@/ai/presentationClient';
import { activeTask, getDraft, getSession, sessionTasks, useAiStore } from '@/ai/client';
import { DEEPSEEK_MODELS, type Artifact, type SendInput, type Session, type Task } from '@/ai/domain';
import { AiWorkspacePanel } from '@/ai/ui/AiWorkspacePanel';
import { AiCreateChildButton, AiSessionBar } from '@/ai/ui/AiSessionBar';
import { AiArtifactJobs } from '@/ai/ui/AiArtifactJobs';
import { AiModelPicker } from '@/ai/ui/AiModelPicker';
import { AiError, fileToBase64, useAction } from '@/ai/ui/common';
import { AiInteractionView } from '@/ai/ui/AiTaskView';
import { AiTargetRefs } from '@/ai/ui/AiTargetRefs';
import { canvasMemberIds } from '@/ai/canvasScope';
import { flushCanvasEdits } from '../canvasEditFlush';

export function NewChatInput({ canvasId = 'qixue-draft-canvas', sessionId }: { canvasId?: string; sessionId?: string }) {
  const snapshot = useAiStore((state) => state.snapshot);
  const activeId = useAiStore((state) => state.activeSessionByCanvas[canvasId]);
  const session = sessionId ? snapshot?.sessions.find(s => s.id === sessionId) : getSession(snapshot, canvasId, activeId);
  const temporary = session?.mode === 'temporary';
  const minimal = isMinimalSession(session);
  const draftId = session?.id ?? `canvas:${canvasId}`;
  const draftState = useAiStore((state) => state.draftsBySession[draftId]);
  const selection = useAiStore((state) => state.inputRefsByCanvas[canvasId]);
  const removeInputRef = useAiStore((state) => state.removeInputRef);
  const selected=useMemo(()=>{const members=snapshot?.graph?canvasMemberIds(snapshot.graph,canvasId):new Set<string>();
    return minimal?[]:(selection??[]).filter(ref=>members.has(ref));},[selection,snapshot?.graph,canvasId,minimal]);
  const command = useAiStore((state) => state.command);
  const setDraft = useAiStore((state) => state.setDraft);
  const connection = useAiStore((state) => state.connection);
  const serviceError = useAiStore((state) => state.error);
  const view = useAiStore((state) => state.view);
  const draft = draftState ?? getDraft(draftId);
  const modelSelection = draft.modelSelection && [snapshot?.provider.model, ...(snapshot?.provider.apiFamily === 'deepseek' ? DEEPSEEK_MODELS.map(model => model.id) : [])].includes(draft.modelSelection.model)
    ? draft.modelSelection : { model: snapshot?.provider.model ?? '', thinkingEffort: snapshot?.provider.thinkingEffort ?? 'high' as const };
  const task = activeTask(snapshot, session?.id);
  const playback=usePlaybackStore(s=>s.byCanvas[canvasId]);
  const controlTask=task;
  const isPaused=Boolean(task?.pauseRequested||task?.status==='paused');
  const hasContent=Boolean(draft.text.trim()||draft.artifactIds.length);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<'files'>();
  const menuHost = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const action = useAction();
  // Attaching a file stays busy until parsing finishes, so it gets its own state: sending waits for
  // it, but the user can keep typing the message meanwhile.
  const uploadAction = useAction();
  const artifacts = (snapshot?.artifacts ?? []).filter((artifact) => draft.artifactIds.includes(artifact.id));
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (event.target !== input.current && document.activeElement === input.current) input.current?.blur();
      if (!menuHost.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => { setMenu(undefined); }, [canvasId, session?.id]);

  async function ensureSession(): Promise<Session> {
    if (session) return session;
    throw new Error(sessionId ? '临时会话已关闭。' : '请先在会话视图中选择会话。');
  }

  const send = (intent?: SendInput['intent'], target?: Task) => void action.run(async () => {
    if (!hasContent) return;
    if (session?.lifecycle === 'archived') throw new Error('此会话已归档，仅可查看历史。');
    const currentSession = await ensureSession();
    await flushCanvasEdits(canvasId);
    if (!temporary) useAiStore.getState().setActiveSession(canvasId, currentSession.id);
    const clientMessageId = draft.pendingMessageId ?? crypto.randomUUID();
    setDraft(currentSession.id, { pendingMessageId: clientMessageId });
    const targetTask = target ?? task;
    const sendIntent = intent ?? (targetTask?'amend':'new');
    const result = await command<Task>('input.send', { sessionId: currentSession.id, text: draft.text.trim(), clientMessageId,
      intent: sendIntent, ...(targetTask && sendIntent === 'amend' ? { targetTaskId: targetTask.id } : {}),
      targetIds: [...selected], artifactIds: draft.artifactIds, modelSelection, progressSelection:draft.progressSelection,
      ...(!temporary && useAiStore.getState().view==='canvas'?{presentationOwner,
        ...(playback?.taskId&&playback.cursor>=0?{viewedPart:{taskId:playback.taskId,part:playback.cursor,
          version:snapshot?.presentationParts?.find(p=>p.taskId===playback.taskId&&p.seq===playback.cursor)?.version}}:{})}:{}) } satisfies SendInput);
    setDraft(currentSession.id, { text: '', pendingMessageId: undefined, artifactIds: [], progressSelection:[] });
    if (!temporary) usePlaybackStore.getState().set(canvasId, { taskId: result.id,
      cursor: result.presentation?.cursor ?? (result.id === playback?.taskId ? taskParts(useAiStore.getState().snapshot, result.id).at(-1)?.seq ?? 1 : 1),
      mode: 'follow', cameraFollow: true, followRequest: (usePlaybackStore.getState().byCanvas[canvasId]?.followRequest ?? 0) + 1 });
    setNotice(targetTask?.id===result.id?'已补充当前任务。':'消息已发送。');
  });

  const upload = (files: File[]) => void uploadAction.run(async () => {
    const currentSession = await ensureSession();
    const existing=getDraft(currentSession.id).artifactIds.map(id=>useAiStore.getState().snapshot?.artifacts.find(a=>a.id===id)).filter((a):a is Artifact=>!!a);
    const problem=attachmentBatchError([...existing,...files],attachmentLimits(snapshot??undefined),currentSession);
    if(problem)throw new Error(problem);
    for (const selectedFile of files) {
      const artifact = await command<Artifact>('artifact.upload', { sessionId: currentSession.id, name: selectedFile.name,
        mimeType: selectedFile.type || 'application/octet-stream', dataBase64: await fileToBase64(selectedFile) });
      if(artifact.status==='failed'&&artifact.visualState!=='available')throw new Error(artifact.error??'附件解析失败');
      const current = getDraft(currentSession.id);
      setDraft(currentSession.id, { artifactIds: [...new Set([...current.artifactIds, artifact.id])] });
    }
    setNotice('附件已加入本次消息。');
  });

  const sessionUnavailable = !session || action.busy || uploadAction.busy || !snapshot || connection === 'disconnected';
  const unavailable = sessionUnavailable || session?.lifecycle === 'archived';
  const mainAction=()=>{if(composing)return;if(hasContent){send();return;}if(controlTask)void action.run(async()=>{await command(isPaused?'task.resume':'task.pause',{taskId:controlTask.id});});};
  const mainLabel=hasContent?(task?'补充当前任务':'发送消息'):controlTask?(isPaused?'继续任务':'暂停任务'):'发送消息';
  const replyError = view === 'canvas' ? sessionTasks(snapshot, session?.id).at(-1)?.error || serviceError : undefined;
  return <div className="ai-composer" data-ai-composer data-ai-session-id={session?.id} data-session-unselected={!session||undefined}
    onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
    onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();if(!unavailable)upload(Array.from(event.dataTransfer.files));}}>
    <fieldset disabled={!session} aria-disabled={!session} className="ai-composer-box canvas-composer-surface">
    {!temporary && view === 'canvas' && task?.interaction && <div className="canvas-composer-interaction"><AiInteractionView task={task} /></div>}
    {snapshot && !snapshot.credentialConfigured && <p className="px-4 pt-2 ai-muted">API Key 尚未配置，请在左侧边栏的设置中填写。</p>}
    {session?.lifecycle === 'archived' && <p className="px-4 pt-2 ai-muted">此会话已归档，当前仅可查看历史。</p>}
    {uploadAction.busy && <p className="px-4 pt-2 ai-muted">正在解析附件，解析完成后即可发送（可以先继续输入）。</p>}
    {session&&selected.length>0&&<div className="ai-composer-targets"><AiTargetRefs refs={selected} canvasId={canvasId} pending
      removeDisabled={unavailable} onRemove={ref=>{removeInputRef(canvasId,ref);setDraft(draftId,{pendingMessageId:undefined});}}/></div>}
    <textarea ref={input} rows={2} value={session?draft.text:''} disabled={!session || action.busy || session?.lifecycle === 'archived'}
      onChange={(event) => setDraft(draftId, { text: event.target.value, pendingMessageId: undefined })}
      onPaste={event=>{const files=Array.from(event.clipboardData.files).filter(f=>f.type.startsWith('image/'));if(files.length){event.preventDefault();if(!unavailable)upload(files);}}}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); if (!unavailable && hasContent) send(); } }}
      placeholder={!session?'请先在会话视图中选择会话…':task ? '补充要求或询问进展，将继续当前任务…' : session?.mode === 'temporary' ? '输入临时问题…' : '输入问题，或描述需要梳理的知识…'}
      className="w-full resize-none bg-transparent px-4 pt-2.5 pb-1.5 text-[14px] leading-6 text-slate-200 placeholder:text-slate-500 outline-none new-scroll max-h-48" aria-label="消息" data-ai-input />
    {!minimal && draft.text.length > 20000 && <div className="ai-row px-4 pb-2"><span className="ai-muted">长文本可作为文档按需读取，再输入处理要求。</span><button className="ai-button" disabled={uploadAction.busy} data-ai-paste-as-document onClick={() => void uploadAction.run(async () => {
      const currentSession = await ensureSession();
      const problem=attachmentBatchError([...artifacts,{size:new Blob([draft.text]).size}],attachmentLimits(snapshot??undefined),currentSession);if(problem)throw new Error(problem);
      const artifact = await command<Artifact>('artifact.upload', { sessionId: currentSession.id, name: `粘贴文档-${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.txt`, mimeType: 'text/plain', dataBase64: await fileToBase64(new File([draft.text], '粘贴文档.txt', { type: 'text/plain' })) });
      setDraft(currentSession.id, { text: '', pendingMessageId: undefined, artifactIds: [...draft.artifactIds, artifact.id] });
      setNotice('全文已保存为附件，请输入希望如何处理它。');
    })}>全文转为附件</button></div>}
    {!!draft.progressSelection?.length && <div className="ai-row px-4 pb-2" data-ai-attached-progress>
      <span className="ai-chip">已携带 {draft.progressSelection.length} 个任务的选中进度（发送时补齐完整步骤）
        <button aria-label="移除携带的任务进度" onClick={()=>setDraft(draftId,{progressSelection:[]})}><X size={11}/></button></span>
    </div>}
    {artifacts.length > 0 && <div className="ai-row px-4 pb-2">
      {artifacts.map(artifact=><AiAttachmentChip key={artifact.id} artifact={artifact} sessionId={session!.id} disabled={unavailable}
        onRemove={()=>setDraft(draftId,{artifactIds:draft.artifactIds.filter(id=>id!==artifact.id),pendingMessageId:undefined})}/>)}
    </div>}
    <div className="ai-composer-toolbar">
      <div className="ai-composer-left-tools">
      {!temporary && <AiSessionBar canvasId={canvasId} />}
      </div>
      <input ref={file} type="file" accept={minimal?'.png,.jpg,.jpeg,.webp,.gif':'.txt,.md,.markdown,.json,.csv,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp,.gif'} multiple hidden aria-label={minimal?'上传图片':'上传附件'} onChange={(event) => { const selectedFiles = Array.from(event.target.files ?? []); event.target.value = ''; upload(selectedFiles); }} />
      <div className="ai-composer-send-tools">
        <div ref={menuHost} className="ai-composer-tools ai-composer-files">
          <button type="button" className="ai-composer-tool ai-composer-icon" title={minimal?'图片':'文件'} aria-label={minimal?'图片':'文件'} aria-expanded={menu === 'files'} data-ai-files-button onClick={() => setMenu(menu === 'files' ? undefined : 'files')}><Paperclip size={15} aria-hidden="true" /></button>
          {menu === 'files' && <div className="ai-composer-menu" data-ai-files-menu>
            <button type="button" className="ai-button" aria-label={minimal?'添加图片':'添加附件'} disabled={uploadAction.busy} onClick={() => { setMenu(undefined); file.current?.click(); }}>{minimal?'上传图片':'上传附件'}</button>
            {minimal&&<p className="ai-muted">仅支持 PNG、JPEG、WebP、GIF 图片，也可拖放或粘贴图片。</p>}
          </div>}
        </div>
        {!minimal&&<button type="button" className="ai-composer-tool ai-composer-icon" title="会话笔记" aria-label="会话笔记" disabled={sessionUnavailable} data-ai-notes-button onClick={() => void action.run(async () => { await ensureSession(); setWorkspaceOpen(true); })}><BookOpen size={15} aria-hidden="true" /></button>}
        {!temporary && <AiCreateChildButton canvasId={canvasId} />}
        {snapshot && <AiModelPicker provider={snapshot.provider} value={modelSelection} onChange={selection => setDraft(draftId, { modelSelection: selection })} />}
        <button type="button" className="ai-composer-send" aria-label={mainLabel} title={action.busy?'正在提交…':mainLabel} disabled={unavailable||composing||(!hasContent&&!controlTask)} data-ai-send data-ai-control={hasContent?'send':controlTask?(isPaused?'resume':'pause'):'send'} onClick={mainAction}>{hasContent||!controlTask?<ArrowUp size={19}/>:isPaused?<Play size={17}/>:<Square size={15}/>}</button>
      </div>
    </div>
    {notice && <span role="status" className="sr-only">{notice}</span>}
    {(action.error || uploadAction.error || replyError) && <div className="px-3 pb-2"><AiError text={action.error || uploadAction.error || replyError} /></div>}
    {session && <AiArtifactJobs session={session} />}
    </fieldset>
    {workspaceOpen && session && <AiWorkspacePanel session={session} onClose={() => setWorkspaceOpen(false)} />}
  </div>;
}
