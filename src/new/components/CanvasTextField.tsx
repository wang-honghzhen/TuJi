import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { soundForHandledInsertion } from '../uiSoundEvents';
import { CanvasTextPreview } from './CanvasTextPreview';
import { canvasTextMetrics } from '../canvasTextPresentation';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { registerCanvasEditor } from '../canvasEditFlush';

export type TextTarget = { kind: 'node'; id: string; field: 'name' | 'content' } | { kind: 'edge'; id: string; field: 'edgeContent' };
export type TextSurface = 'canvas' | 'detail';
export interface TextSession {
  target: TextTarget; draft: string; original: string; start: number; end: number;
  backward: boolean; surface: TextSurface;
  commit: (target:TextTarget,value:string)=>boolean|Promise<boolean>;
}
export const textKey = (target: TextTarget) => `${target.kind}:${target.id}:${target.field}`;

export type EditOccupancyCallback = (refId: string, field: TextTarget['field'], active: boolean, expectedValue?: string) => void | Promise<unknown>;
export function useCanvasEditing(onCommit: (target: TextTarget, value: string) => boolean | Promise<boolean>, onOccupancy?: EditOccupancyCallback,canvasId?:string) {
  const [session, setSession] = useState<TextSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(session); current.current = session;
  const commitCallback = useRef(onCommit); commitCallback.current = onCommit;
  const occupancy = useRef(onOccupancy); occupancy.current = onOccupancy;
  const pending = useRef<Promise<boolean> | null>(null);
  const beginSequence = useRef(0);
  const startingTarget = useRef<TextTarget | null>(null);
  const finish = useCallback(async (save = true, target?: TextTarget): Promise<boolean> => {
    const old = current.current;
    if (!old) return true;
    if (target && textKey(old.target) !== textKey(target)) return true;
    if (pending.current) return pending.current;
    if (!save || old.draft === old.original) { current.current = null; setSession(null); setError(''); return true; }
    setSaving(true); setError('');
    const operation = (async () => {
      try {
        if (!await old.commit(old.target, old.draft)) { setError('保存失败，输入已保留。'); return false; }
        const latest = current.current;
        if (latest && textKey(latest.target) === textKey(old.target)) {
          if (latest.draft !== old.draft) { const next = { ...latest, original: old.draft }; current.current = next; setSession(next); return false; }
          current.current = null; setSession(null);
        }
        return true;
      } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，输入已保留。'); return false; }
      finally { pending.current = null; setSaving(false); }
    })();
    pending.current = operation;
    return operation;
  }, []);
  const begin = useCallback(async (target: TextTarget, value: string, surface: TextSurface, offset: number): Promise<boolean> => {
    const commit=commitCallback.current;
    const sequence = ++beginSequence.current;
    startingTarget.current = target;
    const old = current.current; const same = old && textKey(old.target) === textKey(target);
    if (!same && !await finish()) { if (sequence === beginSequence.current) startingTarget.current = null; return false; }
    if (sequence !== beginSequence.current) return false;
    if (!same) {
      try { await occupancy.current?.(target.id, target.field, true, value); }
      catch (reason) { if (sequence === beginSequence.current) { startingTarget.current = null; setError(reason instanceof Error ? reason.message : '无法登记编辑占用，请重试。'); } return false; }
      if (sequence !== beginSequence.current) { void Promise.resolve(occupancy.current?.(target.id, target.field, false)).catch(() => undefined); return false; }
    }
    const draft = same ? old.draft : value; const start = Math.max(0, Math.min(draft.length, offset));
    const next = { target, draft, original: same ? old.original : value, start, end: start, backward: false, surface,commit:same?old.commit:commit };
    startingTarget.current = null; current.current = next; setSession(next); setError(''); return true;
  }, [finish]);
  useEffect(()=>canvasId?registerCanvasEditor(canvasId,finish):undefined,[canvasId,finish]);
  const change = useCallback((draft: string, start: number, end: number, backward = false) => {
    setSession((old) => {
      if (!old || (old.draft === draft && old.start === start && old.end === end && old.backward === backward)) return old;
      const next = { ...old, draft, start, end, backward }; current.current = next; return next;
    });
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const starting = startingTarget.current;
      if (starting && !(event.target instanceof Element && event.target.closest(`[data-text-key="${CSS.escape(textKey(starting))}"]`))) { beginSequence.current++; startingTarget.current = null; }
      const old = current.current;
      if (old && !(event.target instanceof Element && event.target.closest(`[data-text-key="${CSS.escape(textKey(old.target))}"]`))) void finish();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [finish]);
  const occupiedKey = session ? textKey(session.target) : '';
  useEffect(() => {
    if (!occupiedKey) return;
    const target = current.current?.target;
    if (!target) return;
    const timer = setInterval(() => { void Promise.resolve(occupancy.current?.(target.id, target.field, true)).catch(() => setError('编辑占用同步失败，输入已保留。')); }, 30000);
    return () => { clearInterval(timer); void Promise.resolve(occupancy.current?.(target.id, target.field, false)).catch(() => undefined); };
  }, [occupiedKey]);
  return { session, begin, change, finish, saving, error };
}

type Editing = ReturnType<typeof useCanvasEditing>;
const Context = createContext<Editing | null>(null);
export const CanvasEditingProvider = Context.Provider;

function offsetIn(element: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset); return range.toString().length;
}
function clickOffset(element: HTMLElement, event: ReactPointerEvent): number {
  const caretDocument = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const range = caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
  return range && element.contains(range.startContainer) ? offsetIn(element, range.startContainer, range.startOffset) : element.textContent?.length ?? 0;
}

