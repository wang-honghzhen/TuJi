import { estimateTokens } from '../tokens';
import { READ_PAGE_BUDGET } from '../memory';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Split any JSON value losslessly. Large metadata is carried once across fragments. */
function jsonFragments(value: unknown, budget: number, path: Array<string | number> = []): Record<string, unknown>[] {
  if (!Number.isSafeInteger(budget) || budget < 128) throw new Error('结果分页预算不足以容纳片段定位信息');
  const serialized = JSON.stringify(value), fragments: Record<string, unknown>[] = []; let offset = 0;
  while (offset < serialized.length) {
    const make = (length: number) => ({ serializedResult: serialized.slice(offset, offset + length),
      resultFragment: { encoding: 'json', path, offset, totalLength: serialized.length } });
    let length = Math.min(serialized.length - offset, budget * 3);
    while (length > 0 && estimateTokens(JSON.stringify(make(length))) > budget) length = Math.floor(length / 2);
    // Do not cut a UTF-16 surrogate pair between pages.
    if (length && /[\uD800-\uDBFF]/.test(serialized[offset + length - 1]) && /[\uDC00-\uDFFF]/.test(serialized[offset + length] ?? '')) length--;
    if (!length) throw new Error('结果分页预算不足以容纳片段定位信息');
    fragments.push(make(length)); offset += length;
  }
  return fragments;
}
function splitRow(value: unknown, budget: number, path: Array<string | number>): unknown[] {
  if (estimateTokens(JSON.stringify(value)) <= budget) return [value];
  if (!record(value)) return jsonFragments(value, budget, path);
  const row = value, field = ['text', 'content', 'summary'].find(key => typeof row[key] === 'string');
  // Only repeat small identity/range fields. Arbitrary or empty-text rows use JSON fragments.
  if (!field || !row[field] || estimateTokens(JSON.stringify({ ...row, [field]: '' })) > Math.min(128, budget / 3)) return jsonFragments(row, budget, path);
  const body = row[field] as string, parts: Record<string, unknown>[] = []; let offset = 0;
  while (offset < body.length) {
    const start = typeof row.start === 'number' ? row.start + offset : undefined;
    const make = (length: number) => ({ ...row, [field]: body.slice(offset, offset + length),
      ...(start !== undefined ? { start, end: start + length } : {}), resultTextPart: parts.length + 1 });
    let length = Math.min(body.length - offset, budget * 3);
    while (length > 0 && estimateTokens(JSON.stringify(make(length))) > budget) length = Math.floor(length / 2);
    if (length && /[\uD800-\uDBFF]/.test(body[offset + length - 1]) && /[\uDC00-\uDFFF]/.test(body[offset + length] ?? '')) length--;
    if (!length) return jsonFragments(row, budget, path);
    parts.push(make(length)); offset += length;
  }
  return parts;
}
/** Small structured rows retain exact ranges; arbitrary large values use lossless JSON fragments. */
export function resultPages(result: Record<string, unknown>, budget = READ_PAGE_BUDGET): Record<string, unknown>[] {
  if (!Number.isSafeInteger(budget) || budget < 128) throw new Error('结果分页预算至少为128 token');
  if (estimateTokens(JSON.stringify(result)) <= budget) return [result];
  const arrayKeys = Object.keys(result).filter(key => Array.isArray(result[key]) && (result[key] as unknown[]).length > 0);
  const header = Object.fromEntries(Object.entries(result).filter(([key]) => !arrayKeys.includes(key)));
  if (!arrayKeys.length || estimateTokens(JSON.stringify(header)) > Math.min(128, budget / 3)) return jsonFragments(result, budget);
  const pages: Record<string, unknown>[] = [];
  try {
    for (const key of arrayKeys) {
      let current: Record<string, unknown> = { ...header, [key]: [] };
      for (const [index, value] of (result[key] as unknown[]).entries()) {
        const rows = splitRow(value, budget - estimateTokens(JSON.stringify({ ...header, [key]: [] })) - 8, [key, index]);
        for (const row of rows) {
          if ((current[key] as unknown[]).length && estimateTokens(JSON.stringify({ ...current, [key]: [...current[key] as unknown[], row] })) > budget) {
            pages.push(current); current = { ...header, [key]: [] };
          }
          (current[key] as unknown[]).push(row);
        }
      }
      if ((current[key] as unknown[]).length) pages.push(current);
    }
  } catch { return jsonFragments(result, budget); }
  return pages.length && pages.every(page => estimateTokens(JSON.stringify(page)) <= budget) ? pages : jsonFragments(result, budget);
}
