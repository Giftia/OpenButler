'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {WindowsPublicWindowProvider}=require('../src/windows-public-window-provider.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const install=process.env.OPENBUTLER_TRIAL_INSTALL_DIR || path.join(process.env.LOCALAPPDATA,'Programs','OpenButlerWindowsTrial');
const root=path.join(__dirname,'../../data/windows-native-evidence');
const profile=path.join(root,'installed-ui-profile-'+Date.now());
const smoke=path.join(profile,'smoke.json');
(async()=>{
 fs.mkdirSync(profile,{recursive:true});
 const app=spawn(path.join(install,'OpenButler Preview Windows Trial.exe'),[],{stdio:'ignore',windowsHide:false,env:{...process.env,OPENBUTLER_DESKTOP_USER_DATA_DIR:profile,OPENBUTLER_DESKTOP_SMOKE_FILE:smoke,OPENBUTLER_DESKTOP_SMOKE_QUIT_AFTER_MS:'14000'}});
 const provider=new WindowsPublicWindowProvider({helperPath:path.join(install,'resources/app.asar.unpacked/src/windows-public-window.exe')});
 try{
  let state;for(let i=0;i<120&&!state;i++){await sleep(250);if(fs.existsSync(smoke))state=JSON.parse(fs.readFileSync(smoke));}
  assert.ok(state);assert.equal(state.status,'loaded');assert.equal(state.hasDesktopBridge,true);assert.ok(state.rootChildren>0);assert.equal(state.previewVersion,'0.2.0-preview.20261002.3');
  const health=await fetch(state.apiBase+'/health').then(r=>r.json());assert.equal(health.ok,true);assert.equal(health.privacy_mode,'strict');
  await sleep(2500);
  const source=(await provider.listSources()).find(s=>s.source_identity.owner_pid===app.pid&&s.label.includes('OpenButler'));
  assert.ok(source,'Capture only the explicitly launched Trial PID');
  await provider.bind(source.source_identity);await provider.prepareSource();const frame=await provider.acquireFrame();
  assert.equal(frame.content_nonblack,true);fs.writeFileSync(path.join(root,'Trial-installed-UI.png'),frame.buffer);frame.buffer.fill(0);provider.close();
  for(let i=0;i<100&&app.exitCode===null;i++)await sleep(250);
  assert.equal(app.exitCode,0,'Trial must exit through its own quit path');await sleep(1500);
  const processes=spawnSync('powershell',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='openbutler-backend-windows-trial.exe'\").Count"],{encoding:'utf8',windowsHide:true});
  assert.equal(processes.status,0);assert.equal(Number(processes.stdout.trim()),0);
  const result={status:'passed',install,profile,version:state.previewVersion,rendered:true,desktop_bridge:true,loopback_health:health,ui_capture:'own Trial PID only',recording:'fresh profile; not started',exit_code:app.exitCode,trial_backends_after_exit:0};
  fs.writeFileSync(path.join(root,'installed-ui-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{provider.close();if(app.exitCode===null)app.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
