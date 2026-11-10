import type { CanvasRecord, DesignNodeData, DesignNodeType, GraphState } from '@/v3/types';
import { DESIGN_LABELS } from '@/v3/design';
import { getStructurePaths } from '@/v3/structure';

export function DesignNodeFields({ value, onChange, state, canvas, nodeId }: { value: DesignNodeData; onChange: (value: DesignNodeData) => void; state: GraphState; canvas: CanvasRecord; nodeId?: string }) {
  const relationKey = value.type === 'combination' ? 'memberIds' : value.type === 'flow' ? 'subjectIds' : undefined;
  const selected = relationKey ? value[relationKey] ?? [] : [];
  const options = getStructurePaths(state, canvas).filter(row => row.kind === 'node' && row.id !== nodeId && (value.type === 'combination'
    ? state.nodes[row.id]?.design?.type === 'proposal' : ['proposal', 'combination'].includes(state.nodes[row.id]?.design?.type ?? '')));
  const hidden = selected.filter(id => !options.some(row => row.id === id));
  return <div className="space-y-4" data-design-fields>
    <fieldset><legend className="mb-2 text-slate-400">内容类型</legend><div className="grid grid-cols-4 gap-1">
      {(Object.entries(DESIGN_LABELS) as [DesignNodeType, string][]).map(([type, label]) => <button type="button" key={type} data-design-type={type} aria-pressed={value.type === type}
        className={`rounded border px-2 py-2 ${value.type === type ? 'border-blue-400/70 bg-blue-400/15 text-blue-100' : 'border-slate-700 text-slate-400'}`}
        onClick={() => onChange({ type, ...(type === 'combination' ? { ...(value.pros !== undefined ? { pros: value.pros } : {}), ...(value.cons !== undefined ? { cons: value.cons } : {}), memberIds: value.memberIds ?? [] } : {}), ...(type === 'flow' ? { subjectIds: value.subjectIds ?? [] } : {}) })}>{label}</button>)}
    </div></fieldset>
    {value.type === 'proposal' && <p className="text-slate-500 leading-5">正文说明设计内容，按需补充适用条件、依赖和限制。需要评价时直接写入正文。</p>}
    {value.type === 'combination' && <>
      <p className="text-slate-500 leading-5">结合目标与成员的相互影响评价，可暂时留空。</p>
      {(['pros', 'cons'] as const).map(key => <label key={key} className="block text-slate-400">{key === 'pros' ? '优点（可选）' : '缺点 / 代价（可选）'}<textarea data-design-field={key} className="ai-input mt-1 w-full text-sm" rows={3} value={value[key] ?? ''} onChange={event => onChange({ ...value, [key]: event.target.value })} /></label>)}
    </>}
    {relationKey && <fieldset><legend className="mb-2 text-slate-400">{value.type === 'combination' ? '成员方案' : '描述的方案或组合'}</legend>
      <div className="max-h-40 overflow-auto new-scroll space-y-2 rounded border border-slate-700 p-2">
        {options.map(row => <label key={row.id} className="flex gap-2 items-start break-words"><input type="checkbox" data-design-ref={row.id} checked={selected.includes(row.id)} onChange={event => onChange({ ...value, [relationKey]: event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id) })} /><span>{row.path}</span></label>)}
        {hidden.map(id => <label key={id} className="flex gap-2 text-slate-400"><input type="checkbox" checked onChange={() => onChange({ ...value, [relationKey]: selected.filter(ref => ref !== id) })} />当前画布外的已关联内容（取消勾选可解除）</label>)}
        {!options.length && !hidden.length && <p className="text-slate-500">尚无可关联的方案。可以先保存，再补充关联。</p>}
      </div>
      <p className="mt-2 text-slate-500 leading-5">{value.type === 'combination' ? '成员连线随选择自动更新。可先记录不完整的组合。' : '在正文中描述完整流程；这里指定流程对应的设计。'}</p>
    </fieldset>}
  </div>;
}
