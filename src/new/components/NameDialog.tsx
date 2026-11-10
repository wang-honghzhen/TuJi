import { useState } from 'react';
import { AiError, AiModal, useAction } from '@/ai/ui/common';

/** Native prompt is unavailable in Electron; keep naming and errors in the app. */
export function NameDialog({ title, label, initialName = '', submitLabel, onSubmit, onClose }: {
  title: string; label: string; initialName?: string; submitLabel: string;
  onSubmit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const action = useAction();
  return <AiModal title={title} onClose={() => { if (!action.busy) onClose(); }}>
    <form className="ai-column" data-name-dialog onSubmit={event => {
      event.preventDefault(); if (name.trim()) void action.run(() => onSubmit(name.trim()));
    }}>
      <label className="ai-label">{label}<input className="ai-input" data-name-input autoFocus required maxLength={1000}
        value={name} disabled={action.busy} onChange={event => setName(event.target.value)} /></label>
      <AiError text={action.error} />
      <div className="ai-row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="ai-button" disabled={action.busy} onClick={onClose}>取消</button>
        <button type="submit" className="ai-button ai-button-primary" data-name-submit disabled={action.busy || !name.trim()}>{action.busy ? '正在保存…' : submitLabel}</button>
      </div>
    </form>
  </AiModal>;
}
