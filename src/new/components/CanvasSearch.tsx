import { GraphSearchResultCopy } from './GraphSearchResultCopy';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, Folder, Search, Share2, X } from 'lucide-react';
import type { CanvasRecord, GraphState } from '@/v3/types';
import { buildCanvasSearchIndex, canvasSearchResult, findCanvasMatches } from '../graphSearch';
import { SearchField } from './SearchField';
import { canvasInteractionBlocked } from '../canvasInteractionScope';

const PAGE_SIZE = 24;

export function CanvasSearch({ state, canvas, onLocate }: { state: GraphState; canvas: CanvasRecord; onLocate: (id: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [kind, setKind] = useState('all');
  const [position, setPosition] = useState<CSSProperties>({});
  const input = useRef<HTMLInputElement>(null), shell = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const searching = open && !!query.trim();
  const index = useMemo(() => searching ? buildCanvasSearchIndex(state, canvas) : [], [searching, state, canvas]);
  const matches = useMemo(() => findCanvasMatches(index, query), [index, query]);
  const results = useMemo(() => kind === 'all' ? matches : matches.filter(({ result }) =>
    result.kind === kind || kind === 'subgraph' && result.kind === 'document'), [matches, kind]);
  const selectedIndex = Math.min(active, Math.max(0, results.length - 1));
  const start = Math.floor(selectedIndex / PAGE_SIZE) * PAGE_SIZE;
  const page = useMemo(() => results.slice(start, start + PAGE_SIZE).map(entry => canvasSearchResult(entry, query)),
    [results, start, query]);
  const resultList = useRef<HTMLDivElement>(null);
  const scrollToActive = useRef(false);
  const moveTo = (index: number) => {
    scrollToActive.current = true;
    setActive(Math.max(0, Math.min(index, results.length - 1)));
  };
  useEffect(() => { setOpen(false); setQuery(''); }, [canvas.canvasId]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useLayoutEffect(() => { if (resultList.current) resultList.current.scrollTop = 0; }, [query, kind, start]);
  useLayoutEffect(() => {
    if (scrollToActive.current) resultList.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    scrollToActive.current = false;
  }, [selectedIndex, open]);
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
  return <div ref={shell} className="canvas-search" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape' && open && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={toggle} type="button" data-canvas-search-toggle className={'canvas-search-toggle' + (open ? ' is-active' : '')} aria-label="搜索当前画布" aria-expanded={open} title="搜索当前画布（Ctrl+F）" onClick={() => setOpen(v => !v)}><Search size={16} aria-hidden="true" /></button>
    {open && <div className="canvas-search-popover" style={position} role="dialog" aria-label="搜索当前画布">
      <header>
        <SearchField ref={input} label="搜索节点、子图或关系" value={query} onChange={value => { setQuery(value); setActive(0); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveTo(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
          if (event.key === 'Enter' && results[selectedIndex]) { event.preventDefault(); locate(results[selectedIndex].result.id); }
        }} />
        <button type="button" aria-label="关闭画布搜索" onClick={close}><X size={15} /></button>
      </header>
      <div className="graph-search-filters" role="group" aria-label="搜索对象类型">{[['all','全部'],['node','节点'],['subgraph','子图'],['edge','关系']].map(([id,label]) => <button key={id} type="button" aria-pressed={kind === id} onClick={() => { setKind(id); setActive(0); }}>{label}</button>)}</div>
      <div className="graph-search-results new-scroll" ref={resultList}>
        {!query.trim() ? <p className="graph-search-empty">可搜索名称、正文和关系描述<br /><span>包含折叠与屏幕外的对象</span></p> : !results.length ? <div className="graph-search-empty" role="status">
          {matches.length ? <>当前类型没有匹配结果<br /><button type="button" className="graph-search-reset" onClick={() => {
            setKind('all'); setActive(0); input.current?.focus();
          }}>查看全部 {matches.length} 个结果</button></> : '当前画布没有匹配结果'}
        </div> : page.map((r,i) => {
          const Icon = r.kind === 'node' ? FileText : r.kind === 'edge' ? Share2 : Folder;
          const index = start + i;
          return <button key={r.id} type="button" data-canvas-search-result={r.id} className={'graph-search-result' + (index === selectedIndex ? ' is-active' : '')} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => locate(r.id)}>
            <Icon size={15} /><GraphSearchResultCopy result={r} query={query} /><ArrowUpRight size={14} className="graph-search-go" />
          </button>;
        })}
      </div>
      {!!results.length && <footer>
        <span role="status">{results.length > PAGE_SIZE ? `${start + 1}–${Math.min(start + PAGE_SIZE, results.length)} / ${results.length}` : `${results.length} 个结果`}</span>
        {results.length > PAGE_SIZE ? <div role="group" aria-label="搜索结果分页">
          <button type="button" aria-label="上一页结果" disabled={!start} onClick={() => moveTo(start - PAGE_SIZE)}><ChevronLeft size={14} /></button>
          <button type="button" aria-label="下一页结果" disabled={start + PAGE_SIZE >= results.length} onClick={() => moveTo(start + PAGE_SIZE)}><ChevronRight size={14} /></button>
        </div> : <span className="graph-search-shortcuts"><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 定位</span>}
      </footer>}
    </div>}
  </div>;
}
