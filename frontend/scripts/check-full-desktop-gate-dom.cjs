"use strict";
// Synthetic React/JSDOM only. No Electron, actual capture/model, user data, or network.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript"), {JSDOM} = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url:"http://localhost/"});
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent"]) global[name] = dom.window[name];
Object.defineProperty(global, "navigator", {value:dom.window.navigator, configurable:true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react"), {act} = React, {createRoot} = require("react-dom/client");
const compilerOptions = {module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX, target:ts.ScriptTarget.ES2020};
let status, calls, response, previewResponder, capabilityResponder, root, hooks = {};
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const identity = {window_id:"x11:1", owner_pid:12, owner_process_start:"34", owner_process_name:"public-test", wm_class:"PublicTest", window_title:"Public test", content_bounds:{x:0,y:0,width:800,height:600}};
const publicCapability = {supported:true, platform:"linux-x11", lock_state:"unknown", lock_protection_supported:false};
const staleCapabilities = {public_window:publicCapability, full_desktop:{supported:true}};
const okay = () => ({ok:true, previewDataUrl:png, source_revision:"synthetic-revision", observation_mode:"vision"});
const observations = [{id:"synthetic-existing-record", state:"ready", evidence_available:true}];
const api = {
  getContextEngineStatus:async()=>status,
  getContextObservations:async()=>({items:observations}),
  setPrivacyMode:async()=>{calls.privacy++;},
  pauseBuiltinCaptureApi:async()=>{calls.pauseApi++; status = {...status, recording:{...status.recording, active:false}};},
  revokeBuiltinCaptureApi:async()=>{calls.revokeApi++; status = {...status, recording:{...status.recording, active:false, authorized:false}};},
};
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports:{}}; cache.set(filename,module);
  const output = ts.transpileModule(fs.readFileSync(filename,"utf8"), {compilerOptions}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename})((name)=>{
    if (name === "../lib/api") return api;
    if (!name.startsWith(".")) return require(name);
    const base = path.resolve(path.dirname(filename),name);
    const file = [base,base+".ts",base+".tsx"].find(value=>fs.existsSync(value));
    assert.ok(file, `Missing ${name}`); return load(file);
  },module,module.exports);
  return module.exports;
}
const dir = path.resolve(__dirname,"../src");
const {PublicWindowCaptureSetup} = load(path.join(dir,"components/PublicWindowCaptureSetup.tsx"));
const {MaskEditor} = load(path.join(dir,"components/MaskEditor.tsx"));
const geometry = load(path.join(dir,"lib/maskGeometry.ts"));
const {createPrivacyPreviewGate} = load(path.join(dir,"lib/privacyPreviewGate.ts"));
const app = fs.readFileSync(path.join(dir,"App.tsx"),"utf8");
let activation = app.slice(app.indexOf("function PreviewActivation("),app.indexOf("function FirstRunGuide("));
// Expose the real handlers to test stale invocation directly, not just disabled DOM.
activation = activation.replace(/  return \(\r?\n    <div className="first-run-backdrop"/, `  hooks.current = {checkPreview, beginRecording, previewCurrent, confirmed, captureConfig, restoreLegacySetup: () => {
    const ticket = previewGate.current.request();
    const config = {display_id: "screen:1", excluded_apps: ["password"], masks: [], confirmed: true};
    setCaptureScope("screen"); setDisplayId(config.display_id); setExclusions("password");
    setPreview({url: "data:image/png;base64,synthetic", maskedRegions: 0, ticket, bounds: {width: 800, height: 600}, fresh: true, configKey: JSON.stringify(config), privacyMode: "strict"});
    setConfirmed(true);
  }};
  return (
    <div className="first-run-backdrop"`);
const today = app.slice(app.indexOf("function PreviewToday("),app.indexOf("function PreviewPrivacy("));
const source = `const {useState,useEffect,useRef}=React;
const {clampMask,sameMask,validImageBounds}=geometry;
const {getContextEngineStatus,getContextObservations,setPrivacyMode,pauseBuiltinCaptureApi,revokeBuiltinCaptureApi}=api;
const Video=()=>null,Eye=()=>null,MessageSquareText=()=>null,PreviewModelSettings=()=>null,PreviewDailyReview=()=>null,CaptureSessionSummary=()=>null;
const StatusItem=()=>null,capturePauseMessage=()=>"",navigateClient=()=>{};
const PreviewObservationRow=({item})=><article data-record={item.id}>Existing synthetic record</article>;
const CaptureObservationFeed=({observations,renderObservation})=><div>{observations.map(item=><React.Fragment key={item.id}>{renderObservation(item)}</React.Fragment>)}</div>;
${activation}\n${today}\nreturn {PreviewActivation,PreviewToday};`;
const compiled = ts.transpileModule(source,{compilerOptions}).outputText;
const {PreviewActivation,PreviewToday} = vm.runInThisContext(`(function(require,React,geometry,createPrivacyPreviewGate,api,MaskEditor,PublicWindowCaptureSetup,hooks,exports){${compiled}\n})`)(require,React,geometry,createPrivacyPreviewGate,api,MaskEditor,PublicWindowCaptureSetup,hooks,{});
const flush = () => new Promise(done=>setImmediate(done));
const deferred = () => {let resolve; const promise = new Promise(yes=>resolve=yes); return {promise,resolve};};
function Harness({entry="setup", activationStatus="real_setup_started"}) {
  const [open,setOpen] = React.useState(entry === "setup");
  const [currentStatus,setCurrentStatus] = React.useState(activationStatus);
  return open ? React.createElement(PreviewActivation,{status:currentStatus,mandatory:false,onChooseReal:()=>setCurrentStatus("real_setup_started"),onChooseDemo:()=>setOpen(false),onChooseLocalChat:()=>setOpen(false),onDismiss:()=>setOpen(false),onComplete:()=>{calls.completed++;setOpen(false);}})
    : React.createElement(PreviewToday,{onOpenGuide:()=>setOpen(true)});
}
async function setup({capabilities=staleCapabilities, windows=false, missingCapabilityMethod=false, entry="setup", activationStatus="real_setup_started", active=false, delayedCapability}={}) {
  if (root) await act(async()=>root.unmount());
  calls = {displays:0,preview:[],start:[],pauseBridge:0,pauseApi:0,revokeApi:0,privacy:0,model:0,completed:0};
  status = {privacy_mode:"strict",capture_available:true,recording:{active,authorized:true,record_count:1,source_kind:"screen",capture_scope:"screen"}};
  response = capabilities;
  capabilityResponder = delayedCapability ? ()=>delayedCapability.promise : async()=>response;
  previewResponder = async()=>okay();
  window.openbutlerDesktop = {
    getCaptureDisplays:async()=>{calls.displays++;return [{id:"screen:1",label:"Synthetic screen"}];},
    getMaskedCapturePreview:async config=>{calls.preview.push(config);return previewResponder(config);},
    startBuiltinCapture:async config=>{calls.start.push(config);return {ok:true};},
    pauseBuiltinCapture:async()=>{calls.pauseBridge++;return {ok:true,active:false};},
    saveBuiltinModelRoutes:async()=>{calls.model++;return {ok:true};},
    ...(!missingCapabilityMethod ? {getCaptureCapabilities:async()=>capabilityResponder()} : {}),
    ...(windows ? {getCaptureWindows:async()=>({ok:true,sources:[{id:identity.window_id,label:"Public test",source_identity:identity}]})} : {}),
  };
  root = createRoot(document.getElementById("root"));
  await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(Harness,{entry,activationStatus})));await flush();});
}
function button(text) {const result=[...document.querySelectorAll("button")].find(node=>node.textContent.trim()===text);assert.ok(result,`Missing ${text}`);return result;}
async function click(text) {await act(async()=>{button(text).click();await flush();});}
async function change(label,value) {const node=document.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(node,value);node.dispatchEvent(new Event("change",{bubbles:true}));await flush();});}
async function tick(label) {await act(async()=>{document.querySelector(`[aria-label="${label}"]`).click();await flush();});}
async function choosePublic() {await change("选择专用公开窗口","x11:1");await tick("确认窗口仅包含公开内容");}
async function loadImage() {const img=document.querySelector(".preview-mask-surface img");assert.ok(img);Object.defineProperties(img,{naturalWidth:{value:800},naturalHeight:{value:600}});await act(async()=>{img.dispatchEvent(new Event("load"));await flush();});}
function assertNoDesktop() {
  assert.equal(calls.displays,0);assert.equal(calls.model,0);assert.equal(calls.privacy,0);
  for (const value of [...calls.preview,...calls.start]) assert.equal(value.capture_scope,"dedicated_public_window");
  assert.equal(document.querySelector('option[value="screen:1"]'),null);
  assert.ok(![...document.querySelectorAll("button")].some(node=>["检查隐私预览","开始记录"].includes(node.textContent.trim())));
}
async function assertGate() {
  const screen=button("整个屏幕（当前不可用）");assert.equal(screen.disabled,true);assert.equal(screen.getAttribute("aria-pressed"),"false");
  assert.match(document.body.textContent,/隐私检查尚未验证/);assert.match(document.body.textContent,/专用公开窗口需单独授权/);
  await act(async()=>{screen.disabled=false;screen.click();await hooks.current.checkPreview();await hooks.current.beginRecording();await flush();});
  assertNoDesktop();
}
const checks=[];const check=name=>checks.push(name);
(async()=>{
  const variants = [null, {}, {full_desktop:{}}, {full_desktop:{supported:false}}, {full_desktop:{supported:true}}, {full_desktop:{supported:"true"}}, staleCapabilities];
  for (const capabilities of variants) for (const windows of [false,true]) {
    await setup({capabilities,windows});await assertGate();assert.equal(calls.preview.length,0);assert.equal(calls.start.length,0);
    if (!windows) {assert.equal(document.querySelector(".public-window-setup"),null);assert.match(document.body.textContent,/不会改录整个屏幕/);}
    if (windows && capabilities?.public_window?.supported !== true) assert.equal(button("检查公开窗口隐私预览").disabled,true);
  }
  await setup({missingCapabilityMethod:true});await assertGate();
  await setup();
  await act(async()=>{hooks.current.restoreLegacySetup();await flush();});
  assert.equal(hooks.current.previewCurrent,true);assert.equal(hooks.current.confirmed,true);
  assert.equal(hooks.current.captureConfig().display_id,"screen:1");
  await assertGate();assert.equal(calls.preview.length,0);assert.equal(calls.start.length,0);
  check("missing, partial, false, malformed and stale true desktop capabilities cannot expose enumeration, preview or start, even with restored screen scope, fresh approved synthetic preview, direct stale handlers and tampered disabled DOM");

  for (const activationStatus of ["unseen","real_setup_started","completed"]) {
    await setup({activationStatus});
    if (activationStatus === "unseen") await click("设置截图记录无需额外安装");
    await assertGate();await click("关闭");assert.ok(document.querySelector('[data-record="synthetic-existing-record"]'));
    await click("设置截图记录");await assertGate();assert.equal(calls.start.length,0);assert.equal(calls.pauseApi,0);assert.equal(calls.revokeApi,0);
  }
  check("first-run, interrupted and completed activation, close and Today resume all stay unavailable and preserve existing authorized records without mutations");

  const pending = deferred();await setup({delayedCapability:pending});await assertGate();await click("关闭");
  await act(async()=>{pending.resolve(staleCapabilities);await flush();});await click("设置截图记录");await assertGate();assert.equal(calls.start.length,0);
  check("late stale supported:true after cancellation cannot authorize a reopened setup");

  await setup({windows:true});await assertGate();assert.equal(button("检查公开窗口隐私预览").disabled,true);
  await choosePublic();await click("检查公开窗口隐私预览");assert.equal(button("开始公开窗口自动记录").disabled,true);
  await loadImage();await tick("确认公开窗口最新预览");await click("开始公开窗口自动记录");
  assert.equal(calls.preview.length,1);assert.equal(calls.start.length,1);assert.equal(calls.completed,1);assert.deepEqual(calls.start[0].source_identity,identity);assertNoDesktop();
  check("separately selected and explicitly approved public-window preview still starts the exact dedicated scope despite stale desktop support");

  await setup({windows:true});await choosePublic();const late=deferred();previewResponder=()=>late.promise;
  await click("检查公开窗口隐私预览");await click("关闭");assert.equal(calls.pauseBridge,1);
  await act(async()=>{late.resolve(okay());await flush();});await click("设置截图记录");await assertGate();
  assert.equal(document.querySelector(".preview-mask-surface img"),null);assert.equal(document.querySelector('[aria-label="确认窗口仅包含公开内容"]').checked,false);assert.equal(calls.start.length,0);
  check("cancelled public-window preview is paused; late preview and prior consent cannot resume either scope");

  await setup({entry:"today",active:true});assert.ok(document.querySelector('[data-record="synthetic-existing-record"]'));
  await click("暂停录制");assert.equal(calls.pauseBridge,1);assert.equal(calls.pauseApi,1);assert.equal(calls.start.length,0);
  await click("设置截图记录");await assertGate();await click("关闭");await click("停止并撤销授权");
  assert.equal(calls.revokeApi,1);assert.equal(calls.start.length,0);assert.ok(document.querySelector('[data-record="synthetic-existing-record"]'));assertNoDesktop();
  check("existing screen session can still pause and revoke; subsequent setup cannot resume screen capture or delete records");

  await act(async()=>root.unmount());dom.window.close();
  console.log(JSON.stringify({suite:"full-desktop-gate-dom",passed:checks.length,checks,rendered_browser:false,real_capture_or_model_called:false},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
