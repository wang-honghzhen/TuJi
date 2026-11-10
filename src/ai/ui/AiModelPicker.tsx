import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { DEEPSEEK_MODELS, type ModelSelection, type ProviderConfig, type ThinkingEffort } from '../domain';

const efforts: Array<{ value: ThinkingEffort; label: string }> = [
  { value: 'none', label: '关闭思考' }, { value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'max', label: '最高' },
];
const modelName = (model: string) => DEEPSEEK_MODELS.find(option => option.id === model)?.name ?? model;

export function AiModelPicker({ provider, value, onChange }: { provider: ProviderConfig; value: ModelSelection; onChange: (selection: ModelSelection) => void }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const models = [...new Set([provider.model, ...(provider.apiFamily === 'deepseek' ? DEEPSEEK_MODELS.map(model => model.id) : [])])].filter(Boolean);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="ai-model-picker" ref={host}>
    <button type="button" className="ai-model-trigger" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="选择模型和思考强度" data-ai-model-picker>
      <span>{modelName(value.model)}</span><span className="ai-model-effort">{efforts.find(effort => effort.value === value.thinkingEffort)?.label}</span><ChevronDown size={13} />
    </button>
    {open && <div className="ai-model-menu" data-ai-model-menu>
      <p>模型</p>{models.map(model => <button type="button" key={model} data-ai-pick-model={model} aria-pressed={value.model === model} onClick={() => onChange({ ...value, model })}>{modelName(model)}{value.model === model && <Check size={13} />}</button>)}
      <p>思考强度</p><div className="ai-model-efforts">{efforts.map(effort => <button type="button" key={effort.value} data-ai-pick-effort={effort.value} aria-pressed={value.thinkingEffort === effort.value} onClick={() => { onChange({ ...value, thinkingEffort: effort.value }); setOpen(false); }}>{effort.label}</button>)}</div>
    </div>}
  </div>;
}
