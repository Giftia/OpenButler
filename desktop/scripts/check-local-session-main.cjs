const assert = require("node:assert/strict");
const {test} = require("node:test");
const {EventEmitter} = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const vm = require("node:vm");
const {execFileSync} = require("node:child_process");
const localApi = require("../src/local-api.cjs");

// Execute real main code with all Electron, OS, filesystem and network effects mocked.
function mainHarness({packaged = false, spawnThrows = false, healthOk = true, fetchBehavior, discoveryImpl, catalogImpl, platform = "win32", storage, childKillExits = true, lifecycleTimeout = false} = {}) {
  const handlers = new Map();
  const children = [];
  const calls = [];
  const writes = [];
  const logs = [];
  const requests = [];
  const exits = [], forceKills = [];
  const fakeFetch = async (url, options) => {
    requests.push({url, options});
    assert.equal(options.redirect, "error");
    assert.match(options.headers[localApi.SESSION_HEADER], /^[a-f0-9]{64}$/);
    assert.equal("Origin" in options.headers, false);
    if (fetchBehavior) return fetchBehavior(url, options, requests.length);
    return {ok: healthOk, status: healthOk ? 200 : 503, redirected: false,
      text: async () => '{"synthetic":true}', json: async () => ({synthetic: true})};
  };
  let now = 0;
  let port = 8200;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, getPath: () => path.resolve(__dirname, "synthetic-user"),
    setPath() {}, requestSingleInstanceLock: () => true, quit() {}, exit(code) { exits.push(code); },
    getVersion: () => "0.0.0-test", whenReady: () => ({then() {}}),
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {url: "about:blank"}, isDestroyed: () => false,
        setWindowOpenHandler(handler) { this.openHandler = handler; },
      });
    }
    isDestroyed() { return false; }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
  }
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform, env: {}, resourcesPath: path.resolve(__dirname, "synthetic-resources"),
  });
  const fakeFs = {
    existsSync: () => true, mkdirSync() {},
    readFileSync() { throw new Error("No user data in synthetic tests."); },
    writeFileSync(...args) { writes.push(args); },
  };
  const childProcess = {
    spawn(command, args, options) {
      if (spawnThrows) throw new Error("synthetic spawn failure");
      const child = Object.assign(new EventEmitter(), {pid: children.length + 200, exitCode: null, killSignals: [],
        kill(signal) {this.killSignals.push(signal); if (childKillExits) queueMicrotask(() => {
          this.signalCode = signal; this.emit("exit", null, signal);
        }); return true;}});
      children.push(child);
      calls.push({command, args, options: {...options, env: {...options.env}}, originalEnv: options.env});
      return child;
    },
    spawnSync(...args) { forceKills.push(args); return {status: 0}; },
    execFile() { throw new Error("Unexpected OS command."); },
  };
  const net = {createServer() {
    return Object.assign(new EventEmitter(), {
      listen(_port, host, callback) { assert.equal(host, "127.0.0.1"); queueMicrotask(callback); },
      address: () => ({port: ++port}), close(callback) { callback(); },
    });
  }};
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, "../src"), process: fakeProcess,
    console: {warn: (...args) => logs.push(args)}, AbortController, AbortSignal, URL,
    Date: {now: () => now},
    setTimeout(callback, delay) {
      if (delay === 300) queueMicrotask(() => { now += delay; callback(); });
      if (delay === 5000) setImmediate(callback);
      if (delay === 1000 && lifecycleTimeout) setImmediate(callback);
      return 1;
    },
    clearTimeout() {},
    fetch: fakeFetch,
    require(name) {
      if (name === "electron") return {app, BrowserWindow, safeStorage: storage, ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
      }};
      if (name === "child_process") return childProcess;
      if (name === "fs") return fakeFs;
      if (name === "net") return net;
      if (name === "path") return path;
      if (name === "node:crypto") return require(name);
      if (name === "./capture-controller.cjs") return require("../src/capture-controller.cjs");
      if (name === "./public-window-controller.cjs") return require("../src/public-window-controller.cjs");
      if (name === "./public-window-provider.cjs") return require("../src/public-window-provider.cjs");
      if (name === "./model-catalog.cjs") return catalogImpl
        ? {createModelCatalog: () => catalogImpl} : require("../src/model-catalog.cjs");
      if (name === "./model-catalog-journal.cjs") return {createJournal: () => ({readJournal: () => null, writeJournal() {}})};
      if (name === "./local-model-discovery.cjs") return discoveryImpl
        ? {...require("../src/local-model-discovery.cjs"), createLocalModelDiscovery: () => discoveryImpl} : require("../src/local-model-discovery.cjs");
      if (name === "./local-api.cjs") return {...localApi,
        createLocalApiRequest: (options) => localApi.createLocalApiRequest({...options, fetchImpl: fakeFetch})};
      if (name === "../package.json") return {productName: "OpenButler Preview", openbutlerChannel: "preview"};
      throw new Error("Unexpected require: " + name);
    },
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/main.cjs"), "utf8");
  const controls = vm.runInContext(source +
    "\n({startBackend, stopBackend, restartBackend, createWindow, privateApi, stopBackendForLifecycle, quitApplication," +
    "getWindow: () => mainWindow, getState: () => backendState, getToken: () => backendSessionToken, getSessionRoutes: () => sessionModelRoutes, stopOwnedSessionBackend, secureModelStorageAvailable, readEncryptedModelRoutes, captureDisplays, captureSelectedDisplay, setWindowProvider: value => {publicWindowProvider=value;}, setControllers: (a,b) => {captureController=a; publicWindowController=b;}})", context);
  return {...controls, app, fakeProcess, handlers, children, calls, writes, logs, requests, exits, forceKills};
}

