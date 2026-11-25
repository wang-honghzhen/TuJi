/** Thirds of a local token, kept unrounded so serialized fragments can be added. */
export function tokenThirds(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    count += code <= 0x7f ? 1 : code > 0xffff ? 12 : 6;
  }
  return count;
}

/** Conservative local estimate; provider usage remains the billing authority. */
export function estimateTokens(text: string): number {
  return Math.ceil(tokenThirds(text) / 3);
}
