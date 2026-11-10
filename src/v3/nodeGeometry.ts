import type { GraphNodeRecord, Rect } from './types';
import { NODE_HEIGHT, NODE_WIDTH } from './types';

export const NODE_MAX_WIDTH = 320;
export const NODE_MAX_HEIGHT = 180;
export const NODE_TEXT_LINE_HEIGHT = 20;
const measured = new WeakMap<GraphNodeRecord, { name: string; content: string; size: Rect & { titleHeight: number } }>();

// Keep sizing deterministic in the browser, workers and server. Conservative
// glyph advances leave room for the system font; actual overflow is checked in DOM.
function advance(char: string, font: number): number {
  if (/\p{Mark}/u.test(char)) return 0;
  if (char === '\t') return font * 2.4;
  return font * (char.codePointAt(0)! > 255 ? 1.05 : /[MW@#%]/.test(char) ? .95 : .62);
}
function textWidth(text: string, font: number): number {
  let longest = 0, current = 0;
  for (const char of text) {
    if (char === '\n') { longest = Math.max(longest, current); current = 0; }
    else current += advance(char, font);
    if (current >= NODE_MAX_WIDTH) return NODE_MAX_WIDTH;
  }
  return Math.max(longest, current);
}
function lines(text: string, font: number, width: number): number {
  let count = 1, used = 0;
  for (const char of text) {
    if (char === '\n') { count++; used = 0; }
    else { const size = advance(char, font); if (used && used + size > width) { count++; used = 0; } used += size; }
    if (count >= 10) return count;
  }
  return count;
}
export function nodeGeometry(node: GraphNodeRecord): Rect & { titleHeight: number } {
  const cached = measured.get(node);
  if (cached?.name === node.name && cached.content === node.content) return cached.size;
  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_WIDTH,
    Math.ceil(Math.max(textWidth(node.name ?? '', 14), textWidth(node.content ?? '', 12)) + 26)));
  const titleHeight = Math.min(NODE_MAX_HEIGHT - 18, lines(node.name ?? '', 14, width - 26) * NODE_TEXT_LINE_HEIGHT);
  const height = Math.min(NODE_MAX_HEIGHT, Math.max(NODE_HEIGHT,
    18 + titleHeight + 4 + lines(node.content ?? '', 12, width - 26) * NODE_TEXT_LINE_HEIGHT));
  const result = { x: 0, y: 0, width, height, titleHeight };
  measured.set(node, { name: node.name, content: node.content, size: result }); return result;
}
