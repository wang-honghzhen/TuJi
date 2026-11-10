import { DesignNodeFields } from './DesignNodeFields';
import { modeOf } from '@/v3/design';
import type { DesignNodeData } from '@/v3/types';
import { canvasDirectory } from '@/v3/canvas';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getCanvasNodeOptions } from '@/v3/layout';
import { getMoveTargets, getStructurePaths, ownershipNotice } from '@/v3/structure';
import { planDocumentImport } from '@/v3/canvasProjection';
import type { CanvasRecord, GraphState } from '@/v3/types';
import type { GraphActionRequest, GraphMutation, GraphMutationResult } from '../graphActions';
import { GraphChoiceField } from './GraphChoiceField';
import { GraphNameLabel, GraphPathLabel } from './GraphPathLabel';

const titles: Record<GraphActionRequest['type'], string> = { editDesign: '编辑设计信息', createNode: '创建节点', createEdge: '创建边', createSubgraph: '创建子图', group: '用所选创建子图', move: '移动到目录', deleteNode: '删除节点', deleteEdge: '删除边', deleteSubgraph: '删除子图', deleteDocument: '移出画布', replaceDocument: '替换为普通目录', registerDocument: '注册为图文档', importDocument: '引入图文档' };
export function GraphActionDialog({ request, state, canvas, onSubmit, onClose }: { request: GraphActionRequest; state: GraphState; canvas: CanvasRecord;
  onSubmit: (command: GraphMutation) => GraphMutationResult | Promise<GraphMutationResult>; onClose: () => void }) {
  const paths = getStructurePaths(state, canvas); const ids = request.ids ?? [];
  const parents = [...new Set(ids.map((id) => paths.find((item) => item.id === id)?.parentId))];
  const [parentId, setParentId] = useState(request.parentId ?? (request.type === 'group' && parents.length === 1 ? parents[0] ?? '' : request.type === 'group' || request.type === 'move' ? '' : canvas.canvasId));
  const [name, setName] = useState(''); const [content, setContent] = useState('');
  const [source, setSource] = useState(request.sourceId ?? ''); const [target, setTarget] = useState('');
  const [direction, setDirection] = useState('none');
  const [mode, setMode] = useState<'cascade' | 'promote' | ''>(''); const [acknowledged, setAcknowledged] = useState(false); const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [design, setDesign] = useState<DesignNodeData>(state.nodes[request.id ?? '']?.design ?? { type: 'proposal' });
  const originalDesign = useRef(state.nodes[request.id ?? '']?.design);
  const [importMode, setImportMode] = useState<'reference' | 'snapshot' | ''>('');
  const [position, setPosition] = useState({ x: Math.max(8, (innerWidth - 390) / 2), y: Math.max(8, (innerHeight - 420) / 2) });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; width: number; height: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const notice = (request.type === 'group' || request.type === 'move') && parentId ? ownershipNotice(state, canvas, ids, parentId) : null;
  const deleting = ['replaceDocument', 'deleteNode', 'deleteEdge', 'deleteSubgraph', 'deleteDocument'].includes(request.type);
  const simple = request.type === 'editDesign' || request.type === 'importDocument' || request.type === 'registerDocument';
  const nodes = getCanvasNodeOptions(state, canvas).map((item) => ({ id: item.id, label: item.path, segments: item.segments }));
  const targets = getMoveTargets(state, canvas, ids).map((item) => ({ id: item.id, label: item.path, segments: item.segments }));
  let mergedReferences = 0;
  if (request.type === 'importDocument') {
    try { mergedReferences = planDocumentImport(state, canvas, request.id!).mergedNodeIds.length; } catch { /* Submit reports the complete conflict. */ }
  }
  useLayoutEffect(() => {
    const clamp = () => { const rect = panel.current?.getBoundingClientRect(); if (!rect) return;
      setPosition((old) => { const next = { x: Math.max(8, Math.min(innerWidth - rect.width - 8, old.x)), y: Math.max(8, Math.min(innerHeight - rect.height - 8, old.y)) };
        return next.x === old.x && next.y === old.y ? old : next; }); };
    clamp(); const observer = new ResizeObserver(clamp); if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', clamp); return () => { observer.disconnect(); window.removeEventListener('resize', clamp); };
  }, []);
  useEffect(() => { setAcknowledged(false); }, [parentId]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (modals.length && modals[modals.length - 1] !== panel.current) return;
      if (event.key === 'Escape' && !event.isComposing && !document.querySelector('[data-choice-menu]')) { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  useEffect(() => {
    if (!deleting) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-action-cancel]')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []).filter(element => element.offsetParent !== null);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap);
    return () => { window.removeEventListener('keydown', trap); previous?.focus(); };
  }, [deleting]);
  const submit = async () => {
    if (saving) return;
    if (notice && !acknowledged) { setError('请先确认节点归属变化'); return; }
    let command: GraphMutation;
    if (request.type === 'editDesign') command = { type: 'updateDesignNode', id: request.id!, design, expectedDesign: originalDesign.current };
    else if (request.type === 'createEdge') {
      if (!source || !target || source === target) { setError('请选择两个不同的节点'); return; }
      const reversed = direction === 'reverse';
      command = { type: 'createEdge', input: { sourceNodeId: reversed ? target : source, targetNodeId: reversed ? source : target,
        directed: direction !== 'none', edgeContent: content } };
    } else if (request.type === 'createNode' || request.type === 'createSubgraph' || request.type === 'group') {
      if (!name.trim() || !parentId) { setError('请填写名称并选择目标路径'); return; }
      command = request.type === 'createNode' ? { type: 'createNode', parentId, name, content, point: request.point, ...(modeOf(canvas) === 'design' ? { design } : {}) } :
        { type: 'createSubgraph', parentId, name, content, ids: request.type === 'group' ? ids : [], point: request.point };
    } else if (request.type === 'move') {
      if (!parentId) { setError('请选择目标路径'); return; } command = { type: 'move', ids, parentId };
    } else if (request.type === 'importDocument') {
      if (!importMode) { setError('请选择引入形式'); return; }
      command = { type: 'importDocument', id: request.id!, mode: importMode, point: request.point };
    } else if (request.type === 'registerDocument') command = { type: 'registerDocument', id: request.id! };
    else if (request.type === 'replaceDocument') command = { type: 'replaceDocument', id: request.id! };
    else if (request.type === 'deleteDocument') command = { type: 'deleteDocument', id: request.id!, mode: 'detach' }; else if (request.type === 'deleteSubgraph') {
      if (!mode) { setError('请选择子图删除方式'); return; } command = { type: 'deleteSubgraph', id: request.id!, mode };
    } else if (request.type === 'deleteNode' || request.type === 'deleteEdge') command = { type: request.type, id: request.id! };
    else return;
    setSaving(true);
    try { const result = await onSubmit(command); if (result.ok) onClose(); else setError(result.pending ? '' : result.error ?? '保存失败，请重试'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  };
  return createPortal(<>{deleting && <div className="space-modal-backdrop fixed inset-0 z-[240]" data-canvas-interactive onPointerDown={event => event.stopPropagation()} />}
    <section ref={panel} data-canvas-interactive data-graph-dialog={request.type} role="dialog" aria-modal={deleting} aria-label={titles[request.type]}
    className="space-panel space-form fixed z-[250] w-[390px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] flex flex-col"
    style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    <header data-action-drag className="flex items-center justify-between px-4 py-3 border-b border-white/10 cursor-grab select-none touch-none"
      onPointerDown={(event) => { if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect(); event.preventDefault(); drag.current = { x: position.x, y: position.y, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { const old = drag.current; if (!old) return; event.preventDefault(); setPosition({ x: Math.max(8, Math.min(innerWidth - old.width - 8, old.x + event.clientX - old.startX)), y: Math.max(8, Math.min(innerHeight - old.height - 8, old.y + event.clientY - old.startY)) }); }}
      onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { drag.current = null; }}>
      <h2 className="text-sm font-semibold">{titles[request.type]}</h2><button type="button" aria-label="取消" onClick={onClose}>×</button>
    </header>
    <div className="space-dialog-body min-h-0 overflow-y-auto new-scroll space-y-4 text-xs">
      {request.type === 'createEdge' ? <>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-1 items-center">
          <GraphChoiceField field="source" value={source} options={nodes.filter((item) => item.id !== target)} onChange={setSource} placeholder="选择起点" />
          <GraphChoiceField field="direction" value={direction} options={[{ id: 'reverse', label: '←' }, { id: 'forward', label: '→' }, { id: 'none', label: '—' }]} onChange={setDirection} placeholder="方向" searchable={false} />
          <GraphChoiceField field="target" value={target} options={nodes.filter((item) => item.id !== source)} onChange={setTarget} placeholder="选择终点" />
        </div>
      </> : !deleting && !simple && <div className="space-y-1 text-slate-400"><div>路径</div>
        {request.type === 'createNode' && request.origin === 'canvas' ? <div data-fixed-parent className="break-words"><GraphPathLabel segments={paths.find((item) => item.id === parentId)?.segments ?? []} /></div> :
          <GraphChoiceField field="parent" value={parentId} options={targets} onChange={setParentId} placeholder={request.type === 'group' && parents.length > 1 ? '节点来自不同目录，请选择路径' : '选择目标路径'} />}
      </div>}
      {['createNode', 'createSubgraph', 'group'].includes(request.type) && <label className="block text-slate-400">名称<input data-action-name autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={request.type === 'createNode' ? '节点名称' : '子图名称'} className="mt-1 w-full rounded border border-slate-700 bg-slate-900/40 px-2 py-2 text-[13px] text-blue-100 outline-none focus:border-blue-400" /></label>}
      {['createNode', 'createSubgraph', 'group', 'createEdge'].includes(request.type) && <label className="block text-slate-400">{request.type === 'createEdge' ? '关系描述' : request.type === 'createNode' ? '节点内容' : '子图说明'}
        <textarea data-action-content value={content} onChange={(event) => setContent(event.target.value)} rows={5} className="mt-1 w-full rounded border border-slate-700 bg-slate-900/30 px-2 py-2 text-[14px] leading-6 text-slate-200 outline-none focus:border-blue-400 resize-y" /></label>}
      {modeOf(canvas) === 'design' && ['createNode', 'editDesign'].includes(request.type) && <DesignNodeFields value={design} onChange={setDesign} state={state} canvas={canvas} nodeId={request.id} />}
      {request.type === 'editDesign' && originalDesign.current?.type === 'combination' && design.type !== 'combination' && (originalDesign.current.pros || originalDesign.current.cons) && <p className="text-slate-400 leading-5">切换类型后，已保存的组合评价会保留在正文中。</p>}
      {request.type === 'move' || request.type === 'group' ? <div className="text-slate-400">已选择 {ids.length} 项；选中父子项时只处理父级一次。</div> : null}
      {notice && <label className="block rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 leading-5 text-amber-200" data-ownership-warning>{notice}<span className="flex gap-2 mt-2 items-start"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} data-ownership-ack />我已了解归属变化</span></label>}
      {request.type === 'importDocument' && <div className="space-y-3">
        <p className="leading-5">将“<GraphNameLabel id={request.id!} name={state.documents[request.id!]?.name ?? request.id!} />”引入当前画布，请选择形式：</p>
        {mergedReferences > 0 && <p data-import-merge-notice className="leading-5 text-amber-200">以图文档形式引入时，画布中已有的 {mergedReferences} 个共享节点入口将并入文档目录，节点数据和关系会保留。</p>}
        {([{ id: 'reference', title: '以图文档形式引入', description: '引用原始图文档；修改会同步影响原数据和其他引用画布。' },
          { id: 'snapshot', title: '以子图形式引入', description: '复制为独立普通子图；包括内部文档、节点和内部关系，后续修改不影响源图文档。' }] as const).map((item) =>
          <label key={item.id} className="flex gap-2 rounded border border-slate-700 p-3 leading-5"><input type="radio" name="import-mode" data-import-mode={item.id} checked={importMode === item.id} onChange={() => setImportMode(item.id)} /><span>{item.title}<span className="block text-slate-400">{item.description}</span></span></label>)}
      </div>}
      {request.type === 'registerDocument' && <p className="leading-6 text-slate-300">将“<GraphNameLabel id={request.id!} name={canvasDirectory(canvas, request.id!)?.name ?? state.documents[request.id!]?.name ?? request.id!} />”注册为图文档，保留内容和位置，并加入右侧图文档列表。{modeOf(canvas) === 'design' ? '设计图文档不可嵌套；请选择画布目录下且不包含其他图文档的子图。' : '图文档路径下的子图仍留在原目录树；画布局部子图成为新的目录树根。若内部引用需要跨树迁移，将额外询问处理方案。'}{canvas.nodeReferenceIds?.some((id) => paths.some((row) => row.id === id && row.segments.some((segment) => segment.id === request.id))) && <span className="block mt-2 text-amber-200">此子图包含共享节点引用。注册会将这些节点的原始归属转移到新图文档，原目录不再拥有它们，已有画布节点引用保留。</span>}</p>}
      {request.type === 'deleteDocument' && <p className="leading-6 text-slate-300">将此图文档移出当前画布。原图文档及其他画布中的引用保留，可从右侧图文档列表重新引入。</p>}
      {request.type === 'replaceDocument' && <div className="space-y-3 leading-6 text-slate-300">
        <p>将此图文档的完整内容和内部关系复制为独立普通目录，替换当前画布中的入口。原图文档和其他画布保留，后续修改互不影响。</p>
        <p>当前内容的会话短代指尽量延续；仍在画布其他位置显示的原对象保留代指，其副本另行编号。历史记录保留原版本，正在运行的会话会暂停，继续时重新核对内容。</p>
        {paths.find(row => row.id === request.id)?.parentId && !canvasDirectory(canvas, paths.find(row => row.id === request.id)!.parentId!) &&
          <p className="text-amber-200">此图文档嵌套在共享目录中；替换后原分支在当前画布隐藏，独立副本放到画布根目录，尽量保留画布位置。</p>}
      </div>}
      {request.type === 'deleteSubgraph' && <div className="space-y-2">
        <div className="text-amber-200 leading-5">{state.documents[request.id!] ? '删除原始子图会同步影响所有引用画布。嵌套的完整图文档仅解除该分支关系，保留原文档数据。失效关系边会自动清理。' : '移除当前画布局部子图。连带删除其局部节点、子图；其中图文档入口仅移出本画布，保留原数据。失效关系边会自动清理。'}</div>
        {(['cascade', 'promote'] as const).map((item) => <label key={item} className="flex gap-2 rounded border border-slate-700 px-3 py-2 leading-5"><input type="radio" name="delete-mode" data-delete-mode={item} checked={mode === item} onChange={() => setMode(item)} />{item === 'cascade' ? '连带删除子图及其所有节点、子图' : '仅移除当前子图，孩子保留并提升到父级'}</label>)}
      </div>}
      {request.type === 'deleteNode' && <div className="text-amber-200 leading-5">删除“<GraphNameLabel id={request.id!} name={state.nodes[request.id!]?.name ?? request.id!} />”及连接它的关系边。图文档内节点的删除会同步影响所有引用画布。</div>}
      {request.type === 'deleteEdge' && <div className="text-slate-300 leading-5">删除该关系边，保留两端节点。</div>}
      {error && <div role="alert" className="text-red-300 leading-5">{error}</div>}
    </div>
    <footer className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 text-xs"><button type="button" data-action-cancel onClick={onClose} className="rounded px-3 py-2 hover:bg-white/10">取消</button>
      <button type="button" data-action-confirm disabled={saving} onClick={() => { void submit(); }} className={`px-4 py-2 disabled:opacity-50 ${deleting ? 'space-danger-button' : 'space-primary-button'}`}>{saving ? '保存中…' : '确定'}</button></footer>
  </section></>, document.body);
}
