const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");

// Execute the real IPC handlers against synthetic in-memory dependencies only.
// No Electron session, filesystem writes, model provider, credentials or capture.
const source = readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
const declaration = source.match(/^let modelRoutesPersistenceUncertain = false;$/m)?.[0];
const lockDeclaration = source.match(/^let modelRoutesSaveInProgress = false;$/m)?.[0];
assert.ok(declaration, "desktop session uncertainty flag exists");
assert.ok(lockDeclaration, "desktop session save lock exists");
const handlersSource = source.slice(source.indexOf('function keylessSessionConfiguration('), source.indexOf('handleDesktopRequest("openbutler:get-acceptance-pack"'));
const route = {mode: "custom", protocol: "openai_compatible", endpoint: "https://example.com/v1", model: "synthetic-model", api_key: "synthetic-old-key"};
const clone = (value) => JSON.parse(JSON.stringify(value));
const config = () => ({image: {...route}, text: {...route}, external_consent: true, masked_data_consent: true});
function fixture() {
  const handlers = new Map();
  const control = {behavior: "success", failWrite: false, failRename: false, failEncrypt: false, failGet: false, calls: 0, persists: 0, updateWait: null, dialogWait: null};
  let disk = config(), active = clone(disk), temporary;
  const publicRoute = ({api_key, ...item}) => ({...item, apiKeyConfigured: Boolean(api_key)});
  const status = () => ({ready: true, image: publicRoute(active.image), text: publicRoute(active.text)});
  const privateApi = async (endpoint, body) => {
    if (endpoint === "/api/model_settings/get") {
      if (control.failGet) throw new Error("synthetic service interruption");
      return status();
    }
    assert.equal(endpoint, "/api/model_settings/update"); control.calls++;
    if (control.updateWait) await control.updateWait;
    if (control.behavior === "validation-failure") return {ok: false, error_code: "image_probe_failed"};
    active = clone(body);
    if (control.behavior === "transport-failure") throw new Error("synthetic post-update interruption");
    if (control.behavior === "invalid-response") return {};
    return {ok: true, ...status()};
  };
  const safeStorage = {isEncryptionAvailable: () => true, encryptString: (value) => {
    if (control.failEncrypt) throw new Error("synthetic encryption failure");
    // Synthetic stand-in only; production uses Electron safeStorage unchanged.
    return value;
  }};
  const fs = {
    writeFileSync: (_path, value, options) => {assert.equal(options.mode, 0o600); if (control.failWrite) throw new Error("synthetic disk full"); temporary = value;},
    renameSync: () => {if (control.failRename) throw new Error("synthetic rename failure"); disk = JSON.parse(temporary); control.persists++;},
  };
  new Function("handleDesktopRequest", "privateApi", "readEncryptedModelRoutes", "safeStorage", "captureController", "publicWindowController", "refreshTrayStatus", "dialog", "mainWindow", "modelRoutesPath", "fs", "secureModelStorageAvailable", "isTrustedSender", "frontendIndexPath", `${declaration}\n${lockDeclaration}\nlet sessionModelRoutes = null; let sessionModelEpoch = 0; let sessionModelValidationPending = false; let backendGeneration = 0;\n${handlersSource}`)(
    (name, handler) => handlers.set(name, handler), privateApi, () => clone(disk), safeStorage, null, null, () => {}, {showMessageBox: async () => control.dialogWait ? await control.dialogWait : {response: 0}}, null, () => "/synthetic/model-routes.enc", fs, () => true, () => true, () => "/synthetic/index.html",
  );
  const get = () => handlers.get("openbutler:get-builtin-model-routes")({sender: {}, senderFrame: {url: "file:///synthetic/index.html"}});
  const save = (value = config()) => handlers.get("openbutler:save-builtin-model-routes")(null, value);
  return {control, get, save, active: () => clone(active), disk: () => clone(disk)};
}
let checks = 0;
async function test(name, run) {await run(); checks++; console.log(`PASS ${name}`);}
(async () => {
  await test("successful persistence clears uncertainty and never returns raw keys", async () => {
    const h = fixture(); assert.equal((await h.get()).persistenceUncertain, false);
    assert.equal((await h.save()).ok, true);
    const state = await h.get(); assert.equal(state.persistenceUncertain, false); assert.equal(state.requiresRevalidation, false);
    assert.ok(!JSON.stringify(state).includes("synthetic-old-key")); assert.equal(state.routes.image.apiKeyConfigured, true);
  });
  await test("disk failure after key-only update keeps old disk but flags active uncertainty", async () => {
    const h = fixture(); const proposed = config(); proposed.image.api_key = "synthetic-new-key"; h.control.failWrite = true;
    assert.equal((await h.save(proposed)).ok, false);
    assert.equal(h.active().image.api_key, "synthetic-new-key"); assert.equal(h.disk().image.api_key, "synthetic-old-key");
    const state = await h.get(); assert.equal(state.ready, true); assert.equal(state.persistenceUncertain, true); assert.equal(state.requiresRevalidation, true);
    assert.ok(!JSON.stringify(state).includes("synthetic-new-key"));
    // Separate reads model renderer remounts within the same Electron session.
    assert.equal((await h.get()).persistenceUncertain, true);
  });
  await test("rename failure stays uncertain until a later full success", async () => {
    const h = fixture(); h.control.failRename = true; await h.save(); assert.equal((await h.get()).persistenceUncertain, true);
    h.control.failRename = false; assert.equal((await h.save()).ok, true); assert.equal((await h.get()).persistenceUncertain, false);
  });
  await test("explicit validation failure restores previous clean state", async () => {
    const h = fixture(); h.control.behavior = "validation-failure"; assert.equal((await h.save()).ok, false);
    assert.equal((await h.get()).persistenceUncertain, false);
  });
  await test("explicit validation failure cannot erase previous uncertainty", async () => {
    const h = fixture(); h.control.failWrite = true; await h.save(); h.control.failWrite = false; h.control.behavior = "validation-failure";
    await h.save(); assert.equal((await h.get()).persistenceUncertain, true);
  });
  await test("thrown update transport and malformed responses remain uncertain", async () => {
    for (const behavior of ["transport-failure", "invalid-response"]) {
      const h = fixture(); h.control.behavior = behavior; assert.equal((await h.save()).ok, false); assert.equal((await h.get()).persistenceUncertain, true);
    }
  });
  await test("encryption failure before dispatch does not introduce uncertainty", async () => {
    const h = fixture(); h.control.failEncrypt = true; assert.equal((await h.save()).ok, false);
    assert.equal(h.control.calls, 0); assert.equal((await h.get()).persistenceUncertain, false);
  });
  await test("unavailable get still reports known persistence uncertainty", async () => {
    const h = fixture(); h.control.failWrite = true; await h.save(); h.control.failGet = true;
    const state = await h.get(); assert.equal(state.ready, false); assert.equal(state.persistenceUncertain, true); assert.equal(state.requiresRevalidation, true);
  });
  await test("remount save is rejected while an earlier backend response is pending", async () => {
    const h = fixture(); let resolve;
    h.control.updateWait = new Promise((done) => {resolve = done;});
    const first = config(); first.image.model = "first-proposal";
    const pending = h.save(first);
    const second = config(); second.image.model = "remount-proposal";
    const rejected = await h.save(second);
    assert.equal(rejected.ok, false); assert.equal(rejected.error_code, "model_routes_save_in_progress");
    assert.equal(h.control.calls, 1); assert.equal(h.control.persists, 0);
    resolve(); assert.equal((await pending).ok, true);
    assert.equal(h.control.calls, 1); assert.equal(h.control.persists, 1);
    assert.equal(h.active().image.model, "first-proposal"); assert.equal(h.disk().image.model, "first-proposal");
    assert.equal((await h.get()).persistenceUncertain, false);
  });
  await test("failed first save releases the main-process guard for a later retry", async () => {
    const h = fixture(); let resolve;
    h.control.updateWait = new Promise((done) => {resolve = done;}); h.control.behavior = "transport-failure";
    const pending = h.save(); assert.equal((await h.save()).error_code, "model_routes_save_in_progress");
    resolve(); assert.equal((await pending).ok, false); assert.equal((await h.get()).persistenceUncertain, true);
    h.control.updateWait = null; h.control.behavior = "success";
    assert.equal((await h.save()).ok, true); assert.equal(h.control.calls, 2); assert.equal(h.control.persists, 1);
    assert.equal((await h.get()).persistenceUncertain, false);
  });
  await test("main-process guard covers the confirmation dialog and releases on cancel", async () => {
    const h = fixture(); let resolve;
    h.control.dialogWait = new Promise((done) => {resolve = done;});
    const proposed = config(); proposed.image.endpoint = "https://another.example/v1";
    const pending = h.save(proposed);
    assert.equal((await h.save()).error_code, "model_routes_save_in_progress"); assert.equal(h.control.calls, 0);
    resolve({response: 1}); assert.equal((await pending).ok, false);
    h.control.dialogWait = null;
    assert.equal((await h.save()).ok, true); assert.equal(h.control.calls, 1);
  });
  console.log(`${checks} mocked desktop persistence checks passed.`);
})().catch((error) => {console.error(error); process.exitCode = 1;});

