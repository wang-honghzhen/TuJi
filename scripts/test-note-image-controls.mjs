import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const cache = path.join(root, '.cache'); await fs.mkdir(cache, { recursive: true });
const temporary = await fs.mkdtemp(path.join(cache, 'note-image-controls-'));
const preview = path.join(cache, 'note-image-controls-preview.png');
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { UserNoteEditor } from './src/ai/ui/UserNoteEditor';
const source = document.createElement('canvas'); source.width=400; source.height=200;
const c=source.getContext('2d'); c.fillStyle='#ad6453'; c.fillRect(0,0,200,200); c.fillStyle='#4059a6';c.fillRect(200,0,200,100);c.fillStyle='#4c9a73';c.fillRect(200,100,200,100);
const page={id:'saved-note',version:1,text:'保存后的图片',createdAt:'2026-11-17',updatedAt:'2026-11-17',blocks:[{id:'before',type:'text',text:'保存后的图片'}, {id:'region',type:'images',images:[{id:'picture',src:source.toDataURL(),x:12,y:12,width:200,height:200,rotation:90,crop:{left:.5,top:0,right:0,bottom:0}}]}, {id:'after',type:'text',text:'图片下方文字'}]};
window.fixture={saved:page,writes:[],fail:false,round:0};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async items=>{if(window.fixture.fail)throw Error('denied');const blob=await items[0].getType('image/png');const bitmap=await createImageBitmap(blob);window.fixture.writes.push({type:blob.type,width:bitmap.width,height:bitmap.height});bitmap.close();}}});
const root=createRoot(document.getElementById('root'));
window.fixture.mount=()=>root.render(<UserNoteEditor key={++window.fixture.round} page={structuredClone(window.fixture.saved)} label='测试笔记' save={async(blocks,version)=>{if(version!==window.fixture.saved.version)throw Error('version conflict');window.fixture.saved={...window.fixture.saved,blocks:structuredClone(blocks),version:version+1};return structuredClone(window.fixture.saved);}} uploadImage={async()=>{throw Error('unused');}} />);
window.fixture.mount();
`;
let child;
try {
  await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, sourcefile: 'note-image-fixture.tsx', loader: 'tsx' }, outfile: path.join(temporary, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') } });
  await fs.writeFile(path.join(temporary, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><style>*{box-sizing:border-box}body{margin:0;background:#e5ebe4;font-family:system-ui}button{cursor:pointer;background:transparent;color:inherit}#root{width:500px;margin:30px auto;background:#fff;padding:28px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const main = `
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});app.commandLine.appendSwitch('disable-gpu');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1000,height:760,webPreferences:{backgroundThrottling:false}});
const evaluate=expression=>w.webContents.executeJavaScript(expression,true);
const until=async(expression,label)=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Timed out: '+label);};
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
const key=(selector,key,extras={})=>evaluate('document.querySelector('+JSON.stringify(selector)+').dispatchEvent(new KeyboardEvent("keydown",'+JSON.stringify({key,bubbles:true,cancelable:true,...extras})+'))');
const select=async()=>{await evaluate('document.querySelector("[data-note-image]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:700,clientY:600}))');await until('!!document.querySelector("[role=menu]")','image menu');await key('[role=menu]','Escape');await delay(50);};
try {
 await w.loadFile(${JSON.stringify(path.join(temporary, 'index.html'))});
 await until('!!document.querySelector("[data-note-image] img")?.complete','saved picture render');
 await select(); assert.equal(await evaluate('document.querySelector("[data-note-image]").dataset.selected'),'true');
 assert.equal(await evaluate('document.querySelector("[aria-label=撤销笔记编辑]").disabled'),true,'selection should not add undo history');
 await click('[aria-label=查看图片]'); await until('!!document.querySelector(".user-note-preview-surface img")?.naturalWidth','edited preview');
 assert.deepEqual(await evaluate('(()=>{const i=document.querySelector(".user-note-preview-surface img");return [i.naturalWidth,i.naturalHeight]})()'),[200,200]);
 await evaluate('[...document.querySelectorAll(".user-note-preview-controls button")].find(b=>b.textContent==="原图").click()');
 await until('document.querySelector(".user-note-preview-surface img")?.naturalWidth===400','original preview');
 await click('[aria-label=放大图片]'); assert.equal(await evaluate('document.querySelector("[aria-label=图片缩放比例]").textContent'),'125%');
 await evaluate('[...document.querySelectorAll(".user-note-preview-controls button")].find(b=>b.textContent==="编辑效果").click()');
 await until('document.querySelector(".user-note-preview-surface img")?.naturalWidth===200','edited preview restored');
 await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); await delay(250); fs.writeFileSync(${JSON.stringify(preview)},(await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 await key('.user-note-image-preview','Escape'); await until('!document.querySelector(".user-note-image-preview")','preview close');
 await key('[data-note-image-region]','c',{ctrlKey:true}); await until('window.fixture.writes.length===1','keyboard copy');
 assert.deepEqual(await evaluate('window.fixture.writes[0]'),{type:'image/png',width:200,height:200});
 assert.equal(await evaluate('document.querySelectorAll("[data-note-image]").length'),1);
 assert.equal(await evaluate('(()=>{const t=document.querySelector("textarea");t.focus();const event=new KeyboardEvent("keydown",{key:"x",ctrlKey:true,bubbles:true,cancelable:true});t.dispatchEvent(event);return event.defaultPrevented;})()'),false,'text cut remains native');
 await select(); await evaluate('window.fixture.fail=true');await key('[data-note-image-region]','x',{ctrlKey:true});
 await until('!!document.querySelector(".user-note-image-message[data-error=true]")','clipboard failure feedback');
 assert.equal(await evaluate('document.querySelectorAll("[data-note-image]").length'),1,'failed cut retains image');
 await evaluate('window.fixture.fail=false');await key('[data-note-image-region]','x',{ctrlKey:true});
 await until('document.querySelectorAll("[data-note-image]").length===0','successful cut');
 await until('window.fixture.saved.blocks.every(b=>b.type!=="images")','cut autosave');
 await click('[aria-label=撤销笔记编辑]');await until('document.querySelectorAll("[data-note-image]").length===1','undo cut');
 await until('window.fixture.saved.blocks.some(b=>b.type==="images")','undo autosave');
 await evaluate('window.fixture.mount()');await until('!!document.querySelector("[data-note-image]")','reopen');await select();
 await evaluate('document.querySelector("[data-note-image]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}))');
 await until('!!document.querySelector(".user-note-preview-surface img")?.naturalWidth','double click saved image preview');
 await key('.user-note-image-preview','Escape'); await select();
 await evaluate('document.querySelector("[data-note-image]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:995,clientY:755}))');
 await until('!!document.querySelector("[role=menu]")','right click reopened image');
 assert.equal(await evaluate('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()'),true,'context menu stays in viewport');
 await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.includes("删除图片")).click()');
 await until('document.querySelectorAll("[data-note-image]").length===0','right menu delete');
 await until('window.fixture.saved.blocks.every(b=>b.type!=="images")','delete autosave');
 await click('[aria-label=撤销笔记编辑]');await until('document.querySelectorAll("[data-note-image]").length===1','undo delete');
 console.log('PASS: saved/reopened image menu, preview and original zoom, PNG keyboard copy, native text cut, failed/successful cut, autosave, undo, double click and viewport menu');
 app.exit(0);
}catch(error){console.error(error.stack);console.error(await evaluate('document.body.innerText').catch(()=>''));app.exit(1);}
});`;
  const mainFile = path.join(temporary, 'main.cjs'); await fs.writeFile(mainFile, main);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [mainFile], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stdout.on('data', bytes => process.stdout.write(bytes)); child.stderr.on('data', bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill(), 45000);
  const [code] = await once(child, 'exit'); clearTimeout(timeout);
  if (code !== 0) throw new Error('Notebook image UI test failed: ' + stderr);
  console.log('Preview: ' + preview);
} finally { if (child && child.exitCode === null) child.kill(); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