test("main lifecycle generates per-spawn tokens, deduplicates startup, rotates and clears", async () => {
  for (const packaged of [false, true]) {
    const h = mainHarness({packaged});
    const first = h.startBackend();
    assert.equal(h.startBackend(), first);
    assert.equal((await first).running, true);
    assert.equal(h.calls.length, 1);
    const oldToken = h.getToken();
    assert.match(oldToken, /^[a-f0-9]{64}$/);
    assert.equal(h.calls[0].options.env.OPENBUTLER_SESSION_TOKEN, oldToken);
    assert.equal(h.calls[0].originalEnv.OPENBUTLER_SESSION_TOKEN, undefined);
    assert.equal(h.fakeProcess.env.OPENBUTLER_SESSION_TOKEN, undefined);
    assert.equal(JSON.stringify(h.calls[0].args).includes(oldToken), false);
    assert.equal(JSON.stringify(h.getState()).includes(oldToken), false);
    assert.equal(h.calls[0].options.stdio, "ignore");
    if (!packaged) assert.ok(h.calls[0].args.includes("--no-proxy-headers"));
    const oldChild = h.children[0];
    assert.equal((await h.restartBackend()).running, true);
    const newToken = h.getToken();
    assert.notEqual(newToken, oldToken);
    oldChild.emit("exit", 0);
    oldChild.emit("error", new Error("late old child error"));
    assert.equal(h.getState().running, true);
    assert.equal(h.getToken(), newToken);
    h.children[1].emit("exit", 1);
    assert.equal(h.getToken(), "");
    assert.equal(h.getState().running, false);
    await h.startBackend();
    h.stopBackend();
    assert.equal(h.getToken(), "");
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.logs, []);
  }
});

test("trusted private model-settings underscore routes dispatch; unknown private paths remain blocked", async () => {
  const h = mainHarness();
  await h.startBackend();
  assert.equal((await h.privateApi('/api/model_settings/get')).synthetic, true);
  const last = h.requests.at(-1);
  assert.ok(String(last.url).endsWith('/api/model_settings/get'));
  assert.equal(last.options.method, 'GET');
  const count = h.requests.length;
  await assert.rejects(h.privateApi('/api/unknown_settings/get'), /local_service_unavailable/);
  await assert.rejects(h.privateApi('/api/model_settings/get/../update'), /local_service_unavailable/);
  assert.equal(h.requests.length, count);
  h.stopBackend();
});

test("local discovery discards results after navigation or detached sender frame", async () => {
  for (const detach of [false, true]) {
    let finish, calls = 0;
    const result = new Promise(resolve => { finish = resolve; });
    const h = mainHarness({discoveryImpl: async () => { calls++; return result; }});
    await h.createWindow();
    const window = h.getWindow(), frame = window.webContents.mainFrame;
    const pending = h.handlers.get('openbutler:list-builtin-local-models')({sender: window.webContents,
      senderFrame: frame}, {endpoint: 'http://127.0.0.1:11435', protocol: 'ollama_native'});
    if (detach) Object.defineProperty(frame, 'url', {get() { throw new Error('detached private detail'); }});
    else frame.url += '#/different-page';
    finish({ok: true, endpoint: 'http://127.0.0.1:11435', models: ['qwen3.5:2b']});
    const response = await pending;
    assert.equal(calls, 1); assert.equal(response.error_code, 'local_discovery_cancelled');
    assert.equal(response.models.length, 0); assert.equal(response.endpoint, '');
    assert.equal(JSON.stringify(response).includes('private'), false);
    h.stopBackend();
  }
});

test("startup failure, timeout, process error and shutdown invalidate the session", async () => {
  for (const config of [{spawnThrows: true}, {healthOk: false}]) {
    const h = mainHarness(config);
    assert.equal((await h.startBackend()).running, false);
    assert.equal(h.getToken(), "");
    assert.deepEqual(h.logs, []);
  }
  const h = mainHarness();
  const pending = h.startBackend();
  h.stopBackend();
  await pending;
  assert.equal(h.calls.length, 0);
  await h.startBackend();
  h.children[0].emit("error", new Error("synthetic process error"));
  assert.equal(h.getToken(), "");
  for (const event of ["before-quit", "will-quit", "exit"]) {
    const other = mainHarness();
    await other.startBackend();
    (event === "exit" ? other.fakeProcess : other.app).emit(event);
    if (event === "before-quit") await other.quitApplication();
    assert.equal(other.getToken(), "");
    assert.equal(other.getState().running, false);
  }
});

