/** Keep UTF-16 coordinates while never cutting a valid surrogate pair. */
export function textBoundary(content: string, end: number): number {
  const before = content.charCodeAt(end - 1), after = content.charCodeAt(end);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}

/**
 * Find the largest fragment accepted by the complete serialized-envelope predicate.
 * Even plain ASCII costs at least one token per three code units under our estimator,
 * so each probe examines at most 3 * budget units, never the whole remaining document.
 */
export function fittingTextEnd(content: string, start: number, budget: number, fits: (end: number) => boolean): number {
  let low = start, high = Math.min(content.length, start + Math.max(0, Math.floor(budget * 3)));
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2), boundary = textBoundary(content, candidate);
    if (fits(boundary)) low = candidate; else high = candidate - 1;
  }
  return textBoundary(content, low);
}
