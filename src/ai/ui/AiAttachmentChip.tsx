import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import type { Artifact } from '../domain';
import { useAiStore } from '../client';

export function AiAttachmentChip({ artifact, sessionId, onRemove, disabled, loadThumbnail=true }: {
  artifact: Artifact; sessionId: string; onRemove?: () => void; disabled?: boolean; loadThumbnail?: boolean;
}) {
  const command=useAiStore(s=>s.command),[preview,setPreview]=useState<string>(),[open,setOpen]=useState(false),[error,setError]=useState('');
  const visual=artifact.mimeType.startsWith('image/')||artifact.mimeType==='application/pdf';
  useEffect(()=>{
    let live=true;
    if(loadThumbnail&&artifact.mimeType.startsWith('image/'))void command<{dataUrl:string}>('artifact.preview',{sessionId,artifactId:artifact.id,version:artifact.version},{reportError:false})
      .then(result=>{if(live)setPreview(result.dataUrl);}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[artifact.id,artifact.version,artifact.mimeType,sessionId,command,loadThumbnail]);
  useEffect(()=>{if(!open)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[open]);
  const view=async()=>{setOpen(true);if(preview)return;try{const result=await command<{dataUrl:string}>('artifact.preview',{sessionId,artifactId:artifact.id,version:artifact.version},{reportError:false});setPreview(result.dataUrl);}catch(e){setError(e instanceof Error?e.message:'预览失败');}};
  return <>
    <span className="ai-chip relative pr-5" data-ai-attachment={artifact.id}>
      {visual?<button type="button" onClick={()=>void view()} aria-label={`预览附件 ${artifact.name}`} className="flex items-center gap-1">
        {preview?<img src={preview} alt="" className="h-9 w-9 rounded object-cover"/>:<FileText size={16}/>}
        <span>{artifact.name}{artifact.firstFrameOnly?'（首帧）':''}</span>
      </button>:<><FileText size={12}/>{artifact.name}</>}
      {artifact.status!=='ready'&&<span>{artifact.status==='partial'?'（部分解析）':'（解析失败）'}</span>}
      {onRemove&&<button type="button" disabled={disabled} className="absolute right-0 top-0" aria-label={`移除附件 ${artifact.name}`} onClick={onRemove}><X size={12}/></button>}
    </span>
    {open&&createPortal(<div role="dialog" aria-modal="true" aria-label={`附件预览 ${artifact.name}`} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-8" onClick={()=>setOpen(false)}>
      <div className="relative max-h-full max-w-full rounded bg-slate-900 p-3" onClick={e=>e.stopPropagation()}>
        <button type="button" aria-label="关闭附件预览" onClick={()=>setOpen(false)} className="absolute right-2 top-2 rounded bg-slate-800 p-2"><X size={18}/></button>
        <p className="mb-2 pr-10">{artifact.name}{artifact.mimeType==='application/pdf'?' · 第 1 页':''}</p>
        {preview?<img src={preview} alt={artifact.name} className="max-h-[75vh] max-w-[85vw] object-contain"/>:<p>{error||'正在生成预览…'}</p>}
      </div>
    </div>,document.body)}
  </>;
}
