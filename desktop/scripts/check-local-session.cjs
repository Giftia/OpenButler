const assert = require("node:assert/strict");
const {test} = require("node:test");
const {EventEmitter} = require("node:events");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const localApi = require("../src/local-api.cjs");

const indexPath = path.resolve(__dirname, "synthetic frontend", "index.html");
const indexUrl = pathToFileURL(indexPath).href;
const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);
const response = (data = {synthetic: true}, status = 200, extra = {}) => ({
  ok: status >= 200 && status < 300, status, redirected: false,
  text: async () => JSON.stringify(data), ...extra,
});

function fixture(fetchImpl = async () => response(), timeoutMs = 1000) {
  const frame = {url: indexUrl};
  const contents = {mainFrame: frame, isDestroyed: () => false};
  const window = {webContents: contents, isDestroyed: () => false};
  const state = {apiBase: "http://127.0.0.1:8123", running: true};
  const session = {token: tokenA};
  const event = {sender: contents, senderFrame: frame};
  const request = localApi.createLocalApiRequest({
    getWindow: () => window, getFrontendIndexPath: () => indexPath,
    getBackendState: () => state, getSessionToken: () => session.token,
    fetchImpl, timeoutMs,
  });
  return {request, event, frame, contents, window, state, session};
}

test("path validation accepts API resources and encoded search queries", () => {
  for (const value of ["/api/events", "/api/butler/goals/a-b", "/api/events?q=a%20b%2Fc%23d%25",
    "/api/events?q=https%3A%2F%2Fexample.invalid", "/api/events?days=7"]) {
    assert.equal(localApi.validateApiPath(value), value);
  }
});

test("unsafe paths fail before fetch, including encoded and double encoded traversal", async () => {
  let called = 0;
  const f = fixture(async () => { called++; return response(); });
  for (const value of [null, {}, "", "/api/", "/api", "api/events", "/health", "//evil.invalid/api/x",
    "https://evil.invalid/api/x", "file:///api/x", "/api/../health", "/api/./events", "/api/x/../../x",
    "/api/%2E%2e/health", "/api/.%2e/health", "/api/%252e%252e/health", "/api/x%2f..%2fy",
    "/api/x\\..\\y", "/api/%5cfoo", "/api/%255cfoo", "/api/x#fragment", "/api/x%23fragment",
    "/api/%00", "/api/x\r\n", "/api/x\t", "/api/%20x", "/api//x", "/api/%", "/api/%3fx",
    "/api/" + "x".repeat(8192)]) {
    assert.equal((await f.request(f.event, value)).status, 400, String(value));
  }
  assert.equal(called, 0);
});

test("renderer cannot submit masked observations or write model keys", async () => {
  let called = 0;
  const f = fixture(async () => { called++; return response(); });
  for (const route of ["/api/context-engine/observations", "/api/context-engine/%6fbservations",
    "/api/context-engine/capture/start", "/api/context-engine/capture/configure",
    "/api/context-engine/evidence/00000000-0000-0000-0000-000000000000",
    "/api/model_settings/update", "/api/model_settings/%75pdate"]) {
    assert.equal((await f.request(f.event, route, {method: "POST", body: "{}"})).status, 400);
  }
  assert.equal((await f.request(f.event, "/api/context-engine/capture/pause", {method: "POST", body: "{}"})).ok, true);
  assert.equal(called, 1);
});

test("daily review permits only the explicit trusted POST route", async () => {
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); return response(); });
  const body = JSON.stringify({day: "2026-10-02", timezone: "UTC", confirmed: true});
  assert.equal((await f.request(f.event, "/api/context-engine/daily-review", {method: "POST", body})).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].body, body);
  for (const options of [{method: "GET"}, {method: "PUT", body}]) {
    assert.equal((await f.request(f.event, "/api/context-engine/daily-review", options)).status, 400);
  }
  assert.equal((await f.request(f.event, "/api/context-engine/daily-review/admin", {method: "POST", body})).status, 400);
  f.frame.url = "https://untrusted.invalid";
  assert.equal((await f.request(f.event, "/api/context-engine/daily-review", {method: "POST", body})).status, 403);
  assert.equal(calls.length, 1);
});

