import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import ts from "typescript";

// Isolated hook/JSX harness: exercises the real component with synthetic IPC only.
// No browser, credentials, native capture, provider calls or persistence is used.
const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
const source = app.slice(app.indexOf("type PreviewModelRoute = "), app.indexOf("function PreviewActivation("));
const compiled = ts.transpileModule("const ModelCatalog = () => null;\n" + source, {compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React}}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const localRoute = {mode: "local", protocol: "ollama_native", endpoint: "http://127.0.0.1:11434", model: "synthetic", apiKeyConfigured: false};
const customRoute = {...localRoute, mode: "custom", protocol: "openai_compatible", endpoint: "https://example.com/v1", apiKeyConfigured: true};
const savedResult = (route = localRoute, ready = false) => ({ready, savedConfigurationAvailable: true, requiresRevalidation: !ready, routes: {image: {...route}, text: {...route}}, external_consent: route.mode === "custom", masked_data_consent: route.mode === "custom"});

function harness(bridge, onSaved = async () => {}) {
  const slots = [], effects = [];
  let cursor = 0, first = true, tree;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => {slots[index] = typeof next === "function" ? next(slots[index]) : next;}];
  };
  const useEffect = (effect) => { if (first) effects.push(effect); };
  const React = {createElement: (type, props, ...children) => ({type, props: props || {}, children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)})};
  const {PreviewModelSettings, readPreviewModelConfiguration, previewModelFailure} = new Function("useState", "useEffect", "React", "KeyRound", "window", `${compiled}; return {PreviewModelSettings, readPreviewModelConfiguration, previewModelFailure};`)(useState, useEffect, React, () => null, {openbutlerDesktop: bridge});
  function render() { cursor = 0; tree = PreviewModelSettings({onSaved}); first = false; return tree; }
  function nodes(node = tree) { return typeof node !== "object" ? [] : [node, ...node.children.flatMap(nodes)]; }
  function content(node = tree) { return typeof node !== "object" ? String(node) : node.children.map(content).join(""); }
  function field(name) { const value = nodes().find((node) => node.props.name === name); assert.ok(value, `Field ${name} exists`); return value; }
  function button(label) { const value = nodes().find((node) => node.type === "button" && content(node) === label); assert.ok(value, `Button ${label} exists`); return value; }
  function change(name, value) { field(name).props.onChange({target: {value, checked: value}}); render(); }
  function click(label) { const value = button(label); assert.ok(!value.props.disabled, `${label} enabled`); value.props.onClick(); render(); }
  render();
  const cleanup = effects.map((effect) => effect());
  return {render, nodes, content, field, button, change, click, cleanup: () => cleanup.forEach((fn) => fn?.()), readPreviewModelConfiguration, previewModelFailure};
}
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await test("web preview reports unavailable without calling model IPC", async () => {
  const h = harness(undefined); await settle(); h.render();
  assert.equal(h.nodes()[0].type, "section");
  assert.equal(h.nodes()[0].props.id, "preview-model-settings");
  assert.equal(h.nodes()[0].props.tabIndex, -1);
  assert.match(h.content(), /暂不可用/);
  assert.match(h.content(), /桌面版/);
  assert.ok(h.button("测试并保存").props.disabled);
});

await test("unconfigured local settings require complete fields and no automatic validation", async () => {
  let calls = 0;
  const h = harness({getBuiltinModelRoutes: async () => ({ready: false}), saveBuiltinModelRoutes: async () => {calls++; return {ok: true};}});
  await settle(); h.render(); assert.match(h.content(), /未配置/); assert.equal(calls, 0);
  h.click("测试并保存"); await settle(); h.render();
  assert.equal(calls, 0); assert.match(h.content(), /请填写图像和文字/);
  assert.ok(!h.nodes().some((node) => node.props.name === "external-model-consent"));
});

await test("saved fields restore without exposing secret; manual validate uses omitted key", async () => {
  let calls = 0, payload, refreshes = 0;
  const result = savedResult(customRoute); result.routes.image.api_key = "must-never-be-read-back";
  const h = harness({getBuiltinModelRoutes: async () => result, saveBuiltinModelRoutes: async (value) => {calls++; payload = value; return {ok: true, status: {ready: true}};}}, async () => {refreshes++;});
  await settle(); h.render();
  assert.match(h.content(), /已保存，待验证/); assert.equal(calls, 0);
  assert.equal(h.field("image-endpoint").props.value, customRoute.endpoint);
  assert.equal(h.field("image-api-key").props.value, "");
  assert.equal(h.field("image-api-key").props.placeholder, "已保存，留空可复用");
  assert.ok(!JSON.stringify(h.nodes()).includes("must-never-be-read-back"));
  h.click("重新测试"); await settle(); h.render();
  assert.equal(calls, 1); assert.equal(refreshes, 1);
  assert.ok(!("api_key" in payload.image)); assert.ok(!("apiKeyConfigured" in payload.image));
  assert.match(h.content(), /测试通过，已加密保存/);
  assert.match(h.content(), /不会自动开始或恢复/);
});

