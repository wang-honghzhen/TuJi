// Windows input regression: CDP clicks bypass Electron's native click-through window.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
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
  return { evaluate, close: () => socket.close() };
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

assert.equal(process.platform, 'win32', 'This test requires a visible Windows desktop');
const data = await fs.mkdtemp(path.join(root, '.cache', 'orb-native-'));
await fs.mkdir(path.join(data, 'desktop-profile'));
await fs.writeFile(path.join(data, 'desktop-profile', 'companion.json'), JSON.stringify({ orbCenter: { x: 440, y: 360 } }));
const [mainPort, rendererPort] = await Promise.all([port(), port()]);
const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'QIXUE_USE_VITE', 'QIXUE_OCR_DATA_DIR']) delete env[key];
const packaged = process.argv.indexOf('--packaged');
const executable = packaged >= 0 ? path.resolve(process.argv[packaged + 1]) : require('electron');
const args = [`--inspect=127.0.0.1:${mainPort}`, ...(packaged >= 0 ? [] : [path.join(root, 'desktop')]), '--smoke-test', `--remote-debugging-port=${rendererPort}`];
const scale = process.argv.find(value => value.startsWith('--force-device-scale-factor='));
if (scale) args.push(scale);
const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', inspector, main, orb, mouse;
const clients = [];
child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
const exit = once(child, 'exit');
try {
  let url;
  await until(() => { url = /QIXUE_SMOKE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]; return url; }, 'server startup');
  const targets = await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json();
  inspector = await connect(targets[0].webSocketDebuggerUrl); clients.push(inspector);
  await inspector.evaluate(`(() => {
    globalThis.e = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron');
    globalThis.mainWindow = e.BrowserWindow.getAllWindows()[0];
    globalThis.hideTestMain = () => mainWindow.hide();mainWindow.on('show', hideTestMain);
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
    const response = await fetch(url + '/api/qixue/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qixue-token': token }, body: JSON.stringify({ action, payload }) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
  }
  const api = (client, action, payload = {}) => client.evaluate(`window.tujiDesktop.command(${JSON.stringify(action)}, ${JSON.stringify(payload)})`);
  const state = () => main.evaluate('window.tujiDesktop.getState()');
  await command('settings.save', { provider: { baseUrl: 'http://127.0.0.1:9/v1' }, credential: 'orb-offline-test' });
  await main.evaluate('window.tujiWindow.close()');
  orb = await page('orb');
  await inspector.evaluate(`(async () => {
    globalThis.orbWindow = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('desktop=orb'));
    globalThis.bed = new e.BrowserWindow({frame:false,show:false,width:700,height:600,backgroundColor:'#31415a',webPreferences:{sandbox:true}});
    await bed.loadURL('data:text/html,'+encodeURIComponent('<body style="background:#31415a;color:white;font:20px sans-serif"><p>图记鼠标交互验证</p><script>window.clicks=0;window.addEventListener("click",()=>window.clicks++)</script>'));
    const a=e.screen.getPrimaryDisplay().workArea;bed.setPosition(a.x+100,a.y+100);bed.show();
    orbWindow.showInactive();
    globalThis.hitLog=[];const hit=orbWindow.setIgnoreMouseEvents.bind(orbWindow);orbWindow.setIgnoreMouseEvents=(...args)=>{hitLog.push(args);return hit(...args)};return true;
  })()`);
  await orb.evaluate(`(() => {
    window.inputLog=[];for(const type of ['pointermove','mousemove','pointerdown','pointerup','mousedown','mouseup','click','dblclick','mouseleave','pointercancel','lostpointercapture'])window.addEventListener(type,e=>{window.inputLog.push({type,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY,detail:e.detail,buttons:e.buttons,target:e.target.className});if(window.inputLog.length>120)window.inputLog.shift()},true);
    window.addEventListener('error',e=>window.inputLog.push({error:e.message}));return true;
  })()`);
  await orb.evaluate('window.pointerLog=[];window.tujiDesktop.onOrbPointer?.(p=>{window.pointerLog.push(p);if(window.pointerLog.length>30)window.pointerLog.shift()});true');
  mouse = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'windows-mouse-test.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = createInterface({ input: mouse.stdout });
  mouse.stderr.on('data', bytes => process.stderr.write(bytes));
  async function input(steps) {
    const response = once(responses, 'line'); mouse.stdin.write(JSON.stringify({ steps }) + '\n');
    const [line] = await response; const result = JSON.parse(line); if (result.error) throw new Error(result.error);
  }
  async function at(x, y) {
    return inspector.evaluate(`(() => {const b=orbWindow.getBounds();return e.screen.dipToScreenPoint({x:b.x+${x},y:b.y+${y}})})()`);
  }
  async function move(x, y, wait = 150) { await input([{ ...await at(x, y), wait }]); }
  async function click(x, y, count = 1) {
    const p=await at(x,y),steps = [{ ...p, wait: 80 }];
    for (let i = 0; i < count; i++) steps.push({ ...p,button: 'down', wait: 10 }, { ...p,button: 'up', wait: 40 });
    await input(steps);
  }
  async function clickButton(selector) {
    const p=await orb.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await click(p.x,p.y);
  }
  async function showOrb() {
    await inspector.evaluate('bed.show();bed.focus();orbWindow.showInactive();true');await delay(100);
  }
  async function dragBy(dx,dy,x=140,y=140) {
    const start=await at(x,y),end=await at(x+dx,y+dy);
    const steps=[{...start,wait:120},{...start,button:'down',wait:50}];
    for(let i=1;i<=24;i++)steps.push({x:Math.round(start.x+(end.x-start.x)*i/24),y:Math.round(start.y+(end.y-start.y)*i/24),wait:15});
    steps.push({...end,button:'up',wait:200});await input(steps);
  }
  async function captureEdge(edge) {
    await move(20,20,500);
    const file=path.join(root,'.cache',`orb-half-${edge}-${scale?.split('=')[1]??'system'}.png`);
    // Refresh the compositor after moving a partly off-screen native window.
    await inspector.evaluate(`(async()=>{await orbWindow.webContents.capturePage();await new Promise(r=>setTimeout(r,120));const image=await orbWindow.webContents.capturePage({x:96,y:96,width:88,height:88});process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},image.toPNG());return true})()`);
  }
  const expanded=()=>orb.evaluate('document.querySelector(".orb-stage").dataset.expanded');
  await move(20, 20); await move(140, 140); await delay(250);
  assert.equal(await expanded(),'true','Native hover opens buttons');
  await click(140,140);await delay(600);assert.equal((await state()).host,'none','First use: single click is inactive');
  await click(140, 140, 2); await delay(700);
  assert.equal((await state()).background, false, 'Native double-click must restore main window');
  await main.evaluate('window.tujiWindow.close()');
  await until(async () => (await state()).background,'close after restore');
  await showOrb();
  const created=await command('temporary.createDesktop');
  await api(orb,'open-panel',{tab:created.id});
  const panel=await page('panel');
  await api(panel,'hide-panel');
  await showOrb();
  await click(140,140);await delay(700);
  assert.equal((await state()).host,'panel','Native single-click reopens last panel');
  await api(panel,'hide-panel');
  assert.equal((await state()).activeTab,created.id);
  await showOrb();
  const before=await inspector.evaluate('orbWindow.getBounds()');
  await dragBy(100,40);
  const after=await inspector.evaluate('orbWindow.getBounds()');
  assert.ok(Math.abs(after.x-before.x-100)<4 && Math.abs(after.y-before.y-40)<4,'Native drag follows cursor');
  assert.equal(after.width,280);assert.equal(after.height,280);
  await delay(600);assert.equal((await state()).host,'none','Dragging must not open panel');
  // Native satellite clicks, including a window handoff after each creation.
  for(let i=0;i<2;i++) {
    await move(140,140);await delay(200);await clickButton('[data-orb-action="new"]');
    await until(async ()=>(await state()).host==='panel','create from native satellite');
    await api(panel,'hide-panel');await showOrb();
  }
  assert.equal(await orb.evaluate('document.querySelectorAll(".orb-satellite").length'),4);
  assert.equal(await orb.evaluate('Boolean(document.querySelector("[data-orb-action=new]"))'),false);
  // Slow movement and pauses in the empty corridors must not collapse the orbit.
  await move(140,140);await delay(200);
  for(const [x,y] of [[180,140],[197,151],[226,155],[208,180],[205,206],[178,210],[151,226],[140,190],[110,218],[240,185]]) {
    await move(x,y,380);assert.equal(await expanded(),'true',`Hover corridor ${x},${y}`);
  }
  await inspector.evaluate('bed.show();bed.focus();true');
  const clicks=await inspector.evaluate('bed.webContents.executeJavaScript("window.clicks")');
  await click(190,180);await delay(200);
  assert.equal(await inspector.evaluate('bed.webContents.executeJavaScript("window.clicks")'),clicks+1,'Transparent corridor clicks pass to underlying window');
  assert.equal(await expanded(),'true','Click-through corridor stays expanded');
  const preview=path.join(root,'.cache',`orb-native-${scale?.split('=')[1]??'system'}.png`);
  await inspector.evaluate(`(async()=>{const image=await orbWindow.webContents.capturePage();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(preview)},image.toPNG());return true})()`);
  await move(15,15,450);assert.equal(await expanded(),'false','Outside the buffered area collapses');
  await move(140,140);await delay(200);await clickButton('.orb-delete');
  await until(()=>orb.evaluate('Boolean(document.querySelector("[data-orb-action=new]"))'),'native delete restores create button');
  assert.equal((await state()).host,'none','Delete must not open a session');
  // Drag to an edge; the exposed half and all inward-facing satellites work.
  const b=await inspector.evaluate('orbWindow.getBounds()'),area=await inspector.evaluate('e.screen.getDisplayMatching(orbWindow.getBounds()).workArea');
  await dragBy(area.x+area.width-5-(b.x+140),0);
  assert.equal((await state()).orb.dock,'right');assert.equal((await state()).orb.flipX,true);
  await captureEdge('right');
  // The rounded silhouette and exposed half must also work at the other edges.
  for(const [edge,target,x,y] of [
    ['left',{x:area.x+5,y:area.y+Math.round(area.height/2)},126,140],
    ['top',{x:area.x+Math.round(area.width/2),y:area.y+5},154,140],
    ['bottom',{x:area.x+Math.round(area.width/2),y:area.y+area.height-5},140,154],
    ['right',{x:area.x+area.width-5,y:area.y+Math.round(area.height/2)},140,126],
  ]) {
    const current=await inspector.evaluate('orbWindow.getBounds()');
    await dragBy(target.x-(current.x+140),target.y-(current.y+140),x,y);
    assert.equal((await state()).orb.dock,edge,`Native drag from exposed half to ${edge}`);
    await captureEdge(edge);
  }
  await move(126,140);await delay(200);await move(88,176,380);
  assert.equal(await expanded(),'true','Docked corridor remains open');
  await clickButton('[data-orb-action="notebook"]');
  await until(async ()=>(await state()).host==='panel','docked notebook button');
  await api(panel,'hide-panel');await showOrb();
  // Restore the real main window with its bounds and page zoom preserved.
  await inspector.evaluate('mainWindow.removeListener("show",hideTestMain);mainWindow.webContents.setZoomFactor(1.15);true');
  const mainBounds=await inspector.evaluate('mainWindow.getBounds()');
  await click(126,140,2);await until(async ()=>(await state()).background===false,'docked double-click');
  assert.equal(await inspector.evaluate('mainWindow.isVisible()'),true);
  assert.deepEqual(await inspector.evaluate('mainWindow.getBounds()'),mainBounds);
  assert.equal(await inspector.evaluate('mainWindow.webContents.getZoomFactor()'),1.15);
  async function mainPoint(x,y) {
    return inspector.evaluate(`(()=>{const b=mainWindow.getBounds(),z=mainWindow.webContents.getZoomFactor();return e.screen.dipToScreenPoint({x:Math.round(b.x+${x}*z),y:Math.round(b.y+${y}*z)})})()`);
  }
  async function mainClick(x,y,count=1) {
    const p=await mainPoint(x,y),steps=[{...p,wait:100}];
    for(let i=0;i<count;i++)steps.push({...p,button:'down',wait:10},{...p,button:'up',wait:40});
    await input(steps);
  }
  // Keep native title-strip double-click available with the compact control UI.
  await mainClick(200,6,2);await until(()=>inspector.evaluate('mainWindow.isMaximized()'),'title strip maximizes');
  await mainClick(200,6,2);await until(()=>inspector.evaluate('!mainWindow.isMaximized()'),'title strip restores');
  const controlX=await main.evaluate('(()=>{const r=document.querySelector(".desktop-window-controls").getBoundingClientRect();return r.x+r.width/2})()');
  await input([{...await mainPoint(controlX,5),wait:250}]);
  const minimize=await main.evaluate('(()=>{const r=document.querySelector(".desktop-window-button[aria-label=最小化]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await mainClick(minimize.x,minimize.y);await until(async ()=>(await state()).background,'visible minimize button returns to orb');
  console.log('Preview: '+preview);
  console.log('Verified: first-use click, restore after handoff, double-click, drag, hover corridors, click-through, satellites, delete, all four edges, title-strip maximize/restore, minimize control, bounds/zoom.');
  console.log('Native Windows orb tests passed.');
} catch (error) {
  console.error(error);
  if (orb && inspector) await fs.writeFile(path.join(root,'.cache','orb-native-failure.json'),JSON.stringify({events:await orb.evaluate('window.inputLog').catch(()=>[]),pointer:await orb.evaluate('window.pointerLog').catch(()=>[]),hits:await inspector.evaluate('hitLog').catch(()=>[])},null,2));
  console.error(stderr.slice(-2000)); process.exitCode = 1;
} finally {
  if (mouse) { mouse.stdin.end('{"action":"stop"}\n'); await once(mouse, 'exit'); }
  if (inspector) await inspector.evaluate('if(globalThis.bed)bed.destroy();e.app.quit();true').catch(() => {});
  clients.forEach(client => client.close());
  const timer = setTimeout(() => child.kill(), 20000); await exit; clearTimeout(timer);
}
