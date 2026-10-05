"use strict";
// Synthetic React + JSDOM interaction tests. No rendered browser, Electron,
// screenshot capture, user data, network, or model invocation is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {JSDOM} = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url: "http://localhost/"});
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent"]) global[key] = dom.window[key];
Object.defineProperty(global, "navigator", {value: dom.window.navigator, configurable: true});
global.IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.setPointerCapture = function(id) { this._pointer = id; };
HTMLElement.prototype.hasPointerCapture = function(id) { return this._pointer === id; };
HTMLElement.prototype.releasePointerCapture = function() { this._pointer = null; };
const React = require("react");
const {act} = React;
const {createRoot} = require("react-dom/client");
const cache = new Map();
function compile(filename, source) {
  const loaded = {exports: {}};
  cache.set(filename, loaded);
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText;
  const execute = vm.runInThisContext(`(function(require,module,exports){${output}\n})`, {filename});
  execute((name) => {
    if (!name.startsWith(".")) return require(name);
    const base = path.resolve(path.dirname(filename), name);
    const file = [base, base+".ts", base+".tsx"].find((candidate) => fs.existsSync(candidate));
    assert.ok(file, `Cannot resolve ${name}`);
    return cache.get(file)?.exports ?? compile(file, fs.readFileSync(file, "utf8"));
  }, loaded, loaded.exports);
  return loaded.exports;
}
const rootDir = path.resolve(__dirname, "../src");
const {MaskEditor} = compile(path.join(rootDir, "components/MaskEditor.tsx"), fs.readFileSync(path.join(rootDir, "components/MaskEditor.tsx"), "utf8"));
const geometry = cache.get(path.join(rootDir, "lib/maskGeometry.ts")).exports;
const {createPrivacyPreviewGate} = compile(path.join(rootDir, "lib/privacyPreviewGate.ts"), fs.readFileSync(path.join(rootDir, "lib/privacyPreviewGate.ts"), "utf8"));
let previewCalls, startCalls, pauseApiCalls, pauseBridgeCalls, privacyCalls, completed;
let previewResponder, startResponder, privacyResponder, active;
const identity = {window_id:"x11:1",owner_pid:12,owner_process_start:"34",owner_process_name:"public-test",wm_class:"PublicTest",window_title:"Public test",content_bounds:{x:0,y:0,width:1920,height:1080}};
const capabilities = {public_window:{supported:true,platform:"linux-x11",lock_state:"unknown",lock_protection_supported:false},full_desktop:{supported:true}};
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const okPreview = () => ({ok: true, previewDataUrl: png, maskedRegions: 2, source_revision:"synthetic-revision", observation_mode:"vision"});
const mockApi = {
  getContextEngineStatus: async () => ({privacy_mode: "strict", capture_available: true, recording: {active, record_count: 0}}),
  setPrivacyMode: async (mode) => { privacyCalls.push(mode); return privacyResponder(mode); },
  pauseBuiltinCaptureApi: async () => { pauseApiCalls++; },
};
cache.set(path.join(rootDir, "lib/api.ts"), {exports: mockApi});
const {PublicWindowCaptureSetup} = compile(path.join(rootDir, "components/PublicWindowCaptureSetup.tsx"), fs.readFileSync(path.join(rootDir, "components/PublicWindowCaptureSetup.tsx"), "utf8"));
const app = fs.readFileSync(path.join(rootDir, "App.tsx"), "utf8");
const activation = app.slice(app.indexOf("function PreviewActivation("), app.indexOf("function FirstRunGuide("));
const syntheticSource = `const {useState,useEffect,useRef}=React;
const {clampMask,sameMask,validImageBounds}=geometry;
const {getContextEngineStatus,setPrivacyMode,pauseBuiltinCaptureApi}=mockApi;
const Video=()=>null, Eye=()=>null;
const StatusItem=({label,value})=><span>{label}: {value}</span>;
${activation}
return PreviewActivation;`;
const output = ts.transpileModule(syntheticSource, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText;
const PreviewActivation = vm.runInThisContext(`(function(require,React,MaskEditor,geometry,createPrivacyPreviewGate,mockApi,PublicWindowCaptureSetup,exports){${output}\n})`, {filename:"PreviewActivation.synthetic.tsx"})(require, React, MaskEditor, geometry, createPrivacyPreviewGate, mockApi, PublicWindowCaptureSetup, {});
let root;
const checks = [];
const check = (text) => checks.push(text);
const flush = () => new Promise((done) => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
function Harness() {
  const [open, setOpen] = React.useState(true);
  return open ? React.createElement(PreviewActivation, {status: "real_setup_started", mandatory: false,
    onChooseReal: () => {}, onChooseDemo: () => setOpen(false), onDismiss: () => setOpen(false),
    onComplete: () => { completed++; setOpen(false); }}) : React.createElement("button", {onClick: () => setOpen(true)}, "重新打开设置");
}
async function setup(options = {}) {
  if (root) await act(async () => root.unmount());
  previewCalls = []; startCalls = []; pauseApiCalls = 0; pauseBridgeCalls = 0; privacyCalls = []; completed = 0; active = !!options.active;
  previewResponder = async () => okPreview(); startResponder = async () => ({ok:true}); privacyResponder = async () => ({});
  window.openbutlerDesktop = {
    getCaptureCapabilities: async () => capabilities,
    getCaptureWindows: async () => ({ok:true,sources:[{id:"x11:1",label:"Public one",source_identity:identity},{id:"x11:2",label:"Public two",source_identity:{...identity,window_id:"x11:2"}}]}),
    getCaptureDisplays: async () => assert.fail("Full-desktop enumeration is disabled"),
    getMaskedCapturePreview: async (config) => { previewCalls.push(config); return previewResponder(config); },
    startBuiltinCapture: async (config) => { startCalls.push(config); return startResponder(config); },
    pauseBuiltinCapture: async () => { pauseBridgeCalls++; return {ok:true}; },
  };
  root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))); await flush(); });
  if (!active) {
    await change(document.querySelector('[aria-label="选择专用公开窗口"]'), "x11:1");
    await act(async () => { document.querySelector('[aria-label="确认窗口仅包含公开内容"]').click(); await flush(); });
  }
}
function button(text) { const found=[...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); assert.ok(found, `Missing button: ${text}`); return found; }
const startButton = () => button("开始公开窗口自动记录");
const confirmation = () => document.querySelector('[aria-label="确认公开窗口最新预览"]');
async function click(text) { await act(async () => { button(text).click(); await flush(); }); }
async function change(input, value) {
  assert.ok(input, `Missing input for ${value}`);
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", {bubbles:true}));
    await flush();
  });
}
async function imageLoad(width=1920,height=1080) {
  const image = document.querySelector(".preview-mask-surface img"); assert.ok(image);
  Object.defineProperties(image,{naturalWidth:{value:width,configurable:true},naturalHeight:{value:height,configurable:true}});
  image.getBoundingClientRect = () => ({left:100,top:50,width:960,height:540,right:1060,bottom:590,x:100,y:50});
  await act(async () => { image.dispatchEvent(new Event("load")); await flush(); });
}
async function preview(width=1920,height=1080) { await click("检查公开窗口隐私预览"); await imageLoad(width,height); }
async function confirm() { await act(async () => { confirmation().click(); await flush(); }); assert.equal(confirmation().checked,true); }
function values(index=0) { const inputs=[...document.querySelectorAll(".preview-mask-fields")][index]?.querySelectorAll("input"); return inputs ? [...inputs].map((input)=>Number(input.value)) : null; }
async function pointer(target,type,x,y) {
  await act(async () => { const event=new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0}); Object.defineProperties(event,{pointerId:{value:1},isPrimary:{value:true}}); target.dispatchEvent(event); await flush(); });
}
async function settle(value, method="resolve") { await act(async () => { value[method](method === "reject" ? new Error("synthetic failure") : okPreview()); await flush(); }); }

