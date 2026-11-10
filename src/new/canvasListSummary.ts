import type { AppSnapshot } from '@/ai/domain';
import type { CanvasRecord } from '@/v3/types';

export function canvasListSummaries(canvases: CanvasRecord[], snapshot: AppSnapshot | null) {
  const summaries = new Map(canvases.map(canvas => [canvas.canvasId, { sessionCount: 0, updatedAt: canvas.updatedAt }]));
  const workspaceCanvas = new Map<string, string>();
  const touch = (canvasId: string, date: string) => {
    const summary = summaries.get(canvasId);
    if (summary && Date.parse(date) > Date.parse(summary.updatedAt)) summary.updatedAt = date;
  };
  for (const session of snapshot?.sessions ?? []) {
    if (session.mode === 'temporary') continue;
    workspaceCanvas.set(session.workspaceId, session.canvasId);
    if (session.lifecycle === 'deleted') continue;
    const summary = summaries.get(session.canvasId);
    if (summary) summary.sessionCount++;
    touch(session.canvasId, session.createdAt);
  }
  for (const event of snapshot?.events ?? []) {
    const canvasId = workspaceCanvas.get(event.workspaceId);
    if (canvasId) touch(canvasId, event.createdAt);
  }
  for (const task of snapshot?.tasks ?? []) if (workspaceCanvas.has(task.workspaceId)) touch(task.canvasId, task.updatedAt);
  return summaries;
}
