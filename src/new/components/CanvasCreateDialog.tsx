import { useState } from 'react';
import { AiModal } from '@/ai/ui/common';
import type { CanvasMode } from '@/v3/types';

export function CanvasCreateDialog({ onCreate, onClose }: { onCreate: (name: string, mode: CanvasMode) => void; onClose: () => void }) {
  const [name, setName] = useState(''), [mode, setMode] = useState<CanvasMode>('explore');
  return <AiModal title="新建画布" onClose={onClose}><form className="ai-column" onSubmit={event => { event.preventDefault(); if (name.trim()) onCreate(name.trim(), mode); }}>
    <label className="ai-column">画布名称<input data-canvas-name autoFocus className="ai-input" maxLength={1000} required value={name} onChange={event => setName(event.target.value)} placeholder="给这次探索或设计起个名字" /></label>
    <fieldset className="ai-column"><legend className="mb-2">画布模式</legend>
      {([{ value: 'explore', title: '探索', text: '积累知识，梳理概念与关系。' }, { value: 'design', title: '设计', text: '记录方案、组合与流程，比较优缺点和取舍。' }] as const).map(item => <label key={item.value} className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${mode === item.value ? 'border-blue-400/60 bg-blue-400/10' : 'border-white/10'}`}>
        <input type="radio" name="canvas-mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} />
        <span>{item.title}<span className="block text-xs text-slate-400 mt-1">{item.text}</span></span>
      </label>)}
    </fieldset>
    <p className="ai-muted">普通会话自动沿用画布模式。临时会话仍从独立入口创建。模式创建后固定。</p>
    <div className="ai-row justify-end"><button type="button" className="ai-button" onClick={onClose}>取消</button><button type="submit" data-create-canvas-confirm disabled={!name.trim()} className="ai-button ai-button-primary">创建画布</button></div>
  </form></AiModal>;
}
