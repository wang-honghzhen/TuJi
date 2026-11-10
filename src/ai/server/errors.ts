export class DomainError extends Error {
  constructor(message: string, public code = 'INVALID_REQUEST', public status = 400, public details?: unknown) { super(message); }
}
export function requireValue(condition: unknown, message: string, code = 'INVALID_REQUEST', details?: unknown): asserts condition {
  if (!condition) throw new DomainError(message, code, 400, details);
}
export function text(value: unknown, name: string, max = 200000): string {
  requireValue(typeof value === 'string' && value.length <= max, `${name} 必须是长度不超过 ${max} 的文本`);
  return value;
}
export function strings(value: unknown, name: string, max = 10000): string[] {
  requireValue(Array.isArray(value) && value.length <= max && value.every(x => typeof x === 'string' && x.length < 1000), `${name} 必须是字符串列表`);
  return [...new Set(value as string[])];
}
