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
const cache = path.join(root, '.cache', 'interaction-updates');
await fs.mkdir(cache, { recursive: true });
const bundle = async (input, output) => build({ absWorkingDir: root, entryPoints: [input], outfile: output, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const data = await fs.mkdtemp(path.join(cache, 'desktop-'));
await bundle('src/ai/server/repository.ts', path.join(data, 'repository.cjs'));
const { Repository } = require(path.join(data, 'repository.cjs'));
const repo = new Repository(path.join(data, 'qixue.sqlite'));
const canvasId = 'interaction-canvas', stamp = '2026-11-15T00:00:00Z';
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
    edges: [], canvases: [{ canvasId, canvasName: '界面交互验证', isDraft: false, updatedAt: stamp, childIds: ['project', 'doc1'],
      directories: { project: { name: '项目规划', childIds: ['analysis', 'design'] }, analysis: { name: '需求分析', childIds: ['n1', 'n2'] },
        design: { name: '界面设计', childIds: ['n3'] } },
      placements: { project: manual(0, 0), doc1: manual(650, 0), analysis: manual(0, 0), design: manual(300, 0),
        n1: manual(0, 0), n2: manual(260, 0), n3: manual(0, 0) }, collapsed: {} }] };
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
repo.transaction(s => {
  const session = { id: 'interaction-session', canvasId, workspaceId: 'interaction-workspace', mode: 'explore', title: '交互验证', lifecycle: 'active', createdAt: stamp };
  s.sessions.push(session);
  s.workspaces.push({ id: session.workspaceId, sessionId: session.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] });
  const task = { id: 'interaction-task', sessionId: session.id, workspaceId: session.workspaceId, canvasId,
    presentationFocus: ['n4'], rootUserMessageId: 'interaction-user', clientRequestId: 'interaction-request', instructionRevision: 1, appliedInstructionRevision: 1,
    status: 'completed', createdAt: stamp, updatedAt: stamp, inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} },
    maxSteps: 100, maxTokens: 100000, usedTokens: 0, stepCount: 0, fencingToken: 0 };
  s.tasks.push(task);
  s.messages.push({ id: task.rootUserMessageId, taskId: task.id, workspaceId: session.workspaceId, role: 'user', text: '查看对象',
    version: 1, status: 'complete', phase: 'request', createdAt: stamp, sequence: 1, targetRefs: [], sourceRefs: [], relatedOperationIds: [] });
  s.messages.push({ id: 'interaction-answer', taskId: task.id, workspaceId: session.workspaceId, role: 'assistant', text: '这是引用的对象。',
    version: 1, status: 'complete', phase: 'final', createdAt: stamp, sequence: 2, targetRefs: ['n4'], sourceRefs: [], relatedOperationIds: [] });
});
repo.transaction(s => { for (const seq of [2,3,4]) s.presentationParts.push({ id: 'interaction-task:part:'+seq, taskId: 'interaction-task', seq, targets: ['n3'],
  revision: 1, graphRevision: 0, kind: 'text', version: 1, sealed: true, stable: true, dwellMs: 2000, events: [] }); });
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
delete env.ELECTRON_RUN_AS_NODE; env.QIXUE_USE_VITE = '1';
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

  await main.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await main.evaluate("(async () => { globalThis.ai = (await import('/src/ai/client.ts')).useAiStore; globalThis.pb = (await import('/src/ai/presentationClient.ts')).usePlaybackStore; return true; })()");
  await click('[data-ai-canvas-button="interaction-canvas"]');
  await main.evaluate("ai.getState().setView('canvas'); true");
  await until(() => main.evaluate('document.querySelector("[data-canvas-viewport]")?.dataset.canvasId === "interaction-canvas"'), 'saved canvas');
  await main.evaluate("ai.getState().setActiveSession('interaction-canvas','interaction-session'); pb.getState().set('interaction-canvas',{taskId:'interaction-task',cursor:1,mode:'review',cameraFollow:true}); true");
  await until(() => main.evaluate('!!document.querySelector("[data-presentation-reference-count]")'), 'gold reference count');
  await until(async () => (await snapshot()).presentationAutoFocus?.['interaction-task:part:1'], 'first auto focus persisted');
  assert.match(await main.evaluate('document.querySelector("[data-presentation-reference-count]").textContent'), /引用了 1 个对象/);
  const view = () => main.evaluate('(() => {const d=document.querySelector("[data-canvas-viewport]").dataset; return [d.panX,d.panY,d.canvasZoom]})()');
  await main.evaluate("pb.getState().set('interaction-canvas',{cameraFollow:false}); pb.getState().set('interaction-canvas',{cursor:2}); true");
  await until(async () => (await snapshot()).presentationAutoFocus?.['interaction-task:part:2'], 'second part first focus');
  const viewAfterSecond = await view();
  await main.evaluate("pb.getState().set('interaction-canvas',{cursor:1,cameraFollow:true}); true");
  await delay(300); assert.deepEqual(await view(), viewAfterSecond, 'reviewing an already seen part does not move camera');
  await main.evaluate("ai.getState().setView('chat'); true"); await delay(150);
  await main.evaluate("ai.getState().setView('canvas'); true");
  await until(() => main.evaluate('!!document.querySelector("[data-canvas-viewport]")'), 'return to canvas');
  await delay(300); assert.deepEqual(await view(), viewAfterSecond, 'remount does not replay auto focus');
  await click('[aria-label="定位指定对象"]'); await delay(150);
  assert.ok(await main.evaluate("pb.getState().byCanvas['interaction-canvas'].consumedLocate===pb.getState().byCanvas['interaction-canvas'].locate"));
  const afterManual = await view();
  await main.evaluate("ai.getState().setView('chat'); true"); await delay(150);
  await main.evaluate("ai.getState().setView('canvas'); true"); await delay(300);
  assert.deepEqual(await view(), afterManual, 'manual request is consumed across remount');
  console.log('PASS: gold count, first focus, review/remount, manual request consumption');

  const beforeSettings = await view();
  await main.evaluate('ai.getState().setSettingsOpen(true); true');
  await until(() => main.evaluate('!!document.querySelector("[data-ai-settings-page]")'), 'settings');
  assert.equal(await main.evaluate('document.querySelector(".ai-settings-brand img").getAttribute("src")'), '/brand/app-icon.png');
  assert.equal(await main.evaluate('document.querySelector("[data-settings-tab=data]")'), null);
  await click('[data-settings-tab=shortcuts]');
  assert.ok(await main.evaluate('document.querySelector("[data-shortcut-reference]").innerText.includes("搜索当前画布中的对象")'));
  await main.evaluate('for(const event of [{key:"d",code:"KeyD"},{key:"+",code:"Equal",ctrlKey:true},{key:"f",code:"KeyF",ctrlKey:true}]) document.querySelector("[data-ai-settings-page]").dispatchEvent(new KeyboardEvent("keydown",{...event,bubbles:true,cancelable:true})); true');
  assert.deepEqual(await view(), beforeSettings, 'settings stops background camera shortcuts');
  assert.equal(await main.evaluate('!!document.querySelector(".canvas-search-popover")'), false);
  await main.evaluate("pb.getState().set('interaction-canvas',{cursor:3}); true");
  await delay(250); assert.equal((await snapshot()).presentationAutoFocus?.['interaction-task:part:3'], undefined, 'settings does not consume first visit');
  await capture('shortcut-reference');
  await click('[data-ai-settings-back]');
  await until(async () => (await snapshot()).presentationAutoFocus?.['interaction-task:part:3'], 'focus after settings closes');
  await main.evaluate('globalThis.testModal=document.createElement("div"); testModal.setAttribute("aria-modal","true"); testModal.setAttribute("role","dialog"); document.body.append(testModal); true');
  await main.evaluate("pb.getState().set('interaction-canvas',{cursor:4}); true");
  await delay(250); assert.equal((await snapshot()).presentationAutoFocus?.['interaction-task:part:4'], undefined, 'modal does not consume first visit');
  await main.evaluate('testModal.remove(); true');
  await until(async () => (await snapshot()).presentationAutoFocus?.['interaction-task:part:4'], 'focus after modal closes without streaming');
  console.log('PASS: app icon, shortcut reference, background key isolation');

  // Fit and invoke real pointer/context-menu handlers, without moving the system cursor.
  await click('[title="适应画布"]');
  const ctrlSelect = async id => {
    await main.evaluate('(() => { const el=document.querySelector('+JSON.stringify('[data-node-id="'+id+'"]')+'); if(!el)throw Error("node missing"); const r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown",{button:0,buttons:1,pointerId:1,ctrlKey:true,bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2})); })()');
    await delay(70);
  };
  const addSelection = async () => {
    await main.evaluate('(() => {const el=document.querySelector("[data-canvas-viewport]");el.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:680,clientY:250}));})()');
    await until(() => main.evaluate('!!document.querySelector("[data-graph-action=addToSession]:not(:disabled)")'), 'add group menu');
    await click('[data-graph-action=addToSession]');
    await until(() => main.evaluate('document.querySelector("[data-canvas-viewport]")?.dataset.selectedCount==="0"'), 'selection cleared');
  };
  await ctrlSelect('n1'); await ctrlSelect('n2');
  assert.equal(await main.evaluate('document.querySelectorAll("[data-ai-target-group]").length'), 0, 'Ctrl selection does not alter input');
  await addSelection();
  await ctrlSelect('n2'); await ctrlSelect('n3'); await addSelection();
  await ctrlSelect('n1'); await ctrlSelect('n2'); await addSelection();
  assert.deepEqual(await main.evaluate("ai.getState().draftsBySession['interaction-session'].targetGroups.map(g=>g.targetIds)"), [['n1','n2'],['n2','n3'],['n1','n2']]);
  await click('[data-ai-target-group]:nth-of-type(3) .ai-target-name');
  await until(() => main.evaluate("JSON.stringify(ai.getState().selectedRefsByCanvas['interaction-canvas'])===JSON.stringify(['n2','n3'])"), 'restore second group');
  assert.equal(await main.evaluate('document.querySelectorAll("[data-ai-target-group]").length'), 3);
  await capture('reference-groups');
  console.log('PASS: Ctrl decoupled, three overlapping groups, clear and whole-group restore');

  await click('[data-document-tab]');
  await main.evaluate('document.querySelector("[data-library-document=doc1]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:1200,clientY:200})); true');
  await until(() => main.evaluate('!!document.querySelector("[data-graph-action=exportDocument]")'), 'document export menu');
  await main.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); true');
  const bundle = await command('document.export', { documentId: 'doc1' });
  const documentFile = path.join(data, 'document.json'); await fs.writeFile(documentFile, JSON.stringify(bundle));
  const {root: domRoot} = await main.send('DOM.getDocument');
  const {nodeId: fileNode} = await main.send('DOM.querySelector', {nodeId:domRoot.nodeId,selector:'input[aria-label="选择图文档文件"]'});
  await main.send('DOM.setFileInputFiles',{nodeId:fileNode,files:[documentFile]});
  await until(async () => Object.keys((await snapshot()).graph.documents).length===2, 'sidebar import');
  assert.equal((await snapshot()).graph.canvases[0].childIds.length,2,'import only adds to library');
  assert.equal(await main.evaluate('!!document.querySelector("[data-layout-undo]")'), false);
  assert.equal(await main.evaluate('document.querySelectorAll("[data-app-error]").length'),0);
  console.log('PASS: sidebar import/export and layout undo absent');
  console.log('Desktop interaction artifacts: '+data);
} catch (error) {
  if (clients[0]) { console.error('UI failure state:', await clients[0].evaluate('({errors:JSON.parse(localStorage.getItem("qixue:ui-errors:v1")||"[]"),text:document.body.innerText.slice(0,1800)})').catch(()=>null)); }
  throw error;
} finally {
  clients.forEach(client => client.close());
  if (!exited) child.stdin.end('QIXUE_SHUTDOWN\n');
  await Promise.race([exit, delay(5000)]); if (!exited) child.kill();
}
