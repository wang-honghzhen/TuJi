// Only the dedicated workspace shortcut uses this entry. The normal desktop
// main owns the window, save handshake, single-instance lock and database.
import { app } from 'electron';
import path from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

let main;
app.on('browser-window-created',(_event,window)=>{ main??=window; });
async function reportReady(argv){
  const request=argv.find(arg=>/^--tuji-request=[a-f0-9-]{36}$/.test(arg))?.slice(15);
  const directory=process.env.TUJI_WORKSPACE_RECEIPTS;
  if(!request||!directory)return;
  const started=Date.now(),deadline=started+60000;
  let lastStatus='';
  while(Date.now()<deadline){
    const hasWindow=Boolean(main&&!main.isDestroyed()),visible=Boolean(hasWindow&&main.isVisible());
    let ready=null;
    if(hasWindow&&/^http:\/\/127\.0\.0\.1:/.test(main.webContents.getURL())){
      ready=await main.webContents.executeJavaScript(`(async()=>{
        const client=await import('/src/ai/client.ts');
        const app=client.useAiStore.getState();
        const desktop=await window.tujiDesktop?.getState();
        return {desktop:window.tujiDesktop?.role==='main',
          foreground:desktop && !desktop.background && desktop.host!=='panel',
          source:performance.getEntriesByType('resource').some(r=>new URL(r.name).pathname==='/src/main.tsx'),
          mounted:!!document.querySelector('#root')?.childElementCount&&!document.querySelector('[data-app-error]'),
          connected:app.connection==='connected'&&!!app.snapshot};
      })()`).catch(()=>null);
      // The desktop activation handler may still be saving the detached editor.
      // A launch receipt observes the handoff without forcing either window.
      if(main.isVisible()&&!main.isMinimized()&&ready?.foreground&&ready.source&&ready.desktop&&ready.mounted&&ready.connected){
        const receipt=path.join(directory,request+'.json');
        await writeFile(receipt+'.tmp',JSON.stringify({...ready,pid:process.pid,port:new URL(main.webContents.getURL()).port,
          runtime:process.env.TUJI_WORKSPACE_RUNTIME}),{flag:'wx'});
        await rename(receipt+'.tmp',receipt);
        return;
      }
    }
    const status=JSON.stringify({pid:process.pid,hasWindow,visible,ready});
    if(status!==lastStatus){
      await writeFile(path.join(directory,request+'.status'),status);
      lastStatus=status;
    }
    await delay(160);
  }
}
app.on('second-instance',(_e,argv)=>{void reportReady(argv).catch(()=>{});});
await import('./main.mjs');
if(app.hasSingleInstanceLock())void reportReady(process.argv).catch(()=>{});
