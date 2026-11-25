import { BrowserWindow, Tray, Menu, ipcMain, screen, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { attachWindowDrag } from './window-controls.mjs';

const CHANNEL = 'tuji:desktop';
const ORB_SIZE = 280, HALF = ORB_SIZE / 2, RADIUS = 28;
const RESPONSE_TIMEOUT_MS = 15000, SAVE_TIMEOUT_MS = 125000;
const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

/** One owner for window visibility and editing. Renderers never open native windows. */
export function createCompanion({ main, origin, preload, icon, directory, secure, quit }) {
  const settingsPath = path.join(directory, 'desktop-profile', 'companion.json');
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* First run or disposable UI cache. */ }
  const state = { ready: true, host: 'none', background: false, detached: false, panelExitId: 0, used: !!saved.used,
    activeTab: typeof saved.activeTab === 'string' ? saved.activeTab : 'notebook', canvasId: '',
    width: clamp(Number(saved.width) || 520, 360, 1200), notePageId: saved.notePageId ?? '',
    noteTabs: Array.isArray(saved.noteTabs) ? saved.noteTabs : [], noteDirectoryId: saved.noteDirectoryId ?? '',
    dockedAiCanvases: Array.isArray(saved.dockedAiCanvases) ? saved.dockedAiCanvases.filter(id => typeof id === 'string') : [],
    drafts: saved.drafts ?? {}, reading: saved.reading ?? {}, enteredSessionByCanvas: {},
    orb: { flipX: false, flipY: false, dock: '' } };
  const windows = new Map([[main.webContents.id, { role: 'main', window: main }]]);
  let orb, panel, tray, quitting = false, transition = false, queue = Promise.resolve(), saveTimer;
  let lastTransition, closing, reporting = false, panelLoading, finishPanelExit;
  let orbPointerTimer, lastOrbPointer, lastOrbPointerAt = 0;
  let orbCenter = saved.orbCenter, detachedBounds = saved.detachedBounds, dragStart, token = 0;
  const pending = new Map();
  function persist() {
    clearTimeout(saveTimer);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ used: state.used, activeTab: state.activeTab, width: state.width,
      notePageId: state.notePageId, noteTabs: state.noteTabs, noteDirectoryId: state.noteDirectoryId,
      drafts: state.drafts, reading: state.reading, dockedAiCanvases: state.dockedAiCanvases, orbCenter, detachedBounds }));
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
    if (closing || quitting) return Promise.resolve();
    if (lastTransition?.fn === fn) return lastTransition.work;
    const work = queue.then(async () => {
      transition = true;
      try { return await fn(); }
      finally { transition = false; if (lastTransition?.work === work) lastTransition = undefined; }
    });
    lastTransition = { fn, work };
    queue = work.catch(() => undefined); return work;
  }
  async function report(cause) {
    if (quitting || reporting) return;
    reporting = true;
    try {
      await dialog.showMessageBox(state.host === 'panel' ? panel : main, { type: 'error', title: '图记',
        message: '内容尚未保存，窗口已保留', detail: String(cause?.message ?? cause) });
    } finally { reporting = false; }
  }
  async function prepare(window) {
    if (!window || window.isDestroyed() || !window.webContents.getURL()) return;
    const contents = window.webContents;
    if (contents.isCrashed()) throw new Error('编辑窗口已停止响应，无法确认保存。');
    const throttled = contents.getBackgroundThrottling();
    const requestId = ++token;
    let timer, deadline;
    if (throttled) contents.setBackgroundThrottling(false);
    try {
      await new Promise((resolve, reject) => {
        const heartbeat = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error('编辑窗口未响应保存请求，请返回窗口检查后重试。')), RESPONSE_TIMEOUT_MS);
        };
        heartbeat();
        // Allow the renderer its normal two-minute command timeout. If a save
        // never settles, keep the editor accessible and let the user retry.
        deadline = setTimeout(() => reject(new Error('编辑内容仍在等待保存，请查看编辑窗口并在操作完成后重试。')), SAVE_TIMEOUT_MS);
        pending.set(requestId, { sender: contents.id, resolve, reject, heartbeat });
        contents.send('tuji:desktop-prepare', requestId);
      });
    } catch (error) {
      if (!contents.isDestroyed()) contents.send('tuji:desktop-prepare-ended', requestId);
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(deadline); pending.delete(requestId);
      if (throttled && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
    }
  }
  // A background main window completed its save barrier before being hidden.
  // The orb never owns an editor. Only a visible editing host can hand one off.
  const owner = () => state.host === 'panel' ? panel : state.background ? undefined : main;
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
    window.on('close', event => {
      if (quitting) return;
      event.preventDefault();
      if (reporting) return;
      if (role === 'panel' && state.host === 'panel') void enqueue(hidePanel).catch(report);
      else if (role === 'orb' && state.background && state.host === 'none') void enqueue(showMain).catch(report);
    });
    window.once('closed', () => windows.delete(contentsId));
    try { await window.loadURL(`${origin}/?desktop=${role}`); }
    catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
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
  async function createPanel() {
    const window = await makeWindow('panel', { width: state.width, height: 760, minWidth: 360, minHeight: 360,
      transparent: true, backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: true, maximizable: false });
    if (quitting) { window.destroy(); return; }
    panel = window;
    attachWindowDrag(panel, origin, () => state.detached && state.host === 'panel' && !transition);
    panel.on('resize', () => { if (!transition && panel.isVisible()) { state.width = panel.getBounds().width;
      if (state.detached) detachedBounds = panel.getBounds(); publish(); } });
    panel.on('move', () => { if (!transition && state.detached && panel.isVisible()) detachedBounds = panel.getBounds(); });
  }
  async function ensurePanel() {
    if (panel) return;
    panelLoading ??= createPanel().finally(() => { panelLoading = undefined; });
    await panelLoading;
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
    try {
      await ensureOrb();
      if (state.host === 'panel') await prepare(panel);
      await prepare(main);
    } catch (error) {
      if (main.isMinimized()) main.restore();
      throw error;
    }
    state.background = true; state.host = 'none'; state.detached = false;
    panel?.hide(); main.hide();
    publish(); orb.showInactive();
    // Load the hidden renderer while the orb is available. A click during
    // startup shares the load, and a failed preload can be retried on click.
    void ensurePanel().catch(() => undefined);
  }
  async function showMain() {
    if (state.host === 'panel') await prepare(panel);
    if (state.background || state.host === 'panel') {
      state.background = false; state.host = 'none'; state.detached = false;
      orb?.hide(); panel?.hide(); publish();
    }
    if (main.isMinimized()) main.restore(); main.show(); main.focus();
  }
  async function openPanel(tab) {
    if (state.background || state.detached) await ensurePanel();
    await prepare(owner());
    if (typeof tab === 'string' && tab.length < 200) state.activeTab = tab;
    state.used = true;
    if (state.background || state.detached) {
      positionPanel(); state.host = 'panel'; orb?.hide(); publish();
      panel.show(); panel.focus();
    } else { state.host = 'main'; publish(); }
  }
  async function hidePanel() {
    if (state.host === 'none') return;
    await prepare(owner());
    const nativeExit = state.host === 'panel';
    if (nativeExit) state.panelExitId = ++token;
    state.host = 'none'; publish();
    if (nativeExit) {
      // A renderer that unmounted or stopped responding must not strand the orb.
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 850);
        finishPanelExit = () => { clearTimeout(timeout); resolve(); };
      });
      state.panelExitId = 0; finishPanelExit = undefined;
      panel.hide();
    }
    if (state.background) { await ensureOrb(); orb.showInactive(); }
  }
  async function toggleDetach() {
    const detached = !state.detached;
    if (state.background || detached) await ensurePanel();
    await prepare(owner());
    state.detached = detached;
    if (!state.background && !state.detached) { panel?.hide(); state.host = 'main'; publish(); }
    else { positionPanel(); state.host = 'panel'; publish(); panel.show(); panel.focus(); }
  }
  ipcMain.handle(CHANNEL, (event, action, payload = {}) => {
    const { role } = trusted(event);
    if (action === 'get-state') return state;
    if (action === 'panel-slide-ended') {
      if (role === 'panel' && state.panelExitId === payload.id) finishPanelExit?.();
      return;
    }
    if (action === 'set-canvas-ai-dock') {
      if (role !== 'main' || typeof payload.canvasId !== 'string' || !payload.canvasId || typeof payload.docked !== 'boolean') throw new Error('无效的画布侧页设置');
      const canvases = new Set(state.dockedAiCanvases);
      if (payload.docked) canvases.add(payload.canvasId); else canvases.delete(payload.canvasId);
      state.dockedAiCanvases = [...canvases]; publish(); return state;
    }
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
  function pendingSave(event, requestId) {
    try { trusted(event); } catch { return; }
    const entry = pending.get(requestId);
    if (entry?.sender === event.sender.id) return entry;
  }
  ipcMain.on('tuji:desktop-preparing', (event, requestId) => pendingSave(event, requestId)?.heartbeat());
  ipcMain.on('tuji:desktop-prepared', (event, requestId, error) => {
    const entry = pendingSave(event, requestId); if (!entry) return;
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
  main.on('close', event => { if (!quitting) { event.preventDefault(); if (!reporting) void enqueue(hideMain).catch(report); } });
  main.on('minimize', () => { if (!quitting && !reporting) void enqueue(hideMain).catch(report); });
  main.on('restore', () => { if (state.background && !transition) void enqueue(showMain).catch(report); });
  const displayChanged = () => { if (orb) positionOrb(orbCenter, true); if (panel && state.host === 'panel') positionPanel(); };
  screen.on('display-metrics-changed', displayChanged); screen.on('display-removed', displayChanged);
  tray = new Tray(icon); tray.setToolTip('图记');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开图记', click: () => { void enqueue(showMain).catch(report); } },
    { type: 'separator' }, { label: '退出', click: () => { void quit(); } }]));
  tray.on('click', () => { void enqueue(showMain).catch(report); });
  return {
    showMain: () => enqueue(showMain).catch(report),
    beforeQuit() {
      if (closing) return closing;
      // Finish accepted transfers first. A restore/close during the quit
      // barrier must not transfer editing to a new host behind that barrier.
      closing = queue.then(async () => {
        if (state.host === 'panel') await prepare(panel);
        await prepare(main);
        persist(); quitting = true; clearTimeout(saveTimer); clearInterval(orbPointerTimer); tray.destroy();
      }).finally(() => { closing = undefined; });
      return closing;
    },
    destroy() { quitting = true; clearTimeout(saveTimer); clearInterval(orbPointerTimer); if (tray && !tray.isDestroyed()) tray.destroy(); orb?.destroy(); panel?.destroy(); }
  };
}
