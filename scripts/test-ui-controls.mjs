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
const cache = path.join(root, '.cache', 'ui-controls');
await fs.mkdir(cache, { recursive: true });
const bundle = async (input, output) => build({ absWorkingDir: root, entryPoints: [input], outfile: output, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const tests = ['ui-controls', 'layout-expansion'];
for (const name of tests) await bundle('scripts/' + name + '.test.ts', path.join(cache, name + '.cjs'));
const unit = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(cache, name + '.cjs'))], { stdio: 'inherit' });
assert.equal(unit.status, 0);
if (!process.argv.includes('--desktop')) process.exit(0);

const data = await fs.mkdtemp(path.join(cache, 'desktop-'));
await bundle('src/ai/server/repository.ts', path.join(data, 'repository.cjs'));
const { Repository } = require(path.join(data, 'repository.cjs'));
const repo = new Repository(path.join(data, 'qixue.sqlite'));
const canvasId = 'qixue-draft-canvas', stamp = '2026-11-15T00:00:00Z';
const manual = (x, y) => ({ x, y, source: 'manual', manualAnchor: { x, y } });
repo.transaction(s => {
  s.setupCompleted = true;
  s.graph = { layoutVersion: 3, nodes: {
    n1: { nodeId: 'n1', name: '收集资料', content: '整理来源与关键内容' },
    n2: { nodeId: 'n2', name: '审核示例', content: '更新后的正文' },
    n3: { nodeId: 'n3', name: '视觉设计', content: '统一紧凑的操作按钮' },
    n4: { nodeId: 'n4', name: '阅读笔记', content: '记录参考内容' },
  }, documents: { doc1: { documentId: 'doc1', kind: 'document', name: '参考资料', childNodeIds: ['n4'], childDocumentIds: [],
    placements: { n4: manual(0, 0) }, rev: 1, metadata: { createdAt: stamp, updatedAt: stamp, version: '3.0', description: '项目知识与阅读笔记' } } },
    edges: [], canvases: [{ canvasId, canvasName: '界面交互验证', isDraft: true, updatedAt: stamp, childIds: ['project', 'doc1'],
      directories: { project: { name: '项目规划', childIds: ['analysis', 'design'] }, analysis: { name: '需求分析', childIds: ['n1', 'n2'] },
        design: { name: '界面设计', childIds: ['n3'] } },
      placements: { project: manual(0, 0), doc1: manual(650, 0), analysis: manual(0, 0), design: manual(300, 0),
        n1: manual(0, 0), n2: manual(260, 0), n3: manual(0, 0) }, collapsed: { analysis: true } }] };
  s.canvasReviewStates = { [canvasId]: { taskIds: ['ui-review-task'], revision: 1 } };
  s.reviewChanges = [{ id: 'ui-review-change', operationId: 'ui-op', workspaceId: 'ui-workspace', taskId: 'ui-review-task', stepId: 'ui-step',
    status: 'committed', commands: [], patches: [], expectedHashes: {}, affectedRefs: ['n2'], affectedCanvasIds: [canvasId],
    createdAt: stamp, instructionRevision: 1, digest: '补充审核示例的说明',
    reviewArchive: { title: '完善说明', request: '补充审核示例的说明', createdAt: stamp },
    review: { canvasId, revision: 1, callId: 'ui-call', sequence: 1, units: [{ id: 'ui-review-unit', kind: 'update', label: '更新审核示例',
      refs: ['n2'], parentId: 'analysis', requires: [], provides: [], removes: [],
      deltas: [{ collection: 'nodes', id: 'n2', path: ['content'], before: '原来的正文', after: '更新后的正文' }],
      dependencies: [], ghosts: [], state: 'pending' }] } }];
  s.userNoteDirectories = Array.from({ length: 5 }, (_, i) => ({ id: 'dir' + i, name: '项目研究与设计记录 ' + (i + 1), createdAt: stamp, updatedAt: stamp }));
});
repo.close();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open');
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout: ' + String(params.expression ?? '').slice(0, 140))); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { send, evaluate, close() { for (const p of pending.values()) clearTimeout(p.timer); socket.close(); } };
}
// Launch the real desktop entry with hidden test windows and a private database.
const bootstrap = path.join(data, 'bootstrap.mjs');
await fs.writeFile(bootstrap, "import { BrowserWindow, dialog } from 'electron'; dialog.showErrorBox = (title, message) => console.error(title, message); " +
  "BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); }; await import(" +
  JSON.stringify(pathToFileURL(path.join(root, 'desktop/main.mjs')).href) + ");");
