import {execFile,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {buildAiRuntime,projectRoot} from './build-ai.mjs';
import {resolveDataDirectory,storageSettingsPath} from '../desktop/data-directory.mjs';

const run=promisify(execFile),require=createRequire(import.meta.url);
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const lower=p=>path.normalize(p).toLowerCase();
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const electron=require('electron');
const workspaceEntry=path.join(projectRoot,'desktop/workspace-entry.mjs');

export async function resolveInstalledExecutable() {
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "Get-ItemPropertyValue -LiteralPath 'HKCU:\\Software\\24c6bb45-3a6e-50a1-98ed-cf3ea2c31cd7' -Name InstallLocation -ErrorAction Stop",
  ].join('; ');
  try {
    const {stdout} = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true});
    const directory = stdout.trim();
    if (!path.isAbsolute(directory)) throw new Error('安装目录无效');
    const executable = path.join(directory, 'Tuji.exe');
    await access(executable);
    return executable;
  } catch (cause) {
    throw new Error('找不到当前 Windows 用户安装的图记。请先安装正式版，再使用工作区快捷方式。', {cause});
  }
}

// Query just the owner PID. Do not fetch graph records, credentials, or the token.
export function ownerPid(database){
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    const metadata=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    if(!metadata)return null;
    const pid=db.prepare("SELECT json_extract(body,'$.pid') AS pid FROM metadata WHERE key='runtime_owner'").get()?.pid;
    return Number.isSafeInteger(pid)&&pid>0?pid:null;
  }finally{db.close();}
}
function alive(pid){
  if(!pid)return false;
  try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
}
async function processInfo(pid){
  if(!alive(pid))return null;
  const script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$env:TUJI_QUERY_PID);if($p){[pscustomobject]@{exe=$p.ExecutablePath;args=$p.CommandLine}|ConvertTo-Json -Compress}";
  const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,env:{...process.env,TUJI_QUERY_PID:String(pid)}});
  return stdout.trim()?JSON.parse(stdout.trim()):null;
}
// Named pipes disappear with their owning process. Double clicks serialize
// even if the first launch is waiting for an editor to finish saving.
async function withLaunchLock(database,action){
  const pipe='\\\\.\\pipe\\tuji-workspace-'+digest(lower(database)).slice(0,32);
  const until=Date.now()+100000;
  for(;;){
    const lock=createServer(c=>c.end());
    try{
      await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(pipe,resolve);});
    }catch(e){
      if(e.code!=='EADDRINUSE'||Date.now()>=until)throw e;
      await delay(200);continue;
    }
    try{return await action();}finally{await new Promise(resolve=>lock.close(resolve));}
  }
}
async function buildWorkspace(cache){
  const builds=path.join(cache,'builds');
  await mkdir(builds,{recursive:true});
  const staging=await mkdtemp(path.join(builds,'building-'));
  try{
    await buildAiRuntime(staging);
    const inputs=['package-lock.json','vite.config.ts','scripts/credential-storage.mjs','scripts/build-ai.mjs'];
    for(const name of (await readdir(path.join(projectRoot,'desktop'))).sort()){
      if(/\.(mjs|cjs|json)$/.test(name))inputs.push('desktop/'+name);
    }
    const hash=createHash('sha256');
    for(const name of inputs){hash.update(name);hash.update(await readFile(path.join(projectRoot,name)));}
    const artifacts={};
    for(const name of ['server.cjs','layout-worker.cjs']){
      artifacts[name]=digest(await readFile(path.join(staging,name)));hash.update(artifacts[name]);
    }
    const version=hash.digest('hex'),directory=path.join(builds,version);
    try{await rename(staging,directory);}
    catch(e){
      if(!['ENOTEMPTY','EEXIST','EPERM','EACCES'].includes(e.code))throw e;
      for(const [name,expected] of Object.entries(artifacts)){
        if(digest(await readFile(path.join(directory,name)))!==expected)throw Error('已缓存的运行模块校验失败。');
      }
    }
    return {version,directory,artifacts};
  }finally{
    // Only the fresh mkdtemp directory returned to this invocation is removed.
    await rm(staging,{recursive:true,force:true});
  }
}
async function start(exe,args,env){
  // Electron is a GUI executable. SW_HIDE on its first ShowWindow call would
  // suppress the actual desktop window even after the renderer is connected.
  const child=spawn(exe,args,{cwd:projectRoot,env,stdio:'ignore',detached:true,windowsHide:args.includes('--quit')});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  return child.pid;
}
export async function launchWorkspace({appData=process.env.APPDATA,installedExe,
  installedArgs=[],entry=workspaceEntry,cache=path.join(projectRoot,'.cache/workspace-desktop')}={}){
  installedExe ??= await resolveInstalledExecutable();
  const configured=async()=>{
    await access(storageSettingsPath(appData));
    return realpath(resolveDataDirectory({appData,installDirectory:path.dirname(installedExe),projectRoot,packaged:true}));
  };
  const directory=await configured();
  const database=await realpath(path.join(directory,'qixue.sqlite'));
  const identity=async()=>{const s=await stat(database,{bigint:true});return String(s.dev)+':'+String(s.ino);};
  return withLaunchLock(database,async()=>{
    const fileId=await identity(),runtime=await buildWorkspace(cache);
    if(lower(await configured())!==lower(directory)||await identity()!==fileId)throw Error('构建期间存储位置已变更。请重新打开工作区快捷方式。');
    const receipts=path.join(cache,'receipts');
    await mkdir(receipts,{recursive:true});
    let ocr=path.join(path.dirname(installedExe),'resources','ocr');
    try{await access(path.join(ocr,'chi_sim.traineddata'));}
    catch{ocr=path.join(projectRoot,'.cache/desktop/ocr');}
    for(const name of ['chi_sim','eng'])await access(path.join(ocr,name+'.traineddata'));
    const env={...process.env,QIXUE_DATA_DIR:directory,QIXUE_USE_VITE:'1',QIXUE_PORT:'0',
      QIXUE_OCR_DATA_DIR:ocr,
      TUJI_WORKSPACE_RUNTIME:runtime.directory,TUJI_WORKSPACE_RECEIPTS:receipts};
    delete env.ELECTRON_RUN_AS_NODE;
    const installedEnv={...process.env,QIXUE_DATA_DIR:directory};
    delete installedEnv.ELECTRON_RUN_AS_NODE;
    const marker='--tuji-build='+runtime.version;
    const identify=async pid=>{
      const current=await processInfo(pid);
      if(!current)return null;
      const workspace=current.exe&&lower(current.exe)===lower(electron)&&current.args?.toLowerCase().includes(lower(entry));
      const installed=current.exe&&lower(current.exe)===lower(installedExe)&&
        installedArgs.every(arg=>current.args?.toLowerCase().includes(arg.toLowerCase()));
      if(!workspace&&!installed)throw Error('数据目录已由另一个本地服务使用。请先从该服务正常退出。');
      return {pid,workspace,correct:workspace&&current.args.includes(marker)};
    };
    let stoppedInstalled=false;
    const stop=async target=>{
      await start(target.workspace?electron:installedExe,[...(target.workspace?[entry]:installedArgs),'--quit'],target.workspace?env:installedEnv);
      const until=Date.now()+55000;
      while(alive(target.pid)&&Date.now()<until)await delay(180);
      if(alive(target.pid))throw Error('原窗口还在保存或等待处理。请查看原窗口，完成保存后再点快捷方式。');
      if(!target.workspace)stoppedInstalled=true;
    };
    let target=await identify(ownerPid(database));
    if(target&&!target.correct)await stop(target);
    let action=target?(target.correct?'activated':'switched'):'started';
    try{
      const request=randomUUID(),file=path.join(receipts,request+'.json');
      const show=()=>start(electron,[entry,marker,'--tuji-request='+request],env);
      let sentTo=await show();
      let until=Date.now()+62000;
      const checked=new Set([sentTo,target?.pid]);
      let nextCheck=Date.now()+1500;
      while(Date.now()<until){
        let receipt;
        try{receipt=JSON.parse(await readFile(file,'utf8'));}
        catch(e){if(e.code!=='ENOENT')throw e;}
        if(receipt){
          if(ownerPid(database)!==receipt.pid||await identity()!==fileId||lower(await configured())!==lower(directory)||lower(receipt.runtime)!==lower(runtime.directory))
            throw Error('当前桌面窗口的数据目录或构建版本与启动请求不一致。');
          return {action,database,fileId,build:runtime.version,artifacts:runtime.artifacts,...receipt};
        }
        if(Date.now()>=nextCheck){
          nextCheck=Date.now()+1500;
          // An ordinary click can win the Electron lock before its server
          // has claimed SQLite. Once the owner is identifiable, hand off normally.
          const owner=ownerPid(database);
          if(owner&&!checked.has(owner)){
            checked.add(owner);
            target=await identify(owner);
            if(target){
              if(!target.correct){await stop(target);action='switched';}
              sentTo=await show();checked.add(sentTo);until=Date.now()+62000;
            }
          }
        }
        await delay(180);
      }
      throw Error('工作区窗口未在时限内就绪。请查看桌面错误提示或再次使用快捷方式。');
    }catch(e){
      if(stoppedInstalled&&!alive(ownerPid(database)))await start(installedExe,installedArgs,installedEnv);
      throw e;
    }
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await launchWorkspace();
    console.log(JSON.stringify({action:result.action,pid:result.pid,build:result.build,fileId:result.fileId}));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
