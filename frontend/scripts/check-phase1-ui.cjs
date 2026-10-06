"use strict";
// DOM-level synthetic component checks; not a rendered browser/desktop acceptance test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {JSDOM} = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url: "http://localhost/"});
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent"]) global[key] = dom.window[key];
Object.defineProperty(global, "navigator", {value: dom.window.navigator, configurable: true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react");
const {act} = React;
const {createRoot} = require("react-dom/client");

let calls = [], responder;
const api = {generateDailyReview: async (day, timezone) => { calls.push({day, timezone}); return responder(day, timezone); }};
const filename = path.resolve(__dirname, "../src/components/PreviewDailyReview.tsx");
const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText;
const loaded = {exports: {}};
const execute = vm.runInThisContext(`(function(require,module,exports){${output}\n})`, {filename});
execute((name) => name === "../lib/api" ? api : require(name), loaded, loaded.exports);
const {PreviewDailyReview} = loaded.exports;
const root = createRoot(document.getElementById("root"));
const checks = [];
const check = (name) => checks.push(name);
const flush = () => new Promise((done) => setImmediate(done));
async function render(props = {}) { await act(async () => { root.render(React.createElement(PreviewDailyReview, {recordRevision: "r1", authorized: true, ...props})); await flush(); }); }
function button(text) { const value = [...document.querySelectorAll("button")].find((item) => item.textContent.includes(text)); assert.ok(value, `Missing button ${text}`); return value; }
async function click(text) { await act(async () => { button(text).click(); await flush(); }); }
async function change(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    await flush();
  });
}
function result(day, timezone) { return {
  status: "ready", reason: null, day, timezone, generated_at: new Date().toISOString(), boundary: "仅覆盖有依据的观察点。",
  counts: {total: 5, ready: 3, pending: 1, failed: 1, expired_evidence: 0, missing_evidence: 0, invalid_records: 0, eligible: 3, included: 2, omitted: 1},
  coverage: {requested_start: day+"T00:00:00Z", requested_end: day+"T23:59:59Z", evaluated_until: day+"T13:00:00Z", observed_start: day+"T09:00:00Z", observed_end: day+"T12:00:00Z", observation_count: 5, gap_threshold_seconds: 900, gaps: [{start: day+"T09:00:00Z", end: day+"T12:00:00Z", seconds: 10800}], gap_count: 1, gaps_truncated: false},
  truncated: true, conclusions: [{text: "Two synthetic activities summarized together", evidence_refs: [{observation_id: "00000000-0000-4000-8000-000000000001", evidence_id: "00000000-0000-4000-8000-000000000002", captured_at: day+"T09:00:00Z"}]}]
}; }

(async () => {
  responder = async (day, timezone) => result(day, timezone);
  await render();
  assert.equal(calls.length, 0); check("mount does not call model or daily-review API");
  await click("生成这一天");
  assert.equal(calls.length, 1);
  for (const text of ["Two synthetic activities", "待整理 1", "失败 1", "本次纳入 2", "不是完整的全天总结", "观察空缺"]) assert.ok(document.body.textContent.includes(text), text);
  check("manual review displays cross-record conclusion, provenance controls, state counts, gaps and limit");
  let evidenceCalls = 0;
  window.openbutlerDesktop = {getMaskedEvidence: async () => { evidenceCalls++; return {ok:false,error:"expired"}; }};
  await click("查看依据");
  assert.equal(evidenceCalls,1); assert.match(document.body.textContent,/依据已过期、被删除或暂不可用/);
  check("expired evidence is explicit and never rendered as available");
  await render({recordRevision: "r2"});
  assert.equal(document.querySelector(".daily-review-conclusions"), null);
  check("changed records invalidate existing ephemeral review");

  let resolveRequest;
  responder = (day, timezone) => new Promise((resolve) => { resolveRequest = () => resolve(result(day, timezone)); });
  const before = calls.length;
  await act(async () => { button("生成这一天").click(); button("生成这一天").click(); await flush(); });
  assert.equal(calls.length, before+1); check("rapid repeated clicks dispatch once");
  const date = document.querySelector('input[type="date"]');
  await change(date, "2026-09-25");
  await act(async () => { resolveRequest(); await flush(); });
  assert.equal(document.querySelector(".daily-review-conclusions"), null);
  check("scope edit invalidates late result");
  await click("生成这一天");
  await render({recordRevision:"r3"});
  await act(async () => { resolveRequest(); await flush(); });
  assert.equal(document.querySelector(".daily-review-conclusions"), null);
  check("record revision invalidates in-flight result");

  await render({recordRevision:"r4", authorized:false});
  assert.equal(button("生成这一天").disabled,true);
  assert.match(document.body.textContent,/授权尚未建立或已撤销/);
  check("revoked consent disables generation without resuming capture");
  await render({recordRevision:"r5"});
  responder = async (day, timezone) => ({...result(day,timezone),status:"empty",conclusions:[],reason:"no_records"});
  await click("生成这一天"); assert.match(document.body.textContent,/没有调用模型/); assert.equal(document.querySelector(".daily-review-conclusions"),null);
  check("empty response is explicit and has no fabricated conclusions");
  responder = async () => { throw new Error("synthetic failure"); };
  await click("重新生成"); assert.match(document.body.textContent,/没有生成结论/); assert.equal(document.querySelector(".daily-review-conclusions"),null);
  check("failed retry clears old conclusions and shows retry guidance");
  await act(async () => root.unmount()); dom.window.close();
  console.log(JSON.stringify({suite:"phase1-daily-review-dom",passed:checks.length,checks,rendered_browser:false},null,2));
})().catch((error) => { console.error(error); process.exitCode=1; dom.window.close(); });
