import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, FileText, Folder, Search, Share2, X } from 'lucide-react';
import type { CanvasRecord, GraphState } from '@/v3/types';
import { searchCanvas } from '../graphSearch';
import { SearchField, SearchHighlight } from './SearchField';
import { canvasInteractionBlocked } from '../canvasInteractionScope';

export function CanvasSearch({ state, canvas, onLocate }: { state: GraphState; canvas: CanvasRecord; onLocate: (id: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [kind, setKind] = useState('all');
  const [position, setPosition] = useState<CSSProperties>({});
  const input = useRef<HTMLInputElement>(null), shell = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => searchCanvas(state, canvas, query).filter(r => kind === 'all' || r.kind === kind || kind === 'subgraph' && r.kind === 'document'), [state, canvas, query, kind]);
  useEffect(() => { setOpen(false); setQuery(''); }, [canvas.canvasId]);
  useEffect(() => setActive(0), [query, kind]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { setActive(index => Math.max(0, Math.min(index, results.length - 1))); }, [results.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = toggle.current?.getBoundingClientRect(); if (!anchor) return;
      const width = Math.min(390, window.innerWidth - 24);
      const top = Math.max(12, Math.min(anchor.bottom + 10, window.innerHeight - 220));
      setPosition({ left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)), top, width, maxHeight: window.innerHeight - top - 12 });
    };
    measure(); const observer = new ResizeObserver(measure);
    if (shell.current?.parentElement) observer.observe(shell.current.parentElement);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [open]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || canvasInteractionBlocked(event.target, true)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !(event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]')) {
        event.preventDefault(); setOpen(true); input.current?.focus();
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!shell.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { setOpen(false); toggle.current?.focus(); };
  const locate = (id: string) => { onLocate(id); close(); };
  return <div ref={shell} className="canvas-search" onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape' && open && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={toggle} type="button" data-canvas-search-toggle className={'canvas-search-toggle' + (open ? ' is-active' : '')} aria-label="搜索当前画布" aria-expanded={open} title="搜索当前画布（Ctrl+F）" onClick={() => setOpen(v => !v)}><Search size={15} /><span>搜索</span></button>
    {open && <div className="canvas-search-popover" style={position} role="dialog" aria-label="搜索当前画布">
      <header><span>搜索当前画布</span><button type="button" aria-label="关闭画布搜索" onClick={close}><X size={15} /></button></header>
      <SearchField ref={input} label="搜索节点、子图或关系" value={query} onChange={setQuery} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(a => Math.max(0, Math.min(results.length - 1, a + (event.key === 'ArrowDown' ? 1 : -1)))); }
        if (event.key === 'Enter' && results[active]) { event.preventDefault(); locate(results[active].id); }
      }} />
      <div className="graph-search-filters" aria-label="搜索对象类型">{[['all','全部'],['node','节点'],['subgraph','子图'],['edge','关系']].map(([id,label]) => <button key={id} type="button" aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div>
      <div className="graph-search-results new-scroll" aria-live="polite">
        {!query.trim() ? <p className="graph-search-empty">输入名称、正文或关系描述<br /><span>包含折叠与屏幕外的对象</span></p> : !results.length ? <p className="graph-search-empty">当前画布没有匹配结果</p> : results.map((r,i) => {
          const Icon = r.kind === 'node' ? FileText : r.kind === 'edge' ? Share2 : Folder;
          return <button key={r.id} type="button" data-canvas-search-result={r.id} className={'graph-search-result' + (i === active ? ' is-active' : '')} onMouseEnter={() => setActive(i)} onClick={() => locate(r.id)} ref={el => { if (el && i === active) el.scrollIntoView({ block: 'nearest' }); }}>
            <Icon size={15} /><span className="graph-search-result-copy"><strong><SearchHighlight text={r.name} query={query} /></strong><small title={r.path}>{r.path}</small>{r.detail && <span><SearchHighlight text={r.detail} query={query} /></span>}</span><ArrowUpRight size={14} className="graph-search-go" />
          </button>;
        })}
      </div>
      {query.trim() && <footer>{results.length} 个结果<span>↑ ↓ 选择 · Enter 定位</span></footer>}
    </div>}
  </div>;
}