(async () => {
  await setup();
  assert.equal(previewCalls.length,0); assert.equal(startCalls.length,0); assert.equal(startButton().disabled,true);
  await click("检查公开窗口隐私预览");
  assert.equal(confirmation().disabled,true); assert.equal(startButton().disabled,true);
  await imageLoad(); assert.equal(confirmation().disabled,false); assert.equal(startButton().disabled,true);
  await confirm(); assert.equal(startButton().disabled,false);
  check("mount performs no capture; preview image load and explicit checkbox are both required");

  const surface=document.querySelector(".preview-mask-surface");
  await pointer(surface,"pointerdown",200,150);
  assert.equal(confirmation().checked,false); assert.equal(startButton().disabled,true);
  assert.match(document.body.textContent,/旧的已遮挡画面/);
  await pointer(surface,"pointermove",400,250); await pointer(surface,"pointerup",400,250);
  assert.deepEqual(values(),[200,200,400,200]);
  assert.equal(previewCalls.length,1); assert.equal(startCalls.length,0);
  check("drag drawing converts CSS coordinates to natural pixels and immediately invalidates approval without auto-preview");

  await pointer(document.querySelector(".preview-mask-handle.at-se"),"pointerdown",400,250);
  await pointer(surface,"pointermove",3000,3000); await pointer(surface,"pointerup",3000,3000);
  assert.deepEqual(values(),[200,200,1720,880]);
  await change(document.querySelector('input[aria-label*="左侧 X"]'),"1919");
  assert.deepEqual(values(),[1919,200,1,880]);
  const selection=document.querySelector(".preview-mask-select");
  await act(async () => { selection.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",shiftKey:true,bubbles:true})); await flush(); });
  assert.deepEqual(values(),[1909,200,1,880]);
  await click("删除"); assert.equal(values(),null); assert.equal(document.querySelectorAll(".preview-mask-region").length,0);
  assert.ok(document.querySelector(".preview-mask-surface img")); assert.equal(confirmation().disabled,true);
  check("resize, numeric fallback, keyboard movement and deletion stay bounded; old masked image remains editing-only");

  await preview(); await confirm(); await click("绘制区域");
  await pointer(document.querySelector(".preview-mask-surface"),"pointerdown",200,150);
  await pointer(document.querySelector(".preview-mask-surface"),"pointercancel",200,150);
  assert.equal(values(),null); assert.equal(confirmation().checked,false); assert.equal(startButton().disabled,true);
  assert.equal(button("检查公开窗口隐私预览").disabled,false);
  await pointer(document.querySelector(".preview-mask-surface"),"pointerdown",250,200);
  assert.equal(document.activeElement, document.querySelector(".preview-mask-surface"));
  await act(async () => { document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); await flush(); });
  assert.equal(values(),null); assert.equal(button("检查公开窗口隐私预览").disabled,false);
  check("cancelled pointer and Escape gestures leave no new rectangle and cannot restore previous consent");

  await preview(); await confirm();
  await change(document.querySelector('[aria-label="自动采样间隔"]'),"30");
  assert.equal(confirmation().checked,false); assert.equal(confirmation().disabled,true); assert.ok(document.querySelector(".is-stale img"));
  const delayed=deferred(); previewResponder=()=>delayed.promise;
  await act(async () => { button("检查公开窗口隐私预览").click(); button("检查公开窗口隐私预览").click(); await flush(); });
  const requestCount=previewCalls.length;
  await change(document.querySelector('[aria-label="自动采样间隔"]'),"60");
  await settle(delayed);
  assert.equal(previewCalls.length,requestCount); assert.equal(confirmation().disabled,true); assert.ok(document.querySelector(".is-stale img"));
  assert.match(document.body.textContent,/旧预览已忽略/);
  check("scope edits invalidate confirmed and in-flight previews; repeated preview clicks dispatch once");

  previewResponder=async()=>okPreview(); await click("检查公开窗口隐私预览");
  await change(document.querySelector('[aria-label="自动采样间隔"]'),"10"); await imageLoad();
  assert.equal(confirmation().disabled,true); assert.equal(button("绘制区域").disabled,false);
  check("editing before image load keeps a usable stale canvas without revalidating it on load");

  await preview(); await confirm();
  await change(document.querySelector('[aria-label="选择专用公开窗口"]'),"x11:2");
  await act(async () => { document.querySelector('[aria-label="确认窗口仅包含公开内容"]').click(); await flush(); });
  assert.equal(document.querySelector(".preview-mask-surface img"),null); assert.equal(confirmation().disabled,true);
  await click("添加区域"); await preview(80,60);
  assert.deepEqual(values(),[0,0,80,60]); assert.equal(confirmation().disabled,true); assert.match(document.body.textContent,/窗口边界调整/);
  await preview(80,60); assert.equal(confirmation().disabled,false);
  check("public-window switch clears old canvas; changed image bounds clamp masks and require another fresh preview");

  await setup(); const closing=deferred(); previewResponder=()=>closing.promise;
  await click("检查公开窗口隐私预览"); await click("关闭"); await settle(closing); await click("重新打开设置");
  assert.equal(document.querySelector(".preview-mask-surface img"),null); assert.equal(confirmation().checked,false); assert.equal(startCalls.length,0);
  check("closing and reopening discards late preview results and never resumes capture");

  await setup(); previewResponder=async()=>({ok:true,previewDataUrl:"file:///raw.png"}); await click("检查公开窗口隐私预览");
  assert.equal(document.querySelector(".preview-mask-surface img"),null); assert.equal(confirmation().disabled,true);
  previewResponder=async()=>okPreview(); await click("检查公开窗口隐私预览");
  await act(async()=>{ document.querySelector(".preview-mask-surface img").dispatchEvent(new Event("error")); await flush(); });
  assert.equal(document.querySelector(".preview-mask-surface img"),null); assert.equal(confirmation().disabled,true);
  check("non-PNG bridge data and image decoding errors cannot become an approvable preview");

  await setup(); await preview(); await confirm();
  startResponder=async()=>({ok:false});
  await act(async()=> { startButton().click(); startButton().click(); await flush(); });
  assert.equal(startCalls.length,1); assert.equal(pauseApiCalls,1); assert.equal(pauseBridgeCalls,1); assert.equal(confirmation().checked,false); assert.equal(confirmation().disabled,true);
  check("double start dispatches once; failed start attempts pause and consumes approval");

  await setup(); await preview(); await confirm(); const starting=deferred(); startResponder=()=>starting.promise;
  await click("开始公开窗口自动记录"); assert.equal(button("关闭").disabled,true); assert.equal(document.querySelectorAll(".activation-choice")[1].disabled,true);
  await act(async()=>root.unmount()); root=null;
  await act(async()=> { starting.resolve({ok:true}); await flush(); });
  assert.equal(pauseApiCalls,1); assert.equal(pauseBridgeCalls,1); assert.equal(completed,0);
  check("navigation cannot accept a late start; unmount during start triggers compensating pause");

  await setup({active:true});
  assert.equal(button("添加区域").disabled,true); assert.equal(button("检查公开窗口隐私预览").disabled,true); assert.equal(previewCalls.length,0); assert.equal(startCalls.length,0);
  check("existing active capture prevents scope edits and never auto-captures a preview");

  await act(async()=>root.unmount()); dom.window.close();
  console.log(JSON.stringify({suite:"phase1-mask-editor-dom",passed:checks.length,checks,rendered_browser:false},null,2));
})().catch((error)=>{ console.error(error); process.exitCode=1; dom.window.close(); });
