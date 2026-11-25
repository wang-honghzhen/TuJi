import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCredentialStorage } from '../scripts/credential-storage.mjs';
import { resolveDataDirectory } from './data-directory.mjs';
import { attachWindowControls } from './window-controls.mjs';
import { createCompanion } from './companion.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('图记');
app.setAppUserModelId('io.github.wang-honghzhen.tuji');
Menu.setApplicationMenu(null);
let directory;
try {
  directory = resolveDataDirectory({ appData: app.getPath('appData'), installDirectory: path.dirname(process.execPath),
    projectRoot, packaged: app.isPackaged, override: process.env.QIXUE_DATA_DIR });
} catch (error) {
  dialog.showErrorBox('无法打开图记数据目录', error instanceof Error ? error.message : '请重新运行安装程序选择可用的数据目录。');
  app.exit(1);
}
app.setPath('userData', path.join(directory, 'desktop-profile'));
if (!app.requestSingleInstanceLock() || process.argv.includes('--quit')) { app.quit(); }
else {
  let window;
  let host;
  let vite;
  let companion;
  let shuttingDown = false;
  let mayQuit = false;
  const credentialStorage = createCredentialStorage(directory, { safeStorage });
  app.on('second-instance', (_event, argv) => { if (argv.includes('--quit')) void shutdown(); else if (companion) void companion.showMain(); });
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    try { await companion?.beforeQuit(); }
    catch (error) { shuttingDown = false; console.error('图记退出前保存失败', error); dialog.showErrorBox('请先保存编辑内容', String(error?.message ?? error)); return; }
    host?.beginShutdown(); await vite?.close(); await host?.close();
    companion?.destroy();
    mayQuit = true; if (process.exitCode === 1) app.exit(1); else app.quit();
  };
  app.on('before-quit', event => { if (!mayQuit) { event.preventDefault(); void shutdown().catch(() => { mayQuit = true; app.quit(); }); } });
  app.on('window-all-closed', () => { if (!companion) void shutdown(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
  process.stdin.setEncoding('utf8');
  let control = '';
  process.stdin.on('data', chunk => {
    control += chunk;
    for (let end; (end = control.indexOf('\n')) >= 0;) {
      const command = control.slice(0, end).trim(); control = control.slice(end + 1);
      if (command === 'QIXUE_SHUTDOWN') void shutdown();
    }
  });
  // Electron emits ready after the main ESM finishes evaluating. Awaiting it at
  // module top level would make startup wait for itself.
  void app.whenReady().then(async () => { try {
    const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : projectRoot;
    if (app.isPackaged && !process.env.QIXUE_OCR_DATA_DIR) process.env.QIXUE_OCR_DATA_DIR = path.join(process.resourcesPath, 'ocr');
    const runtimeDirectory = !app.isPackaged && process.env.TUJI_WORKSPACE_RUNTIME
      ? process.env.TUJI_WORKSPACE_RUNTIME : path.join(runtimeRoot, 'dist-ai');
    const runtimeModule = await import(pathToFileURL(path.join(runtimeDirectory, 'server.cjs')).href);
    const runtime = runtimeModule.default ?? runtimeModule;
    host = await runtime.startApplicationServer({ databasePath: path.join(directory, 'qixue.sqlite'),
      artifactDirectory: path.join(directory, 'artifacts'), credentialStorage, port: Number(process.env.QIXUE_PORT ?? 0),
      ...(!app.isPackaged && process.env.QIXUE_USE_VITE ? {} : { distDirectory: path.join(projectRoot, 'dist') }) });
    if (!app.isPackaged && process.env.QIXUE_USE_VITE) {
      const { createServer } = await import('vite');
      vite = await createServer({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.ts'),
        server: { middlewareMode: true, host: '127.0.0.1', hmr: { server: host.server },
          ...(process.env.TUJI_WORKSPACE_RUNTIME ? {watch:{ignored:['**/docs/**','**/scripts/**','**/release/**']}} : {}) }, appType: 'spa' });
      host.setMiddleware(vite.middlewares);
    }
    window = new BrowserWindow({ width: 1450, height: 920, minWidth: 960, minHeight: 620, frame: false,
      title: '图记', icon: path.join(projectRoot, app.isPackaged ? 'dist' : 'public', 'brand', 'app-icon.png'), backgroundColor: '#020617', show: false,
      webPreferences: { preload: path.join(projectRoot, 'desktop', 'preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false } });
    window.removeMenu(); window.setMenuBarVisibility(false);
    attachWindowControls(window, host.url);
    const secure = targetWindow => {
    targetWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Source links open in the system browser, never inside the local workspace.
      try {
        const target = new URL(url);
        if (['http:', 'https:'].includes(target.protocol) && target.hostname && !target.username && !target.password) void shell.openExternal(target.href).catch(() => {});
      } catch { /* Ignore malformed links. */ }
      return { action: 'deny' };
    });
    targetWindow.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== host.url) event.preventDefault(); });
    targetWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    targetWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    };
    secure(window);
    companion = createCompanion({ main: window, origin: host.url, preload: path.join(projectRoot, 'desktop', 'preload.cjs'),
      icon: path.join(projectRoot, 'desktop', 'assets', 'app-icon.ico'), directory, secure, quit: shutdown });
    await window.loadURL(host.url);
    window.show(); window.focus();
  } catch (error) {
    console.error(`图记桌面启动失败：${error instanceof Error ? error.message : '未知错误'}`);
    process.exitCode = 1; await shutdown();
  } });
}
