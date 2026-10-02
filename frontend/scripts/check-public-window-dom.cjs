"use strict";
// Synthetic React/JSDOM only. No browser, real window capture, model, or network.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript"), {JSDOM} = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url:"http://localhost/"});
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event", "MouseEvent"]) global[name] = dom.window[name];
Object.defineProperty(global, "navigator", {value:dom.window.navigator, configurable:true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react"), {act} = React, {createRoot} = require("react-dom/client");
const cache = new Map();
let pauseApiCalls = 0;
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports:{}}; cache.set(filename,module);
  const output = ts.transpileModule(fs.readFileSync(filename,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename})((name) => {
    if (name === "../lib/api") return {pauseBuiltinCaptureApi:async()=>{pauseApiCalls++;}};
    if (!name.startsWith(".")) return require(name);
    const base = path.resolve(path.dirname(filename),name);
    const file = [base,base+".ts",base+".tsx"].find((value)=>fs.existsSync(value));
    assert.ok(file, `Missing ${name}`); return load(file);
  },module,module.exports);
  return module.exports;
}
const dir = path.resolve(__dirname,"../src");
const {PublicWindowCaptureSetup} = load(path.join(dir,"components/PublicWindowCaptureSetup.tsx"));
const {CaptureSessionSummary, capturePauseMessage} = load(path.join(dir,"components/CaptureSessionSummary.tsx"));
const {CaptureObservationProvenance} = load(path.join(dir,"components/CaptureObservationProvenance.tsx"));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const identity = {window_id:"x11:123",owner_pid:456,owner_process_start:"7788",owner_process_name:"public-test",wm_class:"PublicTest",window_title:"Public test window",content_bounds:{x:0,y:0,width:800,height:600}};
const sources = [{id:"x11:123",label:identity.window_title,source_identity:identity},{id:"x11:124",label:"Second public window",source_identity:{...identity,window_id:"x11:124",window_title:"Second public window"}}];
const capabilities = {public_window:{supported:true,platform:"linux-x11",lock_state:"unknown",lock_protection_supported:false},full_desktop:{supported:false,reason:"lock_state_unknown"}};
const okay = (mode="vision") => ({ok:true,previewDataUrl:png,maskedRegions:0,source_revision:"test-revision",lock_state:"unknown",observation_mode:mode,...(mode === "masked_ocr_text" ? {post_mask_ocr_complete:true,post_mask_ocr_text:"SAFE PUBLIC TEXT",post_mask_ocr_image_digest:"a".repeat(64)} : {})});
const deferred = () => { let resolve; const promise = new Promise((yes)=>{resolve=yes;}); return {promise,resolve}; };
const flush = () => new Promise((done)=>setImmediate(done));
let root, previews, starts, windows, displayCalls, modelCalls, pauses, completes, responder, startResponder;
async function setup(props={}) {
  if(root) await act(async()=>root.unmount());
  previews=[]; starts=[]; windows=0; displayCalls=0; modelCalls=0; pauses=0; completes=0; pauseApiCalls=0;
  responder=async(config)=>okay(config.observation_mode); startResponder=async()=>({ok:true});
  window.openbutlerDesktop={
    getCaptureWindows:async()=>{windows++;return {ok:true,sources};},
    getCaptureDisplays:async()=>{displayCalls++;return[];},
    getMaskedCapturePreview:async(config)=>{previews.push(config);return responder(config);},
    startBuiltinCapture:async(config)=>{starts.push(config);return startResponder(config);},
    pauseBuiltinCapture:async()=>{pauses++;return {ok:true};},
    saveBuiltinModelRoutes:async()=>{modelCalls++;return{ok:true};},
  };
  root=createRoot(document.getElementById("root"));
  await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(PublicWindowCaptureSetup,{active:false,capabilities,onComplete:()=>completes++,onStartingChange:()=>{},...props})));await flush();});
}
function button(text) { const found=[...document.querySelectorAll("button")].find((item)=>item.textContent.trim()===text);assert.ok(found,`Missing button ${text}`);return found; }
function input(label) { const found=document.querySelector(`[aria-label="${label}"]`);assert.ok(found,label);return found; }
async function click(text) { await act(async()=>{button(text).click();await flush();}); }
async function change(label,value) { const node=input(label);await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(node,value);node.dispatchEvent(new Event(node.tagName==="SELECT"?"change":"input",{bubbles:true}));await flush();}); }
async function tick(label) { await act(async()=>{input(label).click();await flush();}); }
const start=()=>button("开始公开窗口自动记录");
const previewButton=()=>button("检查公开窗口隐私预览");
async function choose() { await change("选择专用公开窗口","x11:123");await tick("确认窗口仅包含公开内容"); }
async function imageLoad() {
  const img=document.querySelector(".preview-mask-surface img");assert.ok(img);
  Object.defineProperties(img,{naturalWidth:{value:800,configurable:true},naturalHeight:{value:600,configurable:true}});
  await act(async()=>{img.dispatchEvent(new Event("load"));await flush();});
}
async function preview() { await click("检查公开窗口隐私预览");await imageLoad(); }
async function approve() { await tick("确认公开窗口最新预览");assert.equal(input("确认公开窗口最新预览").checked,true); }
const checks=[];const check=(name)=>checks.push(name);
(async()=>{
  await setup();assert.equal(previews.length,0);assert.equal(starts.length,0);assert.equal(displayCalls,0);assert.equal(modelCalls,0);assert.ok(windows>0);assert.equal(start().disabled,true);assert.match(document.body.textContent,/锁屏状态未知/);assert.match(document.body.textContent,/规则可能遗漏敏感信息/);
  check("mount reads window metadata only; no screen capture, model invocation or automatic start; capability limits are explicit");
  await change("选择专用公开窗口","x11:123");assert.equal(previewButton().disabled,true);assert.match(document.body.textContent,/XID x11:123 · PID 456/);await tick("确认窗口仅包含公开内容");assert.equal(previewButton().disabled,false);
  await click("检查公开窗口隐私预览");assert.equal(start().disabled,true);assert.equal(input("确认公开窗口最新预览").disabled,true);await imageLoad();await approve();await click("开始公开窗口自动记录");
  assert.equal(previews.length,1);assert.equal(starts.length,1);assert.equal(completes,1);assert.equal(starts[0].capture_scope,"dedicated_public_window");assert.deepEqual(starts[0].source_identity,identity);assert.deepEqual(starts[0].masks,[]);assert.ok(starts[0].excluded_apps.length>0);assert.equal(starts[0].interval_seconds,10);assert.equal(starts[0].session_duration_seconds,600);
  check("exact public window plus explicit loaded masked preview approval starts automatic recording with no manual masks required");
  await setup();await choose();await preview();await approve();await change("自动采样间隔","30");assert.equal(start().disabled,true);assert.equal(input("确认公开窗口最新预览").checked,false);await preview();await approve();await change("本次最长记录时间","300");assert.equal(start().disabled,true);await preview();await approve();await click("开始公开窗口自动记录");assert.equal(starts[0].interval_seconds,30);assert.equal(starts[0].session_duration_seconds,300);
  check("interval and session edits consume approval and their exact values reach the desktop bridge");
  await setup();await choose();await preview();await approve();await change("公开窗口观察方式","masked_ocr_text");assert.equal(start().disabled,true);assert.equal(input("确认公开窗口最新预览").checked,false);assert.equal(document.querySelector(".preview-mask-surface img"),null);assert.equal(pauses,1);assert.match(document.body.textContent,/没有视觉理解/);await preview();assert.equal(previews.at(-1).observation_mode,"masked_ocr_text");assert.match(document.body.textContent,/SAFE PUBLIC TEXT/);await approve();await click("开始公开窗口自动记录");assert.equal(starts[0].observation_mode,"masked_ocr_text");
  check("explicit OCR route cancels prior native preview and requires fresh mode-bound approval; text-only limits and masked text are shown");
  await setup();await choose();await preview();await approve();const cancelWait=deferred();window.openbutlerDesktop.pauseBuiltinCapture=()=>{pauses++;return cancelWait.promise;};await change("公开窗口观察方式","masked_ocr_text");assert.equal(previewButton().disabled,true);await click("检查公开窗口隐私预览");assert.equal(previews.length,1);await act(async()=>{cancelWait.resolve({ok:true});await flush();});await preview();assert.equal(previews.length,2);assert.equal(previews[1].observation_mode,"masked_ocr_text");
  check("native cancellation is serialized so a late pause cannot cancel the next mode preview");
  for (const failure of ["false", "active", "throw"]) {
    await setup();await choose();await preview();await approve();window.openbutlerDesktop.pauseBuiltinCapture=async()=>{if(failure==="throw")throw new Error("RAW_PRIVATE_ERROR");return failure==="active"?{ok:true,active:true}:{ok:false};};await change("公开窗口观察方式","masked_ocr_text");assert.equal(previewButton().disabled,true);assert.equal(start().disabled,true);assert.match(document.body.textContent,/旧预览无法确认取消/);assert.ok(!document.body.textContent.includes("RAW_PRIVATE_ERROR"));
  }
  check("negative, active and rejected cancellation receipts fail closed and block replacement capture");

  await setup();await choose();const oldMode=deferred();responder=()=>oldMode.promise;await click("检查公开窗口隐私预览");await change("公开窗口观察方式","masked_ocr_text");assert.equal(pauses,1);await act(async()=>{oldMode.resolve(okay());await flush();});assert.equal(document.querySelector(".preview-mask-surface img"),null);assert.equal(start().disabled,true);
  check("mode change during an in-flight preview cancels its lease and rejects the old route result");
  await setup();await choose();await change("公开窗口观察方式","masked_ocr_text");responder=async()=>okay();await click("检查公开窗口隐私预览");assert.equal(start().disabled,true);assert.equal(document.querySelector(".preview-mask-surface img"),null);
  check("a vision preview cannot authorize the selected OCR route");

  await setup();await choose();await preview();await approve();await change("选择专用公开窗口","x11:124");assert.equal(document.querySelector(".preview-mask-surface img"),null);assert.equal(input("确认窗口仅包含公开内容").checked,false);assert.equal(start().disabled,true);
  check("changing source clears preview, masks and public-only consent instead of switching silently");
  await setup();await choose();const late=deferred();responder=()=>late.promise;await act(async()=>{previewButton().click();previewButton().click();await flush();});assert.equal(previews.length,1);await change("自动采样间隔","60");await act(async()=>{late.resolve(okay());await flush();});assert.equal(document.querySelector(".preview-mask-surface img"),null);assert.equal(start().disabled,true);
  check("repeated preview clicks dispatch once; scope edits reject late masked results");
  await setup();await choose();responder=async()=>({...okay(),source_revision:undefined});await click("检查公开窗口隐私预览");assert.equal(document.querySelector(".preview-mask-surface img"),null);responder=async()=>({...okay(),previewDataUrl:"file:///raw.png"});await click("检查公开窗口隐私预览");assert.equal(document.querySelector(".preview-mask-surface img"),null);
  check("missing source revision and non-PNG preview URLs fail closed");
  for (const [code, text] of [["window_source_unavailable","所选窗口采集暂不可用"],["foreground_unknown","无法确认当前前台窗口"],["window_identity_changed","标题、进程或尺寸已改变"],["opaque_visible_client_required","需要可见且不透明"],["isolated_pixmap_unavailable","无法取得此窗口的独立画面"],["post_mask_ocr_empty","遮挡后没有可识别的文字"],["post_mask_ocr_failed","遮挡后的再次本机识字失败"],["post_mask_ocr_too_large","不会截断文字"]]) {
    await setup();await choose();responder=async()=>({ok:false,error_code:code,error:"RAW_PROVIDER_SECRET"});await click("检查公开窗口隐私预览");
    assert.ok(document.body.textContent.includes(text),code);assert.ok(document.body.textContent.includes("（"+code+"）"));assert.ok(!document.body.textContent.includes("RAW_PROVIDER_SECRET"));assert.equal(start().disabled,true);
  }
  check("known preview failure codes show fixed Chinese guidance and allowlisted diagnostic code without exposing raw messages");
  for (const code of ["unknown_internal_code", "__proto__", "constructor", "<script>RAW_PROVIDER_SECRET</script>", null]) {
    await setup();await choose();responder=async()=>({ok:false,error_code:code,error:"RAW_PROVIDER_SECRET"});await click("检查公开窗口隐私预览");
    assert.ok(!document.body.textContent.includes("RAW_PROVIDER_SECRET"));if(code)assert.ok(!document.body.textContent.includes(code));assert.match(document.body.textContent,/请检查本机服务与窗口范围/);
  }
  check("unknown, prototype and malformed diagnostic codes stay generic and never expose raw provider output");
  await setup();await choose();await preview();await approve();startResponder=async()=>({ok:false,error_code:"privacy_preview_required",error:"RAW_PROVIDER_SECRET"});await click("开始公开窗口自动记录");assert.match(document.body.textContent,/最新隐私预览已失效/);assert.equal(pauses,1);assert.equal(pauseApiCalls,1);assert.ok(!document.body.textContent.includes("RAW_PROVIDER_SECRET"));
  check("known start failures retain bounded diagnostics after compensating pause");
  await setup();await choose();await preview();await approve();startResponder=async()=>({ok:false});await act(async()=>{start().click();start().click();await flush();});assert.equal(starts.length,1);assert.equal(pauses,1);assert.equal(pauseApiCalls,1);assert.equal(input("确认公开窗口最新预览").checked,false);assert.equal(start().disabled,true);
  check("double start dispatches once; failure attempts both pauses and requires fresh approval");
  await setup();await choose();await preview();await approve();const starting=deferred();startResponder=()=>starting.promise;await click("开始公开窗口自动记录");await act(async()=>root.unmount());root=null;await act(async()=>{starting.resolve({ok:true});await flush();});assert.equal(pauses,1);assert.equal(pauseApiCalls,1);assert.equal(completes,0);
  check("unmount while starting compensates with pause and ignores late success");
  await setup();await choose();const leaving=deferred();responder=()=>leaving.promise;await click("检查公开窗口隐私预览");await act(async()=>root.unmount());root=null;await act(async()=>{leaving.resolve(okay());await flush();});assert.equal(starts.length,0);await setup();assert.equal(input("确认窗口仅包含公开内容").checked,false);assert.equal(document.querySelector(".preview-mask-surface img"),null);
  check("dismissed preview never leaks into a reopened setup or starts recording");
  await setup({capabilities:{...capabilities,public_window:{...capabilities.public_window,supported:false}}});assert.equal(input("选择专用公开窗口").disabled,true);assert.equal(previewButton().disabled,true);assert.equal(displayCalls,0);
  check("unsupported public-window capture cannot fall back to display capture");
  await setup({active:true});assert.equal(input("选择专用公开窗口").disabled,true);assert.equal(start().disabled,true);assert.equal(previews.length,0);
  check("active session blocks scope edits and new capture approval");
  await act(async()=>{root.render(React.createElement(CaptureSessionSummary,{state:{active:false,capture_scope:"dedicated_public_window",sourceIdentity:identity,intervalSeconds:30,sessionExpiresAt:"2026-10-02T07:00:00Z",lastResult:"window_identity_changed"}}));await flush();});
  for(const text of ["专用公开窗口","Public test window","XID x11:123 · PID 456","30 秒","本次最晚停止","身份已改变","锁定状态未知"])assert.ok(document.body.textContent.includes(text),text);
  for(const reason of ["session_expired","window_destroyed_unmapped_or_reconfigured","source_binding_mismatch","privacy_processing_failed","lock-screen","suspend"])assert.ok(capturePauseMessage(reason));
  assert.equal(typeof capturePauseMessage("__proto__"),"string");assert.equal(typeof capturePauseMessage("constructor"),"string");
  check("session panel matches native sourceIdentity, capture_scope and sessionExpiresAt contract and renders pause reasons");
  const item={captured_at:"2026-10-02T06:00:00Z",recorded_at:"2026-10-02T06:00:03Z",source_kind:"public_window",source_label:"专用公开窗口",summary:"Model guess",evidence_kind:"privacy_masked_captured_pixels",evidence_available:true,provenance:{source_identity:identity,sampling_interval_ms:10000,sampling_gap_ms:25000},temporal_context:{prior_observation_ids:["prior-id"],inference:true,coverage:"discrete_samples_only",note:"只能根据两次采样推断"}};
  await act(async()=>{root.render(React.createElement(CaptureObservationProvenance,{item}));await flush();});for(const text of ["实际截图（已隐私遮挡）","采集时间","入库时间","额外采样延迟 25 秒","连续上下文为推断","其他窗口的活动未知","不证明每次点击"])assert.ok(document.body.textContent.includes(text),text);
  check("record provenance separates observed screenshot/time/source/gaps from AI inference and incomplete coverage");
  await act(async()=>{root.render(React.createElement(CaptureObservationProvenance,{item:{...item,observation_mode:"masked_ocr_text",observation_route:"post_mask_ocr_to_text_model",ocr_provenance:{engine:"tesseract.js",stage:"post_mask",image_digest:"b".repeat(64),layout:"text_only_no_layout_guarantee"}}}));await flush();});for(const text of ["没有视觉理解","遮挡后 OCR 文字","SHA-256","tesseract.js"])assert.ok(document.body.textContent.includes(text),text);assert.ok(!document.body.textContent.includes("基于遮挡后截图的推断"));
  check("OCR timeline claims text evidence and its digest honestly rather than image understanding");

  await act(async()=>{root.render(React.createElement(CaptureObservationProvenance,{item:{...item,evidence_available:false}}));await flush();});assert.match(document.body.textContent,/截图依据已过期或不可用/);
  check("missing evidence stays explicit even when an old summary exists");
  const app=fs.readFileSync(path.join(dir,"App.tsx"),"utf8");assert.match(app,/设置自动截图记录/);assert.match(app,/停止并撤销授权/);assert.match(app,/captureScope === "screen" \? window.openbutlerDesktop\?\.getCaptureDisplays/);assert.match(app,/capabilities\?\.full_desktop.supported === false/);assert.match(fs.readFileSync(path.join(dir,"components/CaptureObservationAnalysis.tsx"),"utf8"),/旧版 AI 整理推断 · 待核实/);
  check("Today and recording setup expose bounded automatic recording while full-screen unsupported capability remains visible");
  const css=fs.readFileSync(path.join(dir,"styles.css"),"utf8");const nativeSelect=css.slice(css.lastIndexOf("/* Keep native select semantics"));assert.match(nativeSelect,/height: 44px/);assert.match(nativeSelect,/padding: 0 36px 0 12px/);assert.match(nativeSelect,/line-height: 20px/);assert.match(nativeSelect,/appearance: none/);assert.match(nativeSelect,/background-image: linear-gradient/);
  check("Preview native selects use explicit 44px height and zero vertical padding; native visual verification remains required");
  await act(async()=>root.unmount());dom.window.close();console.log(JSON.stringify({suite:"public-window-dom",passed:checks.length,checks,rendered_browser:false},null,2));
})().catch((error)=>{console.error(error);process.exitCode=1;dom.window.close();});
