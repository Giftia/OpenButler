import {spawn} from "node:child_process";
import {existsSync, mkdirSync} from "node:fs";
import {createServer as createNetServer, createConnection} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";

const webUrl = process.env.OPENBUTLER_WEB_URL ?? "http://127.0.0.1:5175";
const browserPath = process.env.OPENBUTLER_BROWSER_PATH ?? findBrowserPath();
const storageKey = "openbutler:first_run_activation:v1";
const forbiddenTerms = [
  "phone_album",
  "seed",
  "source_event_id",
  "raw_ref",
  "evidence_refs",
  "MineContext",
  "godview",
  "PCActivity",
  "butler_core",
  "mock",
];

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
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

async function waitForJson(url, timeoutMs = 12000) {
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 160));
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
    this.ws.onMessage((data) => {
      const message = JSON.parse(data);
      if (!message.id || !this.pending.has(message.id)) return;
      const {resolveMessage, rejectMessage} = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectMessage(new Error(message.error.message));
      else resolveMessage(message.result);
    });
    await this.ws.open();
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
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed";
    throw new Error(detail);
  }
  return result.result?.value;
}

async function navigate(cdp, path) {
  await cdp.send("Page.navigate", {url: `${webUrl}${path}`});
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
}

async function waitForCondition(cdp, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, expression);
    if (lastValue) return lastValue;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return lastValue;
}

async function clickButton(cdp, label) {
  await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.includes(${JSON.stringify(label)}));
    if (!button) throw new Error('Missing button: ${label}');
    button.click();
    return true;
  })()`);
}

let browser;
let cdp;

try {
  assertCondition(Boolean(browserPath), "No Chromium-compatible browser found. Set OPENBUTLER_BROWSER_PATH.");
  await fetch(`${webUrl}/api/butler/demo/run`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({import_pc_activity: true}),
  }).catch(() => undefined);

  const cdpPort = await getFreePort();
  const profileDir = join(tmpdir(), `openbutler-assistant-control-${Date.now()}`);
  mkdirSync(profileDir, {recursive: true});
  browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=390,844",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    `${webUrl}/assistant`,
  ], {stdio: ["ignore", "ignore", "ignore"]});

  const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  assertCondition(Boolean(pageTarget), "Browser DevTools did not expose a page target.");
  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await navigate(cdp, "/assistant");
  await evaluate(cdp, `localStorage.setItem('${storageKey}', 'demo_selected'); location.reload(); true`);
  await waitForCondition(cdp, "document.body.innerText.includes('你可以直接问我今天该看什么')", 10000);

  const initial = await evaluate(cdp, `(() => {
    const text = document.body.innerText;
    const forbiddenTerms = ${JSON.stringify(forbiddenTerms)};
    return {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      hasCapabilities: ['回看今天', '查时间线', '解释依据', '调整提醒'].every((term) => text.includes(term)),
      hasPrompts: ['今天有什么值得注意？', '查看今日记录', '帮我生成晚间复盘'].every((term) => text.includes(term)),
      forbiddenVisible: forbiddenTerms.filter((term) => text.includes(term)),
      firstText: text.slice(0, 900)
    };
  })()`);
  assertCondition(initial.scrollWidth <= initial.width, `Assistant overflows horizontally: ${initial.scrollWidth} > ${initial.width}`);
  assertCondition(initial.hasCapabilities, "Assistant capability cards are missing.");
  assertCondition(initial.hasPrompts, "Assistant quick prompts are missing.");
  assertCondition(initial.forbiddenVisible.length === 0, `Forbidden internal terms visible initially: ${initial.forbiddenVisible.join(", ")}`);

  await clickButton(cdp, "今天有什么值得注意？");
  await waitForCondition(cdp, "document.body.innerText.includes('关键数字：') && document.body.innerText.includes('边界说明：') && document.body.innerText.includes('下一步：')", 12000);

  await clickButton(cdp, "解释这条提醒的依据");
  await waitForCondition(cdp, "document.body.innerText.includes('依据：') && document.body.innerText.includes('普通页面不会展示本地截图路径')", 12000);

  await clickButton(cdp, "这个建议不准确");
  await waitForCondition(cdp, "document.body.innerText.includes('已记录') || document.body.innerText.includes('没有可反馈')", 12000);

  const finalState = await evaluate(cdp, `(() => {
    const text = document.body.innerText;
    const forbiddenTerms = ${JSON.stringify(forbiddenTerms)};
    return {
      hasStructure: ['结论：', '依据：', '边界说明：', '下一步：'].every((term) => text.includes(term)),
      hasNoMemoryClaim: text.includes('不会凭聊天记忆') || text.includes('不能确认远程'),
      forbiddenVisible: forbiddenTerms.filter((term) => text.includes(term)),
      text: text.slice(0, 1400)
    };
  })()`);
  assertCondition(finalState.hasStructure, "Assistant answer structure is missing.");
  assertCondition(finalState.hasNoMemoryClaim, "Assistant does not state the evidence boundary clearly.");
  assertCondition(finalState.forbiddenVisible.length === 0, `Forbidden internal terms visible after answers: ${finalState.forbiddenVisible.join(", ")}`);

  console.log(JSON.stringify({
    checked: "assistant-natural-control",
    ok: true,
    webUrl,
    viewport: "390x844",
    initial,
    finalState: {
      hasStructure: finalState.hasStructure,
      hasNoMemoryClaim: finalState.hasNoMemoryClaim,
      forbiddenVisible: finalState.forbiddenVisible,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "assistant-natural-control",
    ok: false,
    webUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
} finally {
  if (cdp) cdp.close();
  if (browser && !browser.killed) browser.kill();
}
