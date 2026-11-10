import type { AppSnapshot } from '../domain';

/** Preserve canonical messages and immutable inherited snapshots while retiring duplicate stream fragments. */
export function compactConversationHistory(state: AppSnapshot): number {
  const events = [...state.events].sort((a, b) => a.globalSeq - b.globalSeq);
  for (const message of state.messages) {
    const completed = events.find(event => event.type === 'message.completed' && event.payload.messageId === message.id);
    const delta = events.find(event => event.type === 'message.delta' && event.payload.messageId === message.id);
    const stepId = completed?.stepId ?? delta?.stepId;
    if (message.role === 'assistant') message.stepId ??= stepId;
    if (message.sequence !== undefined) continue;
    const started = stepId && message.role === 'assistant'
      ? events.find(event => event.type === 'step.started' && event.stepId === stepId) : undefined;
    message.sequence = (started ?? completed ?? delta)?.globalSeq;
  }
  for (const call of state.toolCalls) {
    if (call.sequence !== undefined) continue;
    const event = events.find(event => event.type === 'tool.started' && event.payload.toolCallId === call.id)
      ?? events.find(event => ['tool.completed', 'tool.failed'].includes(event.type) && event.payload.toolCallId === call.id);
    call.sequence = event?.globalSeq; call.startedAt ??= event?.createdAt;
    // Old presentation calls saved their message before their receipt. Keep the call before its output.
    if (call.name === 'ui_present' || call.name === 'ui_focus') {
      try {
        const message = state.messages.find(message => message.id === JSON.parse(call.result ?? '{}').messageId);
        if (message?.sequence !== undefined) { call.sequence = message.sequence; call.startedAt = message.createdAt; }
      } catch { /* Historical malformed receipts remain viewable. */ }
    }
  }
  for (const task of state.tasks) if (task.status === 'completed') {
    const event = [...events].reverse().find(event => event.taskId === task.id && event.type === 'task.completed');
    task.finishedAt ??= event?.createdAt ?? task.updatedAt;
    task.finishedSequence ??= event?.globalSeq;
  }
  for (const step of state.steps) {
    // Task totals still enforce the execution budget; per-call copies have no consumer.
    delete (step as unknown as Record<string, unknown>).inputTokens;
    delete (step as unknown as Record<string, unknown>).outputTokens;
  }
  const messages = new Set(state.messages.map(message => message.id));
  const obsolete = events.filter(event => event.type === 'message.delta' && messages.has(String(event.payload.messageId)));
  const ids = new Set(obsolete.map(event => event.id));
  state.events = state.events.filter(event => !ids.has(event.id));
  // An interrupted stream may own the last workspace cursor. Retain a single
  // text-free marker so existing inheritance cutoffs never reuse its sequence.
  for (const workspaceId of new Set(obsolete.map(event => event.workspaceId))) {
    const last = obsolete.filter(event => event.workspaceId === workspaceId).sort((a, b) => b.seq - a.seq)[0];
    if (!state.events.some(event => event.workspaceId === workspaceId && event.seq >= last.seq)) {
      state.events.push({ ...last, type: 'history.stream_compacted', payload: {} });
    }
  }
  return obsolete.length;
}