await test("late initial read preserves edits and does not restore old consent", async () => {
  const read = deferred();
  const h = harness({getBuiltinModelRoutes: () => read.promise, saveBuiltinModelRoutes: async () => ({ok: true, status: {ready: true}})});
  h.change("image-mode", "custom"); h.change("image-endpoint", "https://new.example/v1"); h.change("image-model", "new-model");
  read.resolve(savedResult(customRoute)); await settle(); h.render();
  assert.equal(h.field("image-endpoint").props.value, "https://new.example/v1");
  assert.equal(h.field("image-model").props.value, "new-model");
  assert.equal(h.field("external-model-consent").props.checked, false);
  assert.match(h.content(), /修改未保存，请先测试/);
  h.click("恢复已保存配置"); h.render();
  assert.equal(h.field("image-endpoint").props.value, customRoute.endpoint);
  assert.equal(h.field("image-api-key").props.value, "");
});

await test("manual reread preserves an existing draft", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(), saveBuiltinModelRoutes: async () => ({ok: true})});
  await settle(); h.render(); h.change("image-model", "edited-model");
  h.click("刷新状态"); await settle(); h.render();
  assert.equal(h.field("image-model").props.value, "edited-model");
  assert.match(h.content(), /修改未保存，请先测试/);
});

await test("same-tick repeated validation sends only one request and blocks fields", async () => {
  const save = deferred(); let calls = 0;
  const h = harness({getBuiltinModelRoutes: async () => savedResult(), saveBuiltinModelRoutes: () => {calls++; return save.promise;}});
  await settle(); h.render();
  const click = h.button("重新测试").props.onClick; click(); click(); h.render();
  assert.equal(calls, 1); assert.ok(h.button("测试中").props.disabled);
  assert.ok(h.nodes().filter((node) => node.type === "fieldset").every((node) => node.props.disabled));
  save.resolve({ok: true, status: {ready: true}}); await settle(); h.render();
  assert.ok(!h.button("重新测试").props.disabled);
});

await test("failed edits retain previous ready configuration and permit safe restoration", async () => {
  const payloads = []; let refreshes = 0;
  const h = harness({getBuiltinModelRoutes: async () => savedResult(localRoute, true), saveBuiltinModelRoutes: async (payload) => {payloads.push(payload); return {ok: false, error: "模型验证未通过，请检查连接和授权。", error_code: "image_probe_failed"};}}, async () => {refreshes++;});
  await settle(); h.render(); h.change("image-model", "bad-model"); h.click("测试并保存"); await settle(); h.render();
  assert.match(h.content(), /上次配置可用/); assert.match(h.content(), /图像模型未通过测试/);
  assert.match(h.content(), /上次保存的配置仍保留/); assert.equal(refreshes, 1);
  h.click("恢复已保存配置"); assert.equal(h.field("image-model").props.value, localRoute.model);
  h.click("重新测试"); await settle(); assert.equal(payloads[1].image.model, localRoute.model);
});

await test("endpoint change clears entered key and consent; no old key sent", async () => {
  const payloads = [];
  const h = harness({getBuiltinModelRoutes: async () => savedResult(customRoute, true), saveBuiltinModelRoutes: async (payload) => {payloads.push(payload); return {ok: true, status: {ready: true}};}});
  await settle(); h.render(); h.change("image-api-key", "synthetic-entered-key");
  h.change("image-endpoint", "https://new.example/v1");
  assert.equal(h.field("image-api-key").props.value, ""); assert.equal(h.field("external-model-consent").props.checked, false);
  assert.equal(h.field("masked-model-consent").props.checked, false);
  assert.equal(h.field("image-api-key").props.placeholder, "服务需要时填写");
  h.click("测试并保存"); await settle(); h.render(); assert.equal(payloads.length, 0);
  h.change("external-model-consent", true); h.change("masked-model-consent", true);
  h.click("测试并保存"); await settle(); h.render();
  assert.equal(payloads.length, 1); assert.ok(!("api_key" in payloads[0].image));
  assert.ok(!h.content().includes("synthetic-entered-key"));
});

await test("protocol change also revokes draft destination consent and key reuse", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(customRoute), saveBuiltinModelRoutes: async () => ({ok: true})});
  await settle(); h.render(); h.change("image-api-key", "synthetic-key"); h.change("image-protocol", "ollama_native");
  assert.equal(h.field("image-api-key").props.value, ""); assert.equal(h.field("external-model-consent").props.checked, false);
  assert.equal(h.field("image-api-key").props.placeholder, "服务需要时填写");
});

