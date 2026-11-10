import type { AppSnapshot } from './domain';

export interface LatestReading { taskId: string; maxSeq: number }
const storageKey = 'qixue-latest-task-reading';
let readings: Record<string, LatestReading> = {};
try {
  const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
  for (const [sessionId, value] of Object.entries(stored)) {
    const entry = value as LatestReading;
    if (entry && typeof entry.taskId === 'string' && Number.isSafeInteger(entry.maxSeq) && entry.maxSeq >= 0)
      readings[sessionId] = entry;
  }
} catch { /* Storage may be unavailable; reading progress still works in memory. */ }
const save = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(readings)); } catch { /* Optional storage. */ } };

export function canFollowTask(snapshot: AppSnapshot | null, sessionId?: string, taskId?: string): boolean {
  const session = snapshot?.sessions.find(value => value.id === sessionId);
  return !!taskId && !!session && session.mode !== 'temporary' && session.lifecycle === 'active'
    && snapshot?.tasks.filter(task => task.sessionId === sessionId).at(-1)?.id === taskId;
}

export function reconcileReadingProgress(snapshot: AppSnapshot) {
  let changed = false;
  for (const [sessionId, entry] of Object.entries(readings)) {
    if (snapshot.tasks.filter(task => task.sessionId === sessionId).at(-1)?.id !== entry.taskId) {
      delete readings[sessionId]; changed = true;
    }
  }
  if (changed) save();
}

export function maximumReached(sessionId: string, taskId: string): number {
  const entry = readings[sessionId];
  return entry?.taskId === taskId ? entry.maxSeq : -1;
}

export function recordReachedPart(snapshot: AppSnapshot | null, sessionId: string, taskId: string, seq: number) {
  if (!canFollowTask(snapshot, sessionId, taskId) || !Number.isSafeInteger(seq) || seq < 0) return;
  if (seq <= maximumReached(sessionId, taskId)) return;
  readings[sessionId] = { taskId, maxSeq: seq }; save();
}