test("local goal runtime exposes only bounded control routes", async () => {
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); return response(); });
  for (const [method, route] of [["GET", "status"], ["GET", "planner"], ["POST", "planner/configure"], ["POST", "planner/select"], ["GET", "goals/goal-1"],
    ["GET", "commands/request-1"], ["POST", "enabled"], ["POST", "settings"], ["POST", "goals"],
    ["POST", "chat"], ["POST", "evidence"], ["POST", "sources/synthetic/grant"],
    ["POST", "sources/user_statement/revoke"], ["POST", "goals/goal-1/control"],
    ["POST", "goals/goal-1/activate"], ["PATCH", "goals/goal-1"], ["POST", "inbox/notice-1/read"]]) {
    assert.equal((await f.request(f.event, `/api/agent-runtime/${route}`, {method})).ok, true, route);
  }
  const admitted = calls.length;
  for (const [method, route] of [["POST", "run"], ["POST", "actions/execute"],
    ["POST", "sources/remote-inbox/grant"], ["POST", "goals/goal-1/complete"],
    ["DELETE", "goals/goal-1"], ["GET", "goals/goal-1/control"], ["PUT", "enabled"]]) {
    assert.equal((await f.request(f.event, `/api/agent-runtime/${route}`, {method})).status, 400, route);
  }
  assert.equal(calls.length, admitted);
});

test("model conversation permits only explicit consent, send, adoption and reconciliation routes", async () => {
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); return response(); });
  const base = "/api/agent-runtime/conversations";
  for (const [method, suffix] of [["GET", ""], ["GET", "/synthetic-chat"],
    ["POST", "/synthetic-chat/consent"], ["POST", "/synthetic-chat/revoke"],
    ["POST", "/synthetic-chat/turns"], ["GET", "/synthetic-chat/turns/request-1"],
    ["POST", "/synthetic-chat/proposals/proposal-1/adopt"],
    ["GET", "/synthetic-chat/adoptions/adoption-1"]]) {
    assert.equal((await f.request(f.event, base + suffix, {method})).ok, true, suffix);
  }
  const admitted = calls.length;
  for (const [method, suffix] of [["POST", ""], ["DELETE", "/synthetic-chat"],
    ["POST", "/synthetic-chat/execute"], ["POST", "/synthetic-chat/turns/request-1"],
    ["POST", "/synthetic-chat/adoptions/adoption-1"], ["GET", "/synthetic-chat/consent"],
    ["POST", "/synthetic-chat/proposals/proposal-1/execute"],
    ["POST", "/synthetic-chat/proposals/proposal-1/adopt/extra"]]) {
    assert.equal((await f.request(f.event, base + suffix, {method})).status, 400, suffix);
  }
  assert.equal(calls.length, admitted);
});

test("only current exact conversation lookup404 exposes a fixed missing-receipt code", async () => {
  const missing = {detail: "runtime_item_not_found"};
  const f = fixture(async () => response(missing, 404));
  for (const suffix of ["turns/request-1", "adoptions/adoption-1"]) {
    const value = await f.request(f.event, `/api/agent-runtime/conversations/synthetic-chat/${suffix}`);
    assert.deepEqual(value, {ok: false, status: 404, error: "Local API request failed.", code: "runtime_item_not_found"});
  }
  for (const [method, route] of [["POST", "conversations/synthetic-chat/turns"],
    ["GET", "conversations/synthetic-chat"], ["GET", "commands/request-1"]]) {
    assert.equal((await f.request(f.event, `/api/agent-runtime/${route}`, {method})).code, undefined);
  }
  for (const data of [{detail: "Not Found"}, {...missing, extra: "provider-private-text"}, [missing],
    {detail: tokenA}, {detail: "x".repeat(200)}]) {
    const other = fixture(async () => response(data, 404));
    const value = await other.request(other.event, "/api/agent-runtime/conversations/synthetic-chat/turns/request-1");
    assert.equal(value.code, undefined);
    assert.equal(JSON.stringify(value).includes("provider-private-text"), false);
    assert.equal(JSON.stringify(value).includes(tokenA), false);
  }
  const invalid = fixture(async () => response(null, 404, {text: async () => "not-json"}));
  assert.equal((await invalid.request(invalid.event, "/api/agent-runtime/conversations/synthetic-chat/turns/request-1")).code, undefined);
  let changed;
  changed = fixture(async () => response(missing, 404, {text: async () => { changed.session.token = tokenB; return JSON.stringify(missing); }}));
  const stale = await changed.request(changed.event, "/api/agent-runtime/conversations/synthetic-chat/turns/request-1");
  assert.equal(stale.status, 503);
  assert.equal(stale.code, undefined);
});

