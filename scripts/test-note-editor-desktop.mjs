import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), require = createRequire(import.meta.url), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Timed out: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails)); return reply.result.value; };
  return { send, evaluate, close: () => socket.close() };
}
async function until(check, label) { for (let i = 0; i < 140; i++) { if (await check()) return; await delay(100); } throw Error('Timed out: ' + label); }
const data = await fs.mkdtemp(path.join(root, '.cache', 'note-editor-ui-')), [mainPort, rendererPort] = await Promise.all([port(), port()]);
const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE; delete env.QIXUE_USE_VITE;
const child = spawn(require('electron'), [path.join(root, 'desktop'), '--smoke-test', '--inspect=127.0.0.1:' + mainPort, '--remote-debugging-port=' + rendererPort], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', errors = '', exited = false, inspector, main;
child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
const exit = once(child, 'exit').then(([code]) => { exited = true; return code; });
try {
  let url;
  await until(() => { assert.equal(exited, false, errors); url = /QIXUE_SMOKE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; return url; }, 'server startup');
  inspector = await connect((await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0].webSocketDebuggerUrl);
  await inspector.evaluate(`globalThis.e=process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron'); globalThis.w=e.BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); true`);
  let target;
  await until(async () => { target = (await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()).find(t => t.type === 'page' && t.url.startsWith(url) && !t.url.includes('desktop=')); return target; }, 'renderer');
  main = await connect(target.webSocketDebuggerUrl);
  await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const token = (await (await fetch(url + '/api/qixue/connection')).json()).token;
  const command = async (action, payload = {}) => { const response = await fetch(url + '/api/qixue/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qixue-token': token }, body: JSON.stringify({ action, payload }) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
  const snapshot = async () => (await fetch(url + '/api/qixue/snapshot', { headers: { 'x-qixue-token': token } })).json();
  await command('settings.save', { provider: { baseUrl: 'http://127.0.0.1:9/v1' }, credential: 'note-editor-offline-test' });
  const page = await command('userNote.ensure');
  await until(() => main.evaluate('Boolean(window.tujiDesktop && document.querySelector("[data-user-notebook-bookmark]"))'), 'notebook entry');
  await main.evaluate('window.tujiDesktop.command("open-panel",{tab:"notebook"})');
  await until(() => main.evaluate('Boolean(document.querySelector("[data-note-editor] textarea"))'), 'editor');
  const latest = async () => (await snapshot()).userNotePages.find(item => item.id === page.id);
  const pictures = async () => (await latest()).blocks?.filter(b => b.type === 'images').flatMap(b => b.images) ?? [];
  async function setInput(selector, value) { await main.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
  async function rect(selector) { return main.evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`); }
  async function drag(from, to) { await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from }); await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 }); await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, buttons: 1, button: 'left' }); await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 }); }
  async function paste(selector) {
    await main.evaluate(`(async () => { const canvas=document.createElement('canvas'); canvas.width=240; canvas.height=140; const c=canvas.getContext('2d'); c.fillStyle='#a1bdb0'; c.fillRect(0,0,240,140); c.fillStyle='#e5c998'; c.fillRect(20,20,90,90); c.fillStyle='#365c4b'; c.font='20px sans-serif'; c.fillText('Notebook',100,82); const blob=await new Promise(r=>canvas.toBlob(r)); const clip=new DataTransfer(); clip.items.add(new File([blob],'clipboard.png',{type:'image/png'})); document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:clip})); })()`);
  }
  async function capture(name) {
    const destination = path.join(root, '.cache', name + '.png');
    await inspector.evaluate(`(async()=>{await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,160));const image=await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(destination)},image.toPNG());})()`);
    console.log('Screenshot: ' + destination);
  }
  await setInput('[data-note-editor] textarea', '图片上方\n图片下方，文字应完整保留。');
  await main.evaluate('document.querySelector("[data-note-editor] textarea").setSelectionRange(5,5)');
  await paste('[data-note-editor] textarea');
  await until(async () => (await pictures()).length === 1, 'paste and image save');
  const saved = await latest(); assert.equal(saved.blocks[0].text, '图片上方\n'); assert.equal(saved.blocks[2].text, '图片下方，文字应完整保留。');
  await until(() => main.evaluate('[...document.querySelectorAll("[data-note-image] img")].every(i=>i.complete&&i.naturalWidth===240)'), 'authenticated image rendering');
  await paste('[data-note-image-region]');
  await until(async () => (await pictures()).length === 2, 'overlapping second image');
  const second = (await pictures())[1], imageSelector = '[data-note-image="' + second.id + '"]';
  let bounds = await rect(imageSelector);
  await capture('note-editor-before-drag');
  bounds = await rect(imageSelector);
  await drag({ x: bounds.x + 20, y: bounds.y + bounds.height - 20 }, { x: bounds.x + 55, y: bounds.y + bounds.height + 50 });
  await until(async () => (await pictures())[1].y > second.y + 40, 'free drag');
  const moved = (await pictures())[1];
  bounds = await rect(imageSelector + ' [data-resize]');
  await drag({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, { x: bounds.x + 45, y: bounds.y + 25 });
  await until(async () => (await pictures())[1].width > moved.width + 20, 'resize');
  await setInput('[aria-label="图片旋转角度"]', '37');
  await until(async () => (await pictures())[1].rotation === 37, 'rotation');
  await main.evaluate('document.querySelector("[aria-label=裁剪图片]").click()');
  await until(() => main.evaluate('Boolean(document.querySelector(".user-note-crop-stage"))'), 'crop dialog');
  bounds = await rect('.user-note-crop-stage');
  await drag({ x: bounds.x + bounds.width * .15, y: bounds.y + bounds.height * .1 }, { x: bounds.x + bounds.width * .8, y: bounds.y + bounds.height * .85 });
  await main.evaluate('document.querySelector(".note-crop-apply").click()');
  await until(async () => (await pictures())[1].crop?.left > .1, 'crop saved');
  await main.evaluate('window.tujiDesktop.command("patch-view",{width:360})'); await delay(200); await capture('note-editor-narrow');
  assert.equal(await main.evaluate('document.querySelector("[data-note-image-region]").scrollWidth <= document.querySelector("[data-note-image-region]").clientWidth + 1'), true, 'narrow region must not overflow');
  await main.evaluate('window.tujiDesktop.command("patch-view",{width:900})'); await delay(200); await capture('note-editor-wide');
  const regions = await main.evaluate('(() => {const r=document.querySelector("[data-note-image-region]").getBoundingClientRect();const t=[...document.querySelectorAll("[data-note-editor] textarea")].at(-1).getBoundingClientRect();return {bottom:r.bottom,textTop:t.top};})()');
  assert.ok(regions.textTop >= regions.bottom - 1, 'text must follow the complete picture region');
  await main.evaluate('document.querySelector("[aria-label=删除图片]").click()');
  await until(async () => (await pictures()).length === 1, 'delete one image');
  await main.evaluate('document.querySelector("[aria-label=撤销笔记编辑]").click()');
  await until(async () => (await pictures()).length === 2, 'undo image deletion');
  await main.evaluate('window.tujiDesktop.command("hide-panel")');
  await main.evaluate('window.tujiDesktop.command("open-panel",{tab:"notebook"})');
  await until(() => main.evaluate('document.querySelectorAll("[data-note-image]").length === 2'), 'reopen saved image layout');
  assert.equal((await pictures())[1].rotation, 37);
  console.log('PASS: clipboard insertion splits and preserves text; authenticated image load; overlapping images; free drag; resize; arbitrary rotation; crop; undo; narrow/wide layout; save and reopen');
} catch (cause) {
  console.error('Editor verification failed:', cause);
  if (main) console.error(await main.evaluate('document.body.innerText').catch(() => 'Renderer unavailable'));
  throw cause;
} finally {
  if (!exited && inspector) await inspector.evaluate('e.app.quit(); true').catch(() => undefined);
  else if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
  const timer = setTimeout(() => child.kill(), 20000); timer.unref();
  main?.close(); inspector?.close(); const code = await exit; clearTimeout(timer);
  assert.equal(code, 0, output + '\n' + errors);
}
