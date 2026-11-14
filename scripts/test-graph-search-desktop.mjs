import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

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


const data = await fs.mkdtemp(path.join(root, '.cache', 'graph-search-ui-'));
const seedFile=path.join(data,'seed.cjs');
await build({entryPoints:['scripts/graph-search-ui-fixture.ts'],outfile:seedFile,bundle:true,platform:'node',format:'cjs',target:'node24',alias:{'@':path.join(root,'src')}});
(await import(pathToFileURL(seedFile).href)).seedGraphSearchReview(data);
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
  await command('settings.save',{ provider:{baseUrl:'http://127.0.0.1:9/v1'},credential:'graph-search-offline-test'});
  await until(() => main.evaluate('Boolean(document.querySelector("[data-canvas-viewport]"))'), 'canvas ready');
  const initial = await snapshot(), canvasId = initial.graph.canvases.find(c=>c.isDraft).canvasId;
  const mutate = async operation => command('graph.mutate',{canvasId,command:operation,operationId:'search-test-'+crypto.randomUUID(),expectedGraphRevision:(await snapshot()).graphRevision});
  const folder=(await mutate({type:'createSubgraph',parentId:canvasId,name:'课程资料',content:'研究目录'})).id;
  const a=(await mutate({type:'createNode',parentId:folder,name:'向量起点',content:'需要检索的隐藏正文 searchneedle'})).id;
  const b=(await mutate({type:'createNode',parentId:canvasId,name:'计算终点',content:'计算结果'})).id;
  const edge=(await mutate({type:'createEdge',input:{sourceNodeId:a,targetNodeId:b,directed:true,edgeContent:'跨区域关系 relationneedle'}})).id;
  await mutate({type:'moveBlock',id:b,parentId:canvasId,point:{x:1600,y:700}});
  await mutate({type:'toggleCollapse',id:folder});
  await mutate({type:'createDocument',name:'线性代数学习'});
  await mutate({type:'createDocument',name:'其他学习资料'});
  await until(()=>main.evaluate('Boolean(document.querySelector("[data-canvas-search-toggle]"))'),'search button');
  const input=async(selector,text)=>{
    await main.evaluate('document.querySelector('+JSON.stringify(selector)+').focus();document.querySelector('+JSON.stringify(selector)+').select()');
    await main.send('Input.insertText',{text});
  };
  await click(main,'[data-canvas-search-toggle]');
  await input('.canvas-search input','searchneedle');
  await until(()=>main.evaluate('document.querySelectorAll("[data-canvas-search-result]").length === 1'),'node result');
  assert.match(await main.evaluate('document.querySelector("[data-canvas-search-result]").innerText'),/课程资料/);
  await capture('main','graph-search-node-results');
  await click(main,'[data-canvas-search-result]');
  await until(()=>main.evaluate('document.querySelector("[data-canvas-viewport]").dataset.selectedId === '+JSON.stringify(a)),'node selection');
  await until(()=>main.evaluate('document.querySelector("[data-region-id=\\"'+folder+'\\"]")?.dataset.regionCollapsed === "false"'),'reveal ancestor');
  await click(main,'[data-canvas-search-toggle]');
  await input('.canvas-search input','relationneedle');
  await until(()=>main.evaluate('document.querySelectorAll("[data-canvas-search-result]").length === 1'),'edge result');
  assert.match(await main.evaluate('document.querySelector("[data-canvas-search-result]").innerText'),/向量起点 → 计算终点/);
  await capture('main','graph-search-edge-results');
  await main.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await main.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>main.evaluate('document.querySelector("[data-canvas-viewport]").dataset.selectedId === '+JSON.stringify(edge)),'edge selection');
  await capture('main','graph-search-edge-located');
  await click(main,'[data-directory-tab="left"]');
  await input('[data-canvas-directory] input[type=search]','searchneedle');
  await until(()=>main.evaluate('document.querySelectorAll("[data-directory-search-result]").length === 1'),'directory result');
  assert.match(await main.evaluate('document.querySelector("[data-directory-search-result]").innerText'),/课程资料/);
  await click(main,'[data-document-tab]');
  await input('[data-document-library] input[type=search]','线性');
  await until(()=>main.evaluate('document.querySelectorAll("[data-library-document]").length === 1'),'filtered document');
  await capture('main','graph-search-directory-document');
  await main.evaluate('[...document.querySelectorAll("[data-document-library] .graph-search-filters button")].find(b=>b.textContent==="待审核提交").click()');
  assert.match(await main.evaluate('document.querySelector(".pending-search-results").innerText'),/没有匹配的待审核提交/);
  await input('[data-document-library] input[type=search]','待审核');
  await until(()=>main.evaluate('document.querySelectorAll("[data-pending-search-result]").length === 1'),'pending result');
  await capture('main','graph-search-pending-result');
  await click(main,'[data-pending-search-result]');
  await until(()=>main.evaluate('Boolean(document.querySelector("[data-review-unit=search-review-unit]"))'),'review result navigation');
  assert.equal(await main.evaluate('document.querySelector("[data-review-unit=search-review-unit] input").checked'),true);
  await capture('main','graph-search-pending-located');
  // Verify keyboard exit from controls, and a wrapped toolbar in a narrow window.
  await inspector.evaluate('mainWindow.setBounds({width:960,height:700}); true');
  await click(main,'[data-canvas-search-toggle]');
  await until(()=>main.evaluate('Boolean(document.querySelector(".canvas-search-popover"))'),'narrow search popover');
  const geometry=await main.evaluate('(()=>{const p=document.querySelector(".canvas-search-popover").getBoundingClientRect(),t=document.querySelector("[data-canvas-search-toggle]").getBoundingClientRect();return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,tw:t.right,width:innerWidth,height:innerHeight};})()');
  assert.ok(geometry.left>=0 && geometry.right<=geometry.width,JSON.stringify(geometry));
  assert.ok(geometry.top>=0 && geometry.bottom<=geometry.height,JSON.stringify(geometry));
  assert.ok(geometry.tw<=geometry.width,JSON.stringify(geometry));
  await capture('main','graph-search-narrow');
  await main.evaluate('document.querySelector(".canvas-search .graph-search-filters button").focus()');
  await main.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await main.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await main.evaluate('Boolean(document.querySelector(".canvas-search-popover"))'),false);
  assert.equal(await main.evaluate('document.activeElement === document.querySelector("[data-canvas-search-toggle]")'),true);
  console.log('PASS: graph search results, full paths, collapsed-node reveal, keyboard edge locate, directory search, document filtering and pending-review navigation.');
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
