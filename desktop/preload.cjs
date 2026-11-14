const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  const role = process.argv.find(arg => arg.startsWith('--tuji-role='))?.split('=')[1] ?? 'main';
  contextBridge.exposeInMainWorld('tujiDesktop', Object.freeze({
    role,
    getState: () => ipcRenderer.invoke('tuji:desktop', 'get-state'),
    command: (action, payload) => ipcRenderer.invoke('tuji:desktop', action, payload),
    hitTest: interactive => ipcRenderer.send('tuji:orb-hit-test', interactive),
    drag: phase => ipcRenderer.send('tuji:orb-drag', phase),
    onOrbPointer: callback => {
      if (role !== 'orb') return () => {};
      const listener = (_event, pointer) => callback(pointer);
      ipcRenderer.on('tuji:orb-pointer', listener);
      return () => ipcRenderer.removeListener('tuji:orb-pointer', listener);
    },
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('tuji:desktop-state', listener);
      return () => ipcRenderer.removeListener('tuji:desktop-state', listener);
    },
    onPrepare: callback => {
      const listener = async (_event, id) => {
        try { await callback(); ipcRenderer.send('tuji:desktop-prepared', id); }
        catch (cause) { ipcRenderer.send('tuji:desktop-prepared', id, String(cause?.message ?? cause)); }
      };
      ipcRenderer.on('tuji:desktop-prepare', listener);
      return () => ipcRenderer.removeListener('tuji:desktop-prepare', listener);
    },
  }));
  if (role === 'main') contextBridge.exposeInMainWorld('tujiWindow', Object.freeze({
    minimize: () => ipcRenderer.send('tuji:window-action', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('tuji:window-action', 'toggle-maximize'),
    close: () => ipcRenderer.send('tuji:window-action', 'close'),
    getState: () => ipcRenderer.invoke('tuji:window-state'),
    onStateChanged: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('tuji:window-state-changed', listener);
      return () => { ipcRenderer.removeListener('tuji:window-state-changed', listener); };
    },
  }));
}
