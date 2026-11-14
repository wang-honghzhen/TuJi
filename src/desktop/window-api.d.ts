export interface DesktopWindowState { maximized: boolean }

export interface DesktopWindowApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  getState(): Promise<DesktopWindowState>;
  onStateChanged(callback: (state: DesktopWindowState) => void): () => void;
}

declare global {
  interface Window { tujiWindow?: DesktopWindowApi }
}
