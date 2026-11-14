import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type PointerEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpToLine, Check, Crop, Loader2, Redo2, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import type { UserNotePage } from '../domain';
import { userNoteBlocks, type UserNoteBlock, type UserNoteCrop, type UserNoteImage } from '../userNotes';
import { PaperContextMenu } from './PaperEditor';
import { blankCrop, deleteNoteImage, fitNoteImage, insertNoteImages, noteRegionLayout } from './userNoteLayout';
import './user-note-editor.css';

export interface UserNoteEditorHandle { flush(): Promise<void> }
interface Props {
  page: UserNotePage; label: string; highlight?: string;
  toolbarTarget?: HTMLElement | null;
  save(blocks: UserNoteBlock[], expectedVersion: number): Promise<UserNotePage>;
  uploadImage(dataUrl: string): Promise<{ src: string; width: number; height: number }>;
  onDelete?: () => Promise<void>;
}
const liveEditors = new Map<symbol, () => Promise<void>>();
export async function flushUserNoteEditors() { await Promise.all([...liveEditors.values()].map(flush => flush())); }
const same = (a: UserNoteBlock[], b: UserNoteBlock[]) => JSON.stringify(a) === JSON.stringify(b);
const uid = () => crypto.randomUUID();
const asDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取剪贴板图片')); reader.readAsDataURL(file);
});

function TextBlock({ block, label, last, locked, highlight, scrollToMatch, autoFocus, onChange, onComposition, onFocus }: {
  block: Extract<UserNoteBlock, { type: 'text' }>; label: string; last: boolean; locked: boolean; highlight?: string; scrollToMatch: boolean; autoFocus: boolean;
  onChange: (value: string) => void; onComposition: (active: boolean) => void; onFocus: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null), mirror = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    const element = input.current!;
    const resize = () => {
      if (element.clientWidth <= 0) return;
      const scroll = element.closest<HTMLElement>('.utility-paper-scroll'), top = scroll?.scrollTop;
      const wrapper = element.parentElement!, previousMin = wrapper.style.minHeight;
      // Keep the scroll extent while measuring. Temporarily collapsing a long textarea
      // otherwise clamps and persists the reader's position during window handoff.
      wrapper.style.minHeight = element.offsetHeight + 'px'; element.style.height = '0px';
      element.style.height = Math.max(32, Math.ceil(element.scrollHeight / 32) * 32) + 'px'; wrapper.style.minHeight = previousMin;
      if (scroll && top !== undefined) scroll.scrollTop = top;
    };
    let width = element.clientWidth; resize();
    const observer = new ResizeObserver(() => { if (width !== element.clientWidth) { width = element.clientWidth; resize(); } });
    observer.observe(element); return () => observer.disconnect();
  }, [block.text]);
  const query = highlight?.trim(), match = query ? block.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  useEffect(() => {
    if (match < 0 || !scrollToMatch) return;
    const frame = requestAnimationFrame(() => mirror.current?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [query, scrollToMatch]);
  const marked = [];
  if (query) {
    let start = 0, next = block.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    while (next !== -1) { marked.push(block.text.slice(start, next), <mark key={next}>{block.text.slice(next, next + query.length)}</mark>); start = next + query.length; next = block.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), start); }
    marked.push(block.text.slice(start));
  }
  return <div className="user-note-text" data-note-text-block={block.id} data-last={last}>
    {query && <div className="user-note-text-marks" aria-hidden ref={mirror}>{marked}{'\n'}</div>}
    <textarea ref={input} data-paper-input data-note-block={block.id} rows={1} spellCheck={false} value={block.text}
      aria-label={label} readOnly={locked} placeholder={last ? '从这里继续记录，或粘贴图片…' : ''}
      onFocus={onFocus} onChange={event => onChange(event.target.value)}
      onCompositionStart={() => onComposition(true)} onCompositionEnd={() => onComposition(false)}
      onKeyDown={event => {
        if (event.key !== 'Tab' || event.shiftKey || event.nativeEvent.isComposing || locked) return;
        event.preventDefault(); const element = event.currentTarget, start = element.selectionStart;
        element.setRangeText('\t', start, element.selectionEnd, 'end'); onChange(element.value);
        requestAnimationFrame(() => element.setSelectionRange(start + 1, start + 1));
      }} />
  </div>;
}

