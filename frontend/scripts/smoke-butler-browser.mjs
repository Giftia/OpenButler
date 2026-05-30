import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync, mkdirSync, readFileSync} from "node:fs";
import {createServer} from "node:http";
import {createConnection} from "node:net";
import {tmpdir} from "node:os";
import {extname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer as createNetServer} from "node:net";

const apiBaseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(root, "dist");
const browserPath = process.env.OPENBUTLER_BROWSER_PATH ?? findBrowserPath();

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findBrowserPath() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "msedge",
    "chrome",
    "chromium",
  ];
  return candidates.find((candidate) => candidate.includes("\\") ? existsSync(candidate) : true);
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[extname(filePath)] ?? "application/octet-stream";
}

async function requestJson(path, init) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {"Content-Type": "application/json", ...(init?.headers ?? {})},
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
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

function startStaticProxyServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const proxyResponse = await fetch(new URL(`${url.pathname}${url.search}`, apiBaseUrl), {
          method: request.method,
          headers: {"Content-Type": request.headers["content-type"] ?? "application/json"},
          body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        });
        response.statusCode = proxyResponse.status;
        response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/json");
        response.end(Buffer.from(await proxyResponse.arrayBuffer()));
        return;
      }

      const requestedPath = decodeURIComponent(url.pathname);
      const filePath = requestedPath.startsWith("/assets/")
        ? resolve(distDir, `.${requestedPath}`)
        : resolve(distDir, "index.html");
      if (!filePath.startsWith(distDir) || !existsSync(filePath)) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(filePath));
      response.end(readFileSync(filePath));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  return new Promise((resolveServer, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({
        server,
        port: typeof address === "object" && address ? address.port : 0,
      });
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
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
    this.connected = false;
    this.handshakeDone = false;
    this.buffer = Buffer.alloc(0);
    this.messageHandler = () => undefined;
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      const key = randomBytes(16).toString("base64");
      const port = Number(this.wsUrl.port || 80);
      const timer = setTimeout(() => reject(new Error("Timed out opening browser DevTools socket.")), 10000);
      this.socket = createConnection({host: this.wsUrl.hostname, port}, () => {
        const request = [
          `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
          `Host: ${this.wsUrl.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n");
        this.socket.write(request);
      });
      this.socket.on("data", (chunk) => {
        if (!this.handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            return;
          }
          const header = this.buffer.slice(0, headerEnd).toString("utf8");
          if (!header.includes("101")) {
            clearTimeout(timer);
            reject(new Error(`Browser DevTools socket upgrade failed: ${header.split("\r\n")[0]}`));
            return;
          }
          this.handshakeDone = true;
          this.connected = true;
          const rest = this.buffer.slice(headerEnd + 4);
          this.buffer = Buffer.alloc(0);
          clearTimeout(timer);
          resolveOpen();
          if (rest.length) {
            this.handleFrameData(rest);
          }
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
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }
      let payload = this.buffer.slice(offset, offset + length);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + length);
      if (opcode === 1) {
        this.messageHandler(payload.toString("utf8"));
      } else if (opcode === 8) {
        this.close();
      } else if (opcode === 9) {
        this.sendFrame(payload, 10);
      }
    }
  }

  sendFrame(payload, opcode = 1) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    const mask = randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this.sendFrame(text, 1);
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.ws = new DevToolsSocket(wsUrl);
  }

  async open() {
    this.ws.onMessage((data) => this.handleMessage(data));
    await this.ws.open();
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id && this.pending.has(message.id)) {
      const {resolveMessage, rejectMessage} = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        rejectMessage(new Error(message.error.message));
      } else {
        resolveMessage(message.result);
      }
      return;
    }
    if (message.method && this.eventWaiters.has(message.method)) {
      const waiters = this.eventWaiters.get(message.method) ?? [];
      this.eventWaiters.delete(message.method);
      waiters.forEach((resolveEvent) => resolveEvent(message.params ?? {}));
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, {resolveMessage, rejectMessage});
    });
  }

  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      const wrappedResolve = (params) => {
        clearTimeout(timer);
        resolveEvent(params);
      };
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(wrappedResolve);
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluateText(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText : ''",
    returnByValue: true,
  });
  return result.result?.value ?? "";
}

