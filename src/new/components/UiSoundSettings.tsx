import { useState } from 'react';
import { useAiStore } from '@/ai/client';
import { AiError, useAction } from '@/ai/ui/common';
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from '@/shared/soundSettings';
import { uiAudio } from '../uiAudio';

export function UiSoundSettings() {
  const saved = useAiStore(state => state.snapshot?.soundSettings);
  const command = useAiStore(state => state.command);
  const [draft, setDraft] = useState<SoundSettings>(() => ({ ...DEFAULT_SOUND_SETTINGS, ...saved }));
  const [notice, setNotice] = useState('');
  const action = useAction();
  const patch = (value: Partial<SoundSettings>) => { setDraft(previous => ({ ...previous, ...value })); setNotice(''); };
  return <section className="ai-card ai-column" aria-label="界面音效" data-ui-sound-settings>
    <h3>界面音效</h3>
    <label className="ai-check"><input type="checkbox" data-sound-buttons checked={draft.buttonSounds} onChange={event => patch({ buttonSounds: event.target.checked })} />按钮悬停：宝石碰撞声</label>
    <label className="ai-check"><input type="checkbox" data-sound-input checked={draft.inputSounds} onChange={event => patch({ inputSounds: event.target.checked })} />文字输入：宝石旋律</label>
    <label className="ai-label">音量：{Math.round(draft.volume * 100)}%
      <input type="range" min={0} max={100} step={1} aria-label="音效音量" data-sound-volume value={Math.round(draft.volume * 100)}
        onChange={event => patch({ volume: Number(event.target.value) / 100 })} className="w-full accent-blue-400" />
    </label>
    <p className="ai-muted">中文选词上屏后响一次。音效可离线使用，保存后生效并在重启后保留。</p>
    <p className="ai-muted">宝石旋律随输入间隔变化：快打时连贯轻快，慢打时音程舒展，停顿后开启新乐句。</p>
    <div className="ai-row">
      <button type="button" className="ai-button" data-sound-preview="button" data-ui-sound="off" disabled={!draft.buttonSounds || draft.volume === 0}
        onClick={() => { uiAudio.unlock(); uiAudio.play('button', draft.volume); }}>试听碰撞声</button>
      <button type="button" className="ai-button" data-sound-preview="input" data-ui-sound="off" disabled={!draft.inputSounds || draft.volume === 0}
        onClick={() => { uiAudio.unlock(); uiAudio.play('input', draft.volume); }}>试听宝石旋律</button>
      <button type="button" className="ai-button ai-button-primary" data-sound-save disabled={action.busy}
        onClick={() => void action.run(async () => { await command('settings.sound', draft); setNotice('音效设置已保存。'); })}>{action.busy ? '正在保存…' : '保存音效设置'}</button>
    </div>
    {notice && <p role="status" className="ai-muted">{notice}</p>}
    <AiError text={action.error} />
    <details className="ai-muted"><summary>音效来源</summary>
      <p>碰撞声：Kenney · Impact Sounds · CC0。</p>
      <p>宝石旋律：以碰撞声叠加项目内合成的定音共鸣，保留清脆起音与短余音。</p>
      <p>碰撞素材授权：creativecommons.org/publicdomain/zero/1.0/。</p>
    </details>
  </section>;
}
