import { useState } from 'react';
import { AiError, AiModal, useAction } from '@/ai/ui/common';

export function DraftCanvasLeaveDialog({ onSave, onKeep, onCancel }: {
  onSave: (name: string) => Promise<void>; onKeep: () => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState('未命名画布');
  const action = useAction();
  return <AiModal title="是否另存临时画布？" dismissible={false} onClose={onCancel}>
    <div className="ai-column" data-draft-leave-dialog>
      <p className="ai-muted">可以另存为正式画布，或不另存并继续切换。选择“不保存”仍会保留临时内容。</p>
      <label className="ai-label">另存画布名称<input className="ai-input" value={name} onChange={event => setName(event.target.value)} maxLength={80} data-draft-save-name /></label>
      <AiError text={action.error} />
      <div className="ai-row" style={{ justifyContent: 'flex-end' }}>
        <button className="ai-button" disabled={action.busy} onClick={() => void action.run(onKeep)} data-draft-leave-keep>不保存</button>
        <button className="ai-button ai-button-primary" disabled={action.busy || !name.trim()} onClick={() => void action.run(() => onSave(name.trim()))} data-draft-leave-save>另存为画布</button>
      </div>
    </div>
  </AiModal>;
}
