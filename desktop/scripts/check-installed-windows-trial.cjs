'use strict';
// Generated public fixture only. Real installed helper/OCR assets/backend;
// loopback mock understanding is explicitly labeled and never persisted as routes.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {randomBytes,createHash}=require('node:crypto');
const Module=require('node:module');
const asar=require('@electron/asar');
const {WindowsPublicWindowProvider}=require('../src/windows-public-window-provider.cjs');
const {PublicWindowController}=require('../src/public-window-controller.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const install=process.env.OPENBUTLER_TRIAL_INSTALL_DIR || path.join(process.env.LOCALAPPDATA,'Programs','OpenButlerWindowsTrial');
const resources=path.join(install,'resources');
const archive=path.join(resources,'app.asar');
const root=path.join(__dirname,'../../data/windows-native-evidence');
const profile=path.join(root,'installed-trial-profile-'+Date.now());
const helper=path.join(resources,'app.asar.unpacked/src/windows-public-window.exe');
async function freePort(){const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));return port;}
async function stopChild(child){if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),sleep(5000)]);}}
function installedOcr(){
  process.resourcesPath=resources;
  const filename=path.join(resources,'app.asar.unpacked/src/offline-ocr.cjs');
  const mod=new Module(filename,module);mod.filename=filename;
  mod.paths=Module._nodeModulePaths(path.join(resources,'app.asar.unpacked/src'));
  mod._compile(asar.extractFile(archive,'src/offline-ocr.cjs').toString(),filename);
  return mod.exports.createOfflineOcr();
}
(async()=>{
  fs.mkdirSync(root,{recursive:true});assert.equal(fs.existsSync(profile),false,'A new owned trial profile is required.');
  fs.mkdirSync(profile);
  const metadata=JSON.parse(asar.extractFile(archive,'package.json'));
  assert.equal(metadata.productName,'OpenButler Preview Windows Trial');assert.equal(metadata.version,'0.2.0-preview.20261002.3');
  for(const name of ['public-window-controller.cjs','public-window-provider.cjs','windows-public-window-provider.cjs','capture-controller.cjs'])
    assert.equal(sha(asar.extractFile(archive,'src/'+name)),sha(fs.readFileSync(path.join(__dirname,'../src',name))));
  let calls=0;
  const mock=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;if(body.length>2*1024*1024)req.destroy();});
    req.on('end',()=>{
      if(req.url!='/api/chat'){res.writeHead(404);res.end();return;}
      const request=JSON.parse(body);calls++;
      const structured=typeof request.format==='object'&&request.format?.properties?.title;
      const isImage=Boolean(request.messages?.[0]?.images);
      const content=structured?JSON.stringify({title:'[MOCK] Public window test',summary:'MOCK interpretation of synthetic public text; the shopping line was masked.',
        boundary:'Mock understanding, real Windows capture and offline OCR.',comparison:{performed:false,prior_observation_ids:[],current_quote:'',prior_quote:''}}):(isImage?'TEST 42':'READY');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:request.model,message:{role:'assistant',content},done:true,done_reason:'stop'}));
    });
  });
  mock.listen(0,'127.0.0.1');await once(mock,'listening');
  const endpoint='http://127.0.0.1:'+mock.address().port;
  const port=await freePort(),token=randomBytes(32).toString('hex'),base='http://127.0.0.1:'+port;
  const backend=spawn(path.join(resources,'backend/openbutler-backend-windows-trial.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,
    OPENBUTLER_DESKTOP:'1',OPENBUTLER_PREVIEW_BUILTIN:'1',OPENBUTLER_SESSION_TOKEN:token,OPENBUTLER_PORT:String(port),
    OPENBUTLER_DATA_DIR:path.join(profile,'data'),OPENBUTLER_DEFAULT_PRIVACY_MODE:'strict',OPENBUTLER_DISABLE_SEED_EVENTS:'1',
    OPENBUTLER_EXTERNAL_MODEL_ALLOWED:'0',OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED:'0'}});
  const api=async(route,body)=>{
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-OpenButler-Session':token},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('trial_api_'+response.status+'_'+route);return response.json();
  };
  const provider=new WindowsPublicWindowProvider({helperPath:helper});let fixture,controller,ocr;
  try{
    let healthy=false;for(let i=0;i<120&&!healthy;i++){await sleep(250);try{healthy=(await api('/health')).ok===true;}catch{}}
    assert.equal(healthy,true);
    assert.equal((await api('/api/context-engine/observations')).count,0);
    const models=await api('/api/model_settings/update',{image:{mode:'local',protocol:'ollama_native',endpoint,model:'mock-image'},text:{mode:'local',protocol:'ollama_native',endpoint,model:'mock-text'},external_consent:false,masked_data_consent:false});
    assert.equal(models.ok,true);assert.equal(models.ready,true);
    fixture=spawn(helper,['--fixture'],{stdio:['pipe','ignore','ignore'],windowsHide:false});
    let source;for(let i=0;i<30&&!source;i++){await sleep(150);source=(await provider.listSources()).find(s=>s.source_identity.owner_pid===fixture.pid&&s.label==='OpenButler public synthetic integration');}
    assert.ok(source);
    ocr=installedOcr();
    controller=new PublicWindowController({provider,ocr,
      configureBackend:body=>api('/api/context-engine/capture/configure',body),startBackendCapture:()=>api('/api/context-engine/capture/start',{}),
      pauseBackendCapture:()=>api('/api/context-engine/capture/pause',{}),postObservation:body=>api('/api/context-engine/observations',body)});
    const config={capture_scope:'dedicated_public_window',display_id:source.id,source_identity:source.source_identity,excluded_apps:['password-manager','credential-vault'],masks:[{x:0,y:46,width:400,height:20}],confirmed:true,
      interval_seconds:10,session_duration_seconds:60,observation_mode:'masked_ocr_text'};
    const preview=await controller.previewMasked(config);assert.ok(preview.post_mask_ocr_text.trim());assert.equal(preview.post_mask_ocr_text.includes('Shopping:'),false);
    fs.writeFileSync(path.join(root,'Trial-installed-masked-preview.png'),Buffer.from(preview.previewDataUrl.split(',')[1],'base64'));
    await controller.start(config);
    let record;for(let i=0;i<100&&!record;i++){await sleep(200);const rows=await api('/api/context-engine/observations');record=rows.items.find(row=>row.state==='ready');}
    assert.ok(record,controller.lastResult);assert.ok(record.title.startsWith('[MOCK]'));
    assert.equal(record.provenance.capture_method,'windows_wgc_hwnd');assert.equal(record.extraction_version,2);
    const response=await fetch(base+'/api/context-engine/evidence/'+record.evidence_id,{headers:{'X-OpenButler-Session':token}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    const evidence=Buffer.from(await response.arrayBuffer());assert.equal(sha(evidence),record.current_facts.image_digest);
    fs.writeFileSync(path.join(root,'Trial-installed-opened-evidence.png'),evidence);
    await controller.pause('trial_validation_completed');
    const state=await api('/api/context-engine/status');assert.equal(state.recording.active,false);
    const result={status:'passed',version:metadata.version,install,profile,installed_helper_sha256:sha(fs.readFileSync(helper)),
      installed_backend_sha256:sha(fs.readFileSync(path.join(resources,'backend/openbutler-backend-windows-trial.exe'))),
      model_understanding:'loopback HTTP mock only, explicitly labeled [MOCK]; real semantic quality not accepted',mock_calls:calls,
      automatic_recording:true,paused:true,evidence_opened_authenticated:true,evidence_sha256:sha(evidence),record,
      controller_code:'byte-identical to installed archive',ocr_assets:'installed app.asar.unpacked and installed resource language files',no_raw_files:true};
    fs.writeFileSync(path.join(root,'installed-runtime-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({status:'passed',version:metadata.version,record_id:record.id,evidence_opened:true,paused:true,model_understanding:'MOCK ONLY'}));
  }finally{
    if(controller)await controller.pause('trial_cleanup').catch(()=>{});provider.close();if(ocr)await ocr.dispose();await stopChild(fixture);await stopChild(backend);await new Promise(resolve=>mock.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
