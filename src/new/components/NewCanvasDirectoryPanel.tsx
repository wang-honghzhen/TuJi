import { GraphSearchResultCopy } from './GraphSearchResultCopy';
import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import { buildCanvasSearchIndex, canvasSearchResult, findCanvasMatches } from '../graphSearch';
import { SearchField, type PanelSearchProps } from './SearchField';
import type { CanvasRecord, GraphState } from '@/v3/types';
import { getStructurePaths, getMoveTargets } from '@/v3/structure';
import type { GraphActionRequest } from '../graphActions';
import { GraphContextMenu, type GraphMenuItem } from './GraphContextMenu';
import { GraphNameLabel } from './GraphPathLabel';
import { useGraphAppearance } from '../graphAppearance';
import './directory-tree.css';

interface Props extends PanelSearchProps {
  canvas: CanvasRecord | null; state: GraphState | null;
  onNavigate: (id: string) => void;
  onAction: (request: GraphActionRequest) => void;
  onMove: (ids: string[], parentId: string) => void;
  onNotice: (message: string) => void;
  onOrganize?: (regionId: string) => void;
}
export function NewCanvasDirectoryPanel({ canvas, state, onNavigate, onAction, onMove, onNotice, onOrganize, query: controlledQuery, onQueryChange, showSearch = true }: Props) {
  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery, setQuery = onQueryChange ?? setLocalQuery;
  const searching = Boolean(query.trim());
  const searchIndex = useMemo(() => searching && canvas && state ? buildCanvasSearchIndex(state, canvas, false) : [], [canvas, state, searching]);
  const matches = useMemo(() => findCanvasMatches(searchIndex, query).map(entry => canvasSearchResult(entry, query)), [searchIndex, query]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState('');
  const [focusedId, setFocusedId] = useState('');
  const [dropId, setDropId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ position: { x: number; y: number }; items: GraphMenuItem[] } | null>(null);
  const appearance = useGraphAppearance();
  const gradientId = useId().replace(/:/g, '');
  const paths = useMemo(() => canvas && state ? getStructurePaths(state, canvas) : [], [canvas, state]);
  const byId = useMemo(() => new Map(paths.map(item => [item.id, item])), [paths]);
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { parentId } of paths) if (parentId) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    return counts;
  }, [paths]);
  const rows = useMemo(() => {
    if (!closed.size) return paths;
    // Paths are in preorder. Skip each collapsed branch until its next sibling or ancestor.
    let collapsedLevel = Infinity;
    return paths.filter(row => {
      const level = row.segments.length;
      if (level > collapsedLevel) return false;
      collapsedLevel = closed.has(row.id) ? level : Infinity;
      return true;
    });
  }, [paths, closed]);
  useEffect(() => { setSelected(new Set()); setActive(''); setFocusedId(''); setClosed(new Set()); setMenu(null); setLocalQuery(''); }, [canvas?.canvasId]);
  useEffect(() => { setSelected(ids => [...ids].every(id => byId.has(id)) ? ids : new Set([...ids].filter(id => byId.has(id)))); }, [byId]);
  if (!canvas || !state) return null;
  const root = canvas.canvasId;
  const tabStop = rows.some(row => row.id === focusedId) ? focusedId : root;
  const toggleFolder = (id: string) => setClosed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelection = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const request = (type: GraphActionRequest['type'], extras: Partial<GraphActionRequest> = {}) => {
    onAction({ type, origin: 'directory', ...extras }); setMenu(null);
  };
  const locateResult = (id: string) => {
    setSelected(new Set([id]));
    setActive(id);
    setFocusedId(id);
    setClosed(current => {
      if (!current.size) return current;
      const next = new Set(current);
      byId.get(id)?.segments.slice(0, -1).forEach(segment => next.delete(segment.id));
      return next;
    });
    onNavigate(id);
  };
  const openMenu = (event: React.MouseEvent, id = root) => {
    event.preventDefault(); event.stopPropagation(); setActive(id);
    const row = byId.get(id);
    const ids = selected.has(id) ? [...selected] : row && row.kind !== 'root' ? [id] : [];
    if (!selected.has(id)) setSelected(new Set(ids));
    const parentId = !row ? root : row.kind === 'node' ? row.parentId ?? root : id;
    const items: GraphMenuItem[] = [
      { key: 'createNode', label: '新建节点', run: () => request('createNode', { parentId }) },
      { key: 'createSubgraph', label: '新建子图', run: () => request('createSubgraph', { parentId }) },
    ];
    if (onOrganize) items.push({ key: 'organize', label: '整理此目录…', run: () => { setMenu(null); onOrganize(parentId); } });
    if (ids.length) items.push(
      { key: 'group', label: '将所选项组成新子图…', run: () => request('group', { ids }) },
      { key: 'move', label: '移动所选项到…', run: () => request('move', { ids }) });
    if (row?.kind === 'node') items.push({ key: 'deleteNode', label: '删除节点', danger: true, run: () => request('deleteNode', { id }) });
    if (row?.kind === 'subgraph') items.push(
      { key: 'registerDocument', label: '将选中子图注册为图文档', run: () => request('registerDocument', { id }) },
      { key: 'deleteSubgraph', label: '删除子图…', danger: true, run: () => request('deleteSubgraph', { id }) });
    if (row?.kind === 'document') items.push(
      { key: 'detachDocument', label: '移出画布', run: () => request('deleteDocument', { id }) },
      { key: 'replaceDocument', label: '将图文档替换成普通目录', run: () => request('replaceDocument', { id }) });
    setMenu({ position: { x: event.clientX, y: event.clientY }, items });
  };
  return <div className="h-full min-h-0 flex flex-col" data-canvas-directory onContextMenu={(event) => openMenu(event)}>
    {showSearch && <div className="graph-search-inset" onContextMenu={event => event.stopPropagation()}><SearchField label="搜索当前目录中的节点和子图" placeholder="搜索节点、子图…" value={query} onChange={setQuery} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') setQuery('');
      if (event.key === 'Enter' && matches[0]) locateResult(matches[0].id);
    }} /></div>}
    <svg width="0" height="0" aria-hidden="true" className="absolute"><defs>
      <linearGradient id={gradientId}><stop stopColor="#60a5fa" /><stop offset="1" stopColor="#a78bfa" /></linearGradient>
      <linearGradient id={`${gradientId}-document`}><stop stopColor="#f4d27a" /><stop offset="1" stopColor="#f6aa55" /></linearGradient>
    </defs></svg>
    {searching ? <><div className="graph-search-count" aria-live="polite"><span>{matches.length} 个结果</span><span>当前画布</span></div>
      <div className="graph-search-results directory-search-list new-scroll">
        {!matches.length && <p className="graph-search-empty">没有匹配的节点或子图</p>}
        {matches.map(result => { const Icon = result.kind === 'node' ? FileText : Folder;
          return <button type="button" key={result.id} data-directory-search-result={result.id} className="graph-search-result" onClick={() => locateResult(result.id)}>
            <Icon size={14} /><GraphSearchResultCopy result={result} query={query} /><ArrowUpRight size={13} className="graph-search-go" /></button>;
        })}
      </div></> : <><div role="tree" aria-label="画布目录" aria-multiselectable className={`directory-tree min-h-0 overflow-y-auto new-scroll px-2 py-2 ${paths.length > 1 ? 'flex-1' : ''}`} onClick={(event) => { if (event.target === event.currentTarget) { setSelected(new Set()); setActive(''); } }}>
      {rows.map((row, index) => {
        const node = row.kind === 'node'; const fullDocument = row.kind === 'document';
        const { accent, count } = appearance(row.id, row.kind);
        const childCount = childCounts.get(row.id) ?? 0;
        const expanded = childCount > 0 && !closed.has(row.id);
        const Icon = node ? FileText : expanded ? FolderOpen : Folder;
        const depth = row.segments.length - 1;
        const selectable = row.kind !== 'root';
        return <div key={row.id} data-directory-item={row.id} role="treeitem" aria-selected={selectable ? selected.has(row.id) : undefined}
          aria-label={row.segments[depth].name} aria-level={depth + 1} aria-expanded={childCount ? expanded : undefined}
          tabIndex={row.id === tabStop ? 0 : -1} draggable={selectable} onFocus={() => setFocusedId(row.id)}
          className={`flex items-center min-h-7 rounded text-slate-300 cursor-pointer select-none outline-none ${dropId === row.id ? 'ring-1 ring-blue-300 bg-blue-500/25' : selected.has(row.id) ? 'bg-blue-500/20' : active === row.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
          style={{ paddingInlineStart: `min(${depth * 13}px, 38%)` }} title={count !== undefined ? `${row.path}\n${node ? '连接' : '跨子图连接'}：${count} 条（整个项目）` : row.path}
          onClick={(event) => {
            event.stopPropagation();
            const start = event.shiftKey ? rows.findIndex(item => item.id === active) : -1;
            if (start >= 0) {
              setSelected(new Set([...selected, ...rows.slice(Math.min(start, index), Math.max(start, index) + 1).filter((item) => item.kind !== 'root').map((item) => item.id)]));
            } else if (event.ctrlKey || event.metaKey) {
              if (selectable) toggleSelection(row.id);
              setActive(row.id);
            } else { setSelected(new Set(selectable ? [row.id] : [])); setActive(row.id); }
          }}
          onDoubleClick={(event) => { event.stopPropagation(); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) onNavigate(row.id); }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
            const item = event.currentTarget;
            let target: Element | null = null;
            switch (event.key) {
              case 'ArrowUp': target = item.previousElementSibling; break;
              case 'ArrowDown': target = item.nextElementSibling; break;
              case 'Home': target = item.parentElement?.firstElementChild ?? null; break;
              case 'End': target = item.parentElement?.lastElementChild ?? null; break;
              case 'ArrowRight':
                if (expanded) target = item.nextElementSibling;
                else if (childCount) toggleFolder(row.id);
                break;
              case 'ArrowLeft':
                if (expanded) toggleFolder(row.id);
                else if (row.parentId) target = item.parentElement?.querySelector(`[data-directory-item="${CSS.escape(row.parentId)}"]`) ?? null;
                break;
              case ' ': if (selectable) { toggleSelection(row.id); setActive(row.id); } break;
              case 'Enter': onNavigate(row.id); break;
              case 'Delete': if (selectable) request(node ? 'deleteNode' : fullDocument ? 'deleteDocument' : 'deleteSubgraph', { id: row.id }); break;
              default: return;
            }
            event.preventDefault(); event.stopPropagation();
            if (target instanceof HTMLElement) target.focus();
          }}
          onContextMenu={(event) => openMenu(event, row.id)}
          onDragStart={(event) => {
            const ids = selected.has(row.id) ? [...selected] : [row.id];
            setSelected(new Set(ids)); setActive(row.id);
            event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/qixue-items', JSON.stringify({ canvasId: canvas.canvasId, ids }));
          }}
          onDragOver={(event) => { if (!node && event.dataTransfer.types.includes('application/qixue-items')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropId(row.id); } }}
          onDragLeave={() => setDropId((id) => id === row.id ? null : id)}
          onDragEnd={() => setDropId(null)}
          onDrop={(event) => {
            if (node) return;
            event.preventDefault(); event.stopPropagation(); setDropId(null);
            let ids: string[] = [];
            try { const data = JSON.parse(event.dataTransfer.getData('application/qixue-items')); if (data.canvasId === canvas.canvasId) ids = data.ids; } catch { return; }
            if (!ids.length) return;
            if (!getMoveTargets(state, canvas, ids).some((target) => target.id === row.id)) { onNotice('不能移入自身或自己的子目录'); return; }
            onMove(ids, row.id); setClosed((current) => { const next = new Set(current); next.delete(row.id); return next; });
          }}>
          {childCount ? <button type="button" tabIndex={-1} aria-label={expanded ? '折叠目录' : '展开目录'} className="directory-disclosure"
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); event.currentTarget.parentElement?.focus({ preventScroll: true }); toggleFolder(row.id); }}>
            <ChevronRight size={14} aria-hidden="true" />
          </button> : <span className="directory-leaf-guide" aria-hidden="true" />}
          <Icon size={13} data-directory-icon={row.kind} color={row.kind === 'root' ? `url(#${gradientId})` : fullDocument ? `url(#${gradientId}-document)` : 'currentColor'}
            style={{ color: accent }} />
          <GraphNameLabel id={row.id} name={row.segments[depth].name} kind={row.kind} className="ml-1.5 truncate text-xs" />
          {childCount > 0 && !expanded && <span className="directory-child-count" title={`${childCount} 个直接子项`}>{childCount}</span>}
        </div>;
      })}
    </div>
    {paths.length === 1 && <div className="directory-empty">
      <p>此画布的目录还是空的</p>
      <div><button type="button" onClick={() => request('createNode', { parentId: root })}><FilePlus2 size={14} />新建节点</button>
        <button type="button" onClick={() => request('createSubgraph', { parentId: root })}><FolderPlus size={14} />新建子图</button></div>
    </div>}</>}
    {menu && <GraphContextMenu {...menu} onClose={() => setMenu(null)} />}
  </div>;
}