await test("unknown errors and prototype names never expose provider payloads", async () => {
  const h = harness(undefined);
  const unknown = h.previewModelFailure({error: "secret-synthetic", error_code: "secret-synthetic"});
  assert.ok(!unknown.includes("secret-synthetic"));
  assert.equal(typeof h.previewModelFailure({error: "constructor", error_code: "toString"}), "string");
  assert.match(h.previewModelFailure({error_code: "provider_connection_failed"}), /无法连接模型服务/);
  assert.equal(h.readPreviewModelConfiguration(savedResult(customRoute)).image.api_key, "");
});

await test("failed first validation shows unavailable while retaining entered fields", async () => {
  const h = harness({getBuiltinModelRoutes: async () => ({ready: false}), saveBuiltinModelRoutes: async () => ({ok: false, error: "模型验证未通过，请检查连接和授权。", error_code: "provider_connection_failed"})});
  await settle(); h.render(); h.change("image-model", "vision-test"); h.change("text-model", "text-test"); h.click("测试并保存");
  await settle(); h.render(); assert.match(h.content(), /暂不可用/); assert.equal(h.field("image-model").props.value, "vision-test");
});

await test("load failure can recover without model validation", async () => {
  let reads = 0, writes = 0;
  const h = harness({getBuiltinModelRoutes: async () => ++reads === 1 ? {ready: false, error_code: "local_service_unavailable"} : savedResult(), saveBuiltinModelRoutes: async () => {writes++; return {ok: true};}});
  await settle(); h.render(); assert.match(h.content(), /无法读取模型配置/);
  h.click("刷新状态"); await settle(); h.render();
  assert.match(h.content(), /已保存，待验证/); assert.equal(writes, 0);
});

await test("successful save remains saved if surrounding status refresh fails", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(), saveBuiltinModelRoutes: async () => ({ok: true, status: {ready: true}})}, async () => {throw new Error("synthetic refresh failure");});
  await settle(); h.render(); h.click("重新测试"); await settle(); h.render();
  assert.match(h.content(), /模型配置已保存，但录制状态刷新失败/);
  assert.ok(h.nodes().some((node) => node.props.className === "preview-model-state ready"));
});

await test("uncertain IPC result does not claim the old ready state", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(localRoute, true), saveBuiltinModelRoutes: async () => {throw new Error("synthetic interruption");}});
  await settle(); h.render(); h.click("重新测试"); await settle(); h.render();
  assert.match(h.content(), /暂不可用/); assert.match(h.content(), /保存结果未确认/);
});

await test("disk-save failure after backend switch is reread and never labeled old-ready", async () => {
  let reads = 0, activeModel = "synthetic", fails = true;
  const h = harness({
    getBuiltinModelRoutes: async () => {reads++; return {...savedResult(localRoute, true), image: {...localRoute, model: activeModel}, text: localRoute};},
    saveBuiltinModelRoutes: async (payload) => {
      activeModel = payload.image.model;
      return fails ? {ok: false, error: "模型配置未保存，请检查本机服务和密钥存储。"} : {ok: true, status: {ready: true}};
    },
  });
  await settle(); h.render(); h.change("image-model", "new-active-model"); h.click("测试并保存");
  await settle(); h.render();
  assert.equal(reads, 2); assert.equal(activeModel, "new-active-model");
  assert.match(h.content(), /当前运行配置可能与存档不同/);
  assert.ok(!h.nodes().some((node) => node.props.className === "preview-model-state ready"));
  assert.equal(h.field("image-model").props.value, "new-active-model");
  h.click("刷新状态"); await settle(); h.render();
  assert.match(h.content(), /是否一致尚未确认/);
  assert.ok(!h.nodes().some((node) => node.props.className === "preview-model-state ready"));
  fails = false; h.click("测试并保存"); await settle(); h.render();
  assert.ok(h.nodes().some((node) => node.props.className === "preview-model-state ready"));
});

await test("fresh mount detects nonsecret active and saved route mismatch", async () => {
  const h = harness({getBuiltinModelRoutes: async () => ({...savedResult(localRoute, true), image: {...localRoute, model: "different-active-model"}, text: localRoute}), saveBuiltinModelRoutes: async () => ({ok: true, status: {ready: true}})});
  await settle(); h.render();
  assert.match(h.content(), /暂不可用/);
  assert.match(h.content(), /是否一致尚未确认/);
  assert.equal(h.field("image-model").props.value, localRoute.model);
  assert.ok(!h.nodes().some((node) => node.props.className === "preview-model-state ready"));
});

