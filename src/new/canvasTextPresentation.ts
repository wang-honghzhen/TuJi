export type CanvasTextRole = 'title' | 'body' | 'edge' | 'region';

/** Only identifying labels compensate for zoom. Body and relation text keep
 * their natural layout and give way to the overview as they become too small. */
export function canvasTextMetrics(role: CanvasTextRole, zoom: number, baseFont?: number) {
  const base = baseFont ?? (role === 'title' ? 14 : role === 'body' ? 12 : role === 'region' ? 13 : 11);
  const floor = role === 'title' ? 11 : role === 'region' ? 12 : 0;
  return { fontSize: Math.max(base, floor / zoom),
    lineHeight: Math.max(role === 'region' ? 18 : role === 'edge' ? 22 : 20, floor ? (floor + 3) / zoom : 0) };
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Thresholds are in screen pixels. Separate exit/entry thresholds keep small
 * wheel movements from repeatedly hiding and restoring the same label. */
export function canvasTextVisibility(role: CanvasTextRole, zoom: number, width: number, height: number,
  font: number, line: number, wasVisible: boolean | undefined) {
  if (role === 'edge') return { visible: true, opacity: 1 };
  const restoring = wasVisible === false;
  const screenWidth = width * zoom, screenHeight = height * zoom, screenFont = font * zoom;
  const minWidth = role === 'title' ? (restoring ? 64 : 56) : role === 'region' ? (restoring ? 76 : 64) : (restoring ? 76 : 64);
  const minFont = role === 'body' ? (restoring ? 9.6 : 9) : 0;
  const minZoom = role === 'title' ? (restoring ? .28 : .25) : 0;
  const visible = zoom >= minZoom - .0001 && screenWidth >= minWidth - .1 &&
    screenHeight >= line * zoom - .25 && screenFont >= minFont - .001;
  const opacity = !visible ? 0 : role === 'body' ? clamp((screenFont - 9) / 1.2) :
    role === 'title' ?
      Math.min(clamp((screenWidth - 48) / 16), clamp((zoom - .22) / .06)) : clamp((screenWidth - 56) / 20);
  return { visible, opacity };
}
