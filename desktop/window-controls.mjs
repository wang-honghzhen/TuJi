import { ipcMain, screen } from 'electron';
import { createWindowDragDispatcher, trustedWindowEvent, windowControlPointer } from './window-gestures.mjs';

const drags = createWindowDragDispatcher(ipcMain, screen);
export const attachWindowDrag = (window, origin, canDrag) => drags.register(window, origin, canDrag);

/** Only the app's own top-level page may control its native window. */
export function attachWindowControls(window, origin) {
  const dragging = attachWindowDrag(window, origin);
  const trusted = event => trustedWindowEvent(event, window, origin);
  const state = () => ({ maximized: window.isMaximized() });
  const publishState = () => {
    if (!window.isDestroyed()) window.webContents.send('tuji:window-state-changed', state());
  };
  const action = (event, command) => {
    if (!trusted(event)) return;
    dragging.cancel();
    switch (command) {
      case 'minimize': window.minimize(); break;
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize(); else window.maximize();
        break;
      case 'close': window.close(); break;
    }
  };
  let pointerTimer, previousPointer;
  const publishPointer = pointer => {
    if (previousPointer?.edge === pointer.edge && previousPointer?.inside === pointer.inside) return;
    previousPointer = pointer;
    if (!window.isDestroyed()) window.webContents.send('tuji:window-controls-pointer', pointer);
  };
  const trackPointer = () => {
    if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
    publishPointer(windowControlPointer(window, screen));
  };
  const startTracking = () => {
    clearInterval(pointerTimer); previousPointer = undefined;
    trackPointer(); pointerTimer = setInterval(trackPointer, 32);
  };
  const stopTracking = () => {
    clearInterval(pointerTimer); pointerTimer = undefined;
    publishPointer({ edge: false, inside: false });
  };
  ipcMain.handle('tuji:window-state', event => {
    if (!trusted(event)) throw new Error('Window controls are only available to the application page.');
    // The renderer subscribes as it asks for initial state. Resend the cursor
    // state on the next tick even if it has stayed still since the window opened.
    previousPointer = undefined;
    return state();
  });
  ipcMain.on('tuji:window-action', action);
  window.on('show', startTracking);
  window.on('hide', stopTracking);
  window.on('minimize', stopTracking);
  window.on('restore', startTracking);
  window.on('focus', startTracking);
  window.on('blur', () => publishPointer({ edge: false, inside: false }));
  window.on('maximize', publishState);
  window.on('unmaximize', publishState);
  if (window.isVisible()) startTracking();
  window.once('closed', () => {
    clearInterval(pointerTimer);
    ipcMain.removeHandler('tuji:window-state');
    ipcMain.removeListener('tuji:window-action', action);
    dragging.dispose();
  });
}
