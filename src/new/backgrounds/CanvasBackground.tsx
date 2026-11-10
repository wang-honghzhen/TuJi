import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAiStore } from '@/ai/client';
import { BUILTIN_BACKGROUND_URL, normalizePersonalizationSettings, type PersonalizationSettings } from '@/shared/canvasBackgrounds';

interface BackgroundState {
  settings: PersonalizationSettings;
  customImageUrl?: string;
  loading: boolean;
  error: string;
  retry(): void;
}
const Context = createContext<BackgroundState | null>(null);

export function CanvasBackgroundProvider({ children }: { children: ReactNode }) {
  const saved = useAiStore(state => state.snapshot?.personalizationSettings);
  const settings = normalizePersonalizationSettings(saved), assetId = settings.customBackgroundAssetId;
  const [image, setImage] = useState<{ assetId: string; url?: string; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Retire only the old image camera cache; canvas positions remain independent.
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qixue:background-camera:v1:')) localStorage.removeItem(key);
    } catch { /* Background rendering also works when browser storage is unavailable. */ }
  }, []);
  useEffect(() => {
    if (!assetId) { setImage(undefined); return; }
    let cancelled = false, objectUrl: string | undefined;
    setImage(undefined);
    void useAiStore.getState().command<{ mimeType: string; dataBase64: string }>('settings.background.read', { assetId }, { reportError: false }).then(result => {
      if (cancelled) return;
      const binary = atob(result.dataBase64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      setImage({ assetId, url: objectUrl });
    }).catch(cause => {
      if (!cancelled) setImage({ assetId, error: cause instanceof Error ? cause.message : '无法读取自定义背景，请重新上传。' });
    });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [assetId, attempt]);
  const current = image?.assetId === assetId ? image : undefined;
  return <Context.Provider value={{ settings, customImageUrl: current?.url, loading: Boolean(assetId && !current), error: current?.error ?? '', retry: () => setAttempt(value => value + 1) }}>
    <div className="canvas-workspace" data-workspace-background={settings.canvasBackgroundId}>{children}</div>
  </Context.Provider>;
}

export function useCanvasBackground() {
  const value = useContext(Context);
  if (!value) throw new Error('画布背景尚未初始化');
  return value;
}

export function CanvasBackground() {
  const { settings, customImageUrl, error } = useCanvasBackground();
  const id = settings.canvasBackgroundId;
  const source = id === 'custom' && customImageUrl ? customImageUrl : BUILTIN_BACKGROUND_URL;
  return <>
    <div aria-hidden="true" className={`canvas-background${id === 'white-grid' ? ' canvas-white-grid' : ''}`} data-canvas-background={id}>
      {id !== 'white-grid' && <img src={source} alt="" draggable={false} />}
    </div>
    {id === 'custom' && error && <p className="canvas-background-warning" role="status">自定义背景暂不可用，已显示内置星空。可在设置 → 个性化中重新上传。</p>}
  </>;
}
