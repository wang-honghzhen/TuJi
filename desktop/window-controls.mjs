import { ipcMain } from 'electron';

/** Only the app's own top-level page may control its native window. */
export function attachWindowControls(window, origin) {
  const trusted = event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  const state = () => ({ maximized: window.isMaximized() });
  const publishState = () => {
    if (!window.isDestroyed()) window.webContents.send('tuji:window-state-changed', state());
  };
  const action = (event, command) => {
    if (!trusted(event)) return;
    switch (command) {
      case 'minimize': window.minimize(); break;
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize(); else window.maximize();
        break;
      case 'close': window.close(); break;
    }
  };
  ipcMain.handle('tuji:window-state', event => {
    if (!trusted(event)) throw new Error('Window controls are only available to the application page.');
    return state();
  });
  ipcMain.on('tuji:window-action', action);
  window.on('maximize', publishState);
  window.on('unmaximize', publishState);
  window.once('closed', () => {
    ipcMain.removeHandler('tuji:window-state');
    ipcMain.removeListener('tuji:window-action', action);
  });
}
