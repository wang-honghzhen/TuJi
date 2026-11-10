import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Database, Download, Network, Palette, Settings, Upload, Volume2 } from 'lucide-react';
import { useAiStore } from '../client';
import { DEFAULT_PROVIDER, type ProviderConfig } from '../domain';
import { AiError, downloadJson, useAction } from './common';
import { AiCredentialInput } from './AiCredentialInput';
import { UiSoundSettings } from '@/new/components/UiSoundSettings';
import { CanvasBackgroundSettings } from '@/new/components/CanvasBackgroundSettings';
import { useNewUiStore } from '@/new/newUiStore';

const tabs = [{ id: 'model', label: '模型连接', icon: Network }, { id: 'personalization', label: '个性化', icon: Palette }, { id: 'appearance', label: '音效', icon: Volume2 }, { id: 'data', label: '数据', icon: Database }] as const;
type SettingsTab = typeof tabs[number]['id'];

export function AiSettingsDialog() {
  const open = useAiStore(state => state.settingsOpen);
  return open ? <SettingsContent /> : null;
}

function SettingsContent() {
  const snapshot = useAiStore(state => state.snapshot);
  const close = useAiStore(state => state.setSettingsOpen);
  const command = useAiStore(state => state.command);
  const sidebarWidth = useNewUiStore(state => state.leftWidth);
  const [tab, setTab] = useState<SettingsTab>('model');
  const [provider, setProvider] = useState<ProviderConfig>({ ...(snapshot?.provider ?? DEFAULT_PROVIDER), contextPresetTokens: undefined, workNotesPercent: undefined });
  const [credential, setCredential] = useState('');
  const [backup, setBackup] = useState<unknown>();
  const [backupName, setBackupName] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);
  const [notice, setNotice] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLElement>(null);
  const action = useAction();
  const patch = (value: Partial<ProviderConfig>) => { setProvider(previous => ({ ...previous, ...value })); setNotice(''); };
  useEffect(() => () => { setCredential(''); }, []);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const workspace = document.getElementById('root'), previousInert = workspace?.inert ?? false;
    // The settings page is portalled beside the workspace, which keeps its view and drafts mounted.
    if (workspace) workspace.inert = true;
    page.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault(); close(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      if (workspace) workspace.inert = previousInert;
      previousFocus?.focus();
    };
  }, [close]);
  const chooseTab = (next: SettingsTab) => { setTab(next); setNotice(''); action.setError(''); };
  const saveModel = () => void action.run(async () => {
    await command('settings.save', { provider: { protocol: provider.protocol, model: provider.model.trim(), baseUrl: provider.baseUrl.trim() }, ...(credential.trim() ? { credential: credential.trim() } : {}) });
    setCredential(''); setNotice('设置已保存。');
  });
  return createPortal(<section ref={page} className="ai-settings-page" aria-label="应用设置" tabIndex={-1} data-ai-settings-page
    style={{ '--settings-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <aside className="ai-settings-sidebar" data-ai-settings-sidebar aria-label="设置导航">
      <button type="button" className="ai-settings-back" data-ai-settings-back onClick={() => close(false)} aria-label="返回工作区"><ArrowLeft size={17} />返回</button>
      <div className="ai-settings-brand"><span><Settings size={20} /></span><div><p>图记</p><h2>应用设置</h2></div></div>
      <nav className="ai-settings-tabs" role="tablist" aria-label="设置分类" aria-orientation="vertical">{tabs.map((item, index) => {
        const Icon = item.icon;
        return <button key={item.id} type="button" id={'settings-tab-' + item.id} role="tab" aria-selected={tab === item.id} aria-controls={'settings-panel-' + item.id}
          tabIndex={tab === item.id ? 0 : -1} data-settings-tab={item.id} onClick={() => chooseTab(item.id)}
          onKeyDown={event => {
            const target = ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % tabs.length : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (target < 0) return; event.preventDefault(); chooseTab(tabs[target].id); document.getElementById('settings-tab-' + tabs[target].id)?.focus();
          }}><Icon size={17} aria-hidden="true" /><span>{item.label}</span></button>;
      })}</nav>
    </aside>
    <main className="ai-settings-main" data-ai-settings-content>
      <header className="ai-settings-heading"><div><p>应用设置</p><h1>{tabs.find(item => item.id === tab)?.label}</h1></div></header>
      <div className="ai-settings-scroll new-scroll"><div className="ai-settings-form">
    <section role="tabpanel" id="settings-panel-model" aria-labelledby="settings-tab-model" hidden={tab !== 'model'} className="ai-column">
      <div className="ai-settings-intro"><h3>连接你使用的模型</h3><p className="ai-muted">密钥在本机加密保存；留空保留已有密钥。</p></div>
      <label className="ai-label">API 基础地址<input type="url" className="ai-input" value={provider.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com" data-ai-base-url /></label>
      <label className="ai-label">模型名称<input className="ai-input" value={provider.model} onChange={event => patch({ model: event.target.value })} placeholder="填写提供方支持的模型 ID" data-ai-model /></label>
      <label className="ai-label">API 密钥{snapshot?.credentialConfigured ? '（已保存；留空保留）' : '（尚未配置）'}<AiCredentialInput value={credential} onChange={setCredential} placeholder={snapshot?.credentialConfigured ? '输入新密钥以替换' : '输入密钥'} /></label>
      <label className="ai-label">API 协议<select className="ai-input" value={provider.protocol} onChange={event => patch({ protocol: event.target.value as ProviderConfig['protocol'] })} data-ai-protocol><option value="responses">Responses API</option><option value="chat-completions">Chat Completions API</option></select></label>
      <p className="ai-muted">连接信息保存到本地配置。上下文窗口（默认 500k）、摘要 AI、联网 API 和高级参数统一在本地数据目录的 api-config.json 中设置，修改文件后重启应用生效。</p>
    </section>
    <section role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" hidden={tab !== 'appearance'} className="ai-column">
      <UiSoundSettings />
    </section>
    <section role="tabpanel" id="settings-panel-personalization" aria-labelledby="settings-tab-personalization" hidden={tab !== 'personalization'} className="ai-column">
      {tab === 'personalization' && <CanvasBackgroundSettings />}
    </section>
    <section role="tabpanel" id="settings-panel-data" aria-labelledby="settings-tab-data" hidden={tab !== 'data'} className="ai-column">
      <div className="ai-settings-intro"><h3>画布数据导入导出</h3><p className="ai-muted">备份目录、图文档、节点与关系；不包含会话、消息和附件。</p></div>
      <div className="ai-card ai-column"><h3>导出备份</h3><p className="ai-muted">将当前画布数据保存为 JSON 文件。</p>
        <div className="ai-row"><button className="ai-button" disabled={action.busy} onClick={() => void action.run(async () => { const result = await command('backup.export'); downloadJson(result, 'QIXUE-canvas-' + new Date().toISOString().slice(0, 10) + '.json'); })}><Download size={14} />导出画布</button></div>
      </div>
      <div className="ai-card ai-column"><h3>从备份恢复</h3><p className="ai-muted">导入会替换当前画布数据；没有一起导入的画布，其会话会被归档。</p>
        <div className="ai-row"><button className="ai-button" disabled={action.busy} onClick={() => file.current?.click()}><Upload size={14} />选择画布文件</button></div>
        <input ref={file} type="file" accept="application/json,.json" hidden aria-label="选择画布数据文件" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (!selected) return; void action.run(async () => { const text = await selected.text(); setBackup(JSON.parse(text) as unknown); setBackupName(selected.name); setConfirmImport(false); }); }} />
        {backupName && <><p className="ai-muted">准备导入：{backupName}</p><label className="ai-check"><input type="checkbox" checked={confirmImport} onChange={event => setConfirmImport(event.target.checked)} />确认用此文件替换当前画布数据</label><button className="ai-button ai-button-danger" disabled={!confirmImport || action.busy} onClick={() => void action.run(async () => { await command('backup.import', { backup }); setBackup(undefined); setBackupName(''); setConfirmImport(false); setNotice('画布数据已导入。'); })}>导入画布</button></>}
      </div>
    </section>
      </div></div>
      {(tab === 'model' || action.error || notice) && <footer className="ai-settings-footer"><div>
        {action.error ? <AiError text={action.error} /> : notice && <p role="status" className="ai-settings-notice">{notice}</p>}
        {tab === 'model' && <button type="button" className="ai-button ai-button-primary" data-ai-save-settings
          disabled={action.busy || !provider.model.trim() || !provider.baseUrl.trim()} onClick={saveModel}>{action.busy ? '正在保存…' : '保存模型设置'}</button>}
      </div></footer>}
    </main>
  </section>, document.body);
}
