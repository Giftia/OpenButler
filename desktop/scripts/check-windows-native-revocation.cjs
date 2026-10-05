'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {WindowsPublicWindowProvider}=require('../src/windows-public-window-provider.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const results=[];
  for(const action of ['title','move','resize','title_roundtrip','close']){
    const fixture=spawn(path.join(__dirname,'../src/windows-public-window.exe'),['--fixture'],{stdio:['pipe','ignore','ignore'],windowsHide:false});
    const provider=new WindowsPublicWindowProvider();
    try{
      let source;
      for(let i=0;i<20&&!source;i++){await sleep(150);source=(await provider.listSources()).find(v=>v.source_identity.owner_pid===fixture.pid&&v.label==='OpenButler public synthetic integration');}
      assert.ok(source);
      await assert.rejects(provider.bind({...source.source_identity,owner_process_start:String(BigInt(source.source_identity.owner_process_start)+1n)}),/window_source_unavailable/);
      await provider.bind(source.source_identity);await provider.prepareSource();
      const frame=await provider.acquireFrame();assert.equal(frame.capture_method,'windows_wgc_hwnd');frame.buffer.fill(0);
      fixture.stdin.write(action+'\n');await sleep(200);
      await assert.rejects(provider.inspect(),/window_source_unavailable/);
      await assert.rejects(provider.acquireFrame(),/window_source_unavailable/);
      results.push({action,status:'revoked',pixels_after_mutation:0});
    }finally{provider.close();fixture.stdin.end();fixture.kill();}
  }
  const root=path.join(__dirname,'../../data/windows-native-evidence');fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'native-revocation.json'),JSON.stringify({status:'passed',results,actual_os_lock:'not_exercised; WTS event registration required and polling failclosed'},null,2));
  console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1;});
