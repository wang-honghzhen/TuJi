// The draft must include the final attachment/send result before another window edits it.
const pending = new Set<Promise<unknown>>();
export function trackDraftAction<T>(action: () => Promise<T>): Promise<T> {
  const operation = action(); pending.add(operation);
  void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  return operation;
}
export async function flushDraftActions() { await Promise.all([...pending]); }