function CropDialog({ image, onApply, onClose }: { image: UserNoteImage; onApply: (crop: UserNoteCrop) => void; onClose: () => void }) {
  const [crop, setCrop] = useState<UserNoteCrop>(image.crop ?? blankCrop), [aspect, setAspect] = useState(1.5);
  const dialog = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ corner: string; x: number; y: number; crop: UserNoteCrop }>();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('button, [tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true); return () => { window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, []);
  const point = (event: PointerEvent) => { const r = stage.current!.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }; };
  return createPortal(<div className="user-note-crop-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="裁剪图片" className="user-note-crop-dialog">
      <header><div><strong>裁剪图片</strong><p>拖动选择保留区域，也可以调整四角。</p></div><button type="button" title="关闭" aria-label="关闭裁剪" onClick={onClose}><X size={18} /></button></header>
      <div className="user-note-crop-preview"><div className="user-note-crop-stage" ref={stage} style={{ width: Math.min(440, 310 * aspect), aspectRatio: aspect }}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); const p = point(event); const corner = (event.target as HTMLElement).dataset.corner ?? ''; drag.current = { ...p, corner, crop }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          const g = drag.current; if (!g) return; const p = point(event); let left = g.crop.left, top = g.crop.top, right = 1 - g.crop.right, bottom = 1 - g.crop.bottom;
          if (g.corner) { if (g.corner.includes('l')) left = Math.min(right - .05, p.x); else right = Math.max(left + .05, p.x); if (g.corner.includes('t')) top = Math.min(bottom - .05, p.y); else bottom = Math.max(top + .05, p.y); }
          else { left = Math.min(g.x, p.x); right = Math.max(g.x, p.x); top = Math.min(g.y, p.y); bottom = Math.max(g.y, p.y); if (right - left < .05 || bottom - top < .05) return; }
          setCrop({ left, top, right: 1 - right, bottom: 1 - bottom });
        }} onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = undefined; }}>
        <img src={image.src} alt="待裁剪图片" draggable={false} onLoad={event => setAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} />
        <div className="user-note-crop-selection" style={{ left: crop.left * 100 + '%', right: crop.right * 100 + '%', top: crop.top * 100 + '%', bottom: crop.bottom * 100 + '%' }}>
          <i /><i /><i /><i />{['tl', 'tr', 'bl', 'br'].map(corner => <span key={corner} data-corner={corner} className={'crop-corner crop-' + corner} />)}
        </div>
      </div></div>
      <footer><button type="button" onClick={() => setCrop(blankCrop)}>重置选区</button><span /><button type="button" onClick={onClose}>取消</button><button type="button" className="note-crop-apply" onClick={() => onApply(crop)}><Check size={14} />应用裁剪</button></footer>
    </div>
  </div>, document.body);
}

