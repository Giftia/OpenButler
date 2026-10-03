"use strict";
// Real Preview row/Today components with synthetic data only, no model or capture.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const ts=require("typescript"),{JSDOM}=require("jsdom");
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:"http://localhost/"});
for(const name of ["window","document","HTMLElement","Event","MouseEvent"])global[name]=dom.window[name];Object.defineProperty(global,"navigator",{value:dom.window.navigator,configurable:true});global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require("react"),{act}=React,{createRoot}=require("react-dom/client");let retryCalls=0,evidenceCalls=0,captureCalls=0;
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
window.openbutlerDesktop={getMaskedEvidence:async()=>{evidenceCalls++;return{ok:true,dataUrl:png};},getCaptureState:async()=>({active:false,lastResult:"paused"}),pauseBuiltinCapture:async()=>{captureCalls++;return{ok:true};}};
let queue={capacity:4,queued:4,running:1,backpressured:2,accepting:true};
const api={retryContextObservation:async()=>{retryCalls++;return{ok:true,queued:true};},deleteContextObservation:async()=>({deleted:false}),getContextEngineStatus:async()=>({capture_available:true,recording:{active:false,authorized:true,record_count:7,processing_queue:queue}}),getContextObservations:async()=>({items:[]}),pauseBuiltinCaptureApi:async()=>{captureCalls++;},revokeBuiltinCaptureApi:async()=>{captureCalls++;}};
const analysisFile=path.resolve(__dirname,"../src/components/CaptureObservationAnalysis.tsx");
const analysisOutput=ts.transpileModule(fs.readFileSync(analysisFile,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
const analysis={exports:{}};vm.runInThisContext(`(function(require,module,exports){${analysisOutput}\n})`,{filename:analysisFile})(require,analysis,analysis.exports);
const app=fs.readFileSync(path.resolve(__dirname,"../src/App.tsx"),"utf8");
const start=app.indexOf("function observationProcessingReason("),end=app.indexOf("function PreviewPrivacy(");assert.ok(start>=0&&end>start,"real Preview queue component boundaries must exist");const selected=app.slice(start,end);
const source=`const {useState,useEffect,useRef}=React;const {CaptureObservationAnalysis,observationCurrentContent,observationStateLabel}=analysis;const {retryContextObservation,deleteContextObservation,getContextEngineStatus,getContextObservations,pauseBuiltinCaptureApi,revokeBuiltinCaptureApi}=api;const CaptureObservationProvenance=()=>null,CaptureSessionSummary=()=>null,PreviewDailyReview=()=>null,PreviewModelSettings=()=>null,capturePauseMessage=()=>"",navigateClient=()=>{};${selected}\nreturn {PreviewObservationRow,PreviewToday,observationProcessingReason};`;
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
const {PreviewObservationRow,PreviewToday,observationProcessingReason}=vm.runInThisContext(`(function(require,React,api,analysis,exports){${compiled}\n})`)(require,React,api,analysis.exports,{});
const flush=()=>new Promise(done=>setImmediate(done));let root=createRoot(document.getElementById("root"));
const item={id:"00000000-0000-4000-8000-000000000001",captured_at:"2026-10-02T08:00:00Z",state:"recorded_pending",summary:null,title:null,boundary:"离散采样，空缺未知",evidence_available:true,evidence_id:"00000000-0000-4000-8000-000000000002",source_label:"专用公开窗口",processing_reason:"queue_full"};
async function row(value){await act(async()=>{root.render(React.createElement(PreviewObservationRow,{item:value}));await flush();});}
function button(text){const node=[...document.querySelectorAll("button")].find(n=>n.textContent.trim()===text);assert.ok(node,text);return node;}
async function click(text){await act(async()=>{button(text).click();await flush();});}
const checks=[];const check=name=>checks.push(name);
(async()=>{
 await row(item);assert.match(document.body.textContent,/队列已满/);assert.match(document.body.textContent,/不会自动补跑/);assert.ok(button("重新整理"));await click("查看依据");assert.equal(evidenceCalls,1);assert.ok(document.querySelector(".preview-evidence-image"));await click("重新整理");assert.equal(retryCalls,1);assert.match(document.body.textContent,/已加入整理队列，尚未生成结论/);assert.ok(!document.body.textContent.includes("已重新整理。"));
 check("queue-full row retains original masked evidence and explicit retry reports only queued, never completed");
 await row({...item,processing_reason:"queued"});assert.match(document.body.textContent,/已排队，等待整理/);assert.equal([...document.querySelectorAll("button")].some(n=>n.textContent==="重新整理"),false);await row({...item,state:"processing",processing_reason:"running"});assert.match(document.body.textContent,/整理中，截图已保存/);assert.match(document.body.textContent,/尚未生成整理结论/);
 check("queued and running observations stay distinct from ready and do not offer duplicate retry");
 for(const reason of ["process_restarted","capture_paused","authorization_revoked","source_reconfigured","session_expired","invalid_model_result","invalid_source_grounding","invalid_temporal_comparison","evidence_changed","temporal_context_changed","prompt_limit_exceeded","description_limit_exceeded","provider_connection_failed"]){await row({...item,state:"model_unavailable",processing_reason:reason});assert.ok(document.body.textContent.includes(observationProcessingReason(reason)));assert.ok(button("重新整理"));}assert.ok(observationProcessingReason("invalid_source_grounding").includes("OCR 摘录未匹配原始文字"));assert.equal(observationProcessingReason("__proto__").includes("暂不可确认"),true);assert.equal(observationProcessingReason("RAW_PROVIDER_SECRET").includes("RAW_PROVIDER_SECRET"),false);
 check("failure/interruption reasons are truthful fixed labels; unknown raw codes remain hidden");
 const current={version:2,inference:true,input_scope:"current_observation_only",observation_id:item.id,evidence_id:item.evidence_id,image_digest:"a".repeat(64),captured_at:item.captured_at,observation_route:"post_mask_ocr_to_text_model",title:"Summary title",summary:"Model inference",boundary:"Unverified current-frame inference"};
 await row({...item,state:"ready",processing_reason:null,extraction_version:2,current_facts:current,title:current.title,summary:current.summary,temporal_context:{association_state:"ready",prior_observation_ids:["prior-1","prior-3"],inference:true,coverage:"discrete_samples_only",note:"仅有限样本",prior_candidate_count:5,prior_selected_count:2,prior_omitted_count:3,relations:[{prior_observation_id:"prior-1",relation:"uncertain",current_quote:"Model",prior_quote:"prior"}]}});for(const text of ["历史候选 5 条","本次纳入 2 条","省略 3 条","prior-1、prior-3","旧版当前 OCR 模型推断 · 无原文片段校验","引文匹配不等于关系已证实"])assert.ok(document.body.textContent.includes(text),text);
 check("ready rows disclose selected/omitted prior coverage and exact IDs without promoting checked quotes into verified facts");
 await act(async()=>{root.render(React.createElement(PreviewToday,{onOpenGuide:()=>{}}));await flush();});const panel=document.querySelector('[aria-label="本机整理队列"]');assert.ok(panel);for(const text of ["处理中 1","排队 4/4","未入队 2","不代表模型已成功","需手动重试"])assert.ok(panel.textContent.includes(text),text);assert.equal(captureCalls,0);
 check("Today displays actual bounded queue capacity/running/backpressure counts via existing read path without new capture");
 queue={...queue,accepting:false,queued:0,running:0};await click("刷新");assert.match(document.querySelector('[aria-label="本机整理队列"]').textContent,/暂停接收整理任务/);assert.equal(captureCalls,0);
 check("queue stop state is visible and refresh never resumes capture or replays work");
 await act(async()=>root.unmount());dom.window.close();console.log(JSON.stringify({suite:"context-processing-queue-dom",passed:checks.length,checks,real_model_called:false,rendered_browser:false},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
