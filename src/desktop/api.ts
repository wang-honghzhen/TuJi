import type { InputDraft } from '@/ai/client';

export type DesktopRole = 'main' | 'orb' | 'panel';
export interface NotebookTab { id: string; directoryId: string; kind: 'directory' | 'pages'; pageId?: string }
export interface PanelState {
  ready: boolean; host: 'main' | 'panel' | 'none'; background: boolean; detached: boolean; used: boolean;
  activeTab: string; canvasId: string; width: number; notePageId: string;
  noteTabs?: NotebookTab[]; noteDirectoryId?: string;
  drafts: Record<string, InputDraft>; reading: Record<string, { top: number; following: boolean }>;
  enteredSessionByCanvas: Record<string, string>;
  orb: { flipX: boolean; flipY: boolean; dock: string };
}
export interface DesktopApi {
  role: DesktopRole;
  getState(): Promise<PanelState>;
  command(action: string, payload?: unknown): Promise<PanelState>;
  onState(callback: (state: PanelState) => void): () => void;
  onPrepare(callback: () => Promise<void>): () => void;
  hitTest(interactive: boolean): void;
  drag(phase: 'start' | 'move' | 'end' | 'cancel'): void;
  dragPanel(phase: 'start' | 'move' | 'end' | 'cancel'): void;
  onOrbPointer(callback: (pointer: { x: number; y: number; visible: boolean }) => void): () => void;
}
declare global { interface Window { tujiDesktop?: DesktopApi } }
