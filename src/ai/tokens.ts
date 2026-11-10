/** Conservative local estimate; provider usage remains the billing authority. */
export function estimateTokens(text: string): number {
  let ascii = 0, unicode = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x7f) ascii++;
    else unicode += code > 0xffff ? 4 : 2;
  }
  return Math.ceil(ascii / 3) + unicode;
}
