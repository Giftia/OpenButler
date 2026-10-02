import {spawn} from "node:child_process";
import {createConnection, createServer} from "node:net";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {randomBytes} from "node:crypto";

const browserPath = process.env.OPENBUTLER_BROWSER_PATH ?? [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find(existsSync);
if (!browserPath) throw new Error("Chromium browser not found; set OPENBUTLER_BROWSER_PATH");

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitJson(url) {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch { /* wait */ }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out: ${url}`);
}

async function waitHttp(url) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* wait */ }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out: ${url}`);
}

class Cdp {
  constructor(url) { this.url = new URL(url); this.buffer = Buffer.alloc(0); this.nextId = 1; this.pending = new Map(); }
  async open() {
    const key = randomBytes(16).toString("base64");
    await new Promise((done, fail) => {
      this.socket = createConnection({host: this.url.hostname, port: Number(this.url.port)}, () => {
        this.socket.write(`GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.ready) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const header = this.buffer.subarray(0, end).toString();
          if (!header.startsWith("HTTP/1.1 101")) { fail(new Error(header)); return; }
          this.buffer = this.buffer.subarray(end + 4);
          this.ready = true;
          done();
        }
        this.frames();
      });
      this.socket.on("error", fail);
    });
  }
  frames() {
    while (this.buffer.length >= 2) {
      let size = this.buffer[1] & 127;
      let offset = 2;
      if (size === 126) { if (this.buffer.length < 4) return; size = this.buffer.readUInt16BE(2); offset = 4; }
      if (size === 127) { if (this.buffer.length < 10) return; size = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + size) return;
      const opcode = this.buffer[0] & 15;
      const payload = this.buffer.subarray(offset, offset + size);
      this.buffer = this.buffer.subarray(offset + size);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      if (message.id && this.pending.has(message.id)) {
        const {done, fail} = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? fail(new Error(message.error.message)) : done(message.result);
      }
    }
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({id, method, params}));
    const header = Buffer.alloc(body.length < 126 ? 6 : 8);
    header[0] = 0x81;
    header[1] = 0x80 | (body.length < 126 ? body.length : 126);
    let offset = 2;
    if (body.length >= 126) { header.writeUInt16BE(body.length, 2); offset = 4; }
    const mask = randomBytes(4);
    mask.copy(header, offset);
    const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, masked]));
    return new Promise((done, fail) => this.pending.set(id, {done, fail}));
  }
  close() { this.socket?.destroy(); }
}

async function evalIn(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

async function until(cdp, expression, label) {
  for (let i = 0; i < 50; i++) {
    if (await evalIn(cdp, expression)) return;
    await new Promise((done) => setTimeout(done, 120));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const mock = `(() => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
  const state = {active: false, configured: false, authorized: false, count: 0, previewCalls: 0, startCalls: 0, evidenceCalls: 0};
  window.__previewSmoke = state;
  const observation = {id: 'ob-1', captured_at: new Date().toISOString(), state: 'recorded_pending', title: null, summary: null, boundary: '仅基于遮挡后画面，尚无结论。', evidence_available: true, evidence_id: 'opaque-id', source_label: '本机记录'};
  window.openbutlerDesktop = {
    channel: 'preview', apiBase: 'http://127.0.0.1:8000',
    getCaptureDisplays: async () => [{id: 'screen:1', label: '主屏幕'}],
    getMaskedCapturePreview: async () => { state.previewCalls++; return {ok: true, previewDataUrl: png, masked_regions: 1}; },
    startBuiltinCapture: async () => { state.startCalls++; state.active = true; state.count = 1; return {ok: true}; },
    pauseBuiltinCapture: async () => { state.active = false; return {ok: true}; },
    getCaptureState: async () => ({active: state.active}),
    getMaskedEvidence: async () => { state.evidenceCalls++; return {ok: true, dataUrl: png}; },
    getBuiltinModelRoutes: async () => ({}), saveBuiltinModelRoutes: async () => ({ok: true}),
    requestApi: async (path) => {
      let data = {};
      if (path === '/api/context-engine/status') data = {state: 'foundation_only', privacy_mode: 'strict', capture_available: true, model_routes_available: false, recording: {configured: state.configured, authorized: state.authorized, active: state.active, record_count: state.count}};
      else if (path === '/api/context-engine/observations') data = {count: state.count, items: state.count ? [observation] : []};
      else if (path === '/api/context-engine/capture/configure') { state.configured = true; state.authorized = true; data = {configured: true, active: false}; }
      else if (path === '/api/context-engine/capture/start') { state.active = true; data = {configured: true, authorized: true, active: true, record_count: state.count}; }
      else if (path === '/api/context-engine/capture/pause') { state.active = false; data = {configured: true, authorized: true, active: false, record_count: state.count}; }
      else if (path === '/api/context-engine/capture/revoke') { state.active = false; state.authorized = false; data = {configured: true, authorized: false, active: false, record_count: state.count}; }
      else if (path === '/api/privacy-mode') data = {mode: 'strict'};
      else if (path === '/api/events' || path.startsWith('/api/events?') || path === '/api/plugins') data = {items: [], count: 0, privacy_mode: 'strict'};
      return {ok: true, status: 200, data};
    }
  };
})();`;

let vite, browser, cdp, profile;
try {
  const webPort = await freePort();
  const cdpPort = await freePort();
  profile = mkdtempSync(join(tmpdir(), "openbutler-preview-smoke-"));
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort)], {stdio: "ignore"});
  await waitHttp(`http://127.0.0.1:${webPort}/`);
  browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=390,844", `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "about:blank"], {stdio: "ignore"});
  const targets = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
  cdp = new Cdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {source: mock});
  await cdp.send("Page.navigate", {url: `http://127.0.0.1:${webPort}/butler`});
  await until(cdp, "!!document.querySelector('.preview-activation-guide')", "Preview activation");
  await evalIn(cdp, "document.querySelector('.preview-activation-guide .primary-choice').click(); true");
  await until(cdp, "!!document.querySelector('.preview-capture-setup select')", "capture setup");
  const before = await evalIn(cdp, "({startDisabled: [...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('开始本机记录')).disabled, previewCalls: window.__previewSmoke.previewCalls})");
  if (!before.startDisabled || before.previewCalls !== 0) throw new Error("Capture started before privacy preview");
  await evalIn(cdp, "(() => {const el = document.querySelector('.preview-capture-setup textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(el, '密码管理器'); el.dispatchEvent(new Event('input', {bubbles:true})); return true})()");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('检查隐私预览')).click(); true");
  await until(cdp, "!!document.querySelector('.masked-preview img')", "masked preview");
  const unchecked = await evalIn(cdp, "[...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('开始本机记录')).disabled");
  if (!unchecked) throw new Error("Capture enabled without explicit confirmation");
  const overflow = await evalIn(cdp, "({viewport: innerWidth, content: document.documentElement.scrollWidth})");
  if (overflow.viewport !== 390) throw new Error(`Wrong mobile viewport: ${JSON.stringify(overflow)}`);
  if (overflow.content > overflow.viewport) throw new Error(`Preview activation overflow: ${JSON.stringify(overflow)}`);
  await evalIn(cdp, "(() => {const el = document.querySelector('.preview-capture-setup textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(el, '密码管理器\\n银行应用'); el.dispatchEvent(new Event('input', {bubbles:true})); return true})()");
  const invalidated = await evalIn(cdp, "!!document.querySelector('.masked-preview.is-stale img') && document.querySelector('.masked-preview.is-stale').textContent.includes('不能用于录制确认') && document.querySelector('.preview-confirm input').disabled && !document.querySelector('.preview-confirm input').checked && [...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('开始本机记录')).disabled");
  if (!invalidated) throw new Error("Changing capture scope did not invalidate privacy preview");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('检查隐私预览')).click(); true");
  await until(cdp, "!!document.querySelector('.masked-preview img') && !document.querySelector('.masked-preview.is-stale') && !document.querySelector('.preview-confirm input').disabled", "fresh loaded masked preview");
  await evalIn(cdp, "document.querySelector('.preview-confirm input').click(); true");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-capture-setup button')].find(b => b.textContent.includes('开始本机记录')).click(); true");
  await until(cdp, "!!document.querySelector('.preview-today')", "Preview Today");
  const started = await evalIn(cdp, "({calls: window.__previewSmoke.startCalls, text: document.querySelector('.preview-today').innerText})");
  if (started.calls !== 1 || !started.text.includes('待整理') || started.text.includes('已确认结论')) throw new Error("Preview Today state mismatch");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-today button')].find(b => b.textContent.includes('查看时间线')).click(); true");
  await until(cdp, "!!document.querySelector('.preview-timeline-page .preview-observation-row')", "local timeline record");
  await evalIn(cdp, "document.querySelector('.preview-timeline-page .timeline-evidence-button').click(); true");
  await until(cdp, "!!document.querySelector('.preview-timeline-page .preview-evidence-image')", "masked evidence");
  const evidence = await evalIn(cdp, "({calls: window.__previewSmoke.evidenceCalls, src: document.querySelector('.preview-evidence-image').getAttribute('src')})");
  if (evidence.calls !== 1 || !evidence.src.startsWith("data:image/png;base64,")) throw new Error("Evidence was not loaded through desktop bridge");
  await evalIn(cdp, "document.querySelector('[data-nav-key=butler]').click(); true");
  await until(cdp, "!!document.querySelector('.preview-recording-controls')", "recording controls");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-recording-controls button')].find(b => b.textContent.trim() === '暂停').click(); true");
  await until(cdp, "window.__previewSmoke.active === false", "paused capture");
  await evalIn(cdp, "[...document.querySelectorAll('.preview-recording-controls button')].find(b => b.textContent.includes('撤销授权')).click(); true");
  await until(cdp, "window.__previewSmoke.authorized === false", "revoked authorization");
  console.log("preview builtin capture browser smoke ok");
} finally {
  cdp?.close();
  browser?.kill();
  vite?.kill();
  if (profile && resolve(profile).startsWith(resolve(tmpdir()) + "\\")) {
    try { rmSync(profile, {recursive: true, force: true}); } catch { /* browser may still be exiting */ }
  }
}