test("all legacy IPC is guarded and runtime, restart and browser options contain no token", async () => {
  const h = mainHarness();
  await h.createWindow();
  const window = h.getWindow();
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(JSON.stringify(window.options).includes(h.getToken()), false);
  const event = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
  for (const [channel, handler] of h.handlers) {
    if (channel === "openbutler:request-api") continue;
    await assert.rejects(async () => handler({sender: {}, senderFrame: event.senderFrame}), /Desktop request denied/);
    await assert.rejects(async () => handler({sender: event.sender, senderFrame: {url: event.senderFrame.url}}),
      /Desktop request denied/);
  }
  const runtime = await h.handlers.get("openbutler:get-runtime")(event);
  assert.equal(runtime.backend.running, true);
  assert.equal(JSON.stringify(runtime).includes(h.getToken()), false);
  const fileUrl = event.senderFrame.url;
  event.senderFrame.url = fileUrl + "#/timeline";
  assert.equal((await h.handlers.get("openbutler:get-runtime")(event)).mode, "desktop");
  event.senderFrame.url = fileUrl + "?external=1#/timeline";
  await assert.rejects(async () => h.handlers.get("openbutler:get-runtime")(event), /Desktop request denied/);
  event.senderFrame.url = fileUrl;
  assert.equal(h.handlers.has("openbutler:apply-minecontext-model-config"), true);
  assert.equal(h.handlers.has("openbutler:install-minecontext-with-approval"), true);
  const request = h.handlers.get("openbutler:request-api");
  assert.equal((await request(event, "/api/events")).ok, true);
  assert.equal(h.requests.at(-1).url, runtime.apiBase + "/api/events");
  const restarted = await h.handlers.get("openbutler:restart-backend")(event);
  assert.equal(restarted.running, true);
  assert.equal(JSON.stringify(restarted).includes(h.getToken()), false);
  assert.notEqual(restarted.apiBase, runtime.apiBase);
  assert.equal((await request(event, "/api/events")).ok, true);
  assert.equal(h.requests.at(-1).url, restarted.apiBase + "/api/events");
  assert.equal(h.requests.at(-1).options.headers[localApi.SESSION_HEADER], h.getToken());
  h.stopBackend();
  assert.equal((await request(event, "/api/events")).status, 503);
});

test("restart while old health check is pending cannot overwrite the new session", async () => {
  let finishOldHealth;
  const h = mainHarness({fetchBehavior: (_url, _options, count) => count === 1
    ? new Promise((resolve) => { finishOldHealth = resolve; })
    : Promise.resolve({ok: true, redirected: false})});
  const pending = h.startBackend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.getState().running, false);
  assert.equal((await h.restartBackend()).running, true);
  const token = h.getToken();
  const base = h.getState().apiBase;
  finishOldHealth({ok: true, redirected: false});
  await pending;
  h.children[0].emit("exit", 0);
  assert.equal(h.getToken(), token);
  assert.equal(h.getState().apiBase, base);
  assert.equal(h.getState().running, true);
  h.stopBackend();
});

test("preload exposes only the narrow request API while preserving old bridges", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../src/preload.cjs"), "utf8"), {
    process: {argv: ["--openbutler-api-base=http://127.0.0.1:8123", "--openbutler-channel=preview"]},
    require: () => ({
      contextBridge: {exposeInMainWorld(name, value) { assert.equal(name, "openbutlerDesktop"); bridge = value; }},
      ipcRenderer: {invoke: async (...args) => { calls.push(args); return {ok: true, status: 200, data: {}}; }},
    }),
  });
  await bridge.requestApi("/api/events", {method: "POST", body: "{}", headers: {bad: true}, redirect: "follow"});
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["openbutler:request-api", "/api/events", {method: "POST", body: "{}"}]);
  await bridge.getRuntime();
  assert.equal(calls[1][0], "openbutler:get-runtime");
  assert.equal(typeof bridge.applyMineContextModelConfig, "function");
  assert.equal(typeof bridge.installMineContextWithApproval, "function");
  await bridge.listBuiltinLocalModels({endpoint: 'http://127.0.0.1:11435',
    protocol: 'ollama_native', api_key: 'private-ignored', headers: {Authorization: 'private-ignored'}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['openbutler:list-builtin-local-models',
    {endpoint: 'http://127.0.0.1:11435', protocol: 'ollama_native'}]);
  await bridge.startBuiltinModelDownload({inspectionId: "a".repeat(32), catalogId: "fixed-model",
    downloadConsent: true, endpoint: "http://evil.invalid", model: "evil", path: "/private", api_key: "secret"});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["openbutler:start-builtin-model-download",
    {inspectionId: "a".repeat(32), catalogId: "fixed-model", downloadConsent: true}]);
  await bridge.inspectBuiltinModelHost({endpoint: "http://localhost:11435", protocol: "ollama_native", headers: {secret: true}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["openbutler:inspect-builtin-model-host",
    {endpoint: "http://localhost:11435", protocol: "ollama_native"}]);
  await bridge.cancelBuiltinModelDownload({jobId: "b".repeat(32), endpoint: "http://evil.invalid"});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["openbutler:cancel-builtin-model-download", {jobId: "b".repeat(32)}]);
  await bridge.openBuiltinModelCatalogLink({catalogId: "fixed-model", kind: "license", url: "https://evil.invalid"});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["openbutler:open-builtin-model-catalog-link", {catalogId: "fixed-model", kind: "license"}]);
  await bridge.getBuiltinModelDownload();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["openbutler:get-builtin-model-download", {}]);
  assert.equal(Object.keys(bridge).some((key) => /token|ipcRenderer/.test(key)), false);
});