interface Props {
  target: TextTarget; value: string; surface: TextSurface; className?: string; placeholder?: string;
  onActivate: (ctrlKey?: boolean) => boolean | void | Promise<boolean | void>; multiline?: boolean;
  zoom?: number; fontSize?: number; maxLines?: number; wrap?: boolean; style?: CSSProperties;
}

/** Only the inspector owns a draft. Canvas text stays a committed, clipped preview. */
export function CanvasTextField({ target, value, surface, className = '', placeholder = '暂无内容', onActivate, multiline = true, zoom = 1, fontSize, maxLines, wrap = false, style: fieldStyle }: Props) {
  const editing = useContext(Context)!;
  const element = useRef<HTMLDivElement | HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const session = editing.session; const matching = surface === 'detail' && session && textKey(session.target) === textKey(target);
  const active = Boolean(surface === 'detail' && matching && session.surface === surface);
  const draft = matching ? session.draft : value;
  const previewContent = useMemo(() => draft || <span className="text-slate-500">{placeholder}</span>, [draft, placeholder]);
  const textRole = target.kind === 'edge' ? 'edge' : target.field === 'name' ? 'title' : 'body';
  const metrics = canvasTextMetrics(textRole, zoom, fontSize);
  const syncSelection = () => {
    const root = element.current;
    if (!active || !(root instanceof HTMLTextAreaElement)) return;
    editing.change(root.value, root.selectionStart, root.selectionEnd, root.selectionDirection === 'backward');
  };
  useEffect(() => {
    if (!active) return;
    document.addEventListener('selectionchange', syncSelection);
    return () => document.removeEventListener('selectionchange', syncSelection);
  }, [active, editing.change]);
  useLayoutEffect(() => {
    const root = element.current; if (!root || !matching || composing.current) return;
    if (active && root instanceof HTMLTextAreaElement && !editing.saving) {
      root.focus({ preventScroll: true });
      if (root.selectionStart !== session.start || root.selectionEnd !== session.end || (root.selectionDirection === 'backward') !== session.backward)
        root.setSelectionRange(session.start, session.end, session.backward ? 'backward' : 'forward');
      if (surface === 'detail') { root.style.height = 'auto'; root.style.height = `${root.scrollHeight}px`; }
    }
  }, [active, matching, session, editing.saving]);
  const common = {
    'data-canvas-interactive': true, 'data-text-key': textKey(target), 'data-text-surface': surface,
    'data-text-content': Boolean(draft), 'data-text-editing': Boolean(matching), 'data-selection-start': matching ? session.start : undefined,
    'data-text-saving': Boolean(matching && editing.saving),
    'data-selection-end': matching ? session.end : undefined,
    className: `${className} ${matching ? 'canvas-text-editing' : surface === 'canvas' ? 'cursor-default' : 'cursor-text'}`,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if (surface === 'canvas') return;
      event.stopPropagation();
      if (event.ctrlKey) { event.preventDefault(); void onActivate(true); return; }
      const offset = draft ? clickOffset(event.currentTarget, event) : 0;
      if (!active) {
        event.preventDefault();
        void Promise.resolve(onActivate(false)).then((allowed) => { if (allowed !== false) return editing.begin(target, value, surface, offset); }).catch(() => undefined);
      } else void onActivate(false);
    },
  };
  const style = { position: 'relative' as const, outline: 'none', whiteSpace: surface === 'canvas' && !wrap ? 'pre' as const : 'pre-wrap' as const,
    wordBreak: wrap ? 'break-all' as const : undefined,
    textOverflow: surface === 'canvas' && !wrap ? 'ellipsis' : undefined,
    fontSize: fontSize === undefined ? undefined : metrics.fontSize,
    lineHeight: fontSize === undefined ? undefined : `${metrics.lineHeight}px`,
    ...fieldStyle,
    overflow: surface === 'canvas' ? 'hidden' : undefined, userSelect: active ? 'text' as const : 'none' as const };
  return active ? <textarea {...common} ref={(root) => { element.current = root; }} value={draft} rows={1} readOnly={editing.saving}
    aria-label={target.field === 'name' ? '节点名' : target.kind === 'edge' ? '边内容' : '节点内容'} spellCheck={false}
    className={`${common.className} block w-full bg-transparent resize-none border-0`}
    style={style} onChange={syncSelection} onSelect={syncSelection} onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; syncSelection(); }}
    onBlur={() => { requestAnimationFrame(() => { if (active && document.activeElement?.getAttribute('data-text-key') !== textKey(target)) editing.finish(true, target); }); }}
    onPaste={(event) => {
      if (multiline || event.currentTarget.readOnly) return;
      event.preventDefault();
      const root = event.currentTarget, text = event.clipboardData.getData('text/plain').replace(/\r?\n/g, ' ');
      root.setRangeText(text, root.selectionStart, root.selectionEnd, 'end'); syncSelection();
      soundForHandledInsertion(root, text, event.nativeEvent.isTrusted);
    }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || composing.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing.finish(false); }
      else if (event.key === 'Enter') {
        event.stopPropagation();
        if (!multiline || event.ctrlKey || event.metaKey) { event.preventDefault(); editing.finish(); }
      }
    }} /> : <div {...common} ref={(root) => { element.current = root; }} style={style}>
    {surface === 'canvas' && fontSize !== undefined ? <CanvasTextPreview zoom={zoom} wrap={wrap} textRole={textRole}
      fontSize={metrics.fontSize} lineHeight={metrics.lineHeight} maxLines={maxLines}>
      {previewContent}
    </CanvasTextPreview> : previewContent}
  </div>;
}
