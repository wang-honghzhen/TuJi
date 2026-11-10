import { canvasDirectory } from '@/v3/canvas';
import { useEffect, useMemo, useState } from 'react';
import { useId } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import type { CanvasRecord, GraphState } from '@/v3/types';
import { getStructurePaths, getMoveTargets } from '@/v3/structure';
import type { GraphActionRequest } from '../graphActions';
import { GraphContextMenu, type GraphMenuItem } from './GraphContextMenu';
import { GraphNameLabel } from './GraphPathLabel';
import { connectionLevel, nodeConnectionCounts } from '@/v3/nodeConnections';
import { nodeAccents, subgraphAccent } from '../graphAppearance';

interface Props {
  canvas: CanvasRecord | null; state: GraphState | null;
  onNavigate: (id: string) => void;
  onAction: (request: GraphActionRequest) => void;
  onMove: (ids: string[], parentId: string) => void;
  onNotice: (message: string) => void;
  onOrganize?: (regionId: string) => void;
}
export function NewCanvasDirectoryPanel({ canvas, state, onNavigate, onAction, onMove, onNotice, onOrganize }: Props) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState('');
  const [dropId, setDropId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ position: { x: number; y: number }; items: GraphMenuItem[] } | null>(null);
  const gradientId = useId().replace(/:/g, '');
  const paths = useMemo(() => canvas && state ? getStructurePaths(state, canvas) : [], [canvas, state]);
  const connections = useMemo(() => state ? nodeConnectionCounts(state.edges) : new Map<string, number>(), [state?.edges]);
  const parents = new Map(paths.map((item) => [item.id, item.parentId]));
  const rows = paths.filter((item) => {
    let parent = item.parentId;
    while (parent) { if (closed.has(parent)) return false; parent = parents.get(parent); }
    return true;
  });
  useEffect(() => { setSelected(new Set()); setActive(''); setClosed(new Set()); setMenu(null); }, [canvas?.canvasId]);
  useEffect(() => { setSelected((ids) => new Set([...ids].filter((id) => paths.some((row) => row.id === id)))); }, [paths]);
  if (!canvas || !state) return null;
  const root = canvas.canvasId;
  const canSelect = (id: string) => paths.some((row) => row.id === id && row.kind !== 'root');
  const directoryFor = (id: string) => { const row = paths.find((item) => item.id === id); return !row ? root : row.kind === 'node' ? row.parentId ?? root : id; };
  const request = (type: GraphActionRequest['type'], extras: Partial<GraphActionRequest> = {}) => {
    onAction({ type, origin: 'directory', ...extras }); setMenu(null);
  };
  const openMenu = (event: React.MouseEvent, id = root) => {
    event.preventDefault(); event.stopPropagation(); setActive(id);
    const row = paths.find((item) => item.id === id);
    const ids = selected.has(id) ? [...selected] : canSelect(id) ? [id] : [];
    if (!selected.has(id)) setSelected(new Set(ids));
    const parentId = directoryFor(id);
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
    <svg width="0" height="0" aria-hidden="true" className="absolute"><defs>
      <linearGradient id={gradientId}><stop stopColor="#60a5fa" /><stop offset="1" stopColor="#a78bfa" /></linearGradient>
      <linearGradient id={`${gradientId}-document`}><stop stopColor="#f4d27a" /><stop offset="1" stopColor="#f6aa55" /></linearGradient>
    </defs></svg>
    <div role="tree" aria-label="画布目录" aria-multiselectable className="flex-1 min-h-0 overflow-y-auto new-scroll px-2 py-2" onClick={(event) => { if (event.target === event.currentTarget) { setSelected(new Set()); setActive(''); } }}>
      {rows.map((row) => {
        const node = row.kind === 'node'; const fullDocument = row.kind === 'document';
        const connectionCount = node ? connections.get(row.id) ?? 0 : undefined;
        const Icon = node ? FileText : Folder;
        const children = canvasDirectory(canvas, row.id)?.childIds ?? (state.documents[row.id] ? [...state.documents[row.id].childDocumentIds, ...state.documents[row.id].childNodeIds] : []);
        const name = row.id === root ? canvas.canvasName : canvasDirectory(canvas, row.id)?.name ?? state.documents[row.id]?.name ?? state.nodes[row.id]?.name ?? row.id;
        let depth = 0; let ancestor = row.parentId;
        while (ancestor) { depth++; ancestor = parents.get(ancestor); }
        return <div key={row.id} data-directory-item={row.id} role="treeitem" aria-selected={selected.has(row.id)}
          tabIndex={0} draggable={canSelect(row.id)}
          className={`flex items-center min-h-7 rounded text-slate-300 cursor-pointer select-none outline-none ${dropId === row.id ? 'ring-1 ring-blue-300 bg-blue-500/25' : selected.has(row.id) ? 'bg-blue-500/20' : active === row.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
          style={{ paddingLeft: depth * 13 }} title={node ? `${row.path}\n连接：${connectionCount} 条（整个项目）` : row.path}
          onClick={(event) => {
            event.stopPropagation();
            if (event.shiftKey && active) {
              const start = rows.findIndex((item) => item.id === active); const end = rows.findIndex((item) => item.id === row.id);
              setSelected(new Set([...selected, ...rows.slice(Math.min(start, end), Math.max(start, end) + 1).filter((item) => canSelect(item.id)).map((item) => item.id)]));
            } else if (event.ctrlKey || event.metaKey) {
              if (canSelect(row.id)) setSelected((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; });
              setActive(row.id);
            } else { setSelected(new Set(canSelect(row.id) ? [row.id] : [])); setActive(row.id); }
          }}
          onDoubleClick={(event) => { event.stopPropagation(); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) onNavigate(row.id); }}
          onKeyDown={(event) => { if (event.key === 'Enter') onNavigate(row.id); if (event.key === 'Delete' && row.kind !== 'root') request(node ? 'deleteNode' : fullDocument ? 'deleteDocument' : 'deleteSubgraph', { id: row.id }); }}
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
          <button type="button" aria-label={closed.has(row.id) ? '展开目录' : '折叠目录'} disabled={!children.length} className="w-4 shrink-0 text-slate-500 disabled:opacity-0"
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); setClosed((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; }); }}>
            {closed.has(row.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <Icon size={13} data-directory-icon={row.kind} color={row.kind === 'root' ? `url(#${gradientId})` : fullDocument ? `url(#${gradientId}-document)` : 'currentColor'}
            style={{ color: node ? nodeAccents[connectionLevel(connectionCount!)] : subgraphAccent }} />
          <GraphNameLabel id={row.id} name={name} kind={row.kind} className="ml-1.5 truncate text-xs" />
        </div>;
      })}
    </div>
    {menu && <GraphContextMenu {...menu} onClose={() => setMenu(null)} />}
  </div>;
}
