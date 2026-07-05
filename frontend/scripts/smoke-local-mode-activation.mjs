import {spawn} from "node:child_process";
import {existsSync, mkdirSync} from "node:fs";
import {createConnection, createServer as createNetServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";

const webUrl = process.env.OPENBUTLER_WEB_URL ?? "http://127.0.0.1:5175";
const browserPath = process.env.OPENBUTLER_BROWSER_PATH ?? findBrowserPath();

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoOverflow(result, label) {
  assertCondition(result.scrollWidth <= result.width, `${label} horizontal overflow: ${result.scrollWidth} > ${result.width}`);
}

function findBrowserPath() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "msedge",
    "chrome",
  ];
  return candidates.find((candidate) => candidate.includes("\\") ? existsSync(candidate) : true);
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

class DevToolsSocket {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.socket = null;
    this.handshakeDone = false;
    this.buffer = Buffer.alloc(0);
    this.messageHandler = () => undefined;
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      const key = randomBytes(16).toString("base64");
      const timer = setTimeout(() => reject(new Error("Timed out opening DevTools socket.")), 10000);
      this.socket = createConnection({host: this.wsUrl.hostname, port: Number(this.wsUrl.port || 80)}, () => {
        this.socket.write([
          `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
          `Host: ${this.wsUrl.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"));
      });
      this.socket.on("data", (chunk) => {
        if (!this.handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const header = this.buffer.slice(0, headerEnd).toString("utf8");
          if (!header.includes("101")) {
            clearTimeout(timer);
            reject(new Error(`DevTools socket upgrade failed: ${header.split("\r\n")[0]}`));
            return;
          }
          this.handshakeDone = true;
          const rest = this.buffer.slice(headerEnd + 4);
          this.buffer = Buffer.alloc(0);
          clearTimeout(timer);
          resolveOpen();
          if (rest.length) this.handleFrameData(rest);
          return;
        }
        this.handleFrameData(chunk);
      });
      this.socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  handleFrameData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.slice(offset, offset + length);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + length);
      if (opcode === 1) this.messageHandler(payload.toString("utf8"));
      if (opcode === 8) this.close();
      if (opcode === 9) this.sendFrame(payload, 10);
    }
  }

  sendFrame(payload, opcode = 1) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    const mask = randomBytes(4);
    const header = data.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | data.length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, data.length >> 8, data.length & 255]);
    const masked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this.sendFrame(text, 1);
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new DevToolsSocket(wsUrl);
  }

  async open() {
    this.ws.onMessage((data) => this.handleMessage(data));
    await this.ws.open();
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (!message.id || !this.pending.has(message.id)) return;
    const {resolveMessage, rejectMessage} = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) rejectMessage(new Error(message.error.message));
    else resolveMessage(message.result);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, {resolveMessage, rejectMessage});
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.value;
}