test("frontend uses IPC, never falls back on IPC failure, and preserves Web fetch", async () => {
  const ts = require("../../frontend/node_modules/typescript");
  const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/lib/api.ts"), "utf8");
  const code = ts.transpileModule(source.replaceAll("import.meta.env", "testEnvironment"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  }).outputText;
  const calls = [];
  const bridge = {
    apiBase: "http://127.0.0.1:old-port",
    requestApi: async (...args) => { calls.push(args); return {ok: true, status: 200, data: {items: []}}; },
  };
  let fetchCalls = 0;
  const context = {exports: {}, window: {openbutlerDesktop: bridge}, testEnvironment: {},
    fetch: async () => { fetchCalls++; throw new Error("Desktop must use IPC."); }};
  vm.runInNewContext(code, context);
  await context.exports.getEvents("a/b");
  await context.exports.simulateEvents("synthetic");
  assert.equal(calls[0][0], "/api/events?q=a%2Fb");
  assert.equal(calls[1][1].method, "POST");
  assert.equal(calls[1][1].body, '{"scenario":"synthetic"}');
  bridge.requestApi = async () => ({ok: false, status: 403, error: "Desktop request denied."});
  await assert.rejects(context.exports.getEvents(), /403 Desktop request denied/);
  bridge.requestApi = async () => { throw new Error("IPC unavailable"); };
  await assert.rejects(context.exports.getEvents(), /IPC unavailable/);
  assert.equal(fetchCalls, 0);
  const web = {exports: {}, window: {}, testEnvironment: {VITE_API_BASE_URL: "http://synthetic.invalid"},
    fetch: async (url, options) => {
      assert.equal(url, "http://synthetic.invalid/api/events");
      assert.equal(options.headers["Content-Type"], "application/json");
      return {ok: true, json: async () => ({items: []})};
    }};
  vm.runInNewContext(code, web);
  assert.deepEqual(await web.exports.getEvents(), {items: []});
});

test("Python entry forces loopback and disables proxy headers without starting ASGI", () => {
  const script = [
    "import os, runpy, sys, types",
    "calls = []",
    "sys.modules['uvicorn'] = types.SimpleNamespace(run=lambda *a, **kw: calls.append((a, kw)))",
    "os.environ['OPENBUTLER_HOST'] = '0.0.0.0'",
    "os.environ['OPENBUTLER_PORT'] = '8123'",
    "entry = runpy.run_path(sys.argv[1])",
    "entry['main']()",
    "assert len(calls) == 1",
    "args, kwargs = calls[0]",
    "assert args == ('app.main:app',)",
    "assert kwargs['host'] == '127.0.0.1'",
    "assert kwargs['port'] == 8123",
    "assert kwargs['proxy_headers'] is False",
    "assert kwargs['access_log'] is False",
    "assert 'app.main' not in sys.modules",
    "print('synthetic backend entry ok')",
  ].join("\n");
  const result = execFileSync(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-B", "-c", script, path.resolve(__dirname, "../backend_entry.py")], {encoding: "utf8", windowsHide: true});
  assert.match(result, /synthetic backend entry ok/);
});

const sessionConfiguration = () => ({image: {mode: "local", protocol: "ollama_native",
  endpoint: "http://127.0.0.1:11435", model: "qwen3.5:0.8b"},
  text: {mode: "local", protocol: "ollama_native", endpoint: "http://127.0.0.1:11435", model: "qwen3.5:0.8b"},
  external_consent: false, masked_data_consent: false});
async function sessionHarness(update = async () => ({ok: true, ready: true}), options = {}) {
  const updates = [];
  const h = mainHarness({...options, fetchBehavior: async (url, options) => {
    if (String(url).endsWith("/health")) return {ok: true, redirected: false};
    if (String(url).endsWith("/api/model_settings/update")) {
      updates.push(JSON.parse(options.body));
      const result = await update();
      return {ok: true, json: async () => result};
    }
    assert.ok(String(url).endsWith("/api/model_settings/get"));
    return {ok: true, json: async () => ({ready: Boolean(h.getSessionRoutes())})};
  }});
  await h.createWindow();
  const event = {sender: h.getWindow().webContents, senderFrame: h.getWindow().webContents.mainFrame};
  const invoke = (name, ...args) => h.handlers.get("openbutler:" + name)(event, ...args);
  return {...h, event, updates, invoke};
}

test("session-only keyless models validate once, pause previews and never use encrypted storage", async () => {
  const h = await sessionHarness(async () => ({ok: true, ready: true, local_total_timeout_seconds: 90,
    external_total_timeout_seconds: 10, api_key: "must-not-reflect", unrelated: "must-not-reflect"})); const pauses = [];
  h.setControllers({pause: async reason => pauses.push("screen:" + reason)},
    {pause: async reason => pauses.push("window:" + reason)});
  const result = await h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
  assert.equal(result.ok, true); assert.equal(result.status.ready, true); assert.equal(result.ready, true);
  assert.equal(result.persistence, "session_only"); assert.equal(result.savedConfigurationAvailable, false);
  assert.equal(result.local_total_timeout_seconds, 90); assert.equal(result.status.external_total_timeout_seconds, 10);
  assert.ok(!JSON.stringify(result).includes("must-not-reflect"));
  assert.equal(result.persistenceUncertain, false); assert.equal(result.routes.image.apiKeyConfigured, false);
  assert.deepEqual(pauses, ["screen:model_reconfigured", "window:model_reconfigured"]);
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].image.api_key, undefined);
  assert.equal(h.requests.filter(item => !String(item.url).endsWith("/health")).length, 1);
  const state = await h.invoke("get-builtin-model-routes");
  assert.equal(state.persistence, "session_only"); assert.equal(state.ready, true);
  assert.equal(state.savedConfigurationAvailable, false); assert.equal(state.routes.text.model, "qwen3.5:0.8b");
  assert.deepEqual(h.writes, []);
});

