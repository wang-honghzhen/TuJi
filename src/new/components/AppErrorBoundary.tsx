import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useAiStore } from '@/ai/client';

interface UiErrorRecord { at: string; message: string; stack?: string; componentStack?: string }
const errorKey = 'qixue:ui-errors:v1';
export function recordUiError(error: unknown, componentStack?: string): void {
  const record: UiErrorRecord = { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { stack: error.stack } : {}), ...(componentStack ? { componentStack } : {}) };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(errorKey) ?? '[]');
    const records = Array.isArray(saved) ? saved : [];
    localStorage.setItem(errorKey, JSON.stringify([...records.slice(-9), record]));
  } catch { /* Error recovery must work even when local storage is unavailable. */ }
}

/** A render failure shows recovery controls instead of removing the whole interface. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; retrying: boolean }> {
  state: { error: Error | null; retrying: boolean } = { error: null, retrying: false };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { recordUiError(error, info.componentStack ?? undefined); }
  private retry = async () => {
    this.setState({ retrying: true });
    // The failed tree has disconnected its stream; synchronize before remounting it.
    await useAiStore.getState().refresh().catch(() => undefined);
    this.setState({ error: null, retrying: false });
  };
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" data-app-error className="min-h-screen bg-space-950 text-slate-200 p-8">
      <h1 className="text-lg font-semibold">界面显示遇到问题</h1>
      <p className="mt-3 text-sm text-slate-400">错误已记录在本机。你可以重试显示，或刷新页面重新连接。</p>
      <div className="flex gap-3 mt-5">
        <button type="button" data-app-error-retry disabled={this.state.retrying} className="rounded bg-blue-500/20 px-4 py-2" onClick={() => void this.retry()}>{this.state.retrying ? '正在重新连接…' : '重试显示'}</button>
        <button type="button" className="rounded bg-white/5 px-4 py-2" onClick={() => window.location.reload()}>刷新页面</button>
      </div>
      <details className="mt-5 text-xs text-slate-400"><summary>错误详情</summary><pre className="mt-2 whitespace-pre-wrap break-words">{this.state.error.message}</pre></details>
    </div>;
  }
}
