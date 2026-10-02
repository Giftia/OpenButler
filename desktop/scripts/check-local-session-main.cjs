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
function mainHarness({packaged = false, spawnThrows = false, healthOk = true, fetchBehavior} = {}) {
  const handlers = new Map();
  const children = [];
  const calls = [];
  const writes = [];
  const logs = [];
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({url, options});
    assert.equal(options.redirect, "error");
    assert.match(options.headers[localApi.SESSION_HEADER], /^[a-f0-9]{64}$/);
    assert.equal("Origin" in options.headers, false);
    if (fetchBehavior) return fetchBehavior(url, options, requests.length);
    return {ok: healthOk, status: healthOk ? 200 : 503, redirected: false,
      text: async () => '{"synthetic":true}'};
  };
  let now = 0;
  let port = 8200;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, getPath: () => path.resolve(__dirname, "synthetic-user"),
    setPath() {}, requestSingleInstanceLock: () => true, quit() {}, exit() {},
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
    platform: "win32", env: {}, resourcesPath: path.resolve(__dirname, "synthetic-resources"),
  });
  const fakeFs = {
    existsSync: () => true, mkdirSync() {},
    readFileSync() { throw new Error("No user data in synthetic tests."); },
    writeFileSync(...args) { writes.push(args); },
  };
  const childProcess = {
    spawn(command, args, options) {
      if (spawnThrows) throw new Error("synthetic spawn failure");
      const child = Object.assign(new EventEmitter(), {pid: children.length + 200});
      children.push(child);
      calls.push({command, args, options: {...options, env: {...options.env}}, originalEnv: options.env});
      return child;
    },
    spawnSync() { return {status: 0}; },
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
    console: {warn: (...args) => logs.push(args)}, AbortController,
    Date: {now: () => now},
    setTimeout(callback, delay) {
      if (delay === 300) queueMicrotask(() => { now += delay; callback(); });
      return 1;
    },
    clearTimeout() {},
    fetch: fakeFetch,
    require(name) {
      if (name === "electron") return {app, BrowserWindow, ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
      }};
      if (name === "child_process") return childProcess;
      if (name === "fs") return fakeFs;
      if (name === "net") return net;
      if (name === "path") return path;
      if (name === "node:crypto") return require(name);
      if (name === "./capture-controller.cjs") return require("../src/capture-controller.cjs");
      if (name === "./local-api.cjs") return {...localApi,
        createLocalApiRequest: (options) => localApi.createLocalApiRequest({...options, fetchImpl: fakeFetch})};
      if (name === "../package.json") return {productName: "OpenButler Preview", openbutlerChannel: "preview"};
      throw new Error("Unexpected require: " + name);
    },
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/main.cjs"), "utf8");
  const controls = vm.runInContext(source +
    "\n({startBackend, stopBackend, restartBackend, createWindow," +
    "getWindow: () => mainWindow, getState: () => backendState, getToken: () => backendSessionToken})", context);
  return {...controls, app, fakeProcess, handlers, children, calls, writes, logs, requests};
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
