import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LocateFixed } from 'lucide-react';
import { activeTask, getSession, sessionTasks, useAiStore } from '@/ai/client';
import type { Task } from '@/ai/domain';
import { presentationOwner, taskParts, usePlaybackStore } from '@/ai/presentationClient';
import { presentationRows } from '@/ai/presentation';
import { AiMessageView, AiToolGroup } from '@/ai/ui/AiTaskView';
import { resolvePresentationTargets } from '../presentationTargets';
import { canFollowTask, maximumReached, recordReachedPart } from '@/ai/presentationReading';

export function NewAiReplyPanel({canvasId='qixue-draft-canvas'}:{canvasId?:string}){
  const snapshot=useAiStore(s=>s.snapshot),activeId=useAiStore(s=>s.activeSessionByCanvas[canvasId]);
  const command=useAiStore(s=>s.command),connection=useAiStore(s=>s.connection);
  const playback=usePlaybackStore(s=>s.byCanvas[canvasId]),setPlayback=usePlaybackStore(s=>s.set);
  const session=getSession(snapshot,canvasId,activeId),tasks=sessionTasks(snapshot,session?.id),current=activeTask(snapshot,session?.id);
  const suggested=current??tasks.at(-1);
  const task=tasks.find(t=>t.id===playback?.taskId)??suggested;
  const parts=taskParts(snapshot,task?.id),index=Math.max(0,parts.findIndex(p=>p.seq===(playback?.cursor??(parts.some(p=>p.seq===1)?1:0)))),part=parts[index];
  const paused=Boolean(task?.pauseRequested||task?.status==='paused'||task?.presentation?.playbackPaused);
  const eligible=canFollowTask(snapshot,session?.id,task?.id);
  const mode=eligible?(playback?.mode??'follow'):'review',epoch=task?.presentation?.epoch;
  const lastVisible=useRef<{taskId?:string;cursor?:number;rows:ReturnType<typeof presentationRows>}>({rows:[]});
  const rows=useMemo(()=>presentationRows(snapshot,part),[part,snapshot?.messages,snapshot?.toolCalls,snapshot?.changes]);
  if(!paused||lastVisible.current.taskId!==task?.id||lastVisible.current.cursor!==playback?.cursor)
    lastVisible.current={taskId:task?.id,cursor:playback?.cursor,rows};
  const displayedRows=lastVisible.current.rows;
  const [visible,setVisible]=useState(()=>document.visibilityState==='visible'&&document.hasFocus());
  const [typing,setTyping]=useState(false);
  const [editing,setEditing]=useState<{from:number;text:string}>();
  const edit=useRef(editing); edit.current=editing;
  const numberInput=useRef<HTMLInputElement>(null),counter=useRef<HTMLButtonElement>(null);
  const [syncing,setSyncing]=useState(false);
  const syncChain=useRef(Promise.resolve()),syncVersion=useRef(0);
  const mounted=useRef(true),displayedTask=useRef(task?.id);displayedTask.current=task?.id;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const targetStatus=useMemo(()=>resolvePresentationTargets(snapshot?.graph,canvasId,part?.targets??[]),[snapshot?.graph,canvasId,part?.targets]);
  useLayoutEffect(()=>{if(editing){numberInput.current?.focus();numberInput.current?.select();}},[!!editing]);
  useEffect(()=>{edit.current=undefined;setEditing(undefined);},[canvasId,task?.id]);
  const control=(action:string,extra:object={})=>task?command<Task['presentation']>('presentation.control',{taskId:task.id,owner:presentationOwner,action,...extra}).catch(()=>undefined):Promise.resolve(undefined);
  // Only the main reply panel activates playback. Record pickers never mount this panel.
  // Serialize navigation so a slow older request cannot overwrite the latest direction.
  const synchronize=(taskId=task?.id,stillCurrent=()=>true)=>{
    const version=++syncVersion.current;setSyncing(true);
    const current=()=>mounted.current&&displayedTask.current===taskId&&stillCurrent()
      &&useAiStore.getState().activeSessionByCanvas[canvasId]===session?.id
      &&canFollowTask(useAiStore.getState().snapshot,session?.id,taskId);
    const pending=syncChain.current.then(async()=>{
      if(!taskId||!current())return;
      const presentation=useAiStore.getState().snapshot?.tasks.find(value=>value.id===taskId)?.presentation;
      if(!presentation)await command('presentation.control',{taskId,owner:presentationOwner,action:'attach'});
      else if(presentation.owner!==presentationOwner)await command('presentation.control',{taskId,owner:presentationOwner,action:'takeover',epoch:presentation.epoch});
      if(!current())return;
      const latest=usePlaybackStore.getState().byCanvas[canvasId];
      if(latest?.taskId===taskId)await command('presentation.control',{taskId,owner:presentationOwner,action:latest.mode,seq:latest.cursor});
    }).catch(()=>undefined).finally(()=>{if(mounted.current&&version===syncVersion.current)setSyncing(false);});
    syncChain.current=pending;
  };
  useEffect(()=>{
    if(task&&playback?.taskId!==task.id)setPlayback(canvasId,{taskId:task.id,cursor:task.presentation?.cursor??1,mode:eligible&&task.presentation?.mode==='follow'?'follow':'review'});
    else if(task&&!eligible&&playback?.mode==='follow')setPlayback(canvasId,{mode:'review'});
  },[task?.id,playback?.taskId,eligible,playback?.mode]);
  useEffect(()=>{
    if(session&&task&&part&&visible)recordReachedPart(snapshot,session.id,task.id,part.seq);
  },[session?.id,task?.id,part?.seq,visible,eligible]);
  useEffect(()=>{
    if(!task||!eligible||!visible||connection!=='connected')return;
    let current=true;synchronize(task.id,()=>current);
    return()=>{current=false;};
  },[canvasId,task?.id,visible,connection,playback?.followRequest,eligible]);
  useEffect(()=>{
    const update=()=>{setVisible(document.visibilityState==='visible'&&document.hasFocus());setTyping(document.activeElement instanceof Element&&!!document.activeElement.closest('input,textarea,[contenteditable="true"]'));};
    window.addEventListener('focus',update);window.addEventListener('blur',update);document.addEventListener('visibilitychange',update);document.addEventListener('focusin',update);document.addEventListener('focusout',update);
    return()=>{window.removeEventListener('focus',update);window.removeEventListener('blur',update);document.removeEventListener('visibilitychange',update);document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);};
  },[]);
  useEffect(()=>{
    if(!task||task.presentation?.owner!==presentationOwner||task.presentation.mode!=='follow'||!part?.sealed||paused||mode!=='follow'||!visible||typing||editing||syncing||playback?.interactionBusy||connection!=='connected')return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
    void control('show',{seq:part.seq,epoch}).then(result=>{if(cancelled||result?.visiblePart?.seq!==part.seq||result.visiblePart.epoch!==epoch)return;
      timer=setTimeout(()=>{
        if(cancelled)return;
        if(index<parts.length-1)setPlayback(canvasId,{cursor:parts[index+1].seq});
        else if(task.presentation?.round)void control('ack',{seq:part.seq,epoch,stepId:task.presentation.round.stepId,revision:task.presentation.round.revision});
      },part.dwellMs+80);
    });
    return()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[task?.id,task?.presentation?.owner,task?.presentation?.mode,part?.id,part?.sealed,part?.dwellMs,part?.version,index,parts.length,paused,mode,visible,typing,!!editing,syncing,playback?.interactionBusy,connection,epoch,task?.presentation?.round?.lastSeq]);
  useEffect(()=>{useAiStore.getState().setReplyTargetRefs(canvasId,part?.targets??[]);
    return()=>useAiStore.getState().setReplyTargetRefs(canvasId,[]);
  },[part?.id,part?.version,canvasId]);
  const navigate=(seq:number,from=part?.seq??0)=>{
    if(!task||seq===from||!parts.some(value=>value.seq===seq))return;
    const maximum=session?Math.max(maximumReached(session.id,task.id),from):-1;
    setPlayback(canvasId,{taskId:task.id,cursor:seq,mode:eligible&&seq>maximum?'follow':'review',cameraFollow:true});
    if(session)recordReachedPart(snapshot,session.id,task.id,seq);
    if(eligible)synchronize();
  };
  const finishEdit=(commit:boolean,restoreFocus=false)=>{
    const draft=edit.current;if(!draft)return;
    edit.current=undefined;setEditing(undefined);
    const seq=Number(draft.text.trim());
    if(commit&&/^\d+$/.test(draft.text.trim())&&Number.isSafeInteger(seq))navigate(seq,draft.from);
    if(restoreFocus)requestAnimationFrame(()=>counter.current?.focus());
  };
  // Keep playback effects mounted even before the first history segment arrives.
  if (!parts.length) return null;
  return <section className="canvas-reply-panel" aria-label="分段回复" data-ai-reply-panel>
    <div className="canvas-reply-history new-scroll" key={part?.id} tabIndex={0} aria-label="本段回复">
      {targetStatus.notice&&<p className="canvas-reply-target-notice" role="status" data-presentation-target-notice>{targetStatus.notice}</p>}
      <div className="ai-column">{displayedRows.map(row=>row.calls
        ? <div key={row.id} data-action-status><AiToolGroup calls={row.calls}/></div>
        : row.message?<AiMessageView key={row.id} message={row.message} canvasId={canvasId} sessionId={session?.id}/>:null)}</div>
    </div>
    <nav className="canvas-reply-navigation" aria-label="回复分段" data-presentation-navigation>
      <button type="button" className="canvas-reply-nav-button" aria-label="上一段" title="上一段 · 停止跟随" disabled={index===0} onClick={()=>navigate(parts[index-1].seq)}><ChevronLeft size={18}/></button>
      <span className="canvas-reply-counter" data-presentation-counter data-following={mode==='follow'} title={mode==='follow'?'自动跟随':'回看'}>
        {editing?<input ref={numberInput} className="canvas-reply-number" aria-label="当前段落" inputMode="numeric" value={editing.text}
          onChange={event=>{const next={...editing,text:event.target.value};edit.current=next;setEditing(next);}}
          onBlur={()=>finishEdit(true)} onKeyDown={event=>{
            if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();event.stopPropagation();finishEdit(event.key==='Enter',true);}
          }}/>:<button type="button" ref={counter} className="canvas-reply-number" data-presentation-current
          aria-label={`当前${part?.seq===0?'起始输入':`第 ${part?.seq} 段`}，点击修改段落`} title="点击修改段落"
          onClick={()=>setEditing({from:part?.seq??0,text:String(part?.seq??0)})}>{part?.seq??0}</button>}
        <span aria-hidden="true">/</span><span data-presentation-total aria-label={`共 ${parts.at(-1)?.seq??0} 段`}>{parts.at(-1)?.seq??0}</span>
      </span>
      <button type="button" className="canvas-reply-nav-button" aria-label="下一段" title="下一段 · 超过已读最大段号时跟随" disabled={index===parts.length-1} onClick={()=>navigate(parts[index+1].seq)}><ChevronRight size={18}/></button>
      <button type="button" className="canvas-reply-nav-button canvas-reply-locate" aria-label="定位指定对象" aria-hidden={!part?.targets.length||undefined}
        tabIndex={part?.targets.length?0:-1} data-visible={!!part?.targets.length} title={targetStatus.available.length?'定位指定对象':targetStatus.notice}
        disabled={!targetStatus.available.length} onClick={()=>setPlayback(canvasId,{locate:(playback?.locate??0)+1,cameraFollow:true})}><LocateFixed size={17}/></button>
    </nav>
  </section>;
}