const [nativePort, rendererPort] = await Promise.all([port(), port()]);
const env = { ...process.env, QIXUE_DATA_DIR: data, QIXUE_PORT: '0' };
delete env.ELECTRON_RUN_AS_NODE; delete env.QIXUE_USE_VITE;
const args = [bootstrap, '--inspect=127.0.0.1:' + nativePort, '--remote-debugging-port=' + rendererPort];
const scale = process.argv.find(arg => arg.startsWith('--force-device-scale-factor='));
if (scale) args.push(scale);
const child = spawn(require('electron'), args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '', exited = false;
child.stderr.on('data', bytes => stderr += bytes);
child.stdout.on('data', () => {});
const exit = once(child, 'exit').then(() => { exited = true; });
const clients = [];
try {
  let targets;
  await until(async () => {
    assert.equal(exited, false, stderr);
    try { targets = await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json(); return targets.some(t => /^http:\/\/127.0.0.1/.test(t.url)); } catch { return false; }
  }, 'desktop renderer');
  const target = targets.find(t => /^http:\/\/127.0.0.1/.test(t.url)), url = new URL(target.url).origin;
  const main = await connect(target.webSocketDebuggerUrl); clients.push(main);
  await main.send('Page.enable');
  // Native test windows stay hidden. Keep Chromium's page focus stable while
  // injecting captured gestures; explicit blur cancellation is tested below.
  await main.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const natives = await (await fetch('http://127.0.0.1:' + nativePort + '/json/list')).json();
  const native = await connect(natives[0].webSocketDebuggerUrl); clients.push(native);
  await native.evaluate("globalThis.e = process.getBuiltinModule('module').createRequire(" + JSON.stringify(path.join(root, 'package.json')) + ")('electron'); globalThis.w = e.BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); true");
  await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => main.evaluate('!!document.querySelector("[data-sidebar=right] .library-tabs")'), 'sidebar');
  const token = (await (await fetch(url + '/api/qixue/connection')).json()).token;
  const snapshot = async () => (await fetch(url + '/api/qixue/snapshot', { headers: { 'x-qixue-token': token } })).json();
  const command = async (action, payload) => {
    const r = await fetch(url + '/api/qixue/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qixue-token': token }, body: JSON.stringify({ action, payload }) });
    assert.ok(r.ok, await r.clone().text()); return r.json();
  };
  const point = async (selector, client = main) => client.evaluate('(() => { const el=document.querySelector(' + JSON.stringify(selector) + '); if(!el)throw Error("Missing element"); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
  const mouse = (type, p, client = main, extra = {}) => client.send('Input.dispatchMouseEvent', { type, ...p, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }), ...extra });
  const click = async (selector, client = main) => { const p = await point(selector, client); await mouse('mouseMoved', p, client); await mouse('mousePressed', p, client); await mouse('mouseReleased', p, client); await delay(80); };
  const input = async (selector, text) => {
    await main.evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus(); document.querySelector(' + JSON.stringify(selector) + ').select()');
    await main.send('Input.insertText', { text }); await delay(100);
  };
  const capture = async (name, client = main) => {
    const pageUrl = await client.evaluate('location.href');
    await native.evaluate('(async () => { const win=e.BrowserWindow.getAllWindows().find(win=>win.webContents.getURL()===' + JSON.stringify(pageUrl) + '); ' +
      'let image; for(let attempt=0;attempt<4;attempt++){ try{image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); if(attempt>0&&!image.isEmpty())break;}catch(error){if(attempt===3)throw error;} await new Promise(r=>setTimeout(r,250));} ' +
      'if(!image||image.isEmpty())throw Error("Empty capture"); process.getBuiltinModule("fs").writeFileSync(' +
      JSON.stringify(path.join(data, name + '.png')) + ',image.toPNG()); return true; })()');
  };
  const nativeHitTests = async (points, client = main, windowName = 'w') => {
    if (process.platform !== 'win32') return;
    const handle = await native.evaluate(windowName + '.getNativeWindowHandle().readBigUInt64LE().toString()');
    const viewport = await client.evaluate('({width:innerWidth,height:innerHeight})');
    const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/windows-window-hit-test.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    probe.stdout.on('data', bytes => stdout += bytes); probe.stderr.on('data', bytes => stderr += bytes);
    probe.stdin.end(JSON.stringify({ handle, ...viewport, points }));
    const [code] = await once(probe, 'exit'); assert.equal(code, 0, stderr);
    const results = JSON.parse(stdout);
    console.log('Windows native hit tests:', results);
    for (const result of results) assert.equal(result.hit, 1, result.label + ' must reach the client area (HTCLIENT), not the native resize border');
  };
  const revealControls = async () => {
    await mouse('mouseMoved', { x: await main.evaluate('innerWidth') - 180, y: 100 });
    // The actual top edge is a native resize border, so renderer-only CDP mouse
    // injection cannot reveal it. Exercise the native cursor poll without moving
    // the real cursor or showing the private test window.
    await native.evaluate('(() => { const b=w.isMaximized()?e.screen.getDisplayMatching(w.getBounds()).workArea:w.getBounds();' +
      'w.isVisible=()=>true; e.screen.getCursorScreenPoint=()=>({x:b.x+b.width-60,y:b.y+1}); w.emit("show"); })()');
    await until(() => main.evaluate('document.querySelector(".desktop-window-controls").dataset.visible==="true"'), 'window hot edge');
    await native.evaluate('(() => { const b=w.isMaximized()?e.screen.getDisplayMatching(w.getBounds()).workArea:w.getBounds(); e.screen.getCursorScreenPoint=()=>({x:b.x+b.width-60,y:b.y+16}); })()');
    await mouse('mouseMoved', { x: await main.evaluate('innerWidth') - 60, y: 16 });
  };
  const drag = async (selector, destination, captured = false) => {
    const p = await point(selector); await mouse('mouseMoved', p); await mouse('mousePressed', p);
    if (captured) {
      // A hidden native window cannot route an OS-captured mouse via CDP.
      // Deliver the captured events to the viewport without moving the user's cursor.
      await main.evaluate('(() => { const el=document.querySelector("[data-canvas-viewport]"); for(const type of ["pointermove","pointerup"]) el.dispatchEvent(new PointerEvent(type,' +
        JSON.stringify({ pointerId: 1, clientX: destination.x, clientY: destination.y, button: 0, buttons: 1, bubbles: true }) + ')); })()');
      await mouse('mouseReleased', destination); await delay(350); return;
    }
    await mouse('mouseMoved', { x: p.x + 12, y: p.y + 10 }, main, { buttons: 1 });
    await mouse('mouseMoved', destination, main, { buttons: 1 }); await delay(100);
    await mouse('mouseReleased', destination); await delay(350);
  };
  // The hot edge alone reveals the controls; all sizes are CSS pixels.
  const width = await main.evaluate('innerWidth');
  await native.evaluate('globalThis.originalCursor=e.screen.getCursorScreenPoint; globalThis.originalVisible=w.isVisible;' +
    'w.isVisible=()=>true; const initial=w.getBounds(); e.screen.getCursorScreenPoint=()=>({x:initial.x+initial.width-10,y:initial.y+24}); w.emit("show"); true');
  await mouse('mouseMoved', { x: width - 10, y: 24 });
  await delay(80);
  assert.equal(await main.evaluate('getComputedStyle(document.querySelector(".desktop-window-buttons")).visibility'), 'hidden');
  await revealControls();
  const sizes = () => main.evaluate('[...document.querySelectorAll(".desktop-window-button")].map(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]})');
  assert.deepEqual(await sizes(), [[36, 32], [36, 32], [36, 32]]);
  assert.ok(await main.evaluate('[...document.querySelectorAll(".desktop-window-button")].every(el=>el.getBoundingClientRect().top===0)'));
  await nativeHitTests(await main.evaluate('[...document.querySelectorAll(".desktop-window-button")].map(el=>{const r=el.getBoundingClientRect();return {label:el.getAttribute("aria-label"),x:r.x+r.width/2,y:r.y+r.height/2}})'));
  await capture('window-controls');
  await mouse('mouseMoved', { x: width - 180, y: 100 });
  assert.equal(await main.evaluate('getComputedStyle(document.querySelector(".desktop-window-buttons")).visibility'), 'hidden');
  await native.evaluate('w.setSize(960,620); true'); await delay(200);
  assert.deepEqual(await sizes(), [[36, 32], [36, 32], [36, 32]]);
  await native.evaluate('w.setSize(1450,920); true'); await delay(200);
  const restoredBounds = await native.evaluate('w.getBounds()');
  await revealControls();
  await click('[aria-label="最大化窗口"]');
  await until(() => native.evaluate('w.isMaximized()'), 'maximize button');
  await until(() => main.evaluate('document.querySelector(".desktop-window-controls").dataset.maximized === "true"'), 'maximized UI');
  assert.deepEqual(await sizes(), [[36, 32], [36, 32]]);
  await revealControls(); await capture('window-controls-maximized');
  await revealControls();
  await click('[aria-label="还原窗口"]');
  await until(() => native.evaluate('!w.isMaximized()'), 'restore button');
  await until(() => main.evaluate('document.querySelectorAll(".desktop-window-button").length === 3'), 'restored UI');
  assert.deepEqual(await native.evaluate('w.getBounds()'), restoredBounds);
  // Controlled screen cursor exercises the real preload IPC and native bounds
  // without moving the user's cursor or exposing a test window.
  const before = await native.evaluate('w.getBounds()');
  await revealControls();
  await until(() => main.evaluate('getComputedStyle(document.querySelector(".desktop-window-buttons")).visibility === "visible"'), 'drag handle visible');
  await capture('window-controls-restored');
  await revealControls();
  await main.evaluate('globalThis.windowDragEvents=[]; for(const type of ["blur","focus","pointerdown","pointerup","pointercancel","lostpointercapture","gotpointercapture"]) window.addEventListener(type,event=>windowDragEvents.push({type,trusted:event.isTrusted,target:event.target?.className,pointerId:event.pointerId,time:performance.now()}),true); window.tujiWindow.onControlsPointer(pointer=>windowDragEvents.push({type:"native-pointer",...pointer,time:performance.now()})); true');
  await native.evaluate('globalThis.windowDragNativeEvents=[]; for(const type of ["blur","focus","move","resize"]) w.on(type,()=>windowDragNativeEvents.push({type,bounds:w.getBounds(),time:Date.now()})); true');
  const dragCursorStart = await native.evaluate('e.screen.getCursorScreenPoint()');
  const handle = await point('.desktop-window-drag');
  await mouse('mouseMoved', handle); await mouse('mousePressed', handle); await delay(40);
  assert.equal(await main.evaluate('document.querySelector(".desktop-window-drag").dataset.dragging'), 'true');
  await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:' + (dragCursorStart.x + 70) + ',y:' + (dragCursorStart.y + 30) + '}); true');
  const dragEnd = { x: handle.x - 70, y: handle.y + 50 };
  await main.evaluate('document.querySelector(".desktop-window-drag").dispatchEvent(new PointerEvent("pointermove",' + JSON.stringify({ pointerId: 1, clientX: dragEnd.x, clientY: dragEnd.y, buttons: 1, bubbles: true }) + '))');
  const dragVisibility = await main.evaluate('document.querySelector(".desktop-window-controls").dataset.visible');
  assert.equal(dragVisibility, 'true', dragVisibility === 'true' ? undefined : JSON.stringify({ renderer: await main.evaluate('windowDragEvents'), native: await native.evaluate('windowDragNativeEvents') }));
  await main.evaluate('document.querySelector(".desktop-window-drag").dispatchEvent(new PointerEvent("pointerup",' + JSON.stringify({ pointerId: 1, clientX: dragEnd.x, clientY: dragEnd.y, buttons: 0, bubbles: true }) + '))');
  await mouse('mouseReleased', dragEnd); await delay(80);
  const moved = await native.evaluate('w.getBounds()');
  assert.ok(Math.abs(moved.x - before.x - 70) <= 3); assert.ok(Math.abs(moved.y - before.y - 30) <= 3);
  assert.equal(moved.width, before.width); assert.equal(moved.height, before.height);
  // More than one move must never feed changed native dimensions back into size.
  for (const [dx, dy] of [[-130, -45], [210, 80], [0, 0]]) {
    await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:400,y:200}); true');
    await main.evaluate('window.tujiWindow.drag("start")'); await delay(30);
    await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:' + (400 + dx) + ',y:' + (200 + dy) + '}); true');
    await main.evaluate('window.tujiWindow.drag("move"); window.tujiWindow.drag("end")'); await delay(40);
    const b = await native.evaluate('w.getBounds()');
    assert.equal(b.width, before.width); assert.equal(b.height, before.height); assert.equal(await native.evaluate('w.isMaximized()'), false);
  }
  await revealControls();
  const cancelHandle = await point('.desktop-window-drag');
  await mouse('mouseMoved', cancelHandle); await mouse('mousePressed', cancelHandle); await delay(40);
  assert.equal(await main.evaluate('document.querySelector(".desktop-window-drag").dataset.dragging'), 'true');
  const beforeBlur = await native.evaluate('w.getBounds()');
  await main.evaluate('window.dispatchEvent(new Event("blur"))');
  await until(() => main.evaluate('document.querySelector(".desktop-window-drag").dataset.dragging === "false"'), 'blur cancels drag');
  await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:900,y:700}); true');
  await main.evaluate('window.tujiWindow.drag("move")'); await delay(40);
  assert.deepEqual(await native.evaluate('w.getBounds()'), beforeBlur);
  await mouse('mouseReleased', cancelHandle);
  console.log('PASS: native client-area hot edge, fixed window controls, maximize/restore button clicks, trusted drag IPC');
  console.log('Native drag delta:', { x: moved.x - before.x, y: moved.y - before.y });

  // The panel uses the same dispatcher but only its own trusted sender can move it.
  await main.evaluate('window.tujiDesktop.command("open-panel",{tab:"notebook"})');
  await main.evaluate('window.tujiDesktop.command("toggle-detach")');
  let dragPanelTarget;
  await until(async () => { const list = await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json(); dragPanelTarget = list.find(t => t.url.includes('desktop=panel')); return dragPanelTarget; }, 'drag panel');
  const dragPanel = await connect(dragPanelTarget.webSocketDebuggerUrl); clients.push(dragPanel);
  await dragPanel.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => dragPanel.evaluate('!!document.querySelector(".utility-drag-handle")'), 'panel drag handle');
  await native.evaluate('globalThis.p=e.BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes("desktop=panel")); globalThis.panelVisible=p.isVisible; p.isVisible=()=>true; true');
  await delay(300);
  await nativeHitTests(await dragPanel.evaluate('(() => { const r=document.querySelector(".utility-drag-handle").getBoundingClientRect(); return [{label:"panel drag center",x:r.x+r.width/2,y:r.y+r.height/2},{label:"panel drag upper inset",x:r.x+r.width/2,y:r.y+2}]; })()'), dragPanel, 'p');
  const panelBefore = await native.evaluate('p.getBounds()'), mainBeforePanelDrag = await native.evaluate('w.getBounds()');
  await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:400,y:200}); true');
  const panelHandle = await point('.utility-drag-handle', dragPanel);
  await mouse('mouseMoved', panelHandle, dragPanel); await mouse('mousePressed', panelHandle, dragPanel); await delay(40);
  for (const [dx, dy] of [[50, 20], [-80, 40], [35, -10]]) {
    await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:' + (400 + dx) + ',y:' + (200 + dy) + '}); true');
    await dragPanel.evaluate('document.querySelector(".utility-drag-handle").dispatchEvent(new PointerEvent("pointermove",{pointerId:1,buttons:1,bubbles:true}))');
    await delay(40);
    const panelMoved = await native.evaluate('p.getBounds()');
    assert.equal(panelMoved.width, panelBefore.width); assert.equal(panelMoved.height, panelBefore.height);
    assert.ok(Math.abs(panelMoved.x - panelBefore.x - dx) <= 3); assert.ok(Math.abs(panelMoved.y - panelBefore.y - dy) <= 3);
    assert.deepEqual(await native.evaluate('w.getBounds()'), mainBeforePanelDrag);
    assert.equal(await native.evaluate('p.isMaximized()'), false);
  }
  await dragPanel.evaluate('document.querySelector(".utility-drag-handle").dispatchEvent(new PointerEvent("pointerup",{pointerId:1,buttons:0,bubbles:true}))');
  await mouse('mouseReleased', panelHandle, dragPanel); await delay(40);
  const panelEnded = await native.evaluate('p.getBounds()');
  await native.evaluate('e.screen.getCursorScreenPoint=()=>({x:900,y:700}); true');
  await dragPanel.evaluate('window.tujiDesktop.dragPanel("move")'); await delay(40);
  assert.deepEqual(await native.evaluate('p.getBounds()'), panelEnded);
  await dragPanel.evaluate('window.tujiDesktop.command("toggle-detach")');
  await main.evaluate('window.tujiDesktop.command("hide-panel")');
  await native.evaluate('e.screen.getCursorScreenPoint=originalCursor; w.isVisible=originalVisible; p.isVisible=panelVisible; w.emit("hide"); true');
  console.log('PASS: native panel drag handle hit tests, stable dimensions, sender isolation and pointer-up cancellation');

  if (!process.argv.includes('--window-controls-only')) {
  const right = '[data-sidebar=right]';
  assert.equal(await main.evaluate('document.querySelectorAll("' + right + ' [data-sidebar-tabs]").length'), 1);
  assert.ok(await main.evaluate('document.querySelector(".library-tabs").getBoundingClientRect().bottom <= document.querySelector(".library-search-row").getBoundingClientRect().top'));
  await input(right + ' input[type=search]', '参考');
  await click('[data-review-tab=right]');
  assert.equal(await main.evaluate('document.querySelector("' + right + ' input").value'), '');
  assert.equal(await main.evaluate('document.querySelectorAll("' + right + ' input[type=search]").length'), 1);
  await input(right + ' input[type=search]', '审核');
  await until(() => main.evaluate('!!document.querySelector("[data-review-unit]")'), 'review matches');
  await click('[data-review-select-round]');
  await capture('review-sidebar');
  await drag('[data-review-tab=right]', { x: 90, y: 160 });
  await until(() => main.evaluate('!!document.querySelector("[data-review-tab=left]")'), 'left review dock');
  assert.equal(await main.evaluate('document.querySelector("[data-review-panel] input[type=search]").value'), '审核');
  assert.equal(await main.evaluate('document.querySelectorAll("[data-review-panel]").length'), 1);
  assert.ok(await main.evaluate('!!document.querySelector("[data-review-selection]")'));
  const currentWidth = await main.evaluate('innerWidth');
  await drag('[data-review-tab=left]', { x: currentWidth - 240, y: 160 });
  await until(() => main.evaluate('!!document.querySelector("[data-review-dock]")'), 'independent review dock');
  assert.equal(await main.evaluate('document.querySelector("[data-review-panel] input[type=search]").value'), '审核');
  await drag('[data-review-tab=detached]', { x: currentWidth - 80, y: 160 });
  await until(() => main.evaluate('!!document.querySelector("[data-review-tab=right]")'), 'return review dock');
  assert.equal(await main.evaluate('document.querySelector("' + right + ' input").value'), '审核');
  await click('[data-document-tab]');
  assert.equal(await main.evaluate('document.querySelector("' + right + ' input").value'), '参考');
  console.log('PASS: one sidebar/search, separate queries, review search and all three dock hosts');

  await click('[data-review-tab=right]');
  await until(() => main.evaluate('!!document.querySelector("[data-review-select-round]")'), 'review panel ready');
  await click('[data-review-select-round]');
  await until(() => main.evaluate('!!document.querySelector("[data-review-selection] [data-review-revert]:not(:disabled)")'), 'review action ready');
  await click('[data-review-selection] [data-review-revert]');
  await until(async () => (await snapshot()).graph.nodes.n2.content === '原来的正文', 'review revert');
  await until(() => main.evaluate('!!document.querySelector("[data-review-empty]")'), 'review resolved');
  console.log('PASS: selected review changes revert through the unified panel');

  await main.evaluate('window.tujiDesktop.command("open-panel",{tab:"notebook"})');
  await until(() => main.evaluate('!!document.querySelector(".utility-header")'), 'notebook panel');
  await main.evaluate('window.tujiDesktop.command("patch-view",' + JSON.stringify({ width: 360, noteTabs: Array.from({ length: 5 }, (_, i) => ({ id: 'note-view:' + i, directoryId: 'dir' + i, kind: 'directory' })), activeTab: 'note-view:4' }) + ')');
  await delay(350);
  await capture('notebook-tabs-narrow');
  const panelLayout = await main.evaluate('(() => {const h=document.querySelector(".utility-header").getBoundingClientRect(), tabs=document.querySelector(".utility-tabs").getBoundingClientRect(), actions=document.querySelector(".utility-actions").getBoundingClientRect(), scroll=document.querySelector(".utility-tab-scroll");return {height:h.height,sameRow:Math.abs(tabs.y-actions.y)<3,overlap:tabs.right>actions.left,overflow:scroll.scrollWidth>scroll.clientWidth,buttons:[...document.querySelectorAll(".utility-actions button")].map(el=>el.getBoundingClientRect().width)};})()');
  assert.ok(panelLayout.height <= 42); assert.ok(panelLayout.sameRow); assert.equal(panelLayout.overlap, false);
  assert.ok(panelLayout.overflow); assert.deepEqual(panelLayout.buttons, [32, 32]);
  assert.equal(await main.evaluate('getComputedStyle(document.querySelector(".utility-tab-scroll")).scrollbarWidth'), 'none');
  assert.ok(await main.evaluate('(() => {const el=[...document.querySelectorAll(".utility-tab-delete")].at(-1),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()'));
  await click('.utility-tab-pins button');
  await until(() => main.evaluate('!!document.querySelector("[data-paper-input]")'), 'notebook editor');
  await input('[data-paper-input]', '窗口切换后保留的笔记正文');
  await click('[aria-label="窗口化侧边页"]');
  let panelTarget;
  await until(async () => { const list = await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json(); panelTarget = list.find(t => t.url.includes('desktop=panel')); return panelTarget; }, 'detached notebook');
  const panel = await connect(panelTarget.webSocketDebuggerUrl); clients.push(panel);
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => panel.evaluate('!!document.querySelector(".utility-drag-handle")'), 'native drag handle');
  assert.equal(await panel.evaluate('document.querySelector(".utility-header").getBoundingClientRect().height'), 41);
  assert.equal(await panel.evaluate('document.querySelectorAll(".utility-tab").length'), 7);
  await until(() => panel.evaluate('document.querySelector("[data-paper-input]")?.value === "窗口切换后保留的笔记正文"'), 'draft transferred');
  await until(() => panel.evaluate('getComputedStyle(document.querySelector(".utility-panel")).opacity === "1"'), 'detached panel visible');
  await capture('notebook-detached', panel);
  await click('[aria-label="停靠侧边页"]', panel);
  await until(() => main.evaluate('!!document.querySelector(".utility-header")'), 'redock notebook');
  await until(() => main.evaluate('document.querySelector("[data-paper-input]")?.value === "窗口切换后保留的笔记正文"'), 'draft restored');
  await click('[aria-label="隐藏侧边页"]');
  console.log('PASS: one-row notebook tabs at 360px, long-title scrolling, detach/redock');

  for (const zoom of [.12, .25, .5, 1, 3]) {
    console.log('Checking canvas zoom ' + zoom);
    const identifier = await main.send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.setItem(' + JSON.stringify('qixue:canvas-viewport:v1:' + canvasId) + ',' + JSON.stringify(JSON.stringify({ x: 350, y: 120, zoom })) + ')' });
    await main.send('Page.reload'); await until(() => main.evaluate('!!document.querySelector("[data-canvas-viewport]")'), 'reloaded canvas');
    await delay(250);
    await until(() => main.evaluate('Number(document.querySelector("[data-canvas-viewport]")?.dataset.canvasZoom)===' + zoom), 'zoom ' + zoom);
    await main.send('Page.removeScriptToEvaluateOnNewDocument', identifier);
    const buttons = await main.evaluate('[...document.querySelectorAll(".canvas-region-toggle,[data-region-drag]")].map(el=>{const r=el.getBoundingClientRect();return {size:[r.width,r.height],hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})');
    assert.ok(buttons.length >= 2); for (const b of buttons) { assert.deepEqual(b.size, [28, 28]); assert.equal(b.hit, true); }
    if (zoom === .12 || zoom === 1) await capture('canvas-zoom-' + zoom);
    if (zoom === 1) {
      const original = (await snapshot()).graph.canvases[0].placements.design;
      const grip = await point('[data-record-header=design] [data-region-drag]');
      await drag('[data-record-header=design] [data-region-drag]', { x: grip.x + 60, y: grip.y + 24 }, true);
      await until(async () => (await snapshot()).graph.canvases[0].placements.design.x !== original.x, 'region handle move');
      const position = (await snapshot()).graph.canvases[0].placements.design;
      assert.ok(Math.abs(position.x - original.x - 60) < 1); assert.ok(Math.abs(position.y - original.y - 24) < 1);
    }
    if (zoom === .12) {
      await click('[data-record-header=analysis] .canvas-region-toggle');
      await until(async () => !(await snapshot()).graph.canvases[0].collapsed.analysis, 'expand from overview');
      await command('graph.mutate', { canvasId, command: { type: 'toggleCollapse', id: 'analysis' } });
    }
  }
  console.log('PASS: constant, hit-testable region buttons from 12% to 300%, low-zoom expansion');

  const resetView = await main.send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.setItem(' + JSON.stringify('qixue:canvas-viewport:v1:' + canvasId) + ',' + JSON.stringify(JSON.stringify({ x: 300, y: 120, zoom: 1 })) + ')' });
  await main.send('Page.reload'); await until(() => main.evaluate('Number(document.querySelector("[data-canvas-viewport]")?.dataset.canvasZoom)===1'), 'reset preview');
  await main.send('Page.removeScriptToEvaluateOnNewDocument', resetView);
  await command('settings.personalization', { canvasBackgroundId: 'white-grid' });
  await delay(200); await capture('light-background');
  assert.equal(await main.evaluate('document.querySelectorAll("[data-app-error]").length'), 0);
  assert.deepEqual(await main.evaluate('JSON.parse(localStorage.getItem("qixue:ui-errors:v1") || "[]").map(e=>e.message)'), []);
  }
  console.log('Desktop previews: ' + data);
} finally {
  clients.forEach(client => client.close());
  if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
  await Promise.race([exit, delay(5000)]); if (!exited) child.kill();
}
