import type { CanvasDirectory, CanvasRecord } from './types';

/** The canvas is the root. This facade is never a second stored entity. */
export function canvasDirectory(canvas: CanvasRecord, id: string): CanvasDirectory;
export function canvasDirectory(canvas: CanvasRecord | undefined, id: string): CanvasDirectory | undefined;
export function canvasDirectory(canvas: CanvasRecord | undefined, id: string): CanvasDirectory | undefined {
  if (!canvas) return undefined;
  if (id !== canvas.canvasId) return canvas.directories[id];
  return {
    get name() { return canvas.canvasName; }, set name(value: string) { canvas.canvasName = value; },
    get childIds() { return canvas.childIds; }, set childIds(value: string[]) { canvas.childIds = value; },
  };
}
export function canvasDirectoryEntries(canvas: CanvasRecord): Array<[string, CanvasDirectory]> {
  return [[canvas.canvasId, canvasDirectory(canvas, canvas.canvasId)!], ...Object.entries(canvas.directories)];
}
export const canvasDirectories = (canvas: CanvasRecord) => canvasDirectoryEntries(canvas).map(([, directory]) => directory);
export const canvasDirectoryIds = (canvas: CanvasRecord) => canvasDirectoryEntries(canvas).map(([id]) => id);