await test("fresh mount honors desktop persistence uncertainty for key-only mismatch", async () => {
  const h = harness({getBuiltinModelRoutes: async () => ({...savedResult(customRoute, true), image: customRoute, text: customRoute, persistenceUncertain: true, requiresRevalidation: true}), saveBuiltinModelRoutes: async () => ({ok: true, status: {ready: true}})});
  await settle(); h.render();
  assert.match(h.content(), /暂不可用/); assert.match(h.content(), /是否一致尚未确认/);
  assert.ok(!h.nodes().some((node) => node.props.className === "preview-model-state ready"));
  h.click("重新测试"); await settle(); h.render();
  assert.ok(h.nodes().some((node) => node.props.className === "preview-model-state ready"));
});

await test("main-process busy rejection offers retry without claiming old config ready", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(localRoute, true), saveBuiltinModelRoutes: async () => ({ok: false, error: "模型配置正在验证或保存，请等待完成后重试。", error_code: "model_routes_save_in_progress"})});
  await settle(); h.render(); h.click("重新测试"); await settle(); h.render();
  assert.match(h.content(), /另一次模型配置仍在验证或保存/);
  assert.match(h.content(), /等待完成后重新读取状态/);
  assert.ok(!h.nodes().some((node) => node.props.className === "preview-model-state ready"));
});

await test("unmount ignores a late read and does not trigger validation or refresh", async () => {
  const read = deferred(); let calls = 0;
  const h = harness({getBuiltinModelRoutes: () => read.promise, saveBuiltinModelRoutes: async () => {calls++; return {ok: true};}}, async () => {calls++;});
  h.cleanup(); read.resolve(savedResult(customRoute)); await settle(); h.render();
  assert.equal(h.field("image-model").props.value, ""); assert.equal(calls, 0);
});
await test("concise action notice keeps synthetic-input, recording and conditional external-fee consequences", async () => {
  const h = harness({getBuiltinModelRoutes: async () => ({ready: false}), saveBuiltinModelRoutes: async () => ({ok: true})});
  await settle(); h.render();
  const note = () => h.nodes().find((node) => node.props.className === "preview-model-validation-note");
  assert.ok(note());
  assert.match(h.content(note()), /合成图和文字/);
  assert.match(h.content(note()), /不发送本机记录/);
  assert.match(h.content(note()), /可能暂停录制/);
  assert.match(h.content(note()), /不会自动开始或恢复/);
  assert.ok(!h.content(note()).includes("可能产生费用"));
  h.change("image-mode", "custom");
  assert.match(h.content(note()), /使用外部服务可能产生费用/);
  assert.equal(h.field("external-model-consent").props.checked, false);
  assert.equal(h.field("masked-model-consent").props.checked, false);
  assert.notEqual(h.field("external-model-consent"), h.field("masked-model-consent"));
});

await test("short status retains expandable persistence and manual-test explanations", async () => {
  const h = harness({getBuiltinModelRoutes: async () => savedResult(), saveBuiltinModelRoutes: async () => ({ok: true})});
  await settle(); h.render();
  assert.match(h.content(), /配置已载入，请重新测试/);
  const details = h.nodes().find((node) => node.type === "details" && node.props.className === "model-config-help");
  assert.ok(details);
  assert.equal(details.props.open, undefined);
  assert.match(h.content(details), /只读取状态，不会自动调用模型/);
  assert.match(h.content(details), /测试失败不会删除已保存配置/);
  assert.match(h.content(details), /配置只留在内存，未写入磁盘/);
  assert.match(h.content(details), /退出后需重新配置/);
  assert.match(h.content(details), /关闭面板会取消未完成的临时测试/);
});
await test("catalog choice edits one draft and opens manual controls without model activation", async () => {
  let writes = 0;
  const h = harness({getBuiltinModelRoutes: async () => savedResult(), saveBuiltinModelRoutes: async () => {writes++; return {ok: true};}});
  await settle(); h.render();
  const catalog = h.nodes().find((node) => typeof node.type === "function" && node.type.name === "ModelCatalog");
  assert.ok(catalog);
  catalog.props.onPick("image", "http://127.0.0.1:11435", "fixture-vision:3b"); h.render();
  assert.equal(h.field("image-model").props.value, "fixture-vision:3b");
  assert.equal(h.field("image-endpoint").props.value, "http://127.0.0.1:11435");
  assert.equal(h.field("text-model").props.value, "synthetic");
  assert.equal(writes, 0);
  assert.equal(h.nodes().find((node) => node.props.className === "model-advanced-settings").props.open, true);
});

console.log(`${checks} focused model configuration checks passed (synthetic IPC only).`);