async function waitForCondition(cdp, expression, timeoutMs = 5000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(cdp, expression);
    if (ok) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

let browser;
let cdp;

try {
  assertCondition(Boolean(browserPath), "No Chromium-compatible browser found. Set OPENBUTLER_BROWSER_PATH.");
  const cdpPort = await getFreePort();
  const profileDir = join(tmpdir(), `openbutler-local-mode-activation-${Date.now()}`);
  mkdirSync(profileDir, {recursive: true});
  browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=390,844",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    `${webUrl}/butler`,
  ], {stdio: ["ignore", "ignore", "ignore"]});

  const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  assertCondition(Boolean(pageTarget), "Browser DevTools did not expose a page target.");
  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.openbutlerDesktop = {
        apiBase: "",
        getRuntime: async () => ({desktop: true, apiBase: ""}),
        getMineContextStatus: async () => ({reachable: false, running: false, configured: false, status: "not_found"}),
        scanMineContextInstallations: async () => ({found: false, candidates: []}),
        chooseMineContextInstaller: async () => ({selected: false}),
        openMineContextDownloadPage: async () => ({ok: true}),
        downloadMineContextInstaller: async () => ({ok: false, message: "测试环境不会下载安装包。"}),
        installMineContextWithApproval: async () => ({ok: false, message: "测试环境不会安装。"}),
        startMineContext: async () => ({ok: false, message: "未找到本机记录组件。"}),
        testMineContextModelConfig: async () => ({ok: true, message: "只检查字段，不调用外部模型。"}),
        applyMineContextModelConfig: async () => ({ok: false, message: "测试环境未连接本机记录组件。"}),
        restartBackend: async () => ({ok: true}),
        openDataFolder: async () => ({ok: true}),
        showMainWindow: async () => ({ok: true}),
        quitApp: async () => ({ok: true})
      };
    `,
  });

  await cdp.send("Page.navigate", {url: `${webUrl}/butler`});
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await evaluate(cdp, "localStorage.removeItem('openbutler:first_run_activation:v1'); location.reload(); true");
  await waitForCondition(cdp, "!!document.querySelector('.first-run-guide')", 6000, "activation gate");

  const initial = await evaluate(cdp, `(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    hasGuide: !!document.querySelector('.first-run-guide'),
    hasMainShell: !!document.querySelector('.app-shell'),
    hasNav: !!document.querySelector('[data-nav-key="butler"]'),
    hasDemo: document.body.innerText.includes('先看样例'),
    hasLocalMode: document.body.innerText.includes('整理我的本机记录'),
    hasLater: document.body.innerText.includes('稍后配置'),
    text: document.body.innerText
  }))()`);
  assertCondition(initial.hasGuide && initial.hasDemo && initial.hasLocalMode && initial.hasLater, "Activation gate is missing required choices.");
  assertCondition(!initial.hasMainShell && !initial.hasNav, "Main app should not be visible before activation.");
  assertNoOverflow(initial, "initial gate");

  await evaluate(cdp, `Array.from(document.querySelectorAll('.first-run-guide button')).find((button) => button.innerText.includes('先看样例')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const sampleMode = await evaluate(cdp, `(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasMainShell: !!document.querySelector('.app-shell'),
    hasSampleBoundary: document.body.innerText.includes('未读取你的真实数据') || document.body.innerText.includes('样例体验')
  }))()`);
  assertCondition(sampleMode.status === "demo_selected", "Sample choice should persist demo_selected.");
  assertCondition(sampleMode.hasMainShell && sampleMode.hasSampleBoundary, "Sample mode should enter the app with a clear sample-data boundary.");
  assertNoOverflow(sampleMode, "sample mode");

  await evaluate(cdp, "localStorage.removeItem('openbutler:first_run_activation:v1'); location.reload(); true");
  await waitForCondition(cdp, "!!document.querySelector('.first-run-guide')", 6000, "activation gate after sample reset");

  await evaluate(cdp, `Array.from(document.querySelectorAll('.first-run-guide button')).find((button) => button.innerText.includes('整理我的本机记录')).click(); true`);
  await waitForCondition(cdp, "document.body.innerText.includes('智能整理钥匙') || document.body.innerText.includes('智能整理能力')", 5000, "local mode smart key");

  const localMode = await evaluate(cdp, `(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasNav: !!document.querySelector('[data-nav-key="butler"]'),
    hasSmartKey: document.body.innerText.includes('智能整理钥匙') || document.body.innerText.includes('智能整理能力'),
    hasApiKeyHelp: document.body.innerText.includes('我该从哪里获得'),
    hasLocalRecord: document.body.innerText.includes('本机记录组件'),
    hasScan: document.body.innerText.includes('查找本机记录组件'),
    hasPreview: document.body.innerText.includes('授权前预览') && document.body.innerText.includes('第一份今日整理预览'),
    hasDryRunBoundary: document.body.innerText.includes('确认前不会导入真实活动') || document.body.innerText.includes('不会导入真实活动'),
    hasAutoInstall: document.body.innerText.includes('自动安装'),
    hasManualInstall: document.body.innerText.includes('手动安装'),
    forbidden: ['mock', 'seed', 'PCActivity', 'Provider', 'Webhook'].filter((term) => document.body.innerText.includes(term)),
    text: document.body.innerText
  }))()`);
  assertCondition(localMode.status === "real_setup_started", "Local mode choice should persist real_setup_started.");
  assertCondition(!localMode.hasNav, "Local mode activation should not reveal main navigation before completion.");
  assertCondition(localMode.hasSmartKey && localMode.hasApiKeyHelp, "Local mode should show smart key configuration and API Key help.");
  assertCondition(localMode.hasLocalRecord && localMode.hasScan && localMode.hasAutoInstall && localMode.hasManualInstall, "Local mode should show local record component bootstrap choices.");
  assertCondition(localMode.hasPreview && localMode.hasDryRunBoundary, "Local mode should show authorization dry-run preview and first useful result preview.");
  assertCondition(localMode.forbidden.length === 0, `Ordinary activation UI leaked internal terms: ${localMode.forbidden.join(", ")}`);
  assertNoOverflow(localMode, "local mode");

  await evaluate(cdp, `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('稍后配置')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  const later = await evaluate(cdp, `(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasGuide: !!document.querySelector('.first-run-guide'),
    hasMainShell: !!document.querySelector('.app-shell'),
    hasNextStep: document.body.innerText.includes('稍后回来继续设置') || document.body.innerText.includes('先看样例')
  }))()`);
  assertCondition(later.status === "dismissed", "Later choice should persist dismissed.");
  assertCondition(later.hasGuide && !later.hasMainShell && later.hasNextStep, "Later choice should keep the user in activation instead of the main app.");
  assertNoOverflow(later, "later");

  console.log(JSON.stringify({
    checked: "local-mode-activation",
    ok: true,
    webUrl,
    initial: {hasGuide: initial.hasGuide, hasMainShell: initial.hasMainShell},
    sampleMode: {status: sampleMode.status, hasMainShell: sampleMode.hasMainShell},
    localMode: {
      status: localMode.status,
      hasSmartKey: localMode.hasSmartKey,
      hasLocalRecord: localMode.hasLocalRecord,
      hasPreview: localMode.hasPreview,
    },
    later: {status: later.status, hasGuide: later.hasGuide},
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "local-mode-activation",
    ok: false,
    webUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
} finally {
  if (cdp) cdp.close();
  if (browser && !browser.killed) browser.kill();
}
