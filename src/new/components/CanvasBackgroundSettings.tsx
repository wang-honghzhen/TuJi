import { Check, ImagePlus, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { BUILTIN_BACKGROUND_URL, MAX_BACKGROUND_BYTES, type CanvasBackgroundId } from '@/shared/canvasBackgrounds';
import { useAiStore } from '@/ai/client';
import { AiError, useAction } from '@/ai/ui/common';
import { useCanvasBackground } from '../backgrounds/CanvasBackground';

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择。'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export function CanvasBackgroundSettings() {
  const { settings, customImageUrl, loading, error, retry } = useCanvasBackground();
  const chosen = settings.canvasBackgroundId, hasCustom = Boolean(settings.customBackgroundAssetId);
  const command = useAiStore(state => state.command), action = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const select = (canvasBackgroundId: CanvasBackgroundId) => void action.run(async () => {
    setNotice(''); await command('settings.personalization', { canvasBackgroundId });
    setNotice('背景已保存，已应用到所有画布。');
  });
  const upload = (selected: File) => void action.run(async () => {
    setNotice('');
    if (!/\.(png|jpe?g|webp)$/i.test(selected.name) && !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type))
      throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    if (!selected.size || selected.size > MAX_BACKGROUND_BYTES) throw new Error('图片大小需在 12 MB 以内，且不能为空。');
    const mimeType = selected.type || (/\.png$/i.test(selected.name) ? 'image/png' : /\.webp$/i.test(selected.name) ? 'image/webp' : 'image/jpeg');
    await command('settings.background.upload', { name: selected.name, mimeType, dataBase64: await fileBase64(selected) });
    setNotice('图片已保存在本机，并应用到所有画布。');
  });
  const choices: Array<{ id: CanvasBackgroundId; name: string; description: string; url?: string }> = [
    { id: 'starry-sky', name: '星空', description: '深蓝色星空背景', url: BUILTIN_BACKGROUND_URL },
    { id: 'white-grid', name: '纯白点格', description: '白色背景与细点网格' },
    { id: 'custom', name: '我的背景', description: hasCustom ? '使用已上传的图片' : '上传一张喜欢的图片', url: customImageUrl },
  ];
  return <div className="ai-column" data-background-settings aria-busy={action.busy}>
    <div className="ai-settings-intro"><h3>画布背景</h3><p className="ai-muted">选一个适合思考的背景，所有画布统一使用。</p></div>
    <div className="canvas-background-choices" role="group" aria-label="画布背景">{choices.map(background => <article key={background.id} className="canvas-background-card" data-selected={chosen === background.id}>
      <button type="button" className="canvas-background-select" data-background-option={background.id} aria-pressed={chosen === background.id}
        aria-label={background.id === 'custom' && !hasCustom ? '上传自定义背景' : `选择${background.name}背景`} disabled={action.busy}
        onClick={() => background.id === 'custom' && !hasCustom ? file.current?.click() : select(background.id)}>
        <span className={`canvas-background-preview${background.id === 'white-grid' ? ' canvas-white-grid' : ''}`}>
          {background.url ? <img src={background.url} alt="" draggable={false} /> : background.id === 'custom' && <span className="canvas-background-placeholder"><ImagePlus size={28} /><span>{loading ? '正在载入…' : hasCustom ? '自定义图片' : '上传图片'}</span></span>}
        </span>
        <span className="canvas-background-choice-title"><span><strong>{background.name}</strong><small>{background.description}</small></span>
          <span className="canvas-background-radio" aria-hidden="true">{chosen === background.id && <Check size={14} />}</span></span>
      </button>
    </article>)}</div>
    <div className="canvas-background-upload ai-card ai-column">
      <div className="ai-row"><button type="button" className="ai-button" data-background-upload disabled={action.busy} onClick={() => file.current?.click()}><Upload size={15} />{hasCustom ? '更换自定义背景' : '上传背景图片'}</button>
        {hasCustom && <button type="button" className="ai-button" data-background-remove disabled={action.busy} onClick={() => void action.run(async () => {
          setNotice(''); await command('settings.background.remove'); setNotice('已移除自定义背景。');
        })}>移除自定义图片</button>}</div>
      <input ref={file} data-background-file type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden aria-label="上传背景图片" onChange={event => {
        const selected = event.target.files?.[0]; event.target.value = ''; if (selected) upload(selected);
      }} />
      <p className="ai-muted">支持 PNG、JPG、WebP，最大 12 MB。图片按窗口比例居中裁切；仅保存在本机，重启后仍可使用。</p>
    </div>
    {action.error && <AiError text={action.error} />}
    {error && <div className="ai-column"><AiError text={error} /><button type="button" className="ai-button" disabled={action.busy || loading} onClick={retry}>重新读取图片</button></div>}
    {notice && <p role="status" className="ai-settings-notice">{notice}</p>}
  </div>;
}