test("session-only strict preflight rejects secrets, custom routes, consent and noncanonical endpoints without requests", async () => {
  const h = await sessionHarness();
  const changes = [c => c.image.api_key = "secret", c => c.image.headers = {Authorization: "secret"},
    c => c.image.auth = "secret", c => c.api_key = "secret", c => c.external_consent = true,
    c => c.masked_data_consent = true, c => c.image.mode = "custom", c => c.text.protocol = "openai_compatible",
    c => c.image.model = "../private", c => c.image.model = "model name", c => c.image.thinking = "true"];
  for (const endpoint of ["http://127.1:11435", "http://2130706433:11435", "http://0x7f000001:11435",
    "http://127.0.0.1:11435/", "http://127.0.0.1:11435?q=x", "http://secret@127.0.0.1:11435",
    "http://example.com:11435", "http://192.168.0.1:11435", "https://127.0.0.1:11435",
    "http://LOCALHOST:11435", "http://localhost:080", "http://[0:0:0:0:0:0:0:1]:11435"]) {
    changes.push(c => c.image.endpoint = endpoint);
  }
  for (const change of changes) {
    const config = sessionConfiguration(); change(config);
    const result = await h.invoke("use-builtin-local-models-for-session", config);
    assert.equal(result.error_code, "session_models_invalid_configuration");
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
  assert.equal(h.updates.length, 0); assert.deepEqual(h.writes, []);
});

test("session-only accepts canonical localhost and IPv6, remains RAM-only across backend restart", async () => {
  const h = await sessionHarness(); const config = sessionConfiguration();
  config.image.endpoint = "http://localhost:11435"; config.text.endpoint = "http://[::1]:11435";
  assert.equal((await h.invoke("use-builtin-local-models-for-session", config)).ok, true);
  await h.restartBackend(); assert.equal(h.getSessionRoutes(), null);
  const state = await h.invoke("get-builtin-model-routes"); assert.equal(state.ready, false);
  assert.equal(state.savedConfigurationAvailable, false); assert.deepEqual(h.writes, []);
  assert.equal(h.updates.length, 1);
  const fresh = await sessionHarness(); assert.equal(fresh.getSessionRoutes(), null);
  assert.equal((await fresh.invoke("get-builtin-model-routes")).ready, false);
});

test("session validation reserves shared lock and blocks concurrent enable, encrypted save and capture start", async () => {
  let release; const h = await sessionHarness(() => new Promise(resolve => {release = resolve;}));
  const pending = h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
  await new Promise(resolve => setImmediate(resolve));
  for (const name of ["use-builtin-local-models-for-session", "save-builtin-model-routes", "start-builtin-capture", "get-masked-capture-preview"]) {
    assert.equal((await h.invoke(name, sessionConfiguration())).error_code, "model_routes_save_in_progress");
  }
  assert.equal(h.updates.length, 1); release({ok: true, ready: true});
  assert.equal((await pending).ok, true); assert.deepEqual(h.writes, []);
});

test("failed or uncertain session publication stops owned backend, leaves no active RAM configuration", async () => {
  for (const behavior of [async () => ({ok: false, ready: false}), async () => ({}),
    async () => ({ok: true, ready: false}), async () => {throw new Error("private secret transport details");}]) {
    const h = await sessionHarness(behavior);
    const result = await h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
    assert.equal(result.ok, false); assert.equal(result.ready, false); assert.equal(h.getState().running, false);
    assert.equal(h.getSessionRoutes(), null); assert.equal(result.persistenceUncertain, false);
    assert.ok(!JSON.stringify(result).includes("private secret")); assert.deepEqual(h.writes, []);
  }
});

test("revocation during pending validation prevents late activation and preserves the fresh backend", async () => {
  let release; const h = await sessionHarness(() => new Promise(resolve => {release = resolve;}));
  const pending = h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
  await new Promise(resolve => setImmediate(resolve));
  const revoked = await h.invoke("revoke-builtin-session-models");
  assert.equal(revoked.sessionRevoked, true); assert.equal(revoked.ready, false);
  assert.deepEqual(h.children[0].killSignals, ["SIGKILL"]);
  assert.equal(h.getSessionRoutes(), null); const newToken = h.getToken();
  release({ok: true, ready: true});
  assert.equal((await pending).error_code, "session_models_cancelled");
  assert.equal(h.getToken(), newToken); assert.equal(h.getState().running, true);
  assert.equal(h.getSessionRoutes(), null); assert.deepEqual(h.writes, []);
});

test("session publication checks original sender after pauses and update, including detached frame", async () => {
  for (const detached of [false, true]) {
    let release; const h = await sessionHarness(() => new Promise(resolve => {release = resolve;}));
    const pending = h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
    await new Promise(resolve => setImmediate(resolve));
    if (detached) Object.defineProperty(h.event.senderFrame, "url", {get() {throw new Error("detached");}});
    else h.event.senderFrame.url += "#new-intent";
    release({ok: true, ready: true});
    assert.equal((await pending).error_code, "session_models_cancelled");
    assert.equal(h.getSessionRoutes(), null); assert.equal(h.getState().running, false);
  }
  const h = await sessionHarness();
  h.setControllers({pause: async () => {h.event.senderFrame.url += "#new-intent";}}, null);
  assert.equal((await h.invoke("use-builtin-local-models-for-session", sessionConfiguration())).error_code,
    "session_models_cancelled");
  assert.equal(h.updates.length, 0);
});


test("Linux weak or unknown storage fails closed before read, encryption, update or write", async () => {
  for (const provider of ["basic_text", "unknown", "future_unverified", undefined]) {
    let encryptions = 0, decryptions = 0;
    const storage = {isEncryptionAvailable: () => true, getSelectedStorageBackend: () => provider,
      encryptString() {encryptions++;}, decryptString() {decryptions++;}};
    const h = mainHarness({platform: "linux", storage}); await h.createWindow();
    assert.equal(h.secureModelStorageAvailable(), false); assert.equal(h.readEncryptedModelRoutes(), null);
    const event = {sender: h.getWindow().webContents, senderFrame: h.getWindow().webContents.mainFrame};
    const result = await h.handlers.get("openbutler:save-builtin-model-routes")(event, sessionConfiguration());
    assert.equal(result.ok, false); assert.equal(encryptions, 0); assert.equal(decryptions, 0);
    assert.equal(h.requests.length, 1); assert.deepEqual(h.writes, []);
  }
  for (const provider of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    assert.equal(mainHarness({platform: "linux", storage: {isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => provider}}).secureModelStorageAvailable(), true);
  }
  for (const platform of ["darwin", "win32"]) {
    assert.equal(mainHarness({platform, storage: {isEncryptionAvailable: () => true}}).secureModelStorageAvailable(), true);
  }
  assert.equal(mainHarness({platform: "linux", storage: {isEncryptionAvailable: () => true,
    getSelectedStorageBackend() {throw new Error("private provider failure");}}}).secureModelStorageAvailable(), false);
});


test("unconfirmed exact-child exit blocks backend restart until exit is observed", async () => {
  const h = mainHarness({childKillExits: false}); await h.createWindow();
  const stopped = h.stopOwnedSessionBackend();
  assert.equal(h.getState().running, false); assert.equal(h.getToken(), "");
  assert.deepEqual(h.children[0].killSignals, ["SIGKILL"]);
  assert.equal(await stopped, false);
  await h.restartBackend(); assert.equal(h.children.length, 1); assert.equal(h.getState().running, false);
  h.children[0].emit("exit", null, "SIGKILL");
  await h.startBackend(); assert.equal(h.children.length, 2); assert.equal(h.getState().running, true);
});


test("manual restart and app quit hard-stop a pending temporary validation before late response", async () => {
  for (const action of ["restart", "before-quit", "will-quit", "exit"]) {
    let release; const h = await sessionHarness(() => new Promise(resolve => {release = resolve;}));
    const pending = h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
    await new Promise(resolve => setImmediate(resolve));
    if (action === "restart") await h.restartBackend();
    else if (action === "exit") h.fakeProcess.emit("exit");
    else h.app.emit(action);
    assert.deepEqual(h.children[0].killSignals, ["SIGKILL"]);
    release({ok: true, ready: true});
    assert.equal((await pending).error_code, "session_models_cancelled");
    assert.equal(h.getSessionRoutes(), null);
    assert.equal(h.getState().running, action === "restart");
    assert.equal(h.children.length, action === "restart" ? 2 : 1);
    assert.deepEqual(h.writes, []);
  }
});


test("session receipt forwards only finite bounded observed timeout numbers", async () => {
  for (const [local, external] of [["90", "10"], [Infinity, NaN], [121, 11], [0, -1]]) {
    const h = await sessionHarness(async () => ({ok: true, ready: true,
      local_total_timeout_seconds: local, external_total_timeout_seconds: external}));
    const result = await h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
    assert.equal(result.ok, true); assert.equal(result.status.local_total_timeout_seconds, undefined);
    assert.equal(result.status.external_total_timeout_seconds, undefined);
  }
});


test("navigation cancellation reports unconfirmed exact-child stop truthfully", async () => {
  let release; const h = await sessionHarness(() => new Promise(resolve => {release = resolve;}), {childKillExits: false});
  const pending = h.invoke("use-builtin-local-models-for-session", sessionConfiguration());
  await new Promise(resolve => setImmediate(resolve)); h.event.senderFrame.url += "#cancelled";
  release({ok: true, ready: true});
  assert.equal((await pending).error_code, "session_models_stop_unconfirmed");
  assert.equal(h.getState().running, false); assert.equal(h.getSessionRoutes(), null);
  await h.restartBackend(); assert.equal(h.children.length, 1);
});


test("explicit revoke recovers a confirmed-stopped backend after failed validation without restoring routes", async () => {
  let valid = false; const h = await sessionHarness(async () => ({ok: valid, ready: valid}));
  assert.equal((await h.invoke("use-builtin-local-models-for-session", sessionConfiguration())).ok, false);
  assert.equal(h.getState().running, false); assert.equal(h.getSessionRoutes(), null);
  const result = await h.invoke("revoke-builtin-session-models");
  assert.equal(result.sessionRevoked, true); assert.equal(result.backendRunning, true);
  assert.equal(result.ready, false); assert.equal(h.getSessionRoutes(), null); assert.equal(h.updates.length, 1);
  assert.equal((await h.invoke("get-builtin-model-routes")).ready, false);
  valid = true;
  assert.equal((await h.invoke("use-builtin-local-models-for-session", sessionConfiguration())).ok, true);
  assert.equal(h.updates.length, 2); assert.deepEqual(h.writes, []);
});


test("catalog inspection discards navigation results and all catalog IPC remains main-frame guarded", async () => {
  let release, checks, closed = 0;
  const catalogImpl = {getCatalog: () => ({ok: true}), status: () => ({ok: true, job: null}),
    cancel: () => ({ok: true}), start: (_input, options) => ({ok: options.isCurrent()}),
    close: () => {closed++;}, inspect: (_input, options) => {checks = options; return new Promise(resolve => {release = resolve;});}};
  const h = mainHarness({catalogImpl}); await h.createWindow();
  const contents = h.getWindow().webContents;
  const event = {sender: contents, senderFrame: contents.mainFrame};
  for (const channel of ["get-builtin-model-catalog", "open-builtin-model-catalog-link", "inspect-builtin-model-host", "start-builtin-model-download",
    "get-builtin-model-download", "cancel-builtin-model-download"]) {
    assert.throws(() => h.handlers.get("openbutler:" + channel)({sender: contents, senderFrame: {url: event.senderFrame.url}}), /Desktop request denied/);
  }
  const pending = h.handlers.get("openbutler:inspect-builtin-model-host")(event, {});
  assert.equal(checks.isCurrent(), true); event.senderFrame.url += "#changed";
  assert.equal(checks.isCurrent(), false); release({ok: true, inspectionId: "a".repeat(32)});
  assert.equal((await pending).error_code, "catalog_inspection_stale");
  for (const name of ["before-quit", "will-quit"]) h.app.emit(name);
  h.fakeProcess.emit("exit"); assert.equal(closed, 3);
});

// No native process or pixels: exercise acknowledged shutdown ordering in real main code.
test("orderly quit stops local capture immediately, waits for durable acknowledgment and is idempotent", async () => {
  let release;
  const h = mainHarness({fetchBehavior: async (url) => String(url).endsWith('/capture/pause')
    ? new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({active: false})}); })
    : {ok: true, json: async () => ({})}});
  await h.createWindow();
  const reasons = [], beforeKills = h.forceKills.length;
  h.setControllers({active: true, pause(reason) { this.active = false; reasons.push(reason); return Promise.resolve(); }}, null);
  let prevented = 0;
  h.app.emit('before-quit', {preventDefault() { prevented++; }});
  h.app.emit('before-quit', {preventDefault() { prevented++; }});
  assert.equal(prevented, 2);
  assert.deepEqual(reasons, ['shutdown']);
  assert.equal(h.exits.length, 0);
  assert.equal(h.forceKills.length, beforeKills);
  assert.notEqual(h.getToken(), ''); // Preserved only for the private stop acknowledgment.
  assert.equal(h.requests.filter(item => String(item.url).endsWith('/capture/pause')).length, 1);
  const event = {sender: h.getWindow().webContents, senderFrame: h.getWindow().webContents.mainFrame};
  assert.throws(() => h.handlers.get('openbutler:start-builtin-capture')(event, {}), /service is stopping/);
  release();
  await h.quitApplication();
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.getToken(), '');
  assert.equal(h.getState().running, false);
  assert.ok(h.forceKills.length > beforeKills);
});

