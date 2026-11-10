import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAiRuntime, projectRoot } from './build-ai.mjs';
import { createCredentialStorage } from './credential-storage.mjs';

const runtimeFile = path.join(projectRoot, 'dist-ai', 'server.cjs');
if (!existsSync(runtimeFile)) await buildAiRuntime();
if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) throw new Error('页面尚未构建，请先运行 npm run build。');
const imported = await import(pathToFileURL(runtimeFile).href);
const runtime = imported.default ?? imported;
const directory = path.resolve(process.env.QIXUE_DATA_DIR ?? path.join(projectRoot, '.local', 'data'));
const port = Number(process.env.QIXUE_PORT ?? 5173);
const host = await runtime.startApplicationServer({ databasePath: path.join(directory, 'qixue.sqlite'),
  artifactDirectory: path.join(directory, 'artifacts'), port, distDirectory: path.join(projectRoot, 'dist'), credentialStorage: createCredentialStorage(directory) });
console.log(`图记已启动：http://localhost:${host.port}/ （本地数据：${directory}）`);
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await host.close(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); });

