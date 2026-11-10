import type { ChatMessage, ToolCallRecord } from './domain';

export const PRESENTATION_FUNCTIONS = new Set(['ui_present', 'ui_focus', 'task_finish', 'br']);
/** Ordinary presentation calls are facts; successful br calls are display-only boundaries. */
export function successfulPresentationCall(call: ToolCallRecord): boolean {
  if (!PRESENTATION_FUNCTIONS.has(call.name) || call.status !== 'completed') return false;
  try { const result = JSON.parse(call.result ?? '{}'); return result.status === 'ok' && !result.error; }
  catch { return false; }
}

/** A successful break controls display only; failures remain visible and paired. */
export function successfulPartBreak(call: ToolCallRecord): boolean {
  return call.name === 'br' && successfulPresentationCall(call);
}
export function hiddenPresentationCall(call: ToolCallRecord): boolean { return successfulPartBreak(call); }

export function presentationSourceCall(message: ChatMessage, calls: ToolCallRecord[]): ToolCallRecord | undefined {
  if (!message.presentationCallId) return undefined;
  const call = calls.find(c => c.id === message.presentationCallId && c.taskId === message.taskId);
  if (!call || !successfulPresentationCall(call)) return undefined;
  try {
    const args = JSON.parse(call.arguments);
    return ['ui_present','task_finish'].includes(call.name) && args.text === message.text || call.name === 'ui_focus' && !message.text ? call : undefined;
  } catch { return undefined; }
}
