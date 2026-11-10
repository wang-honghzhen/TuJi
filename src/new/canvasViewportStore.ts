export interface CanvasViewport { x: number; y: number; zoom: number }
const key = (canvasId: string) => `qixue:canvas-viewport:v1:${canvasId}`;
const cache = new Map<string, CanvasViewport>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function valid(value: unknown): value is CanvasViewport {
  if (!value || typeof value !== 'object') return false;
  const view = value as CanvasViewport;
  return Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.zoom) && view.zoom >= .12 && view.zoom <= 3;
}
export function loadCanvasViewport(canvasId: string, fallback: CanvasViewport): CanvasViewport {
  const cached = cache.get(canvasId);
  if (cached) return cached;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(canvasId)) ?? 'null');
    if (valid(stored)) { cache.set(canvasId, stored); return stored; }
  } catch { /* Storage may be unavailable; the in-memory view still works. */ }
  cache.set(canvasId, fallback);
  return fallback;
}
export function flushCanvasViewport(canvasId: string): void {
  clearTimeout(timers.get(canvasId)); timers.delete(canvasId);
  const view = cache.get(canvasId);
  if (view) try { localStorage.setItem(key(canvasId), JSON.stringify(view)); } catch { /* Keep the in-memory view. */ }
}
export function saveCanvasViewport(canvasId: string, view: CanvasViewport): void {
  if (!valid(view)) return;
  cache.set(canvasId, view);
  clearTimeout(timers.get(canvasId));
  timers.set(canvasId, setTimeout(() => flushCanvasViewport(canvasId), 180));
}
