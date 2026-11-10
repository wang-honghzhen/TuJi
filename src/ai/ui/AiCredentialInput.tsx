import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';

export function AiCredentialInput({ value, onChange, placeholder, setup = false }: {
  value: string; onChange: (value: string) => void; placeholder: string; setup?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (!value) setVisible(false); }, [value]);
  return <div className={`ai-credential-field${setup ? ' ai-setup-key' : ''}`}>
    {setup && <KeyRound size={16} aria-hidden="true" />}
    <input className="ai-input" type={visible ? 'text' : 'password'} required={setup} autoComplete="new-password" spellCheck={false}
      value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder}
      data-ai-credential={setup ? undefined : true} data-ai-setup-credential={setup ? true : undefined} />
    <button type="button" className="ai-icon-button ai-credential-toggle" aria-label={visible ? '隐藏密钥' : '显示密钥'} aria-pressed={visible}
      title={visible ? '隐藏密钥' : '显示密钥'} data-ai-credential-toggle onClick={() => setVisible(previous => !previous)}>
      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
    </button>
  </div>;
}
