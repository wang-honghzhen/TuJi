import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import tailwindConfig from '../tailwind.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const cache = path.join(root, '.cache'); await fs.mkdir(cache, { recursive: true });
const temporary = await fs.mkdtemp(path.join(cache, 'notebook-workflows-ui-'));
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { useAiStore } from './src/ai/client'; import { usePanelState } from './src/desktop/panelState';
import './src/desktop/companion.css'; import './src/ai/ui/notebook.css';
import { UserNotebook } from './src/ai/ui/UserNotebook';
import './src/new/new-ui.css'; import './src/new/space-theme.css';
const command=async(action,payload)=>{const reply=await window.noteTest.command(action,payload);useAiStore.setState({snapshot:reply.snapshot});if(reply.error)throw Error(reply.error);return reply.result;};
window.fixture={command, state:()=>useAiStore.getState().snapshot, reader:(directoryId,pageId)=>usePanelState.setState({activeTab:'reader',noteTabs:[{id:'reader',kind:'pages',directoryId,pageId}]}),global:()=>usePanelState.setState({activeTab:'notebook'})};
function App(){const tab=usePanelState(s=>s.activeTab);return <UserNotebook key={tab} tabId={tab}/>;}
window.noteTest.command('snapshot').then(reply=>{useAiStore.setState({snapshot:reply.snapshot,command});usePanelState.setState({host:'main',activeTab:'notebook',notePageId:'first'});createRoot(document.getElementById('root')).render(<App/>);});
`;
const server = `export { Repository } from './src/ai/server/repository'; export { userNotebookCommand } from './src/ai/server/userNotebook';`;
await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, sourcefile: 'notebook-workflows-fixture.tsx', loader: 'tsx' }, outfile: path.join(temporary, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') } });
await build({ absWorkingDir: root, stdin: { contents: server, resolveDir: root, sourcefile: 'notebook-workflows-server.ts', loader: 'ts' }, outfile: path.join(temporary, 'server.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') }, external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const cssPath = path.join(temporary, 'fixture.css');
const themed = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(await fs.readFile(cssPath, 'utf8'), { from: cssPath });
await fs.writeFile(cssPath, themed.css);
await fs.writeFile(path.join(temporary, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><style>#root{height:100vh;display:flex}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
await fs.writeFile(path.join(temporary, 'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('noteTest',{command:(action,payload)=>ipcRenderer.invoke('note-test-command',action,payload)});");
const main = `
const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Repository,userNotebookCommand}=require('./server.cjs');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});app.commandLine.appendSwitch('disable-gpu');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
const repo=new Repository(':memory:');const stamp='2026-11-17T00:00:00Z';
repo.transaction(s=>{s.userNoteDirectories=[{id:'a',name:'项目资料',createdAt:stamp,updatedAt:stamp},{id:'b',name:'阅读摘录',createdAt:stamp,updatedAt:stamp}];s.userNotePages=[{id:'first',text:'这是待整理的笔记。',version:1,createdAt:stamp,updatedAt:stamp},{id:'second',text:'项目资料原有页',directoryId:'a',version:1,createdAt:stamp,updatedAt:stamp},{id:'third',text:'阅读摘录原有页',directoryId:'b',version:1,createdAt:stamp,updatedAt:stamp}];});
ipcMain.handle('note-test-command',(_,action,payload)=>{try{return {result:action==='snapshot'?null:userNotebookCommand(repo,action,payload||{}),snapshot:repo.publicSnapshot()};}catch(error){return {error:error.message,snapshot:repo.publicSnapshot()};}});
const w=new BrowserWindow({show:false,width:620,height:700,webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
const evaluate=expression=>w.webContents.executeJavaScript(expression,true);
const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out: '+label);};
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
const button=(text,scope='document')=>evaluate('[...'+scope+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');
const input=async(selector,text)=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').focus();document.querySelector('+JSON.stringify(selector)+').select()');w.webContents.insertText(text);await delay(100);};
const screenshot=async(name)=>{await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await delay(200);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
const openTransfer=async()=>{await click('[aria-label="笔记页操作"]');await button('将此页添加到...');await until('!!document.querySelector("[aria-label=选择目标目录]")','directory picker');};
const noDialog=()=>until('!document.querySelector("[aria-modal=true]")','dialog closed');
try{
 await w.loadFile(${JSON.stringify(path.join(temporary, 'index.html'))});await until('!!document.querySelector("[data-user-notebook-page]")','notebook');
 assert.match(await evaluate('document.querySelector(".paper-page-counter").textContent'),/第 1\\/ 3 页/);
 assert.equal(await evaluate('document.querySelector(".note-page-location").textContent'),'未分类');
 assert.equal(await evaluate('document.body.innerText.includes("Ctrl+V 粘贴图片")'),false);
 await screenshot('notebook-footer');
 await openTransfer();await screenshot('directory-picker');await button('项目资料');await button('添加到此目录');await noDialog();
 assert.equal(repo.state.userNotePages[0].directoryId,'a');assert.deepEqual(repo.state.userNoteDirectories[0].pageIds,['second','first']);
 await openTransfer();await button('阅读摘录');await button('添加到此目录');await until('!!document.querySelector(".note-transfer-choice")','copy or move choice');
 await screenshot('move-or-copy');await button('复制一份');await noDialog();
 assert.equal(repo.state.userNotePages.length,4);assert.equal(repo.state.userNotePages[0].directoryId,'a');assert.equal(repo.state.userNotePages[3].text,repo.state.userNotePages[0].text);
 await openTransfer();await button('阅读摘录');await button('添加到此目录');await until('!!document.querySelector(".note-transfer-choice")','move choice');await button('迁移到此目录');await noDialog();
 assert.equal(repo.state.userNotePages[0].directoryId,'b');assert.deepEqual(repo.state.userNoteDirectories[1].pageIds,['third',repo.state.userNotePages[3].id,'first']);
 await evaluate('window.fixture.reader("b","first")');await until('!!document.querySelector(".note-address")','directory reader');
 await click('[aria-label="笔记页操作"]');await button('改变当前页顺序');await until('!!document.querySelector(".note-reorder-dialog")','reorder dialog');await screenshot('reorder-dialog');
 await button('确认顺序');await noDialog();assert.deepEqual(repo.state.userNoteDirectories[1].pageIds,['first','third',repo.state.userNotePages[3].id]);
 assert.equal(await evaluate('document.querySelector("[data-user-notebook-page]").dataset.userNotebookPage'),'first');
 await click('[aria-label="笔记页操作"]');await button('改变当前页顺序');await until('!!document.querySelector(".note-reorder-dialog")','reorder again');
 await evaluate('window.fixture.command("userNote.create",{directoryId:"b"})');await until('document.querySelector(".note-reorder-dialog").innerText.includes("页号已发生变化")','stale order');
 assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="确认顺序").disabled'),true);
 await button('刷新页号并重新选择');await input('[aria-label="调整顺序的参考页号"]','4');
 await evaluate('(()=>{const s=document.querySelector("[aria-label=放在参考页前面或后面]");s.value="after";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await button('确认顺序');await noDialog();assert.equal(repo.state.userNoteDirectories[1].pageIds.at(-1),'first');
 await evaluate('window.fixture.global()');await until('!!document.querySelector(".note-library-title")','all notes');
 await openTransfer();await button('新建目录');await input('[aria-label="新目录名称"]','新的资料夹');await button('创建');
 await until('document.querySelector(".note-dialog-path").textContent.includes("新的资料夹")','new folder selected');
 w.setSize(360,620);await delay(200);await screenshot('narrow-picker');
 assert.equal(await evaluate('(()=>{const r=document.querySelector(".note-dialog").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'),true);
 await button('添加到此目录');await until('!!document.querySelector(".note-transfer-choice")','narrow confirmation');await screenshot('narrow-confirmation');
 await button('迁移到此目录');await noDialog();assert.equal(repo.state.userNotePages[0].directoryId,repo.state.userNoteDirectories.find(d=>d.name==='新的资料夹').id);
 await screenshot('narrow-notebook');
 console.log('PASS: real themed notebook UI and backend transfer/copy/move, folder creation, original-page reorder, stale order refresh, current page retention, footer and 360 px viewport');
 repo.close();app.exit(0);
}catch(error){console.error(error.stack);console.error(await evaluate('document.body.innerText').catch(()=>''));repo.close();app.exit(1);}
});`;
await fs.writeFile(path.join(temporary, 'main.cjs'), main);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(temporary, 'main.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stdout.on('data', bytes => process.stdout.write(bytes)); child.stderr.on('data', bytes => { stderr += bytes; });
const timeout = setTimeout(() => child.kill(), 45000);
try { const [code] = await once(child, 'exit'); if (code !== 0) throw new Error('Notebook UI test failed: ' + stderr); console.log('Screenshots: ' + temporary); }
finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
