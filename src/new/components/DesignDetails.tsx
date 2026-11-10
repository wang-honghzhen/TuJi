import type { DesignNodeData } from '@/v3/types';

export function DesignDetails({ data, endpointName, onEdit }: { data: DesignNodeData; endpointName: (id: string) => string; onEdit?: () => void }) {
  return <div className="mt-4 border-t border-white/10 pt-3 space-y-3 text-sm" data-design-details>
    {data.type === 'combination' && <>
      {data.pros?.trim() && <div><p className="text-xs text-slate-400 mb-1">优点</p><p>{data.pros}</p></div>}
      {data.cons?.trim() && <div><p className="text-xs text-slate-400 mb-1">缺点 / 代价</p><p>{data.cons}</p></div>}
    </>}
    {(data.type === 'combination' || data.type === 'flow') && <div><p className="text-xs text-slate-400 mb-1">{data.type === 'combination' ? '成员方案' : '描述的方案或组合'}</p>
      {(data.type === 'combination' ? data.memberIds : data.subjectIds)?.length ? <ul className="list-disc pl-4">{(data.type === 'combination' ? data.memberIds : data.subjectIds)!.map(id => <li key={id}>{endpointName(id)}</li>)}</ul> : <p className="text-slate-500">尚未关联</p>}
    </div>}
    {onEdit && <button type="button" data-edit-design className="ai-button text-xs" onClick={onEdit}>编辑设计信息</button>}
  </div>;
}
