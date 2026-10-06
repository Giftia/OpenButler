'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {PNG} = require('pngjs');
const {WindowsPublicWindowProvider} = require('../src/windows-public-window-provider.cjs');
const {PublicWindowController} = require('../src/public-window-controller.cjs');
const {createOfflineOcr} = require('../src/offline-ocr.cjs');
const {sourceRevision} = require('../src/public-window-provider.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

(async () => {
  const helper = path.join(__dirname,'../src/windows-public-window.exe');
  const fixture = spawn(helper,['--fixture'],{stdio:'ignore',windowsHide:false});
  const provider = new WindowsPublicWindowProvider();
  let ocr,controller;
  const evidence = path.join(__dirname,'../../data/windows-native-evidence');
  fs.mkdirSync(evidence,{recursive:true});
  try {
    assert.equal(await provider.probe(),true);
    let source;
    for(let attempt=0;attempt<20&&!source;attempt++) {
      await sleep(150);
      source=(await provider.listSources()).find(value=>value.source_identity.owner_pid===fixture.pid
        && value.label==='OpenButler public synthetic integration');
    }
    assert.ok(source,'only the self-created public fixture may be selected');
    const config={capture_scope:'dedicated_public_window',display_id:source.id,source_identity:source.source_identity,
      excluded_apps:['password-manager','credential-vault'],masks:[{x:0,y:46,width:400,height:20}],
      interval_seconds:10,session_duration_seconds:60,observation_mode:'masked_ocr_text',confirmed:true};
    await provider.bind(source.source_identity);await provider.prepareSource();
    const frame=await provider.acquireFrame();
    assert.equal(frame.capture_method,'windows_wgc_hwnd');assert.equal(frame.content_nonblack,true);
    assert.equal(sourceRevision(frame.source_identity),sourceRevision(config.source_identity));
    frame.buffer.fill(0);
    ocr=await createOfflineOcr();
    const posts=[];let configured;
    controller=new PublicWindowController({provider,ocr,
      configureBackend:async body=>{configured=body;return {consent_revision:'12345678-1234-4234-8234-123456789012'};},
      startBackendCapture:async()=>({}),pauseBackendCapture:async()=>({}),
      postObservation:async body=>{posts.push(body);return {recorded:true};}});
    const preview=await controller.previewMasked(config);
    assert.equal(preview.lock_state,'unlocked');assert.equal(preview.lock_protection_supported,true);
    const masked=Buffer.from(preview.previewDataUrl.split(',')[1],'base64');
    const pixels=PNG.sync.read(masked);
    for(let y=46;y<66;y++)for(let x=0;x<400;x++)assert.deepEqual([...pixels.data.subarray((y*pixels.width+x)*4,(y*pixels.width+x)*4+3)],[0,0,0]);
    fs.writeFileSync(path.join(evidence,'Windows-public-window-masked-preview.png'),masked);
    assert.ok(preview.post_mask_ocr_text.trim());
    await controller.start(config);const captured=await controller.captureOnce();
    assert.equal(captured.recorded,true,JSON.stringify(captured));
    assert.equal(posts.length,1);assert.equal(posts[0].post_mask_ocr_complete,true);
    assert.equal(posts[0].post_mask_ocr_engine,'tesseract.js');
    fs.writeFileSync(path.join(evidence,'native-configure.json'),JSON.stringify(configured));
    fs.writeFileSync(path.join(evidence,'native-payload.json'),JSON.stringify(posts[0]));
    const result={status:'passed',capture_method:'windows_wgc_hwnd',identity:source.source_identity,
      raw_pixels_written:false,masked_regions:preview.maskedRegions,post_mask_ocr:preview.post_mask_ocr_text,
      post_mask_ocr_image_digest:posts[0].post_mask_ocr_image_digest,
      model_route:'not_called; local OCR only',native_window:'self-created public fixture',timeline_backend:'pending separate validation'};
    await controller.pause('native_test_completed');
    await assert.rejects(provider.acquireFrame(),/window_source_unavailable/);
    fs.writeFileSync(path.join(evidence,'native-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {
    if(controller)await controller.pause('native_test_cleanup').catch(()=>{});
    provider.close();if(ocr)await ocr.dispose();fixture.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
