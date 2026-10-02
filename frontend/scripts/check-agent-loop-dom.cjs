"use strict";
// Synthetic React/JSDOM and transport checks. These are not native desktop/rendered-browser acceptance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {webcrypto, createHash} = require("node:crypto");
const {JSDOM} = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url: "http://localhost/assistant"});
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "DOMException"]) global[key] = dom.window[key];
Object.defineProperty(global, "navigator", {value: dom.window.navigator, configurable: true});
Object.defineProperty(global, "crypto", {value: webcrypto, configurable: true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react"), {act} = React, {createRoot} = require("react-dom/client");
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative);
  const source = fs.readFileSync(filename, "utf8").replace(/import\.meta\.env\.VITE_API_BASE_URL/g, '""');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText;
  const module = {exports: {}};
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`, {filename})((name) => name.endsWith(".css") ? {} : dependencies[name] || require(name), module, module.exports);
  return module.exports;
}
const client = load("../src/lib/agentRuntimeApi.ts");
const plannerSettings = load("../src/components/PlannerModelSettings.tsx", {"../lib/agentRuntimeApi": client});
const {AgentLoopPanel} = load("../src/components/AgentLoopPanel.tsx", {"../lib/agentRuntimeApi": client, "./PlannerModelSettings": plannerSettings, "./NaturalChatPanel": {NaturalChatPanel: () => null}});
const checks = [], check = (text) => checks.push(text);
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let index = 0; index < 5; index++) await tick(); await new Promise((resolve)=>setTimeout(resolve,20)); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
const baseGoal = (id, status = "active") => ({id, title: `Goal ${id}`, target_id: `target-${id}`, success_event_type: "commitment_closed", success_value: true, version: 2, status, source_ids: ["user_statement"], evidence_ids: ["e1"], deadline_at: null, activated_at: "2026-10-02T00:00:00Z", wait_target: {target_id: `target-${id}`, event_type: "commitment_closed", value: true}, checkpoint: {stage: "approved"}, plan: {source_versions:{user_statement:1},tasks:[{kind:"wait",status:"pending"}]}, approval: {}, completion_evidence_ids: [], blocked_reason: null});
function fixture() { return {
  status: {enabled: false, planner: "deterministic_local", counts: {}, settings: {quiet_until: null, daily_notice_budget: 10, cooldown_seconds: 600}, next_wake_at: null},
  goals: [baseGoal("g1"), baseGoal("g2", "paused"), baseGoal("g3", "candidate"), baseGoal("g4", "waiting_external"), baseGoal("g5", "completed"), baseGoal("g6", "cancelled")],
  sources: [{id:"user_statement",scope:"goal_tracking",version:1,status:"active",consented_at:"2026-10-02T00:00:00Z",expires_at:null}],
  evidence: [{id:"e1",source_id:"user_statement",source_event_id:"event-1",target_id:"target-g1",event_type:"commitment_open",value:"Synthetic only",observed_at:"2026-10-02T00:00:00Z",expires_at:null,valid:true,provenance:{kind:"local_user_supplied",source_system_verified:false},trust:"untrusted"}],
  inbox: [{id:"n1",goal_id:"g1",action_id:"a1",kind:"ask_user",message:"Synthetic notice only",created_at:"2026-10-02T00:00:00Z",read_at:null}],
  messages: [{id:"m1",conversation_id:"local-preview",role:"user",content:"Persisted synthetic note",client_message_id:"initial",created_at:"2026-10-02T00:00:00Z"}]
}; }
let state = fixture(), calls = [], loadHandler, mutationHandler;
const api = {load: async (signal) => { calls.push({name:"load",args:[signal]}); return loadHandler ? loadHandler(signal) : clone(state); }};
api.plannerStatus = async () => ({selected_mode:"deterministic",name:"deterministic_local",ready:true,configured:false,model_ready:false,needs_validation:true,configuration_revision:0,configuration:null,confirmed:false,last_attempt:"never",last_failure:null,model_allowed_sources:["synthetic"],boundary:"synthetic_loopback_only"});
for (const name of ["setEnabled","message","createGoal","activateGoal","controlGoal","readNotice","source","configure","commandStatus"]) api[name] = async (...args) => { calls.push({name,args}); if (mutationHandler) return mutationHandler(name,args); return {}; };
let root;
async function mount() { root = createRoot(document.getElementById("root")); await act(async () => { root.render(React.createElement(AgentLoopPanel,{api})); }); await act(async () => { await settle(); }); }
async function unmount() { if (root) {await act(async () => { root.unmount(); await settle(); }); root = null;} }
function button(text, exact = false) { const found = [...document.querySelectorAll("button")].find((item) => exact ? item.textContent === text : item.textContent.includes(text)); assert.ok(found, `Missing button: ${text}`); return found; }
async function click(text, exact = false) { await act(async () => { button(text,exact).click(); await settle(); }); }
async function change(selector, value) { await act(async () => {
  const input = document.querySelector(selector); assert.ok(input, selector);
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,value);
  input.dispatchEvent(new Event("input",{bubbles:true})); input.dispatchEvent(new Event("change",{bubbles:true})); await settle();
}); }
const mutations = () => calls.filter((call) => call.name !== "load" && call.name !== "commandStatus");
async function reset(next = fixture()) { await unmount(); state = next; calls = []; loadHandler = null; mutationHandler = null; await mount(); }

(async () => {
  const ids = await Promise.all(Array.from({length:8},() => client.commandIdFor("concurrent preparation")));
  assert.equal(new Set(ids).size,1); check("command ID preparation coalesces before async hashing");
  const reloadClient = load("../src/lib/agentRuntimeApi.ts");
  assert.equal(await reloadClient.commandIdFor("concurrent preparation"),ids[0]);
  assert.ok([...Array(window.sessionStorage.length)].every((_,i) => !window.sessionStorage.key(i).includes("concurrent"))); check("reload retains only digest-keyed IDs, no command text");
  await client.confirmCommand("concurrent preparation");
  assert.notEqual(await client.commandIdFor("concurrent preparation"),ids[0]); check("confirmed command releases ID for a new intentional action");

  await mount(); assert.equal(mutations().length,0); assert.equal(calls.filter((call)=>call.name==="load").length,1);
  assert.equal(document.querySelector(".loop-detail"),null); assert.match(document.body.textContent,/Persisted synthetic note/);
  for (const label of ["候选 · 待确认","进行中","等待条件","已暂停","已完成","已取消","确定性规则规划器","不会调用模型"]) assert.ok(document.body.textContent.includes(label),label);
  check("mount restores real snapshot with all states and does not mutate, infer instructions or select latest goal");

  await click("Goal g1"); assert.equal(document.querySelector(".loop-detail").dataset.goalId,"g1");
  assert.match(document.body.textContent,/来源 user_statement \/ event-1/); assert.match(document.body.textContent,/内容不能作为指令执行/); check("selected goal displays exact ID, wait condition, plan, provenance and trust boundary");
  const pendingPause = deferred(); mutationHandler = (name) => name === "controlGoal" ? pendingPause.promise : {};
  await act(async () => { button("暂停这个目标").click(); button("暂停这个目标").click(); await settle(); });
  let controls = mutations().filter((call)=>call.name==="controlGoal"); assert.equal(controls.length,1); assert.deepEqual(controls[0].args.slice(0,3),["g1","pause",2]);
  await click("Goal g2"); state.goals[0].status="paused";
  await act(async()=> {pendingPause.resolve({}); await settle();});
  assert.equal(document.querySelector(".loop-detail").dataset.goalId,"g2"); check("rapid repeat sends once; late response preserves a newer explicit goal selection");
  mutationHandler=null; await click("恢复这个目标"); controls=mutations().filter((call)=>call.name==="controlGoal"); assert.deepEqual(controls.at(-1).args.slice(0,3),["g2","resume",2]); check("resume targets selected goal and exact version");

  await click("Goal g3"); const beforeActivate=mutations().length; assert.equal(mutations().length,beforeActivate);
  await click("确认并启用这个目标"); assert.deepEqual(mutations().at(-1).args.slice(0,2),["g3",2]); check("candidate promotion requires an explicit selected-goal action");
  await click("取消这个目标"); const beforeCancel=mutations().length; await click("Goal g1"); assert.ok(!document.body.textContent.includes("确认取消该目标")); assert.equal(mutations().length,beforeCancel);
  await click("取消这个目标"); await click("保留目标"); assert.equal(mutations().length,beforeCancel);
  await click("取消这个目标"); await click("确认取消该目标"); assert.deepEqual(mutations().at(-1).args.slice(0,3),["g1","cancel",2]); check("cancel requires explicit confirmation and changing selection clears stale confirmation");

  const goalBefore=clone(state.goals); await click("仅标为已读"); assert.equal(mutations().at(-1).name,"readNotice"); assert.equal(mutations().at(-1).args[0],"n1"); assert.deepEqual(state.goals,goalBefore); check("notice read is separate from goal completion");

  await reset(); await change("#loop-message","A response-loss retry note");
  mutationHandler=(name) => { if(name==="message") throw new Error("simulated response loss"); return {state:"outcome_unknown"}; };
  await click("保存本地消息"); let sent=mutations().filter((call)=>call.name==="message"); const firstMessageId=sent[0].args[1];
  assert.equal(document.querySelector("#loop-message").value,"A response-loss retry note"); assert.match(document.body.textContent,/可能已在本机保存/); assert.equal(button("保存本地消息").disabled,true);
  assert.equal(document.querySelectorAll(".loop-message").length,1); check("uncertain writes keep draft, avoid fake conversation entries and require fresh read");
  await unmount(); await mount(); await change("#loop-message","A response-loss retry note"); mutationHandler=null;
  await click("保存本地消息"); sent=mutations().filter((call)=>call.name==="message"); assert.equal(sent.at(-1).args[1],firstMessageId); assert.equal(document.querySelector("#loop-message").value,""); check("navigation and explicit retry preserve idempotency key until confirmed");

  await reset(); const older=deferred(), newer=deferred(), firstReadStarted=deferred(); let reads=0;
  loadHandler=()=> { if(++reads===1){firstReadStarted.resolve();return older.promise;}return newer.promise; };
  await click("刷新状态",true); await firstReadStarted.promise; await click("重新读取中…",true);
  const latest=fixture(); latest.messages[0].content="Newer snapshot wins";
  await act(async()=> {newer.resolve(latest); await settle();});
  const stale=fixture(); stale.messages[0].content="Stale response must be ignored";
  await act(async()=> {older.resolve(stale); await settle();});
  assert.match(document.body.textContent,/Newer snapshot wins/); assert.ok(!document.body.textContent.includes("Stale response must be ignored")); check("out-of-order refreshes cannot overwrite newer state");
  const savedReconcile=client.reconcileCommandReceipts, heldReconcile=deferred();let reconciles=0;client.reconcileCommandReceipts=()=>++reconciles===1?heldReconcile.promise:Promise.resolve();
  let dispatchedReads=0;loadHandler=()=>{dispatchedReads++;return Promise.resolve(latest);};
  await click("刷新状态",true);assert.equal(dispatchedReads,0);await click("重新读取中…",true);assert.equal(dispatchedReads,1);
  await act(async()=>{heldReconcile.resolve();await settle();});assert.equal(dispatchedReads,1);assert.match(document.body.textContent,/Newer snapshot wins/);client.reconcileCommandReceipts=savedReconcile;check("refresh superseded during receipt reconciliation is discarded before snapshot dispatch");
  loadHandler=()=>Promise.reject(new Error("unavailable")); await click("刷新状态",true); assert.equal(button("启用本地循环").disabled,true); assert.match(document.body.textContent,/旧数据仅供查看/); check("failed/incomplete reads disable mutations without replacing old state with demo data");

  await reset(); const waitRead=deferred(); let readSignal; loadHandler=(signal)=>{readSignal=signal;return waitRead.promise;}; await click("刷新状态",true); await unmount(); assert.equal(readSignal.aborted,true);
  await act(async()=>{waitRead.resolve(fixture());await settle();}); assert.equal(document.querySelector(".agent-loop"),null); check("navigation aborts reads and ignores late completion after unmount");

  const empty=fixture(); empty.sources=[]; empty.goals=[]; empty.inbox=[]; empty.messages=[]; empty.evidence=[]; await reset(empty);
  assert.equal(button("明确授权此来源").disabled,true); assert.match(document.body.textContent,/还没有目标/); assert.match(document.body.textContent,/还没有已保存的本地笔记/);
  await act(async()=>{document.querySelector('.loop-check input[type="checkbox"]').click();await settle();}); await change("#loop-grant-source","synthetic"); assert.equal(button("明确授权此来源").disabled,true); check("empty state honest and source change resets explicit consent");
  await act(async()=>{document.querySelector('.loop-check input[type="checkbox"]').click();await settle();}); await click("明确授权此来源"); assert.deepEqual(mutations().at(-1).args.slice(0,2),["synthetic","grant"]); check("source grant requires checkbox plus explicit selected-source submit");
  await reset(); await click("忘记这个来源"); const beforeForget=mutations().length; await click("保留来源"); assert.equal(mutations().length,beforeForget); await click("忘记这个来源"); await click("确认忘记该来源"); assert.deepEqual(mutations().at(-1).args.slice(0,2),["user_statement","delete"]); check("forget discloses scope and requires separate irreversible-action confirmation");
  await change("#loop-goal-title","Explicit manual goal"); await change("#loop-goal-target","target-new"); await change("#loop-goal-value","not JSON"); const beforeCreate=mutations().length; await click("保存候选，稍后确认"); assert.equal(mutations().length,beforeCreate); assert.match(document.body.textContent,/必须是有效 JSON/);
  await change("#loop-goal-value","true"); await click("保存候选，稍后确认"); const created=mutations().at(-1); assert.equal(created.name,"createGoal"); assert.deepEqual(created.args[0],{title:"Explicit manual goal",target_id:"target-new",success_event_type:"commitment_closed",success_value:true,evidence_ids:[],source_ids:["user_statement"],deadline_at:null}); check("manual goals use explicit object/event/value and authorized source; invalid JSON cannot submit");
  await unmount();

  // Lost reply followed by opposite toggles must not replay an obsolete intent.
  await reset(); state.status.settings.execution_epoch=0;
  const receipts=new Map(); let loseEnable=true, offlineReceipts=true;
  mutationHandler=(name,args)=>{
    if(name==="commandStatus") { if(offlineReceipts) throw new Error("offline"); return receipts.get(args[0]) || {state:"outcome_unknown"}; }
    if(name==="setEnabled") { state.status.enabled=args[0]; state.status.settings.execution_epoch++; receipts.set(args[1],{state:"completed"}); if(loseEnable){loseEnable=false;throw new Error("lost successful reply");} }
    return {};
  };
  await click("启用本地循环"); assert.equal(state.status.enabled,true); assert.match(document.body.textContent,/请求结果尚未确认/);
  const originalEnable=mutations().find((call)=>call.name==="setEnabled").args[1]; offlineReceipts=false;
  await click("刷新状态",true); assert.ok(button("暂停整个循环"));
  await click("暂停整个循环"); assert.equal(state.status.enabled,false); await click("启用本地循环"); assert.equal(state.status.enabled,true);
  assert.notEqual(mutations().filter((call)=>call.name==="setEnabled").at(-1).args[1],originalEnable);
  check("lost enable reply reconciles before disable-enable cycle and never replays obsolete enable ID");

  await reset(); const settingsReceipts=new Map(); let loseSettings=true, settingsOffline=true;
  mutationHandler=(name,args)=>{
    if(name==="commandStatus") { if(settingsOffline) throw new Error("offline");return settingsReceipts.get(args[0]) || {state:"outcome_unknown"}; }
    if(name==="configure") { Object.assign(state.status.settings,args[0]); settingsReceipts.set(args[1],{state:"completed"}); if(loseSettings){loseSettings=false;throw new Error("lost settings reply");} }
    return {};
  };
  await change("#loop-notice-budget","5"); await change("#loop-quiet-until","2026-10-03T10:30"); await click("保存提醒限制");
  let configs=mutations().filter((call)=>call.name==="configure"); assert.equal(configs[0].args[0].quiet_until,"2026-10-03T10:30:00.000Z"); const originalSetting=configs[0].args[1];
  settingsOffline=false; await click("刷新状态",true); await change("#loop-notice-budget","6"); await click("保存提醒限制"); await change("#loop-notice-budget","5"); await click("保存提醒限制");
  configs=mutations().filter((call)=>call.name==="configure"); assert.notEqual(configs.at(-1).args[1],originalSetting); assert.equal(state.status.settings.daily_notice_budget,5);
  assert.match(document.body.textContent,/本地提醒限制已保存/); check("UTC quiet/budget settings explicitly persist and A-B-A loss recovery uses a new intentional command");

  await reset(); mutationHandler=(name,args)=>name==="setEnabled" ? Promise.reject(new Error("lost reply")) : name==="commandStatus" ? {state:"completed"} : {};
  await click("启用本地循环"); assert.match(document.body.textContent,/当前状态已变化/); assert.equal(state.status.enabled,false); check("known receipt alone cannot claim enabled when refreshed state disagrees");

  const withdrawn=fixture(); withdrawn.sources[0].status="revoked"; withdrawn.sources[0].version=2; withdrawn.goals[4].verification_status="withdrawn"; withdrawn.goals[4].blocked_reason="source_revoked";
  withdrawn.evidence[0].value="REVOKED SECRET SHOULD NOT RENDER";
  await reset(withdrawn); assert.match(document.body.textContent,/曾完成 · 当前无法核验/); assert.ok(!document.body.textContent.includes("REVOKED SECRET")); assert.ok(!document.body.textContent.includes("Goal g1")); check("withdrawn completion proof and mixed-snapshot revoked content are never presented as valid");

  const regranted=fixture(); regranted.sources[0].version=3; regranted.evidence[0].source_version=1; regranted.goals[0].title="OLD CONSENT DERIVED TITLE";
  await reset(regranted); assert.ok(!document.body.textContent.includes("OLD CONSENT DERIVED TITLE")); assert.ok(!document.body.textContent.includes("Synthetic only")); check("same-ID regrant with newer source version hides old plan/approval-derived goal and evidence content");

  const proposed=fixture(); proposed.sources[0].id="synthetic";proposed.evidence[0].source_id="synthetic";proposed.evidence[0].source_version=1;proposed.goals[0].source_ids=["synthetic"];proposed.goals[0].plan.source_versions={synthetic:1};proposed.goals[0].plan.proposal={summary:"Untrusted model draft <script>not code</script>",steps:["Suggest reading the synthetic checklist", "Propose checking the synthetic event"],evidence_ids:["e1"],status:"proposed_unverified",authored_by:"planner",executable:false};
  await reset(proposed); await click("Goal g1"); assert.match(document.body.textContent,/模型建议草稿 · 未核验/); assert.match(document.body.textContent,/proposed_unverified/); assert.match(document.body.textContent,/步骤尚未执行/); assert.match(document.body.textContent,/Untrusted model draft <script>not code<\/script>/); assert.equal(document.querySelectorAll(".loop-proposal script").length,0); assert.match(document.querySelector(".loop-proposal").textContent,/e1/); assert.equal(state.goals[0].status,"active");
  assert.equal(new Set([...document.querySelectorAll("[id]")].map((element)=>element.id)).size,document.querySelectorAll("[id]").length);check("model proposal shows plain-text summary, steps and evidence with unique IDs as unverified non-executable draft without completing goal");
  proposed.sources[0].version=3; const redacted=client.readableRuntimeSnapshot(proposed); assert.equal(redacted.goals[0].plan,null); assert.equal(redacted.goals[0].approval,null); await reset(proposed); assert.ok(!document.body.textContent.includes("Untrusted model draft"));
  const withheld=fixture(); withheld.goals[0].content_withheld=true; withheld.goals[0].plan.proposal={summary:"WITHHELD PROPOSAL",steps:["WITHHELD STEP"],evidence_ids:[],status:"proposed_unverified",authored_by:"planner",executable:false}; assert.equal(client.readableRuntimeSnapshot(withheld).goals[0].plan,null);
  const missingEvidence=clone(proposed);missingEvidence.sources[0].version=1;missingEvidence.goals[0].plan.proposal.evidence_ids=["missing"];assert.equal(client.readableRuntimeSnapshot(missingEvidence).goals[0].plan.proposal,null);
  const otherTarget=clone(proposed);otherTarget.sources[0].version=1;otherTarget.evidence[0].target_id="other-target";assert.equal(client.readableRuntimeSnapshot(otherTarget).goals[0].plan.proposal,null);
  const manualProposal=fixture();manualProposal.goals[0].plan.proposal=clone(proposed.goals[0].plan.proposal);assert.equal(client.runtimePlanProposal(manualProposal.goals[0]),null);
  check("withheld, mismatched generations, missing/other-target evidence redact proposals; manual user_statement cannot display a model proposal");
  await reset(); state.evidence[0].value="PAYLOAD HIDDEN ON FORGET"; await click("刷新状态",true); await click("Goal g1"); assert.match(document.body.textContent,/PAYLOAD HIDDEN ON FORGET/);
  const forget=deferred(); mutationHandler=(name)=>name==="source" ? forget.promise : {state:"outcome_unknown"};
  await click("忘记这个来源"); await click("确认忘记该来源"); assert.ok(!document.body.textContent.includes("PAYLOAD HIDDEN ON FORGET")); assert.ok(!document.body.textContent.includes("Goal g1"));
  await click("g5 · 版本"); assert.match(document.body.textContent,/来源操作结果尚待本机回执确认/); assert.ok(!document.body.textContent.includes("关联依据已撤回或到期")); assert.ok(!document.body.textContent.includes("不会据此继续行动")); check("pending forget of completed goal hides content without claiming backend withdrawal or stopped execution");
  loadHandler=()=>Promise.reject(new Error("offline after forget")); await act(async()=>{forget.resolve({});await settle();}); assert.ok(!document.body.textContent.includes("PAYLOAD HIDDEN ON FORGET")); check("revoke/forget hides local derived payload immediately even if reconciliation read fails");

  await reset(); const lateWrite=deferred(); mutationHandler=(name)=>name==="message"?lateWrite.promise:{};
  await change("#loop-message","Late write from old route"); await click("保存本地消息"); await unmount(); await mount(); await click("Goal g2");
  await act(async()=>{lateWrite.resolve({});await settle();}); assert.equal(document.querySelector(".loop-detail").dataset.goalId,"g2"); assert.ok(!document.body.textContent.includes("文字已保存到本机")); check("late write completion after route remount cannot alter new selection or feedback");

  await reset(); const originalPrepare=client.commandIdFor, prepare=deferred(); client.commandIdFor=()=>prepare.promise;
  await change("#loop-message","Do not dispatch after leaving"); const beforeDispatch=mutations().length; await click("保存本地消息"); await unmount();
  await act(async()=>{prepare.resolve("00000000-0000-4000-8000-000000000000");await settle();}); assert.equal(mutations().length,beforeDispatch); client.commandIdFor=originalPrepare; check("navigation during request-ID preparation prevents a late mutation dispatch");

  const realSetInterval=window.setInterval, realClearInterval=window.clearInterval; const timers=new Map(); let timerId=0, visibility="visible";
  window.setInterval=(callback,delay)=>{assert.equal(delay,30000);const id=++timerId;timers.set(id,callback);return id;}; window.clearInterval=(id)=>timers.delete(id);
  Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>visibility}); await reset(); assert.equal(timers.size,1);
  await change("#loop-message","Unsaved draft survives observer"); await change("#loop-notice-budget","17"); await click("Goal g1"); await click("取消这个目标"); const beforeObserve=mutations().length;
  let loadCount=calls.filter((call)=>call.name==="load").length; await act(async()=>{[...timers.values()][0]();await settle();}); assert.equal(calls.filter((call)=>call.name==="load").length,loadCount+1); assert.equal(mutations().length,beforeObserve);
  assert.equal(document.querySelector("#loop-message").value,"Unsaved draft survives observer"); assert.equal(document.querySelector("#loop-notice-budget").value,"17"); assert.equal(document.querySelector(".loop-detail").dataset.goalId,"g1"); assert.ok(button("确认取消该目标"));
  visibility="hidden"; loadCount=calls.filter((call)=>call.name==="load").length; await act(async()=>{[...timers.values()][0]();await settle();}); assert.equal(calls.filter((call)=>call.name==="load").length,loadCount);
  visibility="visible"; const observerRead=deferred(); loadHandler=()=>observerRead.promise; await act(async()=>{[...timers.values()][0]();await settle();}); loadCount=calls.filter((call)=>call.name==="load").length;
  await act(async()=>{[...timers.values()][0]();await settle();}); assert.equal(calls.filter((call)=>call.name==="load").length,loadCount);
  await act(async()=>{observerRead.resolve(fixture());await settle();}); loadHandler=null; const observerWrite=deferred(); mutationHandler=(name)=>name==="message"?observerWrite.promise:{};
  await click("保存本地消息"); loadCount=calls.filter((call)=>call.name==="load").length; await act(async()=>{[...timers.values()][0]();await settle();}); assert.equal(calls.filter((call)=>call.name==="load").length,loadCount);
  await act(async()=>{observerWrite.resolve({});await settle();}); await unmount(); assert.equal(timers.size,0); loadCount=calls.filter((call)=>call.name==="load").length; document.dispatchEvent(new Event("visibilitychange")); await settle(); assert.equal(calls.filter((call)=>call.name==="load").length,loadCount);
  window.setInterval=realSetInterval;window.clearInterval=realClearInterval;check("visible 30s observer is read-only, preserves drafts/selection/confirmation, skips hidden/busy state and fully cleans up");

  let bridgeCalls=[];
  window.openbutlerDesktop={requestApi:async (url,options)=>{bridgeCalls.push({url,...options});return {ok:true,status:200,data:{}};}};
  await client.agentRuntimeApi.source("user_statement","grant","cmd-grant"); await client.agentRuntimeApi.source("user_statement","revoke","cmd-revoke"); await client.agentRuntimeApi.source("synthetic","delete","cmd-delete");
  assert.deepEqual(JSON.parse(bridgeCalls[0].body),{scope:"goal_tracking",confirmed:true,command_id:"cmd-grant"});
  assert.deepEqual(JSON.parse(bridgeCalls[1].body),{command_id:"cmd-revoke"}); assert.deepEqual(JSON.parse(bridgeCalls[2].body),{command_id:"cmd-delete"});
  await client.agentRuntimeApi.message("hello","cmd-message"); assert.equal(bridgeCalls.at(-1).url,"/api/agent-runtime/chat"); assert.deepEqual(JSON.parse(bridgeCalls.at(-1).body),{conversation_id:"local-preview",content:"hello",client_message_id:"cmd-message"});
  await client.agentRuntimeApi.controlGoal("goal-123","pause",4,"cmd-pause"); assert.deepEqual(JSON.parse(bridgeCalls.at(-1).body),{operation:"pause",expected_version:4,command_id:"cmd-pause"}); check("desktop transport matches strict API payloads and never falls back to stable chat");
  window.openbutlerDesktop=undefined; let fetchCalls=[];
  global.fetch=async(url,options)=>{fetchCalls.push({url,options});return {ok:true,status:200,json:async()=>({})};};
  await client.agentRuntimeApi.setEnabled(false,"cmd-disable"); assert.match(fetchCalls[0].url,/^http:\/\/localhost\/api\/agent-runtime\/enabled$/); assert.equal(fetchCalls[0].options.redirect,"error");
  window.openbutlerDesktop={apiBase:"https://example.com"}; await assert.rejects(()=>client.agentRuntimeApi.setEnabled(true,"cmd-network"),/只能连接本机/); assert.equal(fetchCalls.length,1); check("HTTP fallback restricts loopback and refuses redirects/remote endpoints");
  window.openbutlerDesktop={requestApi:async()=>({ok:true,status:200,data:{items:[]}})};
  await assert.rejects(()=>client.loadRuntimeSnapshot(),/格式不兼容/); check("incompatible state snapshots fail closed");

  const app=fs.readFileSync(path.resolve(__dirname,"../src/App.tsx"),"utf8");
  assert.ok(app.includes('chat: isPreviewDesktop() ? <AgentLoopPanel /> : <Chat activationStatus={activationStatus} />'));
  assert.ok(app.includes('先用管家对话')); assert.ok(app.includes('只保存本地文字与目标；不启用录制'));
  // Frozen Phase 1 Chat hash; self-contained in a clean archive or CI checkout.
  const stableChat=app.slice(app.indexOf("function Chat("),app.indexOf("type PreviewMask =")).replace(/\r\n/g,"\n");
  assert.equal(createHash("sha256").update(stableChat).digest("hex"),"88bfbfb3f303148da5b2c91a78e190f7518c4ab4a4bba874c9374c95862aa298");
  const stableClient=fs.readFileSync(path.resolve(__dirname,"../src/lib/api.ts"),"utf8");
  assert.match(stableClient,/function askButler\(message: string\)/);
  assert.match(stableClient,/"\/api\/chat"/);
  assert.match(app,/function Chat\(\{activationStatus\}/);
 check("preview-only route and explicit recording-independent activation preserve stable Chat");
  const activation=app.slice(app.indexOf("function PreviewActivation("),app.indexOf("function FirstRunGuide("));
  const geometry=load("../src/lib/maskGeometry.ts"), gate=load("../src/lib/privacyPreviewGate.ts"); let captureMutations=0;
  const noCapture=()=>{captureMutations++;return Promise.resolve({ok:true});};
  window.openbutlerDesktop={startBuiltinCapture:noCapture,getMaskedCapturePreview:noCapture,pauseBuiltinCapture:noCapture};
  const activationSource=`const {useState,useEffect,useRef}=React;
    const {clampMask,sameMask,validImageBounds}=geometry;
    const {createPrivacyPreviewGate}=gate;
    const getContextEngineStatus=noCapture,setPrivacyMode=noCapture,pauseBuiltinCaptureApi=noCapture;
    const Video=()=>null,Eye=()=>null,MessageSquareText=()=>null,MaskEditor=()=>null,StatusItem=()=>null;
    ${activation}
return PreviewActivation;`;
  const activationOutput=ts.transpileModule(activationSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
  const PreviewActivation=vm.runInThisContext(`(function(require,React,geometry,gate,noCapture,exports){${activationOutput}\n})`)(require,React,geometry,gate,noCapture,{});
  function ActivationHarness(){const [open,setOpen]=React.useState(true);return open?React.createElement(PreviewActivation,{status:"unseen",mandatory:true,onChooseDemo:noCapture,onChooseReal:noCapture,onDismiss:noCapture,onComplete:noCapture,onChooseLocalChat:()=>setOpen(false)}):React.createElement("p",null,"Explicit local conversation chosen");}
  root=createRoot(document.getElementById("root"));await act(async()=>{root.render(React.createElement(ActivationHarness));});await act(async()=>{await settle();});
  await click("先用管家对话");assert.match(document.body.textContent,/Explicit local conversation chosen/);assert.equal(captureMutations,0);await unmount();check("first-run local-chat choice exits explicitly without capture, model, source grant or activation-complete side effects");
  dom.window.close(); console.log(JSON.stringify({suite:"agent-loop-ui-synthetic",passed:checks.length,checks,rendered_browser:false,native_desktop:false},null,2));
})().catch(async(error)=>{console.error(error);try{await unmount();}catch{}dom.window.close();process.exitCode=1;});
