import {spawn} from "node:child_process";
import {existsSync, mkdirSync} from "node:fs";
import {createServer as createNetServer, createConnection} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";

const webUrl = process.env.OPENBUTLER_WEB_URL ?? "http://127.0.0.1:5175";
const browserPath = process.env.OPENBUTLER_BROWSER_PATH ?? findBrowserPath();

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoHorizontalOverflow(result, label) {
  assertCondition(result.scrollWidth <= result.width, `${label} mobile overflow: ${result.scrollWidth} > ${result.width}`);
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

async function navigate(cdp, path) {
  await cdp.send("Page.navigate", {url: `${webUrl}${path}`});
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
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
  const profileDir = join(tmpdir(), `openbutler-first-run-${Date.now()}`);
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

  await navigate(cdp, "/butler");
  await evaluate(cdp, "localStorage.removeItem('openbutler:first_run_activation:v1'); location.reload(); true");
  await waitForCondition(
    cdp,
    "!!document.querySelector('.first-run-guide') && document.body.innerText.includes('像安装一个私人管家一样开始')",
    6000,
    "first-run activation dialog",
  );
  const initial = await evaluate(cdp, `(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    hasDialog: !!document.querySelector('.first-run-guide'),
    hasMainShell: !!document.querySelector('.app-shell'),
    hasPrimaryNav: !!document.querySelector('[data-nav-key="butler"]'),
    hasIntro: document.body.innerText.includes('像安装一个私人管家一样开始'),
    hasDemo: document.body.innerText.includes('先看样例'),
    hasReal: document.body.innerText.includes('让 OpenButler 整理我的本机记录'),
    hasLater: document.body.innerText.includes('稍后配置')
  }))()`);
  assertCondition(initial.hasDialog && initial.hasIntro && initial.hasDemo && initial.hasReal && initial.hasLater, "First-run activation dialog missing expected choices.");
  assertCondition(!initial.hasMainShell && !initial.hasPrimaryNav, "Main application shell is visible before activation completes.");
  assertNoHorizontalOverflow(initial, "Initial");

  await evaluate(cdp, `Array.from(document.querySelectorAll('.first-run-guide button')).find((button) => button.innerText.includes('先看样例')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  const afterDemo = await evaluate(cdp, `(() => ({
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasDialog: !!document.querySelector('.first-run-guide'),
    hasPrimaryNav: !!document.querySelector('[data-nav-key="butler"]'),
    hasSample: document.body.innerText.includes('钥匙可能在玄关托盘附近') || document.body.innerText.includes('样例体验') || document.body.innerText.includes('3 件事'),
    textStart: document.body.innerText.slice(0, 240),
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))()`);
  assertCondition(afterDemo.status === "demo_selected", "Demo choice did not persist demo_selected.");
  assertCondition(!afterDemo.hasDialog, "Demo choice did not close the activation dialog.");
  assertCondition(afterDemo.hasPrimaryNav, "Demo mode should enter the sample application shell.");
  assertCondition(afterDemo.hasSample || afterDemo.textStart.includes("样例体验"), `Demo choice did not reveal sample value. Text: ${afterDemo.textStart}`);
  assertNoHorizontalOverflow(afterDemo, "Demo");

  await navigate(cdp, "/butler");
  await evaluate(cdp, "localStorage.setItem('openbutler:first_run_activation:v1', 'unseen'); location.reload(); true");
  await waitForCondition(cdp, "!!document.querySelector('.first-run-guide')", 6000, "first-run dialog before real setup");
  await evaluate(cdp, `Array.from(document.querySelectorAll('.first-run-guide button')).find((button) => button.innerText.includes('整理我的本机记录')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const afterReal = await evaluate(cdp, `(() => ({
    path: location.pathname,
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasLocalSetup: document.body.innerText.includes('启用完整功能前，需要完成这些设置'),
    hasModelConfig: document.body.innerText.includes('模型供应商'),
    hasMineContextScan: document.body.innerText.includes('扫描本机 MineContext'),
    hasAutoInstall: document.body.innerText.includes('自动安装'),
    hasManualInstall: document.body.innerText.includes('手动安装'),
    hasPrimaryNav: !!document.querySelector('[data-nav-key="butler"]'),
    hasNoRealImport: document.body.innerText.includes('不会导入真实活动'),
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))()`);
  assertCondition(afterReal.path === "/butler", `Real setup should stay in activation dialog, got ${afterReal.path}`);
  assertCondition(afterReal.status === "real_setup_started", "Real setup did not persist real_setup_started.");
  assertCondition(afterReal.hasLocalSetup && afterReal.hasModelConfig && afterReal.hasMineContextScan && afterReal.hasAutoInstall && afterReal.hasManualInstall && afterReal.hasNoRealImport, "Real setup did not show model config and MineContext bootstrap panel.");
  assertCondition(!afterReal.hasPrimaryNav, "Real setup should not reveal the main navigation before completion.");
  assertNoHorizontalOverflow(afterReal, "Real setup");

  await navigate(cdp, "/butler");
  await evaluate(cdp, "localStorage.setItem('openbutler:first_run_activation:v1', 'unseen'); location.reload(); true");
  await waitForCondition(cdp, "!!document.querySelector('.first-run-guide')", 6000, "first-run dialog before later choice");
  await evaluate(cdp, `Array.from(document.querySelectorAll('.first-run-guide button')).find((button) => button.innerText.includes('稍后配置')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  const afterLater = await evaluate(cdp, `(() => ({
    status: localStorage.getItem('openbutler:first_run_activation:v1'),
    hasDialog: !!document.querySelector('.first-run-guide'),
    hasMainShell: !!document.querySelector('.app-shell'),
    hasNextStep: document.body.innerText.includes('你可以稍后回来继续设置') || document.body.innerText.includes('先看样例'),
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))()`);
  assertCondition(afterLater.status === "dismissed", "Later choice did not persist dismissed.");
  assertCondition(afterLater.hasDialog && !afterLater.hasMainShell && afterLater.hasNextStep, "Later choice should keep the activation gate instead of entering the full app.");
  assertNoHorizontalOverflow(afterLater, "Later");

  await evaluate(cdp, "localStorage.setItem('openbutler:first_run_activation:v1', 'demo_selected'); true");
  await navigate(cdp, "/me");
  const reopenBefore = await evaluate(cdp, "document.body.innerText.includes('重新选择开始方式')");
  assertCondition(reopenBefore, "/me missing reopen activation guide entry.");
  await evaluate(cdp, `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('重新选择开始方式')).click(); true`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  const afterReopen = await evaluate(cdp, `(() => ({
    hasDialog: !!document.querySelector('.first-run-guide'),
    hasIntro: document.body.innerText.includes('像安装一个私人管家一样开始'),
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))()`);
  assertCondition(afterReopen.hasDialog && afterReopen.hasIntro, "/me did not reopen first-run activation flow.");
  assertNoHorizontalOverflow(afterReopen, "Reopen");

  console.log(JSON.stringify({
    checked: "first-run-activation",
    ok: true,
    webUrl,
    viewport: "390x844",
    initial,
    afterDemo,
    afterReal,
    afterLater,
    afterReopen,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "first-run-activation",
    ok: false,
    webUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
} finally {
  if (cdp) cdp.close();
  if (browser && !browser.killed) browser.kill();
}