async function waitForText(cdp, snippet, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await evaluateText(cdp);
    if (text.includes(snippet)) {
      return text;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for page text: ${snippet}. Last text: ${text.slice(0, 300)}`);
}

let staticServer;
let browser;
let cdp;

try {
  assertCondition(existsSync(resolve(distDir, "index.html")), "Missing frontend dist. Run npm run build before browser smoke.");
  assertCondition(Boolean(browserPath), "No Chromium-compatible browser found. Set OPENBUTLER_BROWSER_PATH.");
  await requestJson("/health");
  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");

  staticServer = await startStaticProxyServer();
  const cdpPort = await getFreePort();
  const profileDir = join(tmpdir(), `openbutler-browser-smoke-${Date.now()}`);
  mkdirSync(profileDir, {recursive: true});
  browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    `http://127.0.0.1:${staticServer.port}/butler`,
  ], {stdio: ["ignore", "ignore", "pipe"]});

  let browserStderr = "";
  browser.stderr.on("data", (chunk) => {
    browserStderr += chunk.toString();
  });

  const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  assertCondition(Boolean(pageTarget), "Browser DevTools did not expose a page target.");
  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", 10000).catch(() => undefined);
  await cdp.send("Page.navigate", {url: `http://127.0.0.1:${staticServer.port}/butler`});
  await loadEvent;

  let text = await waitForText(cdp, "Productization Harness", 12000);
  for (const snippet of [
    "目标完成度自检",
    "一页演示包",
    "演练空数据路径",
    "证据边界",
    "strict: external_model_used=false",
    "minecontext_source_deleted=0",
    "copied_screenshots=0",
    "不调用外部模型",
    "不删除 MineContext 源数据",
  ]) {
    assertCondition(text.includes(snippet), `Rendered /butler page missing text: ${snippet}`);
  }
  assertCondition(!text.includes("API 连接失败"), "Rendered /butler page reported an API connection failure.");

  await cdp.send("Runtime.evaluate", {
    expression: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('演练空数据路径'))?.click()",
  });
  text = await waitForText(cdp, "dry_run=true", 12000);
  for (const snippet of [
    "mutates_data=false",
    "演练边界",
    "external_model_used=false",
    "minecontext_source_deleted=0",
    "copied_screenshots=0",
  ]) {
    assertCondition(text.includes(snippet), `Data-insufficient drill UI missing text: ${snippet}`);
  }

  const inboxLoad = cdp.waitForEvent("Page.loadEventFired", 10000).catch(() => undefined);
  await cdp.send("Page.navigate", {url: `http://127.0.0.1:${staticServer.port}/butler/inbox`});
  await inboxLoad;
  await waitForText(cdp, "Butler Inbox", 12000);
  text = await waitForText(cdp, "查看证据详情", 12000);
  await cdp.send("Runtime.evaluate", {
    expression: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('查看证据详情'))?.click()",
  });
  text = await waitForText(cdp, "evidence_boundary", 12000);
  for (const snippet of ["证据详情", "privacy_notes", "未复制截图文件", "未调用外部模型"]) {
    assertCondition(text.includes(snippet), `Inbox evidence detail missing text: ${snippet}`);
  }

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Browser smoke reset must preserve PC Activity events.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Browser smoke reset must preserve MineContext source data.");

  console.log(JSON.stringify({
    checked: "butler-browser-smoke",
    ok: true,
    apiBaseUrl,
    browserPath,
    pageUrl: `http://127.0.0.1:${staticServer.port}/butler`,
    rendered: {
      productization_harness: true,
      objective_status: true,
      demo_pack: true,
      data_insufficient_drill: true,
      inbox_evidence_click: true,
      evidence_boundary: true,
    },
    drill: {
      dry_run: true,
      mutates_data: false,
    },
    privacy: {
      external_model_used: false,
      minecontext_source_deleted: 0,
      copied_screenshots: 0,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-browser-smoke",
    ok: false,
    apiBaseUrl,
    browserPath,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (cdp) {
    cdp.close();
  }
  if (browser && !browser.killed) {
    browser.kill();
  }
  if (staticServer?.server) {
    await new Promise((resolveClose) => staticServer.server.close(resolveClose));
  }
}