test("unacknowledged orderly stop is bounded and cannot claim a persisted stop", async () => {
  const h = mainHarness({lifecycleTimeout: true, fetchBehavior: async (url) => String(url).endsWith('/capture/pause')
    ? new Promise(() => {}) : {ok: true, json: async () => ({})}});
  await h.startBackend();
  await h.quitApplication();
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.getState().running, false);
  assert.equal(h.getToken(), '');
  assert.ok(h.forceKills.length > 1); // Recovery, not the desktop, decides whether a stop was persisted.
});

test("service restart awaits stop with the old token before launching a fresh backend", async () => {
  let release;
  const h = mainHarness({fetchBehavior: async (url) => String(url).endsWith('/capture/pause')
    ? new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({active: false})}); })
    : {ok: true, json: async () => ({})}});
  await h.startBackend();
  const token = h.getToken();
  const restarting = h.restartBackend();
  await h.startBackend();
  assert.equal(h.children.length, 1);
  assert.equal(h.requests.at(-1).options.headers[localApi.SESSION_HEADER], token);
  assert.deepEqual(JSON.parse(h.requests.at(-1).options.body), {reason: 'shutdown'});
  release();
  await restarting;
  assert.equal(h.children.length, 2);
  assert.notEqual(h.getToken(), token);
  assert.equal(h.getState().running, true);
  h.stopBackend();
});

