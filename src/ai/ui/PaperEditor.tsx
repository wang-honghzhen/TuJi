import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { AiError } from './common';
import './notebook.css';

export type PaperRevision = number | string;
export interface PaperEditorHandle { flush: () => Promise<void>; remove: () => Promise<void> }
export const PaperSaveScope = createContext<MutableRefObject<Map<symbol, () => Promise<void>>> | null>(null);

export function PaperContextMenu({ x, y, label, onDelete, onClose }: {
  x: number; y: number; label: string; onDelete: () => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8))}px`;
    const previous = document.activeElement as HTMLElement | null;
    element.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); previous?.focus(); }
    };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); window.removeEventListener('resize', onClose); };
  }, []);
  return <div ref={menu} role="menu" className="paper-context-menu" onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" onClick={onDelete}>{label}</button>
  </div>;
}

/** Serial autosave keeps typing during a request and never replaces an unsaved draft with a remote update. */
export const PaperEditor = forwardRef<PaperEditorHandle, {
  text: string; version: PaperRevision; label: string; placeholder?: string; className?: string;
  autoFocus?: boolean; readOnly?: boolean; allowTab?: boolean; deleteLabel?: string;
  save: (text: string, version: PaperRevision) => Promise<{ text: string; version: PaperRevision }>;
  onDelete?: (version: PaperRevision) => Promise<void | { text: string; version: PaperRevision }>; onNext?: () => void;
}>(function PaperEditor(props, ref) {
  const [value, setValue] = useState(props.text), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const input = useRef<HTMLTextAreaElement>(null), current = useRef(value), saved = useRef({ text: props.text, version: props.version });
  const options = useRef(props); options.current = props;
  const pending = useRef<Promise<void>>(), timer = useRef<ReturnType<typeof setTimeout>>(), composing = useRef(false), removing = useRef(false);
  const scope = useContext(PaperSaveScope), api = useRef<PaperEditorHandle>(null!), key = useRef(Symbol());
  const clearTimer = () => { clearTimeout(timer.current); timer.current = undefined; };
  const flush = (): Promise<void> => {
    clearTimer();
    if (pending.current) return pending.current;
    if (removing.current || options.current.readOnly || current.current === saved.current.text) return Promise.resolve();
    setBusy(true); setError('');
    const request = async () => {
      while (!removing.current && !composing.current && current.current !== saved.current.text) {
        const next = current.current;
        const result = await options.current.save(next, saved.current.version);
        saved.current = result;
        if (current.current === next) { current.current = result.text; setValue(result.text); }
      }
    };
    pending.current = request().catch(cause => { setError(cause instanceof Error ? cause.message : '保存失败，文字仍保留在此处'); throw cause; })
      .finally(() => { pending.current = undefined; setBusy(false); });
    return pending.current;
  };
  const remove = async () => {
    if (removing.current || !options.current.onDelete) return;
    removing.current = true; clearTimer(); setMenu(undefined); setError('');
    try {
      await pending.current?.catch(() => undefined);
      const result = await options.current.onDelete(saved.current.version);
      if (result) { saved.current = result; current.current = result.text; setValue(result.text); }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); throw cause; }
    finally { removing.current = false; }
  };
  api.current = { flush, remove };
  useImperativeHandle(ref, () => ({ flush: () => api.current.flush(), remove: () => api.current.remove() }), []);
  useEffect(() => {
    const token = key.current; scope?.current.set(token, () => api.current.flush());
    return () => { scope?.current.delete(token); clearTimer(); };
  }, [scope]);
  useEffect(() => {
    if (!pending.current && current.current === saved.current.text) {
      saved.current = { text: props.text, version: props.version }; current.current = props.text; setValue(props.text);
    }
  }, [props.text, props.version]);
  useLayoutEffect(() => {
    const element = input.current; if (!element) return;
    const resize = () => { element.style.height = '0px'; element.style.height = `${Math.ceil(element.scrollHeight / 32) * 32}px`; };
    resize(); const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; resize(); } });
    let width = element.clientWidth; observer.observe(element); return () => observer.disconnect();
  }, [value]);
  const schedule = () => { clearTimer(); if (!composing.current) timer.current = setTimeout(() => { void api.current.flush().catch(() => undefined); }, 650); };
  const change = (next: string) => { current.current = next; setValue(next); setError(''); schedule(); };
  return <div className={`paper-editor ${props.className ?? ''}`} data-saving={busy || undefined}
    onContextMenu={event => {
      if (!props.onDelete || props.readOnly) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: event.clientX || rect.left + 20, y: event.clientY || rect.top + 20 });
    }}>
    <textarea ref={input} aria-label={props.label} aria-invalid={!!error} data-paper-input rows={1} spellCheck={false}
      autoFocus={props.autoFocus} readOnly={props.readOnly} value={value} placeholder={props.placeholder}
      onChange={event => change(event.target.value)} onBlur={() => { if (!menu) void flush().catch(() => undefined); }}
      onCompositionStart={() => { composing.current = true; clearTimer(); }} onCompositionEnd={() => { composing.current = false; schedule(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || props.readOnly) return;
        if (event.key === 'Tab' && props.allowTab && !event.shiftKey) {
          event.preventDefault(); const element = event.currentTarget, start = element.selectionStart;
          element.setRangeText('\t', start, element.selectionEnd, 'end'); change(element.value);
          requestAnimationFrame(() => element.setSelectionRange(start + 1, start + 1));
        }
        if (event.key === 'Enter' && !event.shiftKey && props.onNext) { event.preventDefault(); void flush().then(props.onNext).catch(() => undefined); }
        if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void flush().catch(() => undefined); }
      }} />
    <AiError text={error} />
    {menu && <PaperContextMenu {...menu} label={props.deleteLabel ?? '删除这条笔记'} onClose={() => setMenu(undefined)} onDelete={() => { void remove().catch(() => undefined); }} />}
  </div>;
});
