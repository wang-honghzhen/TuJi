import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runtimeCheck(resources, dataDirectory) {
  const runtime = path.join(resources, 'app.asar.unpacked');
  const require = createRequire(path.join(runtime, 'dist-ai', 'server.cjs'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE smoke(value TEXT); INSERT INTO smoke VALUES (\'Tuji\')');
  assert.equal(db.prepare('SELECT value FROM smoke').get().value, 'Tuji');
  db.close();
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(680, 140), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000'; context.font = '48px Arial'; context.fillText('TUJI DESKTOP 2026', 25, 90);
  const png = canvas.toBuffer('image/png');
  assert.ok(png.length > 1000);
  const { createWorker } = require('tesseract.js');
  await fs.mkdir(path.join(dataDirectory, 'ocr-cache'), { recursive: true });
  const worker = await createWorker('chi_sim+eng', 1, { langPath: path.join(resources, 'ocr'),
    cachePath: path.join(dataDirectory, 'ocr-cache'), gzip: false, errorHandler: () => {} });
  try { assert.match((await worker.recognize(png)).data.text, /DESKTOP/i); }
  finally { await worker.terminate(); }

  const content = 'BT /F1 24 Tf 40 100 Td (Tuji desktop PDF) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(Buffer.from(pdf)), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1);
    assert.match((await page.getTextContent()).items.map(item => item.str ?? '').join(' '), /Tuji desktop PDF/);
    const viewport = page.getViewport({ scale: 1 }), image = createCanvas(500, 200);
    await page.render({ viewport, canvasContext: image.getContext('2d'), canvas: image }).promise;
    assert.ok(image.toBuffer('image/png').length > 1000);
  } finally { await loadingTask.destroy(); }
  const layout = new Worker(path.join(runtime, 'dist-ai', 'layout-worker.cjs'));
  try {
    const reply = once(layout, 'message', { signal: AbortSignal.timeout(10000) });
    layout.postMessage({ graph: { nodes: {}, documents: {}, canvases: [], edges: [], layoutVersion: 0 },
      options: { mode: 'auto', canvasId: 'smoke', solveTime: Date.now() } });
    const [message] = await reply; assert.ok(message.result, message.error);
  } finally { await layout.terminate(); }
  console.log('PASS: packaged SQLite, native canvas, PDF parsing/rendering, Chinese/English OCR and layout worker');
}

async function desktopCheck(executable) {
  await fs.access(executable);
  const cache = path.join(root, '.cache'); await fs.mkdir(cache, { recursive: true });
  const dataDirectory = await fs.mkdtemp(path.join(cache, 'desktop-smoke-'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const debugPort = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env, QIXUE_DATA_DIR: dataDirectory, QIXUE_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.QIXUE_USE_VITE; delete env.QIXUE_OCR_DATA_DIR; delete env.QIXUE_OCR_LANGUAGE;
  const child = spawn(executable, ['--smoke-test', `--remote-debugging-port=${debugPort}`],
    { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errorOutput = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errorOutput += data; });
  const exit = once(child, 'exit').then(([code]) => { exited = true; return code; });
  let socket;
  try {
    let url;
    for (let i = 0; i < 150; i++) {
      url = /QIXUE_SMOKE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) break;
      if (exited) throw new Error(`Desktop exited before ready: ${errorOutput}`);
      await delay(200);
    }
    assert.ok(url, `Desktop startup timeout: ${errorOutput}`);
    const stateLine = /^QIXUE_SMOKE_STATE (.+)$/m.exec(output);
    assert.ok(stateLine, 'Desktop did not report native window state');
    const windowState = JSON.parse(stateLine[1]);
    assert.equal(windowState.menuVisible, false, 'Native menu bar should be removed');
    assert.equal(windowState.applicationMenu, false, 'Default application menu should be removed');
    assert.equal(path.resolve(windowState.dataDirectory), path.resolve(dataDirectory));
    const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /id="root"/);
    const { token } = await (await fetch(`${url}/api/qixue/connection`)).json();
    const snapshot = await (await fetch(`${url}/api/qixue/snapshot`, { headers: { 'x-qixue-token': token } })).json();
    assert.equal(snapshot.schemaVersion, 3); assert.equal(snapshot.sessions.length, 0); assert.equal(snapshot.credentialConfigured, false);
    assert.ok((await fs.stat(path.join(dataDirectory, 'qixue.sqlite'))).size > 0);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find(item => item.type === 'page' && item.url.startsWith(url)); assert.ok(target);
    socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
    const evaluated = new Promise((resolve, reject) => {
      socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.id === 1) data.error ? reject(new Error(data.error.message)) : resolve(data.result); });
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => { for (let i = 0; i < 100; i++) { if (document.getElementById('root')?.childElementCount) return { title: document.title, text: document.body.innerText }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Renderer did not mount'); })()`,
      awaitPromise: true, returnByValue: true } }));
    const result = await evaluated; assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    assert.ok(result.result.value.text.length > 20, 'Renderer is empty');
    assert.match(result.result.value.text, /图记|连接|服务/);
    console.log('PASS: packaged desktop startup, no native menu, renderer, local API and isolated data directory');
  } finally {
    if (!exited && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 2, method: 'Page.close' }));
    else if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
    const timer = setTimeout(() => child.kill(), 10000); timer.unref();
    const code = await exit; clearTimeout(timer); socket?.close(); assert.equal(code, 0, errorOutput);
  }
  const runtime = spawn(executable, [script, '--runtime', path.join(path.dirname(executable), 'resources'), dataDirectory],
    { cwd: path.dirname(executable), windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  const timeout = setTimeout(() => runtime.kill(), 120000); timeout.unref();
  const [code] = await once(runtime, 'exit'); clearTimeout(timeout); assert.equal(code, 0, 'Packaged runtime verification failed');
  console.log(`Desktop verification complete. Isolated test data: ${dataDirectory}`);
}

if (process.argv[2] === '--runtime') await runtimeCheck(process.argv[3], process.argv[4]);
else await desktopCheck(path.resolve(root, process.argv[2] ?? 'release/win-unpacked/Tuji.exe'));
