import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { buildAiRuntime, projectRoot } from '../scripts/build-ai.mjs';

await buildAiRuntime();
if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) throw new Error('请先运行 npm run build 构建桌面页面。');
const require = createRequire(import.meta.url);
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(projectRoot, 'desktop')],
  { cwd: projectRoot, env: environment, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
child.on('error', error => { console.error(`桌面启动失败：${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true; child.stdin.end('QIXUE_SHUTDOWN\n');
  const timeout = setTimeout(() => child.kill(), 5000); timeout.unref(); child.once('exit', () => clearTimeout(timeout));
});
