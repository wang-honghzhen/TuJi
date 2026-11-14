import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = await fs.mkdtemp(path.join(root, '.cache', 'notebook-state-'));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open');
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugger disconnected')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}
async function launch() {
  const [mainPort, rendererPort] = await Promise.all([port(), port()]);
  const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE','QIXUE_USE_VITE','QIXUE_OCR_DATA_DIR']) delete env[key];
  const child = spawn(require('electron'), ['--inspect=127.0.0.1:' + mainPort, path.join(root, 'desktop'), '--smoke-test',
    '--remote-debugging-port=' + rendererPort], { cwd: root, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let stdout = '', stderr = '', exited = false, url, inspector;
  const clients = [];
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const exit = once(child, 'exit').then(([code]) => { exited = true; return code; });
  async function close() {
    if (!exited && inspector) await inspector.evaluate('e.app.quit(); true').catch(() => undefined);
    else if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
    for (const client of clients) client.close();
    const timer = setTimeout(() => child.kill(), 20000); timer.unref();
    const code = await exit; clearTimeout(timer);
    assert.equal(code, 0, stdout + '\n' + stderr);
  }
  try {
    for (let i = 0; i < 200; i++) {
      url = /QIXUE_SMOKE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
      if (url) break; assert.equal(exited, false, stderr); await delay(150);
    }
    assert.ok(url, stderr);
    const targets = await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json();
    inspector = await connect(targets[0].webSocketDebuggerUrl); clients.push(inspector);
    await inspector.evaluate('globalThis.e=process.getBuiltinModule("module").createRequire(' + JSON.stringify(path.join(root, 'package.json')) + ')("electron"); globalThis.mainWindow=e.BrowserWindow.getAllWindows()[0]; mainWindow.on("show",()=>mainWindow.hide()); mainWindow.webContents.setBackgroundThrottling(false); true');
    async function page(role) {
      let target;
      await until(async () => {
        const targets = await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json();
        target = targets.find(t => t.type === 'page' && t.url.startsWith(url) && (role === 'main' ? !t.url.includes('desktop=') : t.url.includes('desktop=' + role)));
        return target;
      }, role + ' renderer');
      const client = await connect(target.webSocketDebuggerUrl); clients.push(client);
      await until(() => client.evaluate('Boolean(window.tujiDesktop && document.querySelector("#root")?.childElementCount)'), role + ' ready');
      return client;
    }
    const main = await page('main');
    const token = (await (await fetch(url + '/api/qixue/connection')).json()).token;
    const command = async (action, payload = {}) => {
      const response = await fetch(url + '/api/qixue/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qixue-token': token }, body: JSON.stringify({ action, payload }) });
      const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
    };
    const snapshot = async () => (await fetch(url + '/api/qixue/snapshot', { headers: { 'x-qixue-token': token } })).json();
    return { main, page, command, snapshot, close };
  } catch (error) { await close(); throw error; }
}
const api = (client, action, payload = {}) => client.evaluate('window.tujiDesktop.command(' + JSON.stringify(action) + ',' + JSON.stringify(payload) + ')');
const state = client => client.evaluate('window.tujiDesktop.getState()');
async function click(client, selector) {
  await client.evaluate('(() => { const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)throw Error("Missing element");el.click(); })()');
}
async function folderClick(client, name) {
  await client.evaluate('(() => { const el=[...document.querySelectorAll(".note-folder-open")].find(el=>el.querySelector("strong")?.textContent===' + JSON.stringify(name) + ');if(!el)throw Error("Missing folder");el.click(); })()');
}
async function address(client, value) {
  await client.evaluate('document.querySelector("[aria-label=\\"笔记目录路径\\"]").focus();document.querySelector("[aria-label=\\"笔记目录路径\\"]").select()');
  await client.send('Input.insertText', { text: value });
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function scroll(client, top) {
  const actual = await client.evaluate('(() => {const el=document.querySelector(".utility-paper-scroll");el.scrollTop=' + top + ';el.dispatchEvent(new Event("scroll",{bubbles:true}));return el.scrollTop;})()');
  assert.equal(actual, top);
}

const first = await launch();
try {
  await first.command('settings.save', { provider: { baseUrl: 'http://127.0.0.1:9/v1' }, credential: 'notebook-state-local-test' });
  await until(() => first.main.evaluate('Boolean(document.querySelector("[data-user-notebook-bookmark]"))'), 'entry');
  const earlier = await first.command('userNote.create');
  const directory = await first.command('userNote.directory.create', { name: '目录状态' });
  const firstPage = await first.command('userNote.create', { directoryId: directory.id });
  const secondPage = await first.command('userNote.create', { directoryId: directory.id });
  await api(first.main, 'open-panel', { tab: 'note-directory' });
  await until(() => first.main.evaluate('Boolean(document.querySelector(".note-folder-open"))'), 'folder');
  await folderClick(first.main, '目录状态');
  await until(() => first.main.evaluate('Boolean(document.querySelector(".note-page-toolbar"))'), 'reader');
  const reader = (await state(first.main)).activeTab;
  const selected = async () => (await state(first.main)).noteTabs.find(tab => tab.id === reader);
  const visiblePage = () => first.main.evaluate('document.querySelector("[data-user-notebook-page]")?.dataset.userNotebookPage');
  await until(async () => (await selected()).pageId === firstPage.id, 'persist initial selection');
  await first.command('userNote.assign', { id: earlier.id, directoryId: directory.id, expectedVersion: earlier.version });
  await until(() => first.main.evaluate('document.querySelector("[data-user-note-page-total]")?.textContent.includes("3")'), 'earlier inserted');
  assert.equal(await visiblePage(), firstPage.id, 'Adding an earlier page must preserve the selected page identity');
  await click(first.main, '[aria-label="下一页笔记"]');
  await until(async () => (await selected()).pageId === secondPage.id, 'second page selection');
  const removed = await first.command('userNote.assign', { id: secondPage.id, directoryId: '', expectedVersion: secondPage.version });
  await until(async () => (await selected()).pageId === earlier.id && await visiblePage() === earlier.id, 'reconcile removed selection');
  await first.command('userNote.assign', { id: secondPage.id, directoryId: directory.id, expectedVersion: removed.version });
  await until(() => first.main.evaluate('document.querySelector("[data-user-note-page-total]")?.textContent.includes("3")'), 'readded page');
  assert.equal(await visiblePage(), earlier.id, 'Re-added page must not hijack the reading position');
  for (const page of (await first.snapshot()).userNotePages) {
    await first.command('userNote.assign', { id: page.id, directoryId: '', expectedVersion: page.version });
  }
  await first.command('userNote.directory.create', { name: '新下级', parentId: directory.id });
  await until(() => first.main.evaluate('document.querySelector(".note-folder-open strong")?.textContent==="新下级"'), 'reader converts to directory after folder changes mode');
  assert.equal((await selected()).kind, 'directory');
  assert.equal(await first.main.evaluate('Boolean(document.querySelector(".note-page-toolbar"))'), false);
  await first.command('userNote.directory.delete', { id: directory.id, deletePages: false });
  await until(async () => (await selected()).directoryId === '', 'deleted directory falls back to root');
  assert.equal((await selected()).kind, 'directory');
  assert.equal(await first.main.evaluate('document.querySelector("[aria-label=\\"笔记目录路径\\"]")?.value'), '/');
  console.log('PASS notebook live state: initial stable page; insert-before; moved-out/re-added selection; page-directory mode change; deleted path normalization');
} finally { await first.close(); }