function ImageRegion({ block, selected, locked, onSelect, onPatch, onStart, onEnd, onCrop, onRemove, onRaise }: {
  block: Extract<UserNoteBlock, { type: 'images' }>; selected?: string; locked: boolean;
  onSelect: (id: string) => void; onPatch: (id: string, update: Partial<UserNoteImage>, gesture?: boolean) => void;
  onStart: () => void; onEnd: () => void; onCrop: (image: UserNoteImage) => void; onRemove: (id: string) => void; onRaise: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null), [available, setAvailable] = useState(420);
  const gesture = useRef<{ image: UserNoteImage; x: number; y: number; kind: string; scale: number; width: number }>();
  useLayoutEffect(() => { const observer = new ResizeObserver(() => { const width = root.current!.clientWidth; if (width > 0) setAvailable(width); }); observer.observe(root.current!); return () => observer.disconnect(); }, []);
  const layout = noteRegionLayout(block.images, available), image = block.images.find(item => item.id === selected);
  return <div ref={root} data-note-image-region={block.id} className="user-note-image-region" data-selected={!!image} tabIndex={0} aria-label="图片区域，可继续粘贴图片" style={{ height: Math.max(64, layout.height * layout.scale) }}
    onKeyDown={event => {
      if (!image || locked || (event.target as HTMLElement).tagName === 'INPUT') return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onRemove(image.id); }
      if (event.key === 'Escape') onSelect('');
      const offset = event.shiftKey ? 10 : 1;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onPatch(image.id, fitNoteImage({ ...image, x: image.x + (event.key === 'ArrowLeft' ? -offset : event.key === 'ArrowRight' ? offset : 0), y: image.y + (event.key === 'ArrowUp' ? -offset : event.key === 'ArrowDown' ? offset : 0) }, layout.width)); }
    }}
    onPointerDown={event => { if (event.target === event.currentTarget) { onSelect(''); event.currentTarget.focus(); } }}>
    <div className="user-note-image-plane" style={{ width: layout.width, height: layout.height, transform: 'scale(' + layout.scale + ')' }}>
      {block.images.map(item => {
        const crop = item.crop ?? blankCrop;
        return <div key={item.id} data-note-image={item.id} className="user-note-image" data-selected={selected === item.id} style={{ left: item.x, top: item.y, width: item.width, height: item.height, transform: 'rotate(' + item.rotation + 'deg)' } as CSSProperties}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onSelect(item.id); }}
          onPointerDown={event => {
            if (event.button !== 0 || locked) return; event.preventDefault(); event.stopPropagation(); onSelect(item.id); root.current?.focus(); onStart();
            gesture.current = { image: item, x: event.clientX, y: event.clientY, kind: (event.target as HTMLElement).dataset.resize ?? 'move', scale: layout.scale, width: layout.width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={event => {
            const g = gesture.current; if (!g || g.image.id !== item.id) return; const dx = (event.clientX - g.x) / g.scale, dy = (event.clientY - g.y) / g.scale;
            let next = { ...g.image };
            if (g.kind === 'move') { next.x += dx; next.y += dy; }
            else { const angle = -g.image.rotation * Math.PI / 180; const localX = dx * Math.cos(angle) - dy * Math.sin(angle); const ratio = Math.max(24 / g.image.width, (g.image.width + localX) / g.image.width); next.width *= ratio; next.height *= ratio; }
            onPatch(item.id, fitNoteImage(next, g.width), true);
          }} onPointerUp={event => { if (!gesture.current) return; gesture.current = undefined; onEnd(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { gesture.current = undefined; onEnd(); }}>
          <div className="user-note-image-clip"><img src={item.src} draggable={false} alt="笔记插图" style={{ width: 100 / (1 - crop.left - crop.right) + '%', height: 100 / (1 - crop.top - crop.bottom) + '%', left: -100 * crop.left / (1 - crop.left - crop.right) + '%', top: -100 * crop.top / (1 - crop.top - crop.bottom) + '%' }} /></div>
          {selected === item.id && <span data-resize="se" className="user-note-image-resize" title="拖动调整图片大小" />}
        </div>;
      })}
    </div>
    {image && <div className="user-note-image-tools" role="toolbar" aria-label="图片编辑" onPointerDown={event => event.stopPropagation()}>
      <button type="button" onClick={() => onCrop(image)} title="裁剪图片" aria-label="裁剪图片"><Crop size={14} /><span>裁剪</span></button>
      <button type="button" onClick={() => onPatch(image.id, fitNoteImage({ ...image, rotation: (image.rotation - 90) % 360 }, layout.width))} title="逆时针旋转 90°" aria-label="逆时针旋转 90 度"><RotateCcw size={14} /></button>
      <label title="旋转角度"><input aria-label="图片旋转角度" type="number" step={1} value={Math.round(image.rotation)} onChange={event => onPatch(image.id, fitNoteImage({ ...image, rotation: Number(event.target.value) % 360 }, layout.width))} /><span>°</span></label>
      <span className="note-tool-divider" />
      <button type="button" onClick={() => onRaise(image.id)} title="移到最上层" aria-label="图片移到最上层"><ArrowUpToLine size={14} /></button>
      <button type="button" onClick={() => onRemove(image.id)} title="删除图片" aria-label="删除图片" className="note-image-delete"><Trash2 size={14} /></button>
    </div>}
    {!image && <span className="user-note-image-hint">点击图片编辑 · 可在此继续粘贴</span>}
  </div>;
}

export const UserNoteEditor = forwardRef<UserNoteEditorHandle, Props>(function UserNoteEditor(props, ref) {
  const [blocks, setBlocks] = useState(() => userNoteBlocks(props.page)), [selected, setSelected] = useState<{ blockId: string; imageId: string }>();
  const [cropTarget, setCropTarget] = useState<{ blockId: string; image: UserNoteImage }>(), [error, setError] = useState('');
  const [status, setStatus] = useState<'saved' | 'editing' | 'saving'>('saved'), [uploading, setUploading] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>(), [, renderHistory] = useState(0);
  const root = useRef<HTMLDivElement>(null), options = useRef(props); options.current = props;
  const current = useRef(blocks), saved = useRef({ blocks, version: props.page.version }), pending = useRef<Promise<void>>(), importing = useRef<Promise<void>>();
  const timer = useRef<ReturnType<typeof setTimeout>>(), composing = useRef(false), token = useRef(Symbol()), mounted = useRef(true);
  const history = useRef<{ past: UserNoteBlock[][]; future: UserNoteBlock[][]; group: string; at: number }>({ past: [], future: [], group: '', at: 0 });
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const schedule = () => { clearTimeout(timer.current); if (!composing.current) timer.current = setTimeout(() => { void flushRef.current().catch(() => undefined); }, 600); };
  const remember = (group = '') => {
    const h = history.current;
    if (!group || h.group !== group || Date.now() - h.at > 700) { h.past.push(structuredClone(current.current)); if (h.past.length > 60) h.past.shift(); }
    h.future = []; h.group = group; h.at = Date.now(); renderHistory(value => value + 1);
  };
  const change = (next: UserNoteBlock[], group = '', record = true) => { if (same(next, current.current)) return; if (record) remember(group); current.current = next; setBlocks(next); setStatus('editing'); setError(''); schedule(); };
  const flush = (): Promise<void> => {
    clearTimeout(timer.current);
    if (importing.current) return importing.current.then(() => flushRef.current());
    if (pending.current) return pending.current;
    if (same(current.current, saved.current.blocks) || composing.current) return Promise.resolve();
    setStatus('saving'); setError('');
    pending.current = (async () => {
      while (!same(current.current, saved.current.blocks) && !composing.current) {
        const next = current.current;
        const result = await options.current.save(next, saved.current.version);
        saved.current = { blocks: userNoteBlocks(result), version: result.version };
        if (current.current === next) { current.current = saved.current.blocks; if (mounted.current) setBlocks(current.current); }
      }
      if (mounted.current) setStatus('saved');
    })().catch(cause => { if (mounted.current) { setStatus('editing'); setError(cause instanceof Error ? cause.message : '保存失败，编辑内容仍保留在这里'); } throw cause; }).finally(() => { pending.current = undefined; });
    return pending.current;
  };
  flushRef.current = flush;
  useImperativeHandle(ref, () => ({ flush: () => flushRef.current() }), []);
  useEffect(() => { mounted.current = true; const key = token.current; liveEditors.set(key, () => flushRef.current()); return () => { mounted.current = false; liveEditors.delete(key); clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    if (props.page.version <= saved.current.version || pending.current || importing.current || !same(current.current, saved.current.blocks)) return;
    const next = userNoteBlocks(props.page); saved.current = { blocks: next, version: props.page.version }; current.current = next; setBlocks(next); setStatus('saved');
    history.current = { past: [], future: [], group: '', at: 0 };
  }, [props.page.version, props.page.blocks, props.page.text]);
  const undo = (redo = false) => {
    if (uploading) return; const h = history.current, source = redo ? h.future : h.past, target = redo ? h.past : h.future, next = source.pop();
    if (!next) return; target.push(structuredClone(current.current)); h.group = ''; change(next, '', false); setSelected(undefined); renderHistory(value => value + 1);
  };
  const patchImage = (blockId: string, imageId: string, update: Partial<UserNoteImage>, gesture = false) => change(current.current.map(block => block.id === blockId && block.type === 'images' ? { ...block, images: block.images.map(image => image.id === imageId ? { ...image, ...update } : image) } : block), '', !gesture);
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault(); if (importing.current) return;
    const target = event.target as HTMLElement, input = target instanceof HTMLTextAreaElement ? target : undefined;
    const blockId = input?.dataset.noteBlock ?? target.closest<HTMLElement>('[data-note-image-region]')?.dataset.noteImageRegion ?? selected?.blockId ?? current.current.at(-1)!.id;
    const selection = input ? { start: input.selectionStart, end: input.selectionEnd } : undefined;
    const available = Math.max(120, root.current!.clientWidth), existing = current.current.find(block => block.id === blockId);
    setUploading(true); setError('');
    importing.current = (async () => {
      const images: UserNoteImage[] = [];
      for (const [index, file] of files.entries()) {
        const result = await options.current.uploadImage(await asDataUrl(file));
        const scale = Math.min(1, (available - 32) / result.width, 420 / result.height);
        const offset = existing?.type === 'images' ? Math.min(40, existing.images.length * 12) : 0;
        images.push(fitNoteImage({ id: uid(), src: result.src, x: offset + index * 12, y: 12 + offset + index * 12, width: result.width * scale, height: result.height * scale, rotation: 0, crop: blankCrop }, available));
      }
      const next = insertNoteImages(current.current, blockId, images, selection); change(next);
      const region = next.find(block => block.type === 'images' && block.images.some(image => image.id === images[0].id));
      if (region) { setSelected({ blockId: region.id, imageId: images[0].id }); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-note-image-region="' + region.id + '"]')?.focus()); }
    })().catch(cause => { setError(cause instanceof Error ? cause.message : '图片粘贴失败，请重试'); throw cause; }).finally(() => { importing.current = undefined; setUploading(false); });
    void importing.current.catch(() => undefined);
  };
  const toolbar = <div className="user-note-edit-status"><span role="status">{status === 'saving' ? '正在保存…' : status === 'editing' ? '编辑中' : '已保存'}</span><span />
    <button type="button" disabled={!history.current.past.length || uploading} onClick={() => undo()} title="撤销 Ctrl+Z" aria-label="撤销笔记编辑"><Undo2 size={14} /></button>
    <button type="button" disabled={!history.current.future.length || uploading} onClick={() => undo(true)} title="重做 Ctrl+Shift+Z" aria-label="重做笔记编辑"><Redo2 size={14} /></button>
  </div>;
  return <div ref={root} className="user-note-editor" data-note-editor data-saving={status === 'saving' || undefined} aria-busy={uploading}
    onPaste={paste} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !cropTarget) void flush().catch(() => undefined); }}
    onContextMenu={event => { if (!props.onDelete || (event.target as HTMLElement).closest('[data-note-image-region]')) return; event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || composing.current || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void flush().catch(() => undefined); }
      if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') { event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === 'y'); }
    }}>
    {uploading && <div className="user-note-saving" role="status"><Loader2 size={13} className="note-spin" />正在保存粘贴的图片…</div>}
    {blocks.map((block, index) => block.type === 'text' ? <TextBlock key={block.id} block={block} label={index ? props.label + ' 文字段落 ' + (index + 1) : props.label} last={index === blocks.length - 1} locked={uploading} highlight={props.highlight} autoFocus={index === 0}
      scrollToMatch={!!props.highlight?.trim() && blocks.findIndex(item => item.type === 'text' && item.text.toLocaleLowerCase().includes(props.highlight!.trim().toLocaleLowerCase())) === index}
      onFocus={() => setSelected(undefined)} onComposition={value => { composing.current = value; if (value) clearTimeout(timer.current); else schedule(); }}
      onChange={value => change(current.current.map(item => item.id === block.id && item.type === 'text' ? { ...item, text: value } : item), 'text:' + block.id)} />
      : <ImageRegion key={block.id} block={block} locked={uploading} selected={selected?.blockId === block.id ? selected.imageId : undefined}
        onSelect={imageId => setSelected(imageId ? { blockId: block.id, imageId } : undefined)}
        onPatch={(imageId, update, gesture) => patchImage(block.id, imageId, update, gesture)}
        onStart={() => { clearTimeout(timer.current); remember(); }} onEnd={schedule}
        onCrop={image => setCropTarget({ blockId: block.id, image })}
        onRemove={imageId => { change(deleteNoteImage(current.current, block.id, imageId)); setSelected(undefined); }}
        onRaise={imageId => change(current.current.map(item => item.id === block.id && item.type === 'images' ? { ...item, images: [...item.images.filter(image => image.id !== imageId), ...item.images.filter(image => image.id === imageId)] } : item))} />)}
    {props.toolbarTarget ? createPortal(toolbar, props.toolbarTarget) : toolbar}
    {error && <div className="user-note-error" role="alert"><span>{error}</span><button type="button" onClick={() => void flush().catch(() => undefined)}>重试保存</button></div>}
    {menu && <PaperContextMenu {...menu} label="删除当前笔记页" onClose={() => setMenu(undefined)} onDelete={() => { setMenu(undefined); void props.onDelete?.().catch(cause => setError(String(cause))); }} />}
    {cropTarget && <CropDialog image={cropTarget.image} onClose={() => setCropTarget(undefined)} onApply={crop => {
      const old = cropTarget.image.crop ?? blankCrop;
      patchImage(cropTarget.blockId, cropTarget.image.id, fitNoteImage({ ...cropTarget.image, crop, width: cropTarget.image.width * (1 - crop.left - crop.right) / (1 - old.left - old.right), height: cropTarget.image.height * (1 - crop.top - crop.bottom) / (1 - old.top - old.bottom) }, Math.max(root.current!.clientWidth, cropTarget.image.width)));
      setCropTarget(undefined);
    }} />}
  </div>;
});
