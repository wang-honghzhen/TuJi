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


const data = await fs.mkdtemp(path.join(root, '.cache', 'notebook-ui-'));
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

  await command('settings.save',{provider:{baseUrl:'http://127.0.0.1:9/v1'},credential:'notebook-offline-test'});
  const first=await command('userNote.ensure');
  await command('userNote.save',{id:first.id,expectedVersion:first.version,text:'第一份笔记：叶绿素吸收光能。\n独立页面测试'});
  const second=await command('userNote.create');
  await command('userNote.save',{id:second.id,expectedVersion:second.version,text:'第二份笔记：光合作用'});
  await api(main,'open-panel',{tab:'notebook'});
  await until(()=>main.evaluate('Boolean(document.querySelector("[data-paper-input]"))'),'notebook ready');
  const idle = () => until(()=>main.evaluate('document.querySelector(".note-workspace")?.getAttribute("aria-busy") !== "true"'),'notebook idle');
  const clickText = async text => { await idle(); return main.evaluate(`(() => {const el=[...document.querySelectorAll('.utility-panel button')].find(e=>e.textContent.trim()===${JSON.stringify(text)} && e.offsetParent!==null); if(!el)throw Error('Missing button '+${JSON.stringify(text)});el.click();})()`); };
  const input = async (selector,value) => {
    await main.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); e.focus();e.select();})()`);
    await main.send('Input.insertText',{text:value});
  };
  await clickText('目录');
  await until(()=>main.evaluate('Boolean(document.querySelector(".note-directory-heading"))'),'directory home');
  assert.equal(await main.evaluate('document.querySelectorAll(".utility-tab-pins .utility-tab").length'),2);
  await clickText('新建目录');
  await input('[aria-label="新目录名称"]','学习');
  await clickText('创建');
  await until(async()=> (await snapshot()).userNoteDirectories?.some(d=>d.name==='学习'),'create directory');
  await idle(); await main.evaluate('document.querySelector(".note-folder-open").click()');
  await until(()=>main.evaluate('document.querySelector(".note-directory-heading strong")?.textContent==="学习"'),'open folder');
  await clickText('新建目录'); await input('[aria-label="新目录名称"]','数学'); await clickText('创建');
  await until(async()=> (await snapshot()).userNoteDirectories?.some(d=>d.name==='数学'),'create nested directory');
  await idle(); await main.evaluate('document.querySelector(".note-folder-open").click()');
  await until(()=>main.evaluate('document.querySelector(".note-directory-heading strong")?.textContent==="数学"'),'open nested folder');
  await clickText('放入现有页');
  await until(()=>main.evaluate('Boolean(document.querySelector(".note-pick-row input"))'),'page picker');
  await main.evaluate('document.querySelector(".note-pick-row input").click()');
  await clickText('放入 1 页');
  await until(()=>main.evaluate('Boolean(document.querySelector(".note-global-page")?.textContent)'),'directory reader');
  const math=(await snapshot()).userNoteDirectories.find(d=>d.name==='数学');
  assert.equal((await snapshot()).userNotePages.find(p=>p.id===first.id).directoryId,math.id);
  assert.match(await main.evaluate('document.querySelector(".note-address input").value'),/学习\/数学/);
  assert.match(await main.evaluate('document.querySelector(".note-global-page").textContent'),/全局第 1 页/);
  assert.match(await main.evaluate('document.querySelector(".paper-page-counter").textContent'),/目录内第/);
  await capture('main','notebook-reader-wide');
  const readerWidth = (await state()).width;
  await api(main,'patch-view',{width:360});
  await capture('main','notebook-reader-narrow');
  await api(main,'patch-view',{width:readerWidth});
  const before=(await state()).noteTabs.length;
  await input('[aria-label="笔记目录路径"]','/学习/数学');
  await main.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await main.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(async()=> (await state()).noteTabs.length===before+1,'same folder opens new reader');
  assert.equal((await state()).noteTabs.at(-1).kind,'pages');
  await clickText('笔记');
  await until(()=>main.evaluate('document.querySelector(".note-library-title")?.textContent.includes("全部笔记")'),'global notebook');
  await main.evaluate('document.querySelector("[aria-label=搜索笔记]").click()');
  await input('[aria-label="笔记搜索关键词"]','叶绿素');
  await until(()=>main.evaluate('document.querySelectorAll(".note-result").length===1'),'search matching text');
  assert.match(await main.evaluate('document.querySelector(".note-result").textContent'),/目录内第 1 页/);
  await capture('main','notebook-search');
  const count=(await state()).noteTabs.length;
  await main.evaluate('document.querySelector(".note-result").click()');
  await until(async()=> (await state()).noteTabs.length===count+1,'search opens directory reader');
  await clickText('目录');
  await until(()=>main.evaluate('Boolean(document.querySelector(".note-folder-row"))'),'return root directory');
  await api(main,'patch-view',{width:360});
  await capture('main','notebook-directory-narrow');
  const overflow=await main.evaluate('(()=>{const e=document.querySelector(".note-workspace");return e.scrollWidth-e.clientWidth})()');
  assert.ok(overflow<=1,'no horizontal overflow in narrow notebook');
  await click(main,'[aria-label="目录操作 学习"]');
  assert.equal(await main.evaluate('document.querySelectorAll(".note-menu [role=menuitem]").length'),2);
  await clickText('删除目录，保留笔记');
  await until(async()=> !(await snapshot()).userNoteDirectories.length,'delete tree');
  assert.equal((await snapshot()).userNotePages.length,2);
  assert.equal((await snapshot()).userNotePages[0].directoryId,undefined);
  await api(main,'patch-view',{width:720});
  await clickText('新建目录'); await input('[aria-label="新目录名称"]','临时材料'); await clickText('创建');
  await until(async()=> (await snapshot()).userNoteDirectories.some(d=>d.name==='临时材料'),'new deletion fixture');
  const d=(await snapshot()).userNoteDirectories.find(d=>d.name==='临时材料');
  const p=(await snapshot()).userNotePages[1];
  await command('userNote.assign',{id:p.id,directoryId:d.id,expectedVersion:p.version});
  await until(()=>main.evaluate('document.querySelector(".note-folder-open small")?.textContent.includes("1 页")'),'folder count refreshed');
  await click(main,'[aria-label="目录操作 临时材料"]');
  await clickText('删除目录及全部笔记');
  await until(async()=> (await snapshot()).userNotePages.length===1,'delete directory with pages');
  assert.equal((await snapshot()).userNotePages[0].id,first.id);
  await clickText('笔记');
  await until(()=>main.evaluate('Boolean(document.querySelector("[data-paper-input]"))'),'final notebook');
  // Searching immediately after editing must keep autosave alive while the editor is hidden.
  await input('[data-paper-input]','搜索前刚输入的笔记内容');
  await main.evaluate('document.querySelector("[aria-label=搜索笔记]").click()');
  await input('[aria-label="笔记搜索关键词"]','输入');
  await until(async()=> (await snapshot()).userNotePages[0].text==='搜索前刚输入的笔记内容','save during search');
  console.log('PASS notebook UI: create/nest/assign, two permanent tabs, repeated path opens new tab, global/local page labels, keyword path results, both recursive deletion modes, narrow layout, save while searching');
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
