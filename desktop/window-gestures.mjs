/** Window coordinates and cursor coordinates are both device-independent pixels. */
export function trustedWindowEvent(event, window, origin) {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

/** Compensate Electron's fractional-DPI rounding without accumulating size drift. */
export function setStableWindowBounds(window, target) {
  const request = { ...target };
  let widthExact = false, heightExact = false, best, bestError = Infinity;
  // Some Windows coordinate phases cannot represent a requested integer DIP
  // size. Try the closest phases only after readback correction cannot converge.
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    if (!widthExact) { request.x = target.x + offset; request.width = target.width; }
    if (!heightExact) { request.y = target.y + offset; request.height = target.height; }
    for (let attempt = 0; attempt < 3; attempt++) {
      window.setBounds(request, false);
      const actual = window.getBounds();
      const dx = target.width - actual.width, dy = target.height - actual.height;
      widthExact = dx === 0; heightExact = dy === 0;
      if (widthExact && heightExact) return actual;
      const error = Math.abs(dx) + Math.abs(dy);
      if (error < bestError) { bestError = error; best = { ...request }; }
      if (!widthExact) request.width = Math.max(1, request.width + dx);
      if (!heightExact) request.height = Math.max(1, request.height + dy);
    }
  }
  // Preserve the closest representable size if the OS imposes another constraint.
  window.setBounds(best, false);
  return window.getBounds();
}

/** One listener routes gestures to their sending window, never a renderer-supplied ID. */
export function createWindowDragDispatcher(ipcMain, screen) {
  const entries = new Map();
  const channel = 'tuji:window-drag';
  const dispatch = (event, phase) => {
    const entry = entries.get(event.sender.id);
    if (!entry || !trustedWindowEvent(event, entry.window, entry.origin)) return;
    if (phase === 'cancel') { entry.cancel(); return; }
    if (!['start', 'move', 'end'].includes(phase)) return;
    const { window } = entry;
    if (!entry.canDrag() || window.isMaximized() || window.isFullScreen() || window.isMinimized() || !window.isVisible()) { entry.cancel(); return; }
    if (phase === 'start') {
      for (const other of entries.values()) other.cancel();
      const bounds = window.getBounds(), previous = entry.sizeIntent;
      // If an unusual display could only approximate the last size, keep the
      // original intent on the next gesture. A real intervening resize replaces it.
      if (previous?.actual.width === bounds.width && previous.actual.height === bounds.height) {
        bounds.width = previous.width; bounds.height = previous.height;
      }
      entry.start = { cursor: screen.getCursorScreenPoint(), bounds };
    } else if (entry.start) {
      const gesture = entry.start, { cursor: start, bounds } = gesture, cursor = screen.getCursorScreenPoint();
      // Always preserve the dimensions captured at pointer-down. Native resize or
      // display changes must not accumulate size changes over successive moves.
      if (gesture.lastCursor?.x !== cursor.x || gesture.lastCursor?.y !== cursor.y) {
        const actual = setStableWindowBounds(window, { x: Math.round(bounds.x + cursor.x - start.x), y: Math.round(bounds.y + cursor.y - start.y),
          width: bounds.width, height: bounds.height });
        entry.sizeIntent = { width: bounds.width, height: bounds.height, actual };
        gesture.lastCursor = cursor;
      }
      if (phase === 'end') entry.cancel();
    }
  };
  return {
    register(window, origin, canDrag = () => true) {
      // The window's webContents getter is unavailable once 'closed' fires.
      const contents = window.webContents;
      const id = contents.id;
      if (entries.has(id)) throw new Error('Window drag is already registered.');
      const entry = { window, origin, canDrag, start: undefined, sizeIntent: undefined, cancel() { entry.start = undefined; } };
      if (!entries.size) ipcMain.on(channel, dispatch);
      entries.set(id, entry);
      const cancelEvents = ['blur', 'hide', 'maximize', 'minimize', 'enter-full-screen'];
      for (const name of cancelEvents) window.on(name, entry.cancel);
      const preventResize = event => { if (entry.start) event.preventDefault(); };
      window.on('will-resize', preventResize);
      contents.on('did-start-loading', entry.cancel);
      contents.on('render-process-gone', entry.cancel);
      const dispose = () => {
        if (!entries.delete(id)) return;
        entry.cancel();
        for (const name of cancelEvents) window.removeListener(name, entry.cancel);
        window.removeListener('will-resize', preventResize);
        window.removeListener('closed', dispose);
        contents.removeListener('did-start-loading', entry.cancel);
        contents.removeListener('render-process-gone', entry.cancel);
        if (!entries.size) ipcMain.removeListener(channel, dispatch);
      };
      window.once('closed', dispose);
      return { cancel: entry.cancel, dispose };
    },
  };
}

export function windowControlPointer(window, screen, cursor = screen.getCursorScreenPoint()) {
  // Match the renderer viewport. A maximized window's outer bounds can extend
  // beyond the display, and a restored window can straddle two displays.
  const bounds = window.getContentBounds();
  const scale = window.webContents.getZoomFactor();
  const width = (window.isMaximized() ? 2 : 3) * 36 * scale;
  const x = cursor.x - (bounds.x + bounds.width - width), y = cursor.y - bounds.y;
  const insideX = x >= 0 && x < width;
  const inside = insideX && y >= 0 && y < 32 * scale;
  return { edge: inside && y < 8, inside };
}
