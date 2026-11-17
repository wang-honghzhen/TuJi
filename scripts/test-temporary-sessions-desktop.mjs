import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
if (!process.argv.includes('--skip-build')) assert.equal(spawnSync(process.execPath, ['scripts/build-ai.mjs'], { cwd: root, stdio: 'inherit' }).status, 0);
const cache = path.join(root, '.cache', 'temporary-sessions-desktop'); await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'run-'));
await build({ absWorkingDir: root, entryPoints: ['src/ai/server/repository.ts'], outfile: path.join(data, 'repository.cjs'), bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') } });
const { Repository } = require(path.join(data, 'repository.cjs')), repo = new Repository(path.join(data, 'qixue.sqlite'));
const stamp = new Date().toISOString();
repo.transaction(state => {
  state.setupCompleted = true;
  const canvas = (id, isDraft) => ({ canvasId: id, canvasName: isDraft ? '临时画布' : '验证画布', isDraft, updatedAt: stamp,
    childIds: [], directories: {}, placements: {}, collapsed: {} });
  state.graph = { layoutVersion: 3, nodes: {}, documents: {}, edges: [], canvases: [canvas('qixue-draft-canvas', true), canvas('saved-canvas', false)] };
  state.userNoteDirectories = Array.from({ length: 5 }, (_, index) => ({ id: 'dir-' + index, name: '学习与工作笔记目录 ' + (index + 1), createdAt: stamp, updatedAt: stamp }));
});
repo.close();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(100); }
  throw Error('Timed out: ' + label);
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  return { send, evaluate, close() { for (const item of pending.values()) clearTimeout(item.timer); socket.close(); } };
}
const bootstrap = path.join(data, 'bootstrap.mjs');
await fs.writeFile(bootstrap, "import { BrowserWindow, dialog } from 'electron'; dialog.showErrorBox=(title,message)=>console.error(title,message); BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false);}; await import(" + JSON.stringify(pathToFileURL(path.join(root, 'desktop/main.mjs')).href) + ");");
const [nativePort, rendererPort] = await Promise.all([port(), port()]);
const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0', QIXUE_USE_VITE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [bootstrap, '--inspect=127.0.0.1:' + nativePort, '--remote-debugging-port=' + rendererPort],
  { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '', exited = false; child.stderr.on('data', chunk => stderr += chunk); child.stdout.on('data', () => {});
const exit = once(child, 'exit').then(() => { exited = true; }), clients = [];
try {
  let targets;
  await until(async () => {
    assert.equal(exited, false, stderr);
    try { targets = await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json(); return targets.some(target => /^http:\/\/127.0.0.1/.test(target.url)); } catch { return false; }
  }, 'desktop renderer');
  const target = targets.find(target => /^http:\/\/127.0.0.1/.test(target.url)), origin = new URL(target.url).origin;
  const main = await connect(target.webSocketDebuggerUrl); clients.push(main);
  const nativeTargets = await (await fetch('http://127.0.0.1:' + nativePort + '/json/list')).json();
  const native = await connect(nativeTargets[0].webSocketDebuggerUrl); clients.push(native);
  await native.evaluate("globalThis.e=process.getBuiltinModule('module').createRequire(" + JSON.stringify(path.join(root, 'package.json')) + ")('electron'); globalThis.w=e.BrowserWindow.getAllWindows()[0]; true");
  await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await main.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => main.evaluate('!!document.querySelector("[data-canvas-viewport]")'), 'home canvas');
  const token = (await (await fetch(origin + '/api/qixue/connection')).json()).token;
  const snapshot = async () => (await fetch(origin + '/api/qixue/snapshot', { headers: { 'x-qixue-token': token } })).json();
  const command = async (action, payload = {}) => {
    const result = await fetch(origin + '/api/qixue/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qixue-token': token }, body: JSON.stringify({ action, payload }) });
    assert.ok(result.ok, await result.clone().text()); return result.json();
  };
  const click = async selector => {
    await until(() => main.evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el||el.disabled)return false;const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()'), 'clickable ' + selector);
    const point = await main.evaluate('(() => {const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)throw Error("Missing element");const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    for (const type of ['mousePressed', 'mouseReleased']) await main.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await delay(100);
  };
  const capture = async name => {
    await native.evaluate('(async()=>{await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,300));const image=await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error("Empty capture");process.getBuiltinModule("fs").writeFileSync(' + JSON.stringify(path.join(data, name + '.png')) + ',image.toPNG());return true;})()');
  };
  const slantedBoundary = async (name, selector) => {
    await capture(name);
    const seam = await main.evaluate('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return {x:r.left,top:r.top+5,bottom:r.bottom-5,width:innerWidth,height:innerHeight};})()');
    const samples = await native.evaluate('(()=>{const p=' + JSON.stringify(seam) + ',image=e.nativeImage.createFromPath(' + JSON.stringify(path.join(data, name + '.png')) + '),size=image.getSize(),pixels=image.toBitmap();return [p.top,p.bottom].map(y=>Array.from({length:25},(_,i)=>{const x=p.x-12+i,offset=(Math.floor(y*size.height/p.height)*size.width+Math.floor(x*size.width/p.width))*4;return {x,r:pixels[offset+2],g:pixels[offset+1],b:pixels[offset]};}));})()');
    const edges = samples.map(row => row.find(pixel => Math.max(pixel.r, pixel.g, pixel.b) < 140)?.x);
    assert.ok(edges.every(edge => edge !== undefined), name + ' must have a light/dark seam');
    assert.ok(edges[0] - edges[1] >= 8 && edges[0] - edges[1] <= 14, name + ' must slope across its full height: ' + JSON.stringify(edges));
    return edges;
  };

  await main.evaluate('window.tujiDesktop.command("open-panel",{tab:"notebook"})');
  await until(() => main.evaluate('!!document.querySelector(".utility-panel[data-visible=true] [data-paper-input]")'), 'initial notebook');
  assert.equal(await main.evaluate('getComputedStyle(document.querySelector(".utility-tab-pins .utility-tab:last-child"),"::after").display'), 'none');
  await click('[aria-label="隐藏侧边页"]');
  await until(() => main.evaluate('!document.querySelector(".utility-panel")'), 'initial notebook collapsed');
  await main.evaluate('document.querySelector("[data-canvas-viewport]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:600,clientY:300}));true');
  await until(() => main.evaluate('!!document.querySelector("[data-graph-action=createTemporary]")'), 'home temporary menu');
  assert.equal(await main.evaluate('document.querySelector("[data-graph-action=createTemporary]").textContent'), '创建极简临时会话');
  await click('[data-graph-action=createTemporary]');
  await until(() => main.evaluate('!!document.querySelector(".utility-panel[data-visible=true] [aria-selected=true]")'), 'global panel');
  const global = (await snapshot()).sessions.find(session => session.temporaryContext?.scope === 'global'); assert.ok(global);
  assert.equal(await main.evaluate('document.querySelector(".utility-tab [aria-selected=true]").textContent'), '极简1');
  await main.evaluate('window.tujiDesktop.command("patch-view",{width:900})');
  await until(() => main.evaluate('Math.abs(document.querySelector(".utility-panel").getBoundingClientRect().width-900)<1'), 'wide single tab panel');
  assert.equal(await main.evaluate('document.querySelector(".utility-tab-scroll .utility-tab").getBoundingClientRect().width'), 148, 'A lone tab must not grow across the available bar');
  assert.ok(await main.evaluate('[...document.querySelectorAll(".utility-tab-pins .utility-tab")].every(tab=>tab.getBoundingClientRect().width<100)'), 'Pinned notebook/directory tabs remain compact');
  assert.equal(await main.evaluate('getComputedStyle(document.querySelector(".utility-actions")).backgroundColor===getComputedStyle(document.querySelector(".utility-tab-scroll .utility-tab"),"::before").backgroundColor'), true, 'The trailing actions retain the last tab color across the gap');
  await capture('single-tab-capped');
  await slantedBoundary('pinned-slanted-seam', '.utility-tab-scroll .utility-tab[data-theme=temporary]');
  await click('[aria-label="隐藏侧边页"]');
  await until(() => main.evaluate('!!document.querySelector("[data-ai-temporary-bookmark]")'), 'collapsed global label');
  assert.equal(await main.evaluate('document.querySelector("[data-ai-temporary-bookmark]").textContent'), '极简1');
  await click('[data-ai-canvas-button="saved-canvas"]');
  await until(() => main.evaluate('document.querySelector("[data-canvas-viewport]")?.dataset.canvasId==="saved-canvas"'), 'enter saved canvas');
  assert.equal(await main.evaluate('document.querySelector("[data-ai-temporary-bookmark]").textContent'), '极简1');
  await click('[data-ai-temporary-bookmark]');
  assert.equal(await main.evaluate('document.querySelector(".utility-tab [aria-selected=true]").textContent'), '极简1');
  console.log('PASS: actual home context menu creates independent global chat; collapsed label survives canvas switch');

  const source = (await snapshot()).sessions.find(session => session.canvasId === 'saved-canvas' && session.mode !== 'temporary'); assert.ok(source);
  const minimal = await command('session.create', { canvasId: 'saved-canvas', mode: 'temporary', temporaryMode: 'minimal', title: '这是一个很长的临时会话标题用于验证模式按钮右对齐' });
  await command('session.create', { canvasId: 'saved-canvas', mode: 'temporary', temporaryMode: 'branch', sourceSessionId: source.id });
  await command('session.create', { canvasId: 'saved-canvas', mode: 'temporary', temporaryMode: 'custom', sourceSessionId: source.id, orderedTasks: [] });
  await command('temporary.createDesktop');
  await main.evaluate('window.tujiDesktop.command("patch-view",' + JSON.stringify({ width: 360,
    noteTabs: Array.from({ length: 5 }, (_, index) => ({ id: 'note-view:test-' + index, directoryId: 'dir-' + index, kind: 'directory' })), activeTab: minimal.id }) + ')');
  await until(() => main.evaluate('!!document.querySelector("[data-ai-temporary-select]")'), 'canvas mode selector');
  const alignment = await main.evaluate('(()=>{const h=document.querySelector(".utility-content .ai-chat-heading").getBoundingClientRect(),s=document.querySelector("[data-ai-temporary-select]").getBoundingClientRect();return {right:h.right-s.right,sameRow:s.top<h.top+20};})()');
  assert.ok(alignment.right >= 12 && alignment.right <= 16, JSON.stringify(alignment)); assert.ok(alignment.sameRow);
  const labels = await main.evaluate('[...document.querySelectorAll(".utility-tab[data-theme=temporary] [role=tab]")].map(el=>el.textContent)');
  assert.deepEqual(labels, ['极简2', '分支1', '自定义1', '极简1', '悬浮窗1']);
  await capture('mode-right-aligned');
  const layout = await main.evaluate('(()=>{const h=document.querySelector(".utility-header").getBoundingClientRect(),t=document.querySelector(".utility-tabs").getBoundingClientRect(),a=document.querySelector(".utility-actions").getBoundingClientRect(),s=document.querySelector(".utility-tab-scroll");return {height:h.height,overlap:t.right-a.left,overflow:s.scrollWidth>s.clientWidth,buttons:[...document.querySelectorAll(".utility-actions button")].map(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {height:r.height,width:r.width,hit:el.contains(hit),target:hit?.outerHTML.slice(0,300)}})}})()');
  assert.equal(layout.height, 41); assert.ok(layout.overlap < .5, 'Tabs must not overlap actions'); assert.ok(layout.overflow);
  for (const button of layout.buttons) { assert.equal(button.height, 41); assert.equal(button.width, 32); assert.ok(button.hit, JSON.stringify(layout)); }
  await main.evaluate('document.querySelector(".utility-tab-scroll").scrollLeft=0;true');
  await until(() => main.evaluate('document.querySelector(".utility-header").dataset.edgeTheme==="note"'), 'note edge color');
  const noteColor = await main.evaluate('getComputedStyle(document.querySelector(".utility-actions")).backgroundColor');
  await capture('narrow-note-edge');
  await main.evaluate('document.querySelector(".utility-tab-scroll").scrollLeft=100000;true');
  await until(() => main.evaluate('document.querySelector(".utility-header").dataset.edgeTheme==="temporary"'), 'temporary edge color');
  const temporaryColor = await main.evaluate('getComputedStyle(document.querySelector(".utility-actions")).backgroundColor');
  assert.notEqual(noteColor, temporaryColor);
  assert.equal(await main.evaluate('(()=>{const el=[...document.querySelectorAll(".utility-tab-delete")].at(-1),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()'), true);
  await capture('narrow-temporary-edge');
  await main.evaluate('window.tujiDesktop.command("patch-view",{width:900,activeTab:"notebook"})');
  await until(() => main.evaluate('!!document.querySelector("[data-paper-input]")'), 'wide notebook');
  assert.ok(await main.evaluate('[...document.querySelectorAll(".utility-tab-scroll .utility-tab")].every(tab=>Math.abs(tab.getBoundingClientRect().width-148)<.01)'), 'All scrolling tabs have the same 148px total width, including their close button');
  await main.evaluate('(()=>{const scroll=document.querySelector(".utility-tab-scroll"),tab=scroll.querySelector("[data-theme=temporary]");scroll.scrollLeft+=tab.getBoundingClientRect().left-scroll.getBoundingClientRect().left-160;})()');
  await capture('wide-mixed-tabs');
  await slantedBoundary('mixed-slanted-seam', '.utility-tab-scroll .utility-tab[data-theme=temporary]');
  const separators = await main.evaluate('(()=>{const first=document.querySelector(".utility-tab-pins .utility-tab"),note=document.querySelector(".utility-tab-scroll .utility-tab[data-theme=note]"),temporary=document.querySelector(".utility-tab[data-theme=temporary]"),last=document.querySelector(".utility-tab-scroll .utility-tab:last-child");const read=el=>{const s=getComputedStyle(el,"::after"),b=getComputedStyle(el,"::before");return {content:s.content,display:s.display,height:s.height,width:s.width,transform:s.transform,backgroundTransform:b.transform,pointerEvents:s.pointerEvents,color:s.backgroundColor}};return {first:read(first),note:read(note),temporary:read(temporary),last:read(last),surfaces:[getComputedStyle(note,"::before").backgroundColor,getComputedStyle(temporary,"::before").backgroundColor]};})()');
  for (const separator of [separators.first, separators.note, separators.temporary]) {
    assert.notEqual(separator.display, 'none'); assert.notEqual(separator.content, 'none');
    assert.equal(separator.height, '41px'); assert.equal(separator.width, '1px');
    assert.notEqual(separator.transform, 'none'); assert.equal(separator.pointerEvents, 'none');
    assert.equal(separator.backgroundTransform, separator.transform);
  }
  assert.equal(separators.last.display, 'none');
  assert.notEqual(separators.note.color, separators.temporary.color);
  assert.notEqual(separators.surfaces[0], separators.surfaces[1]);
  await click('.utility-tab-pins .utility-tab:last-child [role=tab]');
  const slashPoint = await main.evaluate('(()=>{const tab=document.querySelector(".utility-tab-pins .utility-tab:first-child"),r=tab.getBoundingClientRect(),x=r.right-1.5,y=r.y+r.height/2+6,button=tab.querySelector("button");return {x,y,hit:button.contains(document.elementFromPoint(x,y))};})()');
  assert.equal(slashPoint.hit, true, 'The slash must let pointer hits reach the tab button');
  const { x, y } = slashPoint;
  for (const type of ['mousePressed', 'mouseReleased']) await main.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await until(() => main.evaluate('document.querySelector(".utility-tab-pins .utility-tab:first-child [role=tab]").getAttribute("aria-selected")==="true"'), 'tab activated through slash');
  await capture('slash-separators');
  await main.evaluate('document.querySelector(".utility-tab-scroll").style.maxWidth="120px";true');
  assert.ok(await main.evaluate('[...document.querySelectorAll(".utility-tab-scroll .utility-tab")].every(tab=>tab.getBoundingClientRect().width<=120&&tab.getBoundingClientRect().width>90)'), 'A smaller available scroll area may shrink tabs below the cap');
  await main.evaluate('document.querySelector(".utility-tab-scroll").style.maxWidth="";true');
  console.log('PASS: mixed paper/navy tabs, scrolling changes adjacent action color, 360px controls clickable, mode aligned right');
  console.log('PASS: full-height diagonal color boundaries match separators across pinned/scrolling tabs and preserve click targets');
  console.log('PASS: one or many scrolling tabs stay at 148px including close buttons, shrinking only when the available area is smaller');
  console.log('Desktop session screenshots: ' + data);
} catch (error) {
  if (clients[0]) console.error('UI state:', await clients[0].evaluate('({errors:JSON.parse(localStorage.getItem("qixue:ui-errors:v1")||"[]"),text:document.body.innerText.slice(0,1800)})').catch(() => null));
  console.error('Desktop session artifacts: ' + data); throw error;
} finally {
  clients.forEach(client => client.close());
  if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
  await Promise.race([exit, delay(5000)]); if (!exited) child.kill();
}