test("sender must be the exact current mainFrame, with only index hash routes allowed", async () => {
  let called = 0;
  const f = fixture(async () => { called++; return response(); });
  for (const event of [undefined, {}, {sender: f.contents}, {sender: {}, senderFrame: f.frame},
    {sender: f.contents, senderFrame: {url: indexUrl}},
    {sender: f.contents, senderFrame: {url: indexUrl + "#/timeline"}},
    {sender: f.contents, senderFrame: null}]) {
    assert.equal((await f.request(event, "/api/events")).status, 403);
  }
  for (const url of ["https://example.invalid", "http://127.0.0.1:8123", "about:blank",
    "data:text/html,synthetic", indexUrl + ".other", indexUrl + "?x=1", indexUrl + "?x=1#/timeline",
    pathToFileURL(path.resolve(indexPath, "..", "evil.html")).href + "#/timeline",
    indexUrl.replace("index.html", "index%2ehtml"), indexUrl.replace("index.html", "x/../index.html")]) {
    f.frame.url = url;
    assert.equal((await f.request(f.event, "/api/events")).status, 403);
  }
  assert.equal(called, 0);
  for (const suffix of ["", "#/timeline", "#/butler/inbox", "#/me?view=local"]) {
    f.frame.url = indexUrl + suffix;
    assert.equal((await f.request(f.event, "/api/events")).ok, true);
  }
  f.contents.mainFrame = {url: f.frame.url};
  assert.equal((await f.request(f.event, "/api/events")).status, 403);
  f.contents.mainFrame = f.frame;
  f.window.isDestroyed = () => true;
  assert.equal((await f.request(f.event, "/api/events")).status, 403);
  f.window.isDestroyed = () => false;
  f.contents.isDestroyed = () => true;
  assert.equal((await f.request(f.event, "/api/events")).status, 403);
  assert.equal(localApi.isTrustedSender({get senderFrame() { throw new Error("detached"); }},
    {isDestroyed: () => false, webContents: {}}, indexPath), false);
});

test("navigation blocks external pages, subframes, redirects, webviews and all popups", () => {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (handler) => { contents.openHandler = handler; };
  localApi.restrictNavigation(contents, indexPath);
  for (const url of [indexUrl, indexUrl + "#/timeline", "https://example.invalid", "file:///other.html"]) {
    assert.deepEqual(contents.openHandler({url}), {action: "deny"});
    for (const name of ["will-navigate", "will-frame-navigate"]) {
      let prevented = false;
      contents.emit(name, {url, isMainFrame: true, preventDefault() { prevented = true; }}, url);
      assert.equal(prevented, !url.startsWith(indexUrl));
    }
  }
  for (const name of ["will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    contents.emit(name, {url: indexUrl, isMainFrame: false, preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
  }
});

test("proxy uses current backend address and token without Origin or renderer credentials", async () => {
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); return response(); });
  const result = await f.request(f.event, "/api/events?q=test", {method: "POST", body: '{"synthetic":true}'});
  assert.deepEqual(result, {ok: true, status: 200, data: {synthetic: true}});
  assert.equal(calls[0][0], "http://127.0.0.1:8123/api/events?q=test");
  assert.deepEqual(calls[0][1].headers, {"Content-Type": "application/json", "X-OpenButler-Session": tokenA});
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].body, '{"synthetic":true}');
  assert.equal(JSON.stringify(result).includes(tokenA), false);
  f.state.apiBase = "http://127.0.0.1:8234";
  f.session.token = tokenB;
  assert.equal((await f.request(f.event, "/api/events")).ok, true);
  assert.equal(calls[1][0], "http://127.0.0.1:8234/api/events");
  assert.equal(calls[1][1].headers[localApi.SESSION_HEADER], tokenB);
});

test("invalid options, inactive sessions and non-loopback backends never fetch", async () => {
  let called = 0;
  const f = fixture(async () => { called++; return response(); });
  for (const options of [null, [], "GET", {headers: {Origin: "null"}}, {method: "CONNECT"},
    {method: "GET", body: "x"}, {method: "HEAD", body: "x"}, {method: "POST", body: {}},
    {redirect: "follow"}, {method: "POST\r\n"}]) {
    assert.equal((await f.request(f.event, "/api/events", options)).status, 400);
  }
  for (const token of ["", "a".repeat(63), "z".repeat(64)]) {
    f.session.token = token;
    assert.equal((await f.request(f.event, "/api/events")).status, 503);
  }
  f.session.token = tokenA;
  for (const apiBase of ["https://example.invalid", "http://localhost:8123", "http://127.0.0.1:8123/",
    "http://127.0.0.1:8123@evil.invalid", "http://127.0.0.1:8123/api"]) {
    f.state.apiBase = apiBase;
    assert.equal((await f.request(f.event, "/api/events")).status, 503);
  }
  f.state.apiBase = "http://127.0.0.1:8123";
  f.state.running = false;
  assert.equal((await f.request(f.event, "/api/events")).status, 503);
  assert.equal(called, 0);
});

