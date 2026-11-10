import { app, BrowserWindow, safeStorage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCredentialStorage } from '../scripts/credential-storage.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('图记');
app.setAppUserModelId('io.github.wang-honghzhen.tuji');
const directory = path.resolve(process.env.QIXUE_DATA_DIR ?? (app.isPackaged
  ? path.join(app.getPath('appData'), 'QIXUE-v2') : path.join(projectRoot, '.local', 'data')));
app.setPath('userData', path.join(directory, 'desktop-profile'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let window;
  let host;
  let vite;
  let shuttingDown = false;
  let mayQuit = false;
  const credentialStorage = createCredentialStorage(directory, { safeStorage });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    host?.beginShutdown(); await vite?.close(); await host?.close();
    mayQuit = true; if (process.exitCode === 1) app.exit(1); else app.quit();
  };
  app.on('before-quit', event => { if (!mayQuit) { event.preventDefault(); void shutdown().catch(() => { mayQuit = true; app.quit(); }); } });
  app.on('window-all-closed', () => { void shutdown(); });
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
    const runtimeModule = await import(pathToFileURL(path.join(runtimeRoot, 'dist-ai', 'server.cjs')).href);
    const runtime = runtimeModule.default ?? runtimeModule;
    host = await runtime.startApplicationServer({ databasePath: path.join(directory, 'qixue.sqlite'),
      artifactDirectory: path.join(directory, 'artifacts'), credentialStorage, port: Number(process.env.QIXUE_PORT ?? 0),
      ...(!app.isPackaged && process.env.QIXUE_USE_VITE ? {} : { distDirectory: path.join(projectRoot, 'dist') }) });
    if (!app.isPackaged && process.env.QIXUE_USE_VITE) {
      const { createServer } = await import('vite');
      vite = await createServer({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.ts'),
        server: { middlewareMode: true, host: '127.0.0.1', hmr: { server: host.server } }, appType: 'spa' });
      host.setMiddleware(vite.middlewares);
    }
    window = new BrowserWindow({ width: 1450, height: 920, minWidth: 960, minHeight: 620,
      title: '图记', icon: path.join(projectRoot, 'dist', 'brand', 'tree.png'), backgroundColor: '#020617', show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      // Source links open in the system browser, never inside the local workspace.
      try {
        const target = new URL(url);
        if (['http:', 'https:'].includes(target.protocol) && target.hostname && !target.username && !target.password) void shell.openExternal(target.href).catch(() => {});
      } catch { /* Ignore malformed links. */ }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== host.url) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await window.loadURL(host.url);
    if (process.argv.includes('--smoke-test')) console.log(`QIXUE_SMOKE_READY ${host.url}`);
    else { window.show(); window.focus(); }
  } catch (error) {
    console.error(`图记桌面启动失败：${error instanceof Error ? error.message : '未知错误'}`);
    process.exitCode = 1; await shutdown();
  } });
}
