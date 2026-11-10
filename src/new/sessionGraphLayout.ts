import type { InheritanceEdge, Session } from '@/ai/domain';

export interface PositionedSession { session: Session; x: number; y: number; depth: number }
export const SESSION_NODE_WIDTH = 176;
export const SESSION_NODE_HEIGHT = 134;
export const SESSION_ICON_SIZE = 48;

/** Longest-path columns render multi-parent children once, with the root at y=0. */
export function layoutSessionDag(sessions: Session[], edges: InheritanceEdge[]): { nodes: PositionedSession[]; width: number; height: number } {
  sessions = sessions.filter(session => session.mode !== 'temporary');
  if (!sessions.length) return { nodes: [], width: 0, height: 0 };
  const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const ids = new Set(ordered.map(session => session.id));
  const valid = edges.filter(edge => ids.has(edge.parentSessionId) && ids.has(edge.childSessionId));
  const incoming = new Map(ordered.map(session => [session.id, 0]));
  const outgoing = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const edge of valid) {
    incoming.set(edge.childSessionId, incoming.get(edge.childSessionId)! + 1);
    outgoing.set(edge.parentSessionId, [...(outgoing.get(edge.parentSessionId) ?? []), edge.childSessionId]);
    parents.set(edge.childSessionId, [...(parents.get(edge.childSessionId) ?? []), edge.parentSessionId]);
  }
  const queue = ordered.filter(session => incoming.get(session.id) === 0).map(session => session.id);
  const depth = new Map(ordered.map(session => [session.id, 0]));
  for (let index = 0; index < queue.length; index++) for (const child of outgoing.get(queue[index]) ?? []) {
    depth.set(child, Math.max(depth.get(child)!, depth.get(queue[index])! + 1));
    incoming.set(child, incoming.get(child)! - 1); if (!incoming.get(child)) queue.push(child);
  }
  const levels = new Map<number, Session[]>();
  for (const session of ordered) { const level = depth.get(session.id)!; levels.set(level, [...(levels.get(level) ?? []), session]); }
  const nodes: PositionedSession[] = [];
  const yById = new Map<string, number>();
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const column = levels.get(level)!;
    const parentY = (session: Session) => { const ys = (parents.get(session.id) ?? []).map(id => yById.get(id) ?? 0); return ys.length ? ys.reduce((sum, y) => sum + y, 0) / ys.length : 0; };
    column.sort((a, b) => parentY(a) - parentY(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    column.forEach((session, index) => { const y = (index - (column.length - 1) / 2) * (SESSION_NODE_HEIGHT + 30); yById.set(session.id, y); nodes.push({ session, depth: level, x: SESSION_NODE_WIDTH / 2 + level * (SESSION_NODE_WIDTH + 56), y }); });
  }
  return { nodes, width: Math.max(0, ...nodes.map(node => node.x)) + SESSION_NODE_WIDTH / 2,
    height: 2 * Math.max(SESSION_NODE_HEIGHT - SESSION_ICON_SIZE / 2, ...nodes.map(node => Math.max(Math.abs(node.y - SESSION_ICON_SIZE / 2), Math.abs(node.y + SESSION_NODE_HEIGHT - SESSION_ICON_SIZE / 2)))) };
}
