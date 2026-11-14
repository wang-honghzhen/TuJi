import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open');
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugger disconnected')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}


const data = await fs.mkdtemp(path.join(root, '.cache', 'companion-ui-'));
const [mainPort, rendererPort] = await Promise.all([port(), port()]);
const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0' };
for (const key of ['ELECTRON_RUN_AS_NODE','QIXUE_USE_VITE','QIXUE_OCR_DATA_DIR']) delete env[key];
const packaged = process.argv.indexOf('--packaged');
const executable = packaged >= 0 ? path.resolve(process.argv[packaged + 1]) : require('electron');
const args = [`--inspect=127.0.0.1:${mainPort}`, ...(packaged >= 0 ? [] : [path.join(root, 'desktop')]), '--smoke-test', `--remote-debugging-port=${rendererPort}`];
const scaleArgument = process.argv.find(value => value.startsWith('--force-device-scale-factor='));
if (scaleArgument) args.push(scaleArgument);
const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
let stdout = '', stderr = '', exited = false, inspector, main, orb, panel;
const clients = [];
child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
const exit = once(child, 'exit').then(([code]) => { exited = true; return code; });
try {
  let url;
  for (let i = 0; i < 200; i++) {
    url = /QIXUE_SMOKE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
    if (url) break; assert.equal(exited, false, stderr); await delay(150);
  }
  assert.ok(url, stderr);
  const nativeTargets = await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json();
  inspector = await connect(nativeTargets[0].webSocketDebuggerUrl); clients.push(inspector);
  await inspector.evaluate(`(() => {
    globalThis.e = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root,'package.json'))})('electron');
    globalThis.mainWindow = e.BrowserWindow.getAllWindows()[0];
    mainWindow.on('show', () => mainWindow.hide());
    mainWindow.webContents.setBackgroundThrottling(false);
    return true;
  })()`);
  async function page(role) {
    let target;
    await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${rendererPort}/json/list`)).json();
      target = targets.find(t => t.type === 'page' && t.url.startsWith(url) && (role === 'main' ? !t.url.includes('desktop=') : t.url.includes('desktop=' + role)));
      return target;
    }, role + ' window');
    const result = await connect(target.webSocketDebuggerUrl); clients.push(result);
    await until(() => result.evaluate('Boolean(window.tujiDesktop && document.querySelector("#root")?.childElementCount)'), role + ' renderer');
    return result;
  }
  main = await page('main');
  const token = (await (await fetch(url + '/api/qixue/connection')).json()).token;
  async function command(action, payload = {}) {
    const response = await fetch(url + '/api/qixue/command', { method:'POST',headers:{'content-type':'application/json','x-qixue-token':token},
      body:JSON.stringify({action,payload}) }); const body = await response.json(); assert.ok(response.ok,JSON.stringify(body)); return body;
  }
  async function snapshot() { return (await fetch(url + '/api/qixue/snapshot',{headers:{'x-qixue-token':token}})).json(); }
  async function click(client, selector, count = 1) {
    // Native auxiliary windows mount their content before the slide-in finishes.
    // Compute pointer coordinates only after the panel reaches its resting position.
    await until(() => client.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false;
      const panel=el.closest('.utility-panel'); return !panel || panel.dataset.visible==='true' && Math.abs(new DOMMatrix(getComputedStyle(panel).transform).m41)<.5; })()`), 'stable click ' + selector);
    const p = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing: ' + ${JSON.stringify(selector)}); const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    await delay(80);
    await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:count});
    await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:count});
  }
  const api = (client, action, payload = {}) => client.evaluate(`window.tujiDesktop.command(${JSON.stringify(action)}, ${JSON.stringify(payload)})`);
  const state = () => main.evaluate('window.tujiDesktop.getState()');
  async function capture(role, name) {
    const output = path.join(root,'.cache',name + '.png');
    const client = role === 'main' ? main : role === 'orb' ? orb : panel;
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await inspector.evaluate(`(async () => { const w=e.BrowserWindow.getAllWindows().find(w => ${JSON.stringify(role)} === 'main' ? w===mainWindow : w.webContents.getURL().includes('desktop=' + ${JSON.stringify(role)}));
      await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); await new Promise(r=>setTimeout(r,220));
      const image=await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(output)},image.toPNG()); return true; })()`);
    console.log('Preview: ' + output);
  }
  await command('settings.save',{ provider:{baseUrl:'http://127.0.0.1:9/v1'},credential:'companion-offline-test'});
  await until(() => main.evaluate('Boolean(document.querySelector("[data-user-notebook-bookmark]"))'), 'main notebook');
  await click(main,'button[title="新建画布"]');
  await until(() => main.evaluate('Boolean(document.querySelector("[data-canvas-name]"))'),'canvas dialog');
  await main.evaluate('document.querySelector("[data-canvas-name]").focus()');
  await main.send('Input.insertText',{text:'悬浮窗验证画布'});
  await main.evaluate('document.querySelector("[data-create-canvas-confirm]").click()');
  await until(async () => {const value=await state();return value.canvasId && value.canvasId!=='qixue-draft-canvas' && Object.keys(value.enteredSessionByCanvas).length;},'real canvas/session selection');
  const bounds = await inspector.evaluate('mainWindow.getBounds()');
  await main.evaluate('window.tujiWindow.close()');
  await until(async () => (await state()).background, 'close to tray');
  orb = await page('orb');
  await click(orb,'.orb-core'); await delay(600);
  assert.equal((await state()).host,'none');
  await orb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:140,y:140}); await delay(250);
  assert.equal(await orb.evaluate('document.querySelectorAll(".orb-satellite").length'),2);
  assert.equal(await orb.evaluate('document.querySelectorAll(".orb-tracks path").length'),3);
  assert.equal(await orb.evaluate('getComputedStyle(document.body).backgroundColor'),'rgba(0, 0, 0, 0)');
  await capture('orb','companion-orb-empty');
  await click(orb,'[data-orb-action="notebook"]');
  panel = await page('panel');
  await until(async () => (await state()).host==='panel', 'desktop notebook');
  await until(() => panel.evaluate('Boolean(document.querySelector("[data-paper-input]"))'),'notebook editor');
  await click(panel,'[data-paper-input]');
  await panel.send('Input.insertText',{text:'跨窗口保存：图记笔记'});
  // Transfer immediately, before the 650 ms autosave timer.
  await api(panel,'hide-panel');
  assert.equal((await snapshot()).userNotePages[0].text,'跨窗口保存：图记笔记');
  await click(orb,'.orb-core'); await delay(650);
  assert.equal((await state()).host,'panel');
  await api(panel,'hide-panel');
  const ids = [];
  for (let i=0;i<3;i++) {
    await orb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:140,y:140}); await delay(240);
    await click(orb,'[data-orb-action="new"]');
    await until(async () => (await state()).host==='panel' && (await state()).activeTab !== 'notebook','new temporary panel');
    await until(() => panel.evaluate('Boolean(document.querySelector(".ai-chat-composer textarea"))'),'temporary composer');
    ids.push((await state()).activeTab);
    if(i===0) {
      await click(panel,'.ai-chat-composer textarea');
      await panel.evaluate('document.querySelector(".ai-chat-composer textarea").focus()');
      await panel.send('Input.insertText',{text:'尚未发送的文字，切换窗口后保留'});
      assert.equal(await panel.evaluate('document.querySelector(".ai-chat-composer textarea").value'),'尚未发送的文字，切换窗口后保留');
      await panel.evaluate(`(async () => { const file=new File([await (await fetch('/brand/app-icon.png')).blob()], 'test-image.png', {type:'image/png'});
        const transfer=new DataTransfer(); transfer.items.add(file); document.querySelector('.ai-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer})); })()`);
      await api(panel,'toggle-detach'); assert.equal((await state()).detached,true);
      assert.equal((await state()).drafts[ids[0]].artifactIds.length,1);
      await api(panel,'toggle-detach'); assert.equal((await state()).detached,false);
    }
    await capture('panel','companion-panel-chat-' + (i+1));
    await api(panel,'hide-panel');
    await orb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:140,y:140}); await delay(240);
    await capture('orb','companion-orb-' + (i+1));
    assert.equal(await orb.evaluate('document.querySelectorAll(".orb-satellite").length'),Math.min(i+3,4));
  }
  assert.equal(await orb.evaluate('Boolean(document.querySelector("[data-orb-action=new]"))'),false);
  assert.equal(await orb.evaluate('document.querySelectorAll(".orb-delete").length'),3);
  // An actual double click must not be consumed by opening the side panel first.
  await click(orb,'.orb-core'); await click(orb,'.orb-core',2); await delay(650);
  assert.equal((await state()).background,false); assert.equal((await state()).host,'none');
  assert.deepEqual(await inspector.evaluate('mainWindow.getBounds()'),bounds);
  await api(main,'open-panel',{tab:ids[0]});
  await until(() => main.evaluate('document.querySelector(".utility-panel .ai-chat-composer textarea")?.value === "尚未发送的文字，切换窗口后保留"'),'draft handoff');
  assert.equal((await state()).drafts[ids[0]].artifactIds.length,1);
  const canvasId = (await state()).canvasId;
  const canvasChats=[];
  for(let i=0;i<3;i++) canvasChats.push(await command('session.create',{canvasId,mode:'temporary',temporaryMode:'minimal'}));
  await until(() => main.evaluate('document.querySelectorAll(".utility-tab").length === 8'),'eight tabs');
  await capture('main','companion-main-eight-tabs');
  await api(main,'toggle-detach');
  await until(() => panel.evaluate('document.querySelectorAll(".utility-tab").length === 8'),'detached all tabs');
  await api(panel,'open-panel',{tab:canvasChats[0].id});
  await until(() => panel.evaluate('document.querySelector("[data-ai-temporary-select] option[value=branch]")?.disabled === false'),'canvas source in detached window');
  await command('userNote.ensure');
  await delay(100);
  assert.equal(await panel.evaluate('document.querySelector("[data-ai-temporary-select] option[value=branch]").disabled'),false);
  await panel.evaluate('const select=document.querySelector("[data-ai-temporary-select]"); select.value="branch"; select.dispatchEvent(new Event("change",{bubbles:true}))');
  await until(async () => (await snapshot()).sessions.find(s => s.id===canvasChats[0].id)?.temporaryContext.mode === 'branch','configure branch after handoff');
  await api(panel,'toggle-detach');
  await api(main,'hide-panel');
  await main.evaluate('window.tujiWindow.minimize()');
  await until(async () => (await state()).background,'minimize to tray');
  await api(orb,'open-panel',{tab:ids[0]});
  await until(() => panel.evaluate('document.querySelectorAll(".utility-tab").length === 5'),'desktop five tabs');
  await api(panel,'open-panel',{tab:'notebook'});
  await capture('panel','companion-panel-notebook');
  await api(panel,'hide-panel');
  await orb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:140,y:140}); await delay(250);
  await click(orb,'.orb-delete'); await delay(300);
  assert.equal(await orb.evaluate('document.querySelectorAll(".orb-satellite").length'),4);
  assert.equal(await orb.evaluate('Boolean(document.querySelector("[data-orb-action=new]"))'),true);
  // Simulate a drag with logical display coordinates, without moving the user's real cursor.
  await inspector.evaluate('globalThis.realCursor=e.screen.getCursorScreenPoint; globalThis.cursor={x:200,y:200}; e.screen.getCursorScreenPoint=()=>cursor');
  await orb.evaluate('window.tujiDesktop.drag("start")');
  await delay(80);
  await inspector.evaluate('cursor={x:100000,y:100000}');
  await orb.evaluate('window.tujiDesktop.drag("move"); window.tujiDesktop.drag("end")'); await delay(200);
  assert.equal((await state()).orb.flipX,true); assert.equal((await state()).orb.flipY,true);
  await orb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:140,y:140}); await delay(250);
  await capture('orb','companion-orb-edge');
  await inspector.evaluate('e.screen.getCursorScreenPoint=realCursor');
  // Preserve max state and zoom while hidden; no extra window controls in auxiliary roles.
  await api(orb,'show-main');
  await inspector.evaluate('mainWindow.maximize(); mainWindow.webContents.setZoomFactor(1.15)');
  await main.evaluate('window.tujiWindow.close()'); await until(async () => (await state()).background,'maximized hide');
  await api(orb,'show-main');
  assert.equal(await inspector.evaluate('mainWindow.isMaximized()'),true);
  assert.equal(await inspector.evaluate('mainWindow.webContents.getZoomFactor()'),1.15);
  assert.equal(await panel.evaluate('typeof window.tujiWindow'),'undefined');
  await assert.rejects(api(orb,'set-context',{canvasId:'forbidden'}),/只有主窗口/);
  console.log('PASS: close/minimize to tray, single/double click, notes/drafts handoff, detach/dock, independent 8/5 tabs, satellite counts/deletion, edge mirroring, bounds/max/zoom and role permissions');
} catch (cause) {
  console.error('Companion check failed:', cause);
  if (orb) console.error('Orb:', await orb.evaluate('document.body.innerText').catch(() => 'unavailable'));
  if (panel) console.error('Panel:', await panel.evaluate('document.body.innerText').catch(() => 'unavailable'));
  if (main) console.error('State:', await main.evaluate('window.tujiDesktop.getState()').catch(() => 'unavailable'));
  throw cause;
} finally {
  if(!exited && inspector) await inspector.evaluate('e.app.quit(); true').catch(() => undefined);
  else if(!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
  for(const client of clients) client.close();
  const timer=setTimeout(()=>child.kill(),20000); timer.unref();
  const code=await exit; clearTimeout(timer);
  assert.equal(code,0,stdout + '\n' + stderr);
}
