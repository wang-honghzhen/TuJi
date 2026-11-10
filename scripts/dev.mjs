import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { buildAiRuntime, projectRoot } from './build-ai.mjs';
import { createCredentialStorage } from './credential-storage.mjs';

const runtimeFile = await buildAiRuntime();
if (process.argv.includes('--desktop')) {
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const environment = { ...process.env, QIXUE_USE_VITE: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(projectRoot, 'desktop')], { cwd: projectRoot, env: environment, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', error => { console.error(`桌面启动失败：${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return; stopping = true; child.stdin.end('QIXUE_SHUTDOWN\n');
    const timeout = setTimeout(() => child.kill(), 5000); timeout.unref(); child.once('exit', () => clearTimeout(timeout));
  });
} else {
  const require = createRequire(import.meta.url);
  const directory = path.resolve(process.env.QIXUE_DATA_DIR ?? path.join(projectRoot, '.local', 'data'));
  let port = Number(process.env.QIXUE_PORT ?? 5173);
  let host;
  let vite;
  const credentialStorage = createCredentialStorage(directory);
  const closeHost = async () => {
    host?.beginShutdown();
    try { await vite?.close(); } finally { await host?.close(); vite = undefined; host = undefined; }
  };
  const startHost = async () => {
    // The bundled CJS module must also leave Node's cache after a rebuild.
    delete require.cache[require.resolve(runtimeFile)];
    const runtime = require(runtimeFile);
    host = await runtime.startApplicationServer({ databasePath: path.join(directory, 'qixue.sqlite'),
      artifactDirectory: path.join(directory, 'artifacts'), port, credentialStorage });
    port = host.port;
    try {
      vite = await createServer({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.ts'),
        server: { middlewareMode: true, host: '127.0.0.1', hmr: { server: host.server } }, appType: 'spa' });
      host.setMiddleware(vite.middlewares);
    } catch (error) { await closeHost(); throw error; }
    console.log(`图记开发界面：http://localhost:${host.port}/ （已连接本地 AI 服务）`);
  };
  let closing = false;
  let reloadChain = Promise.resolve();
  let reloadTimer;
  const sourceWatcher = watch(path.join(projectRoot, 'src'), { recursive: true }, (_event, filename) => {
    const relative = String(filename ?? '').replaceAll('\\', '/');
    if (closing || !/^(?:ai\/server\/.*\.ts|ai\/domain\.ts|v3\/.*\.ts)$/.test(relative)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadChain = reloadChain.then(async () => {
        if (closing) return;
        console.log('后端源码已更新，正在保存任务状态并重载本地服务…');
        await closeHost();
        await buildAiRuntime();
        if (!closing) await startHost();
      }).catch(error => { console.error(`本地服务重载失败：${error.message}；修正源码后会自动重试。`); });
    }, 300);
  });
  sourceWatcher.on('error', error => { console.error(`后端源码监听失败：${error.message}`); });
  // Serialize initial startup with changes arriving during the first build.
  reloadChain = startHost();
  try { await reloadChain; } catch (error) { closing = true; sourceWatcher.close(); await closeHost(); throw error; }
  const shutdown = async () => {
    if (closing) return;
    closing = true; clearTimeout(reloadTimer); sourceWatcher.close();
    process.stdin.pause();
    try { await reloadChain; } finally { await closeHost(); }
  };
  process.stdin.setEncoding('utf8');
  let control = '';
  process.stdin.on('data', chunk => {
    control += chunk;
    for (let end; (end = control.indexOf('\n')) >= 0;) {
      const command = control.slice(0, end).trim(); control = control.slice(end + 1);
      if (command === 'QIXUE_SHUTDOWN') void shutdown().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); });
}
