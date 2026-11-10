import { useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useAiStore } from '../client';
import { DEFAULT_PROVIDER, type ProviderConfig } from '../domain';
import { AiError, useAction } from './common';
import { AiCredentialInput } from './AiCredentialInput';

/** First-run setup only. Detailed settings live in the sidebar menu. */
export function AiSetupPage() {
  const command = useAiStore(state => state.command);
  const connection = useAiStore(state => state.connection);
  const configured = useAiStore(state => state.snapshot?.provider);
  const [provider, setProvider] = useState<ProviderConfig>({ ...(configured ?? DEFAULT_PROVIDER), contextPresetTokens: undefined });
  const [credential, setCredential] = useState('');
  const action = useAction();
  return <main className="ai-setup-page" data-ai-setup-page>
    <div className="ai-setup-glow" aria-hidden="true" />
    <form className="ai-setup-form" onSubmit={event => { event.preventDefault(); void action.run(async () => {
      await command('settings.save', { provider: { protocol: provider.protocol, baseUrl: provider.baseUrl.trim(), model: provider.model.trim() }, credential: credential.trim() });
      setCredential('');
    }); }}>
      <div className="ai-setup-logo"><Sparkles size={30} /></div>
      <p className="ai-setup-eyebrow">图记</p>
      <h1>连接你的 AI</h1>
      <p className="ai-muted">让知识在画布上生长。配置一次，即可开始。</p>
      <label className="ai-label">API 基础地址<input className="ai-input" type="url" required value={provider.baseUrl} onChange={event => setProvider({ ...provider, baseUrl: event.target.value })} /></label>
      <label className="ai-label">模型名称<input className="ai-input" required value={provider.model} onChange={event => setProvider({ ...provider, model: event.target.value })} /></label>
      <label className="ai-label">API 协议<select className="ai-input" value={provider.protocol} onChange={event => setProvider({ ...provider, protocol: event.target.value as ProviderConfig['protocol'] })}><option value="chat-completions">Chat Completions API</option><option value="responses">Responses API</option></select></label>
      <label className="ai-label">API Key<AiCredentialInput setup value={credential} onChange={setCredential} placeholder="输入 API Key" /></label>
      <button className="ai-button ai-button-primary" type="submit" disabled={action.busy || !credential.trim() || connection === 'disconnected'} data-ai-setup-submit>{action.busy ? '正在保存…' : '进入图记'}<ArrowRight size={16} /></button>
      <AiError text={action.error} />
      <p className="ai-muted ai-setup-footnote">上下文窗口默认 500k。摘要 AI、联网 API 和高级参数统一在本地数据目录的 api-config.json 中配置。</p>
    </form>
  </main>;
}
