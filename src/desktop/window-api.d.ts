export interface DesktopWindowState { maximized: boolean }

export interface DesktopWindowApi {
  minimize(): void;
  toggleMaximize(): void;
  drag(phase: 'start' | 'move' | 'end' | 'cancel'): void;
  close(): void;
  getState(): Promise<DesktopWindowState>;
  onStateChanged(callback: (state: DesktopWindowState) => void): () => void;
  onControlsPointer(callback: (pointer: { edge: boolean; inside: boolean }) => void): () => void;
}

declare global {
  interface Window { tujiWindow?: DesktopWindowApi }
}
