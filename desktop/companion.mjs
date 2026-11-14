import { BrowserWindow, Tray, Menu, ipcMain, screen, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const CHANNEL = 'tuji:desktop';
const ORB_SIZE = 280, HALF = ORB_SIZE / 2, RADIUS = 28;
const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

/** One owner for window visibility and editing. Renderers never open native windows. */
export function createCompanion({ main, origin, preload, icon, directory, secure, quit, smoke = false }) {
  const settingsPath = path.join(directory, 'desktop-profile', 'companion.json');
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* First run or disposable UI cache. */ }
  const state = { ready: true, host: 'none', background: false, detached: false, used: !!saved.used,
    activeTab: typeof saved.activeTab === 'string' ? saved.activeTab : 'notebook', canvasId: '',
    width: clamp(Number(saved.width) || 520, 360, 1200), notePageId: saved.notePageId ?? '',
    noteTabs: Array.isArray(saved.noteTabs) ? saved.noteTabs : [], noteDirectoryId: saved.noteDirectoryId ?? '',
    drafts: saved.drafts ?? {}, reading: saved.reading ?? {}, enteredSessionByCanvas: {},
    orb: { flipX: false, flipY: false, dock: '' } };
  const windows = new Map([[main.webContents.id, { role: 'main', window: main }]]);
  let orb, panel, tray, quitting = false, transition = false, queue = Promise.resolve(), saveTimer;
  let orbPointerTimer, lastOrbPointer, lastOrbPointerAt = 0;
  let orbCenter = saved.orbCenter, detachedBounds = saved.detachedBounds, dragStart, token = 0;
  const pending = new Map();
  function persist() {
    clearTimeout(saveTimer);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ used: state.used, activeTab: state.activeTab, width: state.width,
      notePageId: state.notePageId, noteTabs: state.noteTabs, noteDirectoryId: state.noteDirectoryId,
      drafts: state.drafts, reading: state.reading, orbCenter, detachedBounds }));
    fs.renameSync(tmp, settingsPath);
  }
  function publish() {
    for (const { window } of windows.values()) if (!window.isDestroyed()) window.webContents.send('tuji:desktop-state', state);
    clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { persist(); } catch { /* Retried on quit. */ } }, 500);
  }
  function trusted(event) {
    const entry = windows.get(event.sender.id);
    if (!entry || entry.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的窗口请求');
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('无效的窗口来源');
    return entry;
  }
  function enqueue(fn) {
    const work = queue.then(async () => { transition = true; try { return await fn(); } finally { transition = false; } });
    queue = work.catch(() => undefined); return work;
  }
  function report(cause) {
    if (!quitting) dialog.showMessageBox(main, { type: 'error', title: '图记', message: '内容尚未保存，窗口已保留', detail: String(cause?.message ?? cause) });
  }
  async function prepare(window) {
    if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
    const requestId = ++token;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('保存等待超时，请检查编辑内容后重试。')); }, 15000);
      pending.set(requestId, { sender: window.webContents.id, resolve, reject, timer });
      window.webContents.send('tuji:desktop-prepare', requestId);
    });
  }
  const owner = () => state.host === 'panel' ? panel : main;
  function display() { return screen.getDisplayNearestPoint(orbCenter ?? screen.getCursorScreenPoint()); }
  function positionOrb(point = orbCenter, snap = false) {
    const area = screen.getDisplayNearestPoint(point ?? screen.getCursorScreenPoint()).workArea;
    let x = clamp(point?.x ?? area.x + area.width - 180, area.x, area.x + area.width);
    let y = clamp(point?.y ?? area.y + area.height * .48, area.y, area.y + area.height);
    const distances = [['left', x - area.x], ['right', area.x + area.width - x], ['top', y - area.y], ['bottom', area.y + area.height - y]].sort((a,b) => a[1] - b[1]);
    const edge = snap && distances[0][1] < RADIUS + 14 ? distances[0][0] : '';
    x = clamp(x, area.x + RADIUS + 5, area.x + area.width - RADIUS - 5);
    y = clamp(y, area.y + RADIUS + 5, area.y + area.height - RADIUS - 5);
    if (edge === 'left') x = area.x;
    if (edge === 'right') x = area.x + area.width;
    if (edge === 'top') y = area.y;
    if (edge === 'bottom') y = area.y + area.height;
    orbCenter = { x: Math.round(x), y: Math.round(y) };
    state.orb = { flipX: x + 125 > area.x + area.width, flipY: y + 125 > area.y + area.height, dock: edge };
    orb?.setBounds({ x: orbCenter.x - HALF, y: orbCenter.y - HALF, width: ORB_SIZE, height: ORB_SIZE }, false);
    publish();
  }
  function trackOrbPointer(force = false) {
    if (!orb || orb.isDestroyed() || !orb.isVisible()) return;
    const cursor = screen.getCursorScreenPoint(), bounds = orb.getBounds();
    const pointer = { x: cursor.x - bounds.x, y: cursor.y - bounds.y, visible: true };
    if (force || !lastOrbPointer || pointer.x !== lastOrbPointer.x || pointer.y !== lastOrbPointer.y || Date.now() - lastOrbPointerAt >= 120) {
      lastOrbPointer = pointer; lastOrbPointerAt = Date.now(); orb.webContents.send('tuji:orb-pointer', pointer);
    }
  }
  async function makeWindow(role, options) {
    const window = new BrowserWindow({ frame: false, show: false, title: role === 'orb' ? '图记悬浮球' : '图记侧边页', icon,
      skipTaskbar: true, ...options, webPreferences: { preload, contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false,
        backgroundThrottling: false, additionalArguments: [`--tuji-role=${role}`] } });
    const contentsId = window.webContents.id;
    windows.set(contentsId, { role, window });
    secure(window); window.removeMenu();
    // Page zoom in the editor must never move the orb away from its native hit
    // coordinates. Electron otherwise shares zoom across this same origin.
    window.webContents.setZoomMode(role === 'orb' ? 'disabled' : 'isolated');
    window.on('close', event => { if (!quitting) { event.preventDefault(); void enqueue(hidePanel).catch(report); } });
    window.once('closed', () => windows.delete(contentsId));
    await window.loadURL(`${origin}/?desktop=${role}`);
    return window;
  }
  async function ensureOrb() {
    if (!orb) {
      // showInactive avoids stealing focus on appearance. Keep the window
      // focusable so Windows delivers the first button-down after a handoff.
      orb = await makeWindow('orb', { width: ORB_SIZE, height: ORB_SIZE, minWidth: ORB_SIZE, minHeight: ORB_SIZE,
        maxWidth: ORB_SIZE, maxHeight: ORB_SIZE, transparent: true, backgroundColor: '#00000000',
        resizable: false, maximizable: false, minimizable: false, hasShadow: false, alwaysOnTop: true });
      orb.setIgnoreMouseEvents(true, { forward: true });
      // Windows can stop forwarding moves when a click-through window is shown
      // beneath a stationary cursor, or while crossing fully transparent pixels.
      // Track only this visible window; do not depend on DOM enter/leave events.
      orb.on('show', () => {
        clearInterval(orbPointerTimer); lastOrbPointer = undefined;
        trackOrbPointer(true); orbPointerTimer = setInterval(trackOrbPointer, 32);
      });
      orb.on('hide', () => {
        clearInterval(orbPointerTimer); lastOrbPointer = undefined; dragStart = undefined;
        orb.setIgnoreMouseEvents(true, { forward: true });
        orb.webContents.send('tuji:orb-pointer', { x: 0, y: 0, visible: false });
      });
      positionOrb(orbCenter, true);
    }
    return orb;
  }
  async function ensurePanel() {
    if (!panel) {
      panel = await makeWindow('panel', { width: state.width, height: 760, minWidth: 360, minHeight: 360,
        backgroundColor: '#080f1d', alwaysOnTop: true });
      panel.on('resize', () => { if (!transition && panel.isVisible()) { state.width = panel.getBounds().width;
        if (state.detached) detachedBounds = panel.getBounds(); publish(); } });
      panel.on('move', () => { if (!transition && state.detached && panel.isVisible()) detachedBounds = panel.getBounds(); });
    }
    return panel;
  }
  function positionPanel() {
    const area = (state.background ? display() : screen.getDisplayMatching(main.getBounds())).workArea;
    let bounds = state.detached ? detachedBounds ?? { x: area.x + area.width - state.width - 40, y: area.y + 40,
      width: state.width, height: Math.min(720, area.height - 80) } : { x: area.x + area.width - state.width,
      y: area.y, width: state.width, height: area.height };
    bounds = { width: clamp(bounds.width, 360, area.width), height: clamp(bounds.height, 360, area.height),
      x: clamp(bounds.x, area.x, area.x + area.width - Math.min(bounds.width, area.width)),
      y: clamp(bounds.y, area.y, area.y + area.height - Math.min(bounds.height, area.height)) };
    panel.setBounds(bounds, false); state.width = bounds.width;
    panel.setResizable(state.detached);
  }
  async function hideMain() {
    if (quitting || state.background) return;
    await prepare(owner());
    state.background = true; state.host = 'none'; state.detached = false;
    panel?.hide(); main.hide();
    await ensureOrb(); publish(); if (!smoke) orb.showInactive();
  }
  async function showMain() {
    await prepare(owner());
    state.background = false; state.host = 'none'; state.detached = false;
    orb?.hide(); panel?.hide(); publish();
    if (main.isMinimized()) main.restore(); main.show(); main.focus();
  }
  async function openPanel(tab) {
    await prepare(owner());
    if (typeof tab === 'string' && tab.length < 200) state.activeTab = tab;
    state.used = true;
    if (state.background || state.detached) {
      await ensurePanel(); positionPanel(); state.host = 'panel'; orb?.hide(); publish();
      if (!smoke) { panel.show(); panel.focus(); }
    } else { state.host = 'main'; publish(); }
  }
  async function hidePanel() {
    await prepare(owner());
    // Let the renderer finish the outward slide before hiding its native surface.
    state.host = 'none'; publish();
    await new Promise(resolve => setTimeout(resolve, 210));
    panel?.hide();
    if (state.background) { await ensureOrb(); if (!smoke) orb.showInactive(); }
  }
  async function toggleDetach() {
    await prepare(owner());
    state.detached = !state.detached;
    if (!state.background && !state.detached) { panel?.hide(); state.host = 'main'; publish(); }
    else { await ensurePanel(); positionPanel(); state.host = 'panel'; publish(); if (!smoke) { panel.show(); panel.focus(); } }
  }
  ipcMain.handle(CHANNEL, (event, action, payload = {}) => {
    const { role } = trusted(event);
    if (action === 'get-state') return state;
    if (action === 'forget-tab') {
      if (typeof payload.id !== 'string' || payload.id.length > 200) throw new Error('无效的标签');
      delete state.drafts[payload.id]; delete state.reading[payload.id];
      if (state.activeTab === payload.id) state.activeTab = typeof payload.next === 'string' && payload.next.length < 200 ? payload.next : 'notebook';
      publish(); return state;
    }
    if (action === 'set-context') {
      if (role !== 'main') throw new Error('只有主窗口可以选择画布');
      if (typeof payload.canvasId === 'string') state.canvasId = payload.canvasId;
      if (payload.enteredSessionByCanvas && typeof payload.enteredSessionByCanvas === 'object') state.enteredSessionByCanvas = payload.enteredSessionByCanvas;
      publish(); return state;
    }
    if (action === 'patch-view') {
      if (role === 'orb' || (state.host === 'panel' && role !== 'panel') || (state.host === 'main' && role !== 'main')) return state;
      if (typeof payload.notePageId === 'string') state.notePageId = payload.notePageId;
      if (typeof payload.noteDirectoryId === 'string') state.noteDirectoryId = payload.noteDirectoryId;
      if (Array.isArray(payload.noteTabs)) state.noteTabs = payload.noteTabs.filter(tab => tab && typeof tab.id === 'string'
        && tab.id.startsWith('note-view:') && typeof tab.directoryId === 'string' && ['directory', 'pages'].includes(tab.kind))
        .map(({ id, directoryId, kind, pageId }) => ({ id, directoryId, kind, ...(typeof pageId === 'string' ? { pageId } : {}) }));
      if (Number.isFinite(payload.width)) { state.width = clamp(payload.width, 360, 1200); if (state.host === 'panel' && !state.detached) positionPanel(); }
      for (const key of ['drafts', 'reading']) if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) state[key] = payload[key];
      if (typeof payload.activeTab === 'string' && payload.activeTab.length < 200) state.activeTab = payload.activeTab;
      publish(); return state;
    }
    return enqueue(async () => {
      if (action === 'show-main') await showMain();
      else if (action === 'open-panel') await openPanel(payload.tab);
      else if (action === 'hide-panel' && role !== 'orb') await hidePanel();
      else if (action === 'toggle-detach' && role !== 'orb') await toggleDetach();
      else throw new Error('不支持的窗口操作');
      return state;
    });
  });
  ipcMain.on('tuji:desktop-prepared', (event, requestId, error) => {
    try { trusted(event); } catch { return; }
    const entry = pending.get(requestId); if (!entry || entry.sender !== event.sender.id) return;
    pending.delete(requestId); clearTimeout(entry.timer);
    if (error) entry.reject(new Error(String(error))); else entry.resolve();
  });
  ipcMain.on('tuji:orb-hit-test', (event, interactive) => {
    try { if (trusted(event).role === 'orb' && typeof interactive === 'boolean') orb?.setIgnoreMouseEvents(!interactive, { forward: true }); } catch { /* Untrusted. */ }
  });
  ipcMain.on('tuji:orb-drag', (event, phase) => {
    try { if (trusted(event).role !== 'orb' || !orbCenter) return; } catch { return; }
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'start') dragStart = { cursor, center: { ...orbCenter } };
    else if (phase === 'move' && dragStart) positionOrb({ x: dragStart.center.x + cursor.x - dragStart.cursor.x, y: dragStart.center.y + cursor.y - dragStart.cursor.y });
    else if (phase === 'end') { const dragging = dragStart; dragStart = undefined; if (dragging) positionOrb(orbCenter, true); }
    else if (phase === 'cancel') dragStart = undefined;
  });
  main.on('close', event => { if (!quitting) { event.preventDefault(); void enqueue(hideMain).catch(report); } });
  main.on('minimize', () => { if (!quitting) void enqueue(hideMain).catch(report); });
  main.on('restore', () => { if (state.background && !transition) void enqueue(showMain).catch(report); });
  const displayChanged = () => { if (orb) positionOrb(orbCenter, true); if (panel && state.host === 'panel') positionPanel(); };
  screen.on('display-metrics-changed', displayChanged); screen.on('display-removed', displayChanged);
  tray = new Tray(icon); tray.setToolTip('图记');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开图记', click: () => { void enqueue(showMain).catch(report); } },
    { type: 'separator' }, { label: '退出', click: () => { void quit(); } }]));
  tray.on('click', () => { void enqueue(showMain).catch(report); });
  return {
    showMain: () => enqueue(showMain),
    async beforeQuit() {
      await queue;
      await prepare(owner()); if (state.host === 'panel') await prepare(main);
      persist(); quitting = true; clearTimeout(saveTimer); clearInterval(orbPointerTimer); tray.destroy();
    },
    destroy() { quitting = true; clearTimeout(saveTimer); clearInterval(orbPointerTimer); if (tray && !tray.isDestroyed()) tray.destroy(); orb?.destroy(); panel?.destroy(); }
  };
}
