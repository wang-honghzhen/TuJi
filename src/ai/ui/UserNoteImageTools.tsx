import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Expand, Scan, Scissors, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { UserNoteImage } from '../userNotes';
import { renderNoteImage } from './userNoteImageActions';

export type NoteImageAction = 'view' | 'copy' | 'cut' | 'delete';
const actions = [
  { id: 'view', label: '查看图片', shortcut: 'Enter', Icon: Expand },
  { id: 'copy', label: '复制图片', shortcut: 'Ctrl+C', Icon: Copy },
  { id: 'cut', label: '剪切图片', shortcut: 'Ctrl+X', Icon: Scissors },
  { id: 'delete', label: '删除图片', shortcut: 'Delete', Icon: Trash2 },
] as const;

export function UserNoteImageMenu({ x, y, busy, onAction, onClose }: { x: number; y: number; busy: boolean; onAction: (action: NoteImageAction) => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!, rect = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    const previous = document.activeElement as HTMLElement | null;
    element.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: Event) => { if (!element.contains(event.target as Node)) onClose(); };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('resize', onClose); window.addEventListener('scroll', outside, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', onClose); window.removeEventListener('scroll', outside, true); if (document.activeElement === document.body || element.contains(document.activeElement)) previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div ref={menu} role="menu" aria-label="笔记图片操作" className="user-note-image-menu" style={{ left: x, top: y }}
    onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && ['c', 'x'].includes(event.key.toLowerCase())) { event.preventDefault(); if (!busy) onAction(event.key.toLowerCase() === 'x' ? 'cut' : 'copy'); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!busy) onAction('delete'); }
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
    {actions.map(({ id, label, shortcut, Icon }) => <button key={id} type="button" role="menuitem" disabled={busy && id !== 'view'} data-danger={id === 'delete'} onClick={() => onAction(id)}><Icon size={14} /><span>{label}</span><kbd>{shortcut}</kbd></button>)}
  </div>, document.body);
}

export function UserNoteImagePreview({ image, onClose }: { image: UserNoteImage; onClose: () => void }) {
  const [original, setOriginal] = useState(false), [src, setSrc] = useState(''), [error, setError] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 }), [area, setArea] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState<number>();
  const dialog = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false, url = '';
    setSrc(''); setError(''); setSize({ width: 0, height: 0 }); setZoom(undefined);
    if (original) setSrc(image.src);
    else void renderNoteImage(image).then(blob => { if (!cancelled) { url = URL.createObjectURL(blob); setSrc(url); } }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法查看图片'); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [image, original]);
  useLayoutEffect(() => {
    const measure = () => setArea({ width: Math.max(1, stage.current!.clientWidth - 32), height: Math.max(1, stage.current!.clientHeight - 32) });
    measure(); const observer = new ResizeObserver(measure); observer.observe(stage.current!); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')], first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus({ preventScroll: true }); };
  }, []);
  const fit = size.width ? Math.min(1, area.width / size.width, area.height / size.height) : 1, scale = zoom ?? fit;
  const changeZoom = (factor: number) => setZoom(Math.max(.05, Math.min(8, scale * factor)));
  return createPortal(<div className="user-note-image-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="查看笔记图片" className="user-note-image-preview">
      <header><strong>查看图片</strong><button type="button" aria-label="关闭图片预览" title="关闭 Esc" onClick={onClose}><X size={18} /></button></header>
      <div className="user-note-preview-controls"><button type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>编辑效果</button><button type="button" aria-pressed={original} onClick={() => setOriginal(true)}>原图</button><span />
        <button type="button" aria-label="缩小图片" disabled={!size.width || scale <= .05} onClick={() => changeZoom(1 / 1.25)}><ZoomOut size={16} /></button>
        <output aria-label="图片缩放比例">{Math.round(scale * 100)}%</output>
        <button type="button" aria-label="放大图片" disabled={!size.width || scale >= 8} onClick={() => changeZoom(1.25)}><ZoomIn size={16} /></button>
        <button type="button" disabled={!size.width} onClick={() => setZoom(undefined)} title="适应窗口" aria-label="图片适应窗口"><Scan size={16} /></button>
        <button type="button" disabled={!size.width} onClick={() => setZoom(1)} title="原始像素大小">1:1</button>
      </div>
      <div ref={stage} className="user-note-preview-stage" tabIndex={0} aria-label="图片预览，可滚动查看放大图片">
        {error ? <p role="alert">{error}</p> : !src ? <p role="status">正在读取图片…</p> : <div className="user-note-preview-surface" style={{ width: Math.max(area.width, size.width * scale), height: Math.max(area.height, size.height * scale) }}>
          <img src={src} alt={original ? '笔记图片原图' : '笔记图片当前编辑效果'} draggable={false} style={{ width: size.width ? size.width * scale : undefined, height: size.height ? size.height * scale : undefined }}
            onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError('图片读取失败，请重新打开笔记后重试')} />
        </div>}
      </div>
      <footer>{size.width ? `${size.width} × ${size.height} 像素` : ''}<span>预览不会修改笔记</span></footer>
    </div>
  </div>, document.body);
}
