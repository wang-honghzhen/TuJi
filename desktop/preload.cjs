const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  const role = process.argv.find(arg => arg.startsWith('--tuji-role='))?.split('=')[1] ?? 'main';
  // The renderer registers its save barrier before mounting any editable UI.
  // An early close (including a page that failed to mount) still gets a reply.
  const prepareListeners = new Set();
  const heartbeats = new Map();
  const stopHeartbeat = id => { clearInterval(heartbeats.get(id)); heartbeats.delete(id); };
  ipcRenderer.on('tuji:desktop-prepare-ended', (_event, id) => stopHeartbeat(id));
  ipcRenderer.on('tuji:desktop-prepare', async (_event, id) => {
    // An attachment upload or note transaction can legitimately outlast the
    // native responsiveness watchdog. Only "prepared" may release the window.
    heartbeats.set(id, setInterval(() => ipcRenderer.send('tuji:desktop-preparing', id), 3000));
    try {
      await Promise.all([...prepareListeners].map(flush => flush()));
      ipcRenderer.send('tuji:desktop-prepared', id);
    } catch (cause) {
      ipcRenderer.send('tuji:desktop-prepared', id, String(cause?.message ?? cause));
    } finally { stopHeartbeat(id); }
  });
  contextBridge.exposeInMainWorld('tujiDesktop', Object.freeze({
    role,
    getState: () => ipcRenderer.invoke('tuji:desktop', 'get-state'),
    command: (action, payload) => ipcRenderer.invoke('tuji:desktop', action, payload),
    hitTest: interactive => ipcRenderer.send('tuji:orb-hit-test', interactive),
    drag: phase => ipcRenderer.send('tuji:orb-drag', phase),
    dragPanel: phase => { if (role === 'panel') ipcRenderer.send('tuji:window-drag', phase); },
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
      prepareListeners.add(callback);
      return () => prepareListeners.delete(callback);
    },
  }));
  if (role === 'main') contextBridge.exposeInMainWorld('tujiWindow', Object.freeze({
    minimize: () => ipcRenderer.send('tuji:window-action', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('tuji:window-action', 'toggle-maximize'),
    drag: phase => ipcRenderer.send('tuji:window-drag', phase),
    close: () => ipcRenderer.send('tuji:window-action', 'close'),
    getState: () => ipcRenderer.invoke('tuji:window-state'),
    onControlsPointer: callback => {
      const listener = (_event, pointer) => callback(pointer);
      ipcRenderer.on('tuji:window-controls-pointer', listener);
      return () => ipcRenderer.removeListener('tuji:window-controls-pointer', listener);
    },
    onStateChanged: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('tuji:window-state-changed', listener);
      return () => { ipcRenderer.removeListener('tuji:window-state-changed', listener); };
    },
  }));
}