test("Quit during an awaiting restart prevents replacement startup", async () => {
  let release;
  const h = mainHarness({fetchBehavior: async (url) => String(url).endsWith('/capture/pause')
    ? new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({active: false})}); })
    : {ok: true, json: async () => ({})}});
  await h.startBackend();
  const restarting = h.restartBackend();
  const quitting = h.quitApplication();
  release();
  await Promise.all([restarting, quitting]);
  await h.startBackend();
  assert.equal(h.children.length, 1);
  assert.equal(h.getState().running, false);
  assert.deepEqual(h.exits, [0]);
});

test("a pending full-screen startup cannot switch to a replacement window source", async () => {
  const h = mainHarness(); await h.createWindow();
  h.setControllers({active: false, busy: false, starting: true}, null);
  const event = {sender: h.getWindow().webContents, senderFrame: h.getWindow().webContents.mainFrame};
  const result = await h.handlers.get('openbutler:get-masked-capture-preview')(event, {capture_scope: 'dedicated_public_window'});
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'capture_already_active');
  h.setControllers(null, null); h.stopBackend();
});

// Runtime tests use the actual IPC handlers; renderer capability values and old
// consent/preview/controller state cannot opt into the disabled source.
test("full desktop remains unavailable on every platform before screen enumeration", async () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const h = mainHarness({platform});
    await h.createWindow();
    h.setWindowProvider({available: () => true, probe: async () => true,
      platform: "synthetic-public-window", lockState: "unlocked", lockProtectionSupported: true});
    const window = h.getWindow();
    const event = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
    const capabilities = await h.handlers.get("openbutler:get-capture-capabilities")(event);
    assert.equal(capabilities.public_window.supported, true);
    assert.equal(capabilities.full_desktop.supported, false);
    assert.equal(capabilities.full_desktop.reason, "full_desktop_unavailable");
    assert.equal((await h.handlers.get("openbutler:get-capture-displays")(event)).length, 0);
    await assert.rejects(h.captureSelectedDisplay("screen:0:0"), /full_desktop_unavailable/);
    h.stopBackend();
  }
});

