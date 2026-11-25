import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StructureConflict, TransferChoice } from '@/v3/structure';
import type { GraphMutationResult } from '../graphActions';
import type { GraphState } from '@/v3/types';
import { getHierarchyIndex } from '@/v3/hierarchyIndex';
import { GraphNameLabel } from './GraphPathLabel';

const options: { id: TransferChoice; name: string; description: string }[] = [
  { id: 'cut', name: '剪切', description: '移除原父级关系，将原内容移到目标目录树。' },
  { id: 'copy-target', name: '复制方案1：目标位置使用普通目录副本', description: '原位置保留原图文档；目标位置使用独立副本，之后不再同步。' },
  { id: 'copy-source', name: '复制方案2：原位置保留普通目录副本', description: '在原位置留下独立副本，将原图文档移到目标目录树。' },
];
export function GraphTreeTransferDialog({ conflicts, state, targetId, onResolve, onCancel }: { conflicts: StructureConflict[]; state: GraphState; targetId?: string;
  onResolve: (choices: Record<string, TransferChoice>) => GraphMutationResult | Promise<GraphMutationResult>; onCancel: () => void }) {
  const [choices, setChoices] = useState<Record<string, TransferChoice>>({}); const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const hierarchy = useMemo(() => getHierarchyIndex(state), [state]);
  const targetRoot = targetId && (hierarchy.treeRoots.get(targetId) ?? targetId);
  // During registration the destination tree is still a canvas-local subgraph.
  const targetRecord = useMemo(() => targetRoot && (state.documents[targetRoot] ??
    state.canvases.find(canvas => canvas.directories[targetRoot])?.directories[targetRoot]), [state, targetRoot]);
  const nameLabel = (id: string | undefined, label: string) => id && state.documents[id]?.name === label
    ? <GraphNameLabel id={id} name={label} /> : label;
  const treeLabel = (id: string | undefined, name: string | undefined, label: string) => id && name && label === name + '目录树'
    ? <><GraphNameLabel id={id} name={name} />目录树</> : label;
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); onCancel(); } };
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true); }, [onCancel]);
  return createPortal(<div className="space-modal-backdrop fixed inset-0 z-[300] flex items-center justify-center" data-canvas-interactive onPointerDown={(event) => event.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label="跨目录树移动" data-tree-transfer className="w-[520px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] space-panel space-form flex flex-col">
      <header className="px-4 py-3 border-b border-white/10 text-sm font-semibold">跨目录树移动：请选择原位置的处理方式</header>
      <div className="min-h-0 overflow-y-auto new-scroll p-4 space-y-4 text-xs">
        {conflicts.map((conflict) => {
          const sourceRoot = hierarchy.treeRoots.get(conflict.id);
          return <div key={conflict.id} data-transfer-id={conflict.id} className="space-y-2">
          <p className="leading-6 text-amber-100">“{nameLabel(conflict.id, conflict.name)}”：
            {treeLabel(sourceRoot, sourceRoot && state.documents[sourceRoot]?.name, conflict.sourceTree)} → {treeLabel(targetRoot, targetRecord && targetRecord.name, conflict.targetTree)}
            <br /><span className="text-slate-400">原父目录：“{nameLabel(hierarchy.documentParents.get(conflict.id), conflict.sourceParent)}”{conflict.outsideCanvas ? '（在当前画布之外）' : ''}。剪切会修改原始目录，并同步影响其他引用画布。</span></p>
          {options.map((option) => <label key={option.id} className="flex items-start gap-2 rounded border border-slate-700 p-3 leading-5 cursor-pointer"><input type="radio" name={`transfer-${conflict.id}`} data-transfer-choice={option.id} checked={choices[conflict.id] === option.id} onChange={() => setChoices((old) => ({ ...old, [conflict.id]: option.id }))} /><span>{option.name}<span className="block text-slate-400">{option.description}</span></span></label>)}
          </div>;
        })}
        <p className="leading-5 text-slate-500">独立副本使用新目录、节点和内部关系；跨副本边界的关系保留在原内容上。</p>
        {error && <p role="alert" className="text-red-300">{error}</p>}
      </div>
      <footer className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 text-xs">
        <button type="button" data-transfer-cancel onClick={onCancel} className="rounded px-3 py-2 hover:bg-white/10">取消操作</button>
        <button type="button" data-transfer-confirm disabled={saving} onClick={async () => { if (saving) return; if (conflicts.some((item) => !choices[item.id])) { setError('请为每个跨树分支选择处理方案'); return; }
          setSaving(true); try { const result = await onResolve(choices); if (!result.ok) setError(result.error ?? '目录已变化，请重新确认'); }
          catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); } finally { setSaving(false); }
        }} className="space-primary-button px-4 py-2 disabled:opacity-50">{saving ? '保存中…' : '按所选方案执行'}</button>
      </footer>
    </section>
  </div>, document.body);
}