test("redirect responses never return bodies or follow Location", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const f = fixture(async (_url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      return response(null, status, {text: () => { throw new Error("must not read redirect body"); }});
    });
    assert.deepEqual(await f.request(f.event, "/api/events"),
      {ok: false, status: 502, error: "Local API redirect denied."});
    assert.equal(calls, 1);
  }
  const f = fixture(async () => response(null, 200, {redirected: true}));
  assert.equal((await f.request(f.event, "/api/events")).status, 502);
});

test("transport errors, backend errors, invalid JSON and echoed tokens are not exposed", async () => {
  const privateText = tokenA + " synthetic-private-path";
  for (const fetchImpl of [
    async () => { throw new Error(privateText); },
    async () => response(privateText, 500, {statusText: privateText}),
    async () => response(null, 200, {text: async () => privateText}),
    async () => response({unexpected: tokenA}),
    async () => response(null, 200, {text: async () => '"' + "\\u0061".repeat(64) + '"'}),
  ]) {
    const f = fixture(fetchImpl);
    const result = await f.request(f.event, "/api/events");
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(tokenA), false);
    assert.equal(JSON.stringify(result).includes("synthetic-private-path"), false);
    assert.equal("data" in result, false);
  }
});

test("timeout covers fetch and response body and aborts the request", async () => {
  for (const stage of ["fetch", "body"]) {
    let signal;
    const f = fixture(async (_url, options) => {
      signal = options.signal;
      if (stage === "fetch") return new Promise(() => {});
      return response(null, 200, {text: () => new Promise(() => {})});
    }, 10);
    assert.equal((await f.request(f.event, "/api/events")).status, 504);
    assert.equal(signal.aborted, true);
  }
});

test("session rotation or frame navigation during fetch drops the response", async () => {
  for (const mutate of [(f) => { f.session.token = tokenB; },
    (f) => { f.frame.url = "https://example.invalid"; },
    (f) => { f.state.apiBase = "http://127.0.0.1:8234"; }]) {
    const f = fixture(async () => { mutate(f); return response(); });
    assert.equal((await f.request(f.event, "/api/events")).status, 503);
  }
});

test("HEAD and empty 204 responses do not attempt JSON parsing", async () => {
  for (const [method, status] of [["HEAD", 200], ["DELETE", 204]]) {
    const f = fixture(async () => response(null, status, {text: () => { throw new Error("empty"); }}));
    assert.deepEqual(await f.request(f.event, "/api/events", {method}), {ok: true, status, data: null});
  }
});



test("command receipt absence forwards only bounded exact current command GET404", async () => {
  const missing = {detail: "runtime_command_not_found"};
  const route = "/api/agent-runtime/commands/request-1";
  const f = fixture(async () => response(missing, 404));
  assert.deepEqual(await f.request(f.event, route), {ok: false, status: 404, error: "Local API request failed.", code: "runtime_command_not_found"});
  for (const path of ["/api/agent-runtime/goals/request-1", "/api/agent-runtime/conversations/chat/turns/request-1", "/api/agent-runtime/conversations/chat/adoptions/request-1"]) {
    assert.equal((await f.request(f.event, path)).code, undefined);
  }
  assert.equal((await f.request(f.event, "/api/agent-runtime/conversations/chat/revoke", {method:"POST",body:"{}"})).code, undefined);
  for (const data of [{detail:"runtime_item_not_found"}, {...missing, extra:"private"}, [missing], {detail:tokenA}]) {
    const other = fixture(async () => response(data, 404));
    assert.equal((await other.request(other.event, route)).code, undefined);
  }
  for (const text of ["<html>404</html>", "{", " ".repeat(129) + JSON.stringify(missing)]) {
    const other = fixture(async () => response(null, 404, {text:async () => text}));
    assert.equal((await other.request(other.event, route)).code, undefined);
  }
  const offline = fixture(async () => { throw new Error("offline"); });
  assert.equal((await offline.request(offline.event, route)).code, undefined);
  let changed;
  changed = fixture(async () => response(missing, 404, {text:async () => { changed.session.token = tokenB; return JSON.stringify(missing); }}));
  assert.deepEqual(await changed.request(changed.event, route), {ok:false,status:503,error:"Local service unavailable."});
});