test("stale desktop IPC preview and start cannot reach controllers or resume after cancel", async () => {
  const h = mainHarness();
  await h.createWindow();
  const window = h.getWindow();
  const event = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
  let captures = 0, pauses = 0;
  const legacy = {previewMasked: async () => { captures++; }, start: async () => { captures++; },
    pause: async () => { pauses++; return {active: false}; }};
  const inputs = [undefined, {}, {display_id: "screen:0:0", excluded_apps: ["password"], masks: []},
    {capture_scope: "full_screen", confirmed: true}, {capture_scope: "full_desktop"},
    {full_desktop: {supported: true}, capture_scope: "screen"}];
  const count = h.requests.length;
  for (const staleState of [{}, {active: true}, {starting: true}, {busy: true}, {preview: {when: 0}}]) {
    h.setControllers({...legacy, ...staleState}, null);
    for (const input of inputs) {
      for (const channel of ["openbutler:get-masked-capture-preview", "openbutler:start-builtin-capture"]) {
        const result = await h.handlers.get(channel)(event, input);
        assert.equal(result.ok, false);
        assert.equal(result.error_code, "full_desktop_unavailable");
        assert.match(result.error, /尚未通过隐私验证/);
      }
    }
    assert.equal((await h.handlers.get("openbutler:pause-builtin-capture")(event)).ok, true);
    const resumed = await h.handlers.get("openbutler:start-builtin-capture")(event, inputs[2]);
    assert.equal(resumed.error_code, "full_desktop_unavailable");
  }
  assert.equal(captures, 0);
  assert.equal(pauses, 5);
  assert.equal(h.requests.length, count);
  assert.deepEqual(h.writes, []);
  h.stopBackend();
});

test("dedicated public-window IPC still selects its own explicit controller", async () => {
  const h = mainHarness();
  await h.createWindow();
  const window = h.getWindow();
  const event = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
  let previews = 0, starts = 0;
  h.setControllers(null, {previewMasked: async config => {
    assert.equal(config.capture_scope, "dedicated_public_window"); previews++; return {ok: true};
  }, start: async config => {
    assert.equal(config.capture_scope, "dedicated_public_window"); starts++; return {active: true};
  }});
  const config = {capture_scope: "dedicated_public_window"};
  assert.equal((await h.handlers.get("openbutler:get-masked-capture-preview")(event, config)).ok, true);
  assert.equal((await h.handlers.get("openbutler:start-builtin-capture")(event, config)).ok, true);
  assert.equal(previews, 1); assert.equal(starts, 1);
  h.setControllers(null, null);
  h.stopBackend();
});
