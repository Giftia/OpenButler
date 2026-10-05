'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PNG}=require('pngjs');
const {bmpToPng}=require('../src/windows-public-window-provider.cjs');
const {checkedIdentity,sourceRevision}=require('../src/public-window-provider.cjs');
const {PublicWindowController}=require('../src/public-window-controller.cjs');
const identity={window_id:'hwnd:123',owner_pid:456,owner_process_start:'789',owner_process_name:'fixture.exe',
  wm_class:'publicFixture',window_title:'Public fixture',content_bounds:{x:1,y:2,width:2,height:2}};
function bmp(){const b=Buffer.alloc(70,255);b.write('BM');b.writeUInt32LE(70,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);b.writeInt32LE(2,18);b.writeInt32LE(-2,22);b.writeUInt16LE(1,26);b.writeUInt16LE(32,28);b.writeUInt32LE(0,30);return b;}
test('HWND strict identity and every binding field changes revision',()=>{
  assert.equal(checkedIdentity(identity).window_id,'hwnd:123');
  for(const key of ['window_id','owner_pid','owner_process_start','owner_process_name','wm_class','window_title','content_bounds']){
    const changed=structuredClone(identity);changed[key]=key==='content_bounds'?{...identity.content_bounds,width:3}:key==='owner_pid'?457:key==='window_id'?'hwnd:124':String(changed[key])+'1';
    assert.notEqual(sourceRevision(changed),sourceRevision(identity));
  }
  assert.throws(()=>checkedIdentity({...identity,window_id:'screen:1'}),/invalid_window_identity/);
});
test('BMP conversion preserves dimensions and wipes input; invalid ContentSize cannot be cropped',()=>{
  const raw=bmp();const result=bmpToPng(raw,identity);assert.equal(PNG.sync.read(result.buffer).width,2);assert.ok(raw.every(x=>x===0));
  const wrong=bmp();wrong.writeInt32LE(3,18);assert.throws(()=>bmpToPng(wrong,identity),/invalid_source_frame/);assert.ok(wrong.every(x=>x===0));
});
for(const lock of ['unknown','locked'])test(`Windows ${lock} lock state obtains zero pixels`,async()=>{
  let acquired=0;
  const provider={bind:async()=>{},close:()=>{},prepareSource:async()=>{},inspect:async()=>({source_identity:identity,foreground_identity:identity,lock_state:lock,lock_protection_supported:true}),acquireFrame:async()=>{acquired++;}};
  const controller=new PublicWindowController({provider,ocr:{recognize:async()=>{}},configureBackend:async()=>{},startBackendCapture:async()=>{},pauseBackendCapture:async()=>{},postObservation:async()=>{}});
  await assert.rejects(controller.previewMasked({capture_scope:'dedicated_public_window',display_id:identity.window_id,source_identity:identity,excluded_apps:['vault'],masks:[],confirmed:true}),/invalid_public_window_capabilities/);
  assert.equal(acquired,0);assert.equal(controller.preview,null);
});
