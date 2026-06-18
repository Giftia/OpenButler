const {app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage} = require("electron");
const {spawn} = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

let mainWindow = null;
let tray = null;
let backendProcess = null;
let isQuitting = false;
let backendState = {
  apiBase: "",
  port: null,
  pid: null,
  running: false,
};
let selectedMineContextHome = "";
let selectedMineContextInstaller = "";

const mineContextBaseUrl = "http://127.0.0.1:1733";

if (process.env.OPENBUTLER_DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPENBUTLER_DESKTOP_USER_DATA_DIR);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function userDataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function desktopStatePath() {
  return path.join(userDataDir(), "desktop-state.json");
}

function readDesktopState() {
  try {
    return JSON.parse(fs.readFileSync(desktopStatePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeDesktopState(patch) {
  const current = readDesktopState();
  const next = {...current, ...patch};
  fs.writeFileSync(desktopStatePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function frontendIndexPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "frontend", "dist", "index.html");
  }
  return path.join(repoRoot(), "frontend", "dist", "index.html");
}

function packagedBackendPath() {
  return path.join(process.resourcesPath, "backend", "openbutler-backend.exe");
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(apiBase, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (lastError) {
    console.warn("Backend health check did not become ready:", lastError.message);
  }
  return false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function redactModelConfig(config = {}) {
  return {
    modelPlatform: config.modelPlatform || "",
    modelId: config.modelId || "",
    baseUrl: config.baseUrl || "",
    apiKeyConfigured: Boolean(config.apiKey),
    embeddingModelPlatform: config.embeddingModelPlatform || "",
    embeddingModelId: config.embeddingModelId || "",
    embeddingBaseUrl: config.embeddingBaseUrl || "",
    embeddingApiKeyConfigured: Boolean(config.embeddingApiKey),
  };
}

function validateModelConfig(config = {}) {
  const missing = [];
  for (const key of ["modelPlatform", "modelId", "baseUrl", "apiKey"]) {
    if (!String(config[key] || "").trim()) missing.push(key);
  }
  if (config.useSeparateEmbedding !== false) {
    for (const key of ["embeddingModelPlatform", "embeddingModelId", "embeddingBaseUrl", "embeddingApiKey"]) {
      if (!String(config[key] || "").trim()) missing.push(key);
    }
  }
  return missing;
}

async function probeMineContext() {
  const state = readDesktopState();
  const checks = [
    `${mineContextBaseUrl}/api/model_settings`,
    `${mineContextBaseUrl}/health`,
    mineContextBaseUrl,
  ];
  let reachable = false;
  let status = "not_running";
  for (const url of checks) {
    try {
      const response = await fetchWithTimeout(url, {method: "GET"}, 1800);
      if (response.status < 500) {
        reachable = true;
        status = "running";
        break;
      }
    } catch {
      // Try the next known local endpoint.
    }
  }
  return {
    baseUrl: mineContextBaseUrl,
    reachable,
    running: reachable,
    status,
    configured: Boolean(state.minecontextModelConfiguredAt),
    model: state.minecontextModelSummary || null,
    install: {
      installerSelected: Boolean(selectedMineContextInstaller),
      silentInstallEnabled: false,
    },
    privacy: {
      localOnly: true,
      writesRequireConfirmation: true,
      apiKeysReturned: false,
      rawActivityReturned: false,
    },
  };
}

async function startBackend() {
  if (backendProcess && backendState.running) return backendState;

  const port = await findFreePort();
  const dataDir = userDataDir();
  const env = {
    ...process.env,
    OPENBUTLER_DESKTOP: "1",
    OPENBUTLER_HOST: "127.0.0.1",
    OPENBUTLER_PORT: String(port),
    OPENBUTLER_DATA_DIR: dataDir,
    OPENBUTLER_DEFAULT_PRIVACY_MODE: "strict",
    OPENBUTLER_DISABLE_SEED_EVENTS: "1",
    OPENBUTLER_COPY_SCREENSHOTS: "0",
    OPENBUTLER_EXTERNAL_MODEL_ALLOWED: "0",
    OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED: "0",
    PYTHONPATH: path.join(repoRoot(), "backend"),
  };
  if (selectedMineContextHome) {
    env.MINECONTEXT_HOME = selectedMineContextHome;
  }

  const packagedExe = packagedBackendPath();
  let command;
  let args;
  let options = {env, windowsHide: true};

  if (app.isPackaged && fs.existsSync(packagedExe)) {
    command = packagedExe;
    args = [];
    options.cwd = path.dirname(packagedExe);
  } else {
    command = process.platform === "win32" ? "python" : "python3";
    args = ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)];
    options.cwd = path.join(repoRoot(), "backend");
  }

  backendProcess = spawn(command, args, options);
  backendProcess.on("exit", () => {
    backendState = {...backendState, running: false, pid: null};
    backendProcess = null;
  });
  backendState = {
    apiBase: `http://127.0.0.1:${port}`,
    port,
    pid: backendProcess.pid ?? null,
    running: true,
  };
  await waitForHealth(backendState.apiBase);
  return backendState;
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
  backendState = {...backendState, running: false, pid: null};
}

async function restartBackend() {
  stopBackend();
  return startBackend();
}

async function createWindow() {
  const state = await startBackend();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "OpenButler",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--openbutler-api-base=${state.apiBase}`,
        `--openbutler-app-version=${app.getVersion()}`,
      ],
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    void loadDesktopErrorPage("页面资源加载失败", `${description} (${code})`, validatedURL || "");
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void loadDesktopErrorPage("页面渲染进程异常退出", details.reason || "unknown", "");
  });

  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      console.warn("OpenButler renderer:", message);
    }
  });

  const indexPath = frontendIndexPath();
  if (fs.existsSync(indexPath)) {
    try {
      await mainWindow.loadFile(indexPath);
      await recordSmokeState("loaded");
    } catch (error) {
      await loadDesktopErrorPage("OpenButler 前端加载失败", error instanceof Error ? error.message : String(error), indexPath);
    }
  } else {
    await loadDesktopErrorPage("OpenButler 前端还没有构建", "请先运行 npm --prefix frontend run build。", indexPath);
  }
}

async function loadDesktopErrorPage(title, detail, source) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safeTitle = String(title).replace(/[<>&]/g, "");
  const safeDetail = String(detail).replace(/[<>&]/g, "");
  const safeSource = String(source).replace(/[<>&]/g, "");
  await mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <!doctype html>
    <html lang="zh-CN">
      <meta charset="utf-8" />
      <title>OpenButler 启动遇到问题</title>
      <body style="margin:0;font-family:'Microsoft YaHei UI',system-ui,sans-serif;background:#eef5f7;color:#0c1f2e;">
        <main style="min-height:100vh;display:grid;place-items:center;padding:40px;">
          <section style="max-width:640px;background:white;border:1px solid #d7e3e8;padding:28px;border-radius:24px;box-shadow:0 20px 60px rgba(16,42,54,.12);">
            <p style="margin:0 0 8px;color:#00796b;font-weight:700;">OpenButler 桌面版</p>
            <h1 style="margin:0 0 14px;font-size:28px;">${safeTitle}</h1>
            <p style="line-height:1.7;color:#435466;">${safeDetail}</p>
            <p style="line-height:1.7;color:#667785;">${safeSource}</p>
            <p style="line-height:1.7;color:#435466;">你可以从系统托盘重启本机服务，或重新安装最新版本。</p>
          </section>
        </main>
      </body>
    </html>
  `));
  await recordSmokeState("error");
}

async function recordSmokeState(status) {
  const smokeFile = process.env.OPENBUTLER_DESKTOP_SMOKE_FILE;
  if (!smokeFile || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const payload = await mainWindow.webContents.executeJavaScript(`(() => ({
      status: ${JSON.stringify(status)},
      title: document.title,
      bodyTextLength: document.body ? document.body.innerText.length : 0,
      rootChildren: document.getElementById("root") ? document.getElementById("root").children.length : 0,
      hasDesktopBridge: Boolean(window.openbutlerDesktop),
      apiBase: window.openbutlerDesktop?.apiBase || "",
      location: window.location.href
    }))()`);
    fs.mkdirSync(path.dirname(smokeFile), {recursive: true});
    fs.writeFileSync(smokeFile, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    fs.mkdirSync(path.dirname(smokeFile), {recursive: true});
    fs.writeFileSync(smokeFile, JSON.stringify({status: "error", error: error.message}, null, 2), "utf8");
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#0b1b26"/>
      <path d="M18 25h28v19H18z" fill="none" stroke="#dff8ed" stroke-width="4" stroke-linejoin="round"/>
      <path d="M25 25v-5h14v5" fill="none" stroke="#dff8ed" stroke-width="4" stroke-linecap="round"/>
      <circle cx="27" cy="34" r="2.5" fill="#4ee6a5"/>
      <circle cx="37" cy="34" r="2.5" fill="#4ee6a5"/>
    </svg>
  `);
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
  tray = new Tray(image);
  tray.setToolTip("OpenButler");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "打开 OpenButler", click: showMainWindow},
    {label: `本机服务：${backendState.running ? "运行中" : "未运行"}`, enabled: false},
    {label: "重启本机服务", click: async () => { await restartBackend(); showMainWindow(); }},
    {label: "打开本地数据文件夹", click: async () => { await shell.openPath(userDataDir()); }},
    {type: "separator"},
    {label: "退出", click: () => { isQuitting = true; stopBackend(); app.quit(); }},
  ]));
  tray.on("click", showMainWindow);
  return tray;
}

ipcMain.handle("openbutler:get-runtime", async () => ({
  apiBase: backendState.apiBase,
  mode: "desktop",
  platform: process.platform,
  appVersion: app.getVersion(),
  backend: {
    pid: backendState.pid,
    running: backendState.running,
  },
  userDataReady: fs.existsSync(userDataDir()),
}));

ipcMain.handle("openbutler:restart-backend", async () => {
  const state = await restartBackend();
  return {running: state.running, apiBase: state.apiBase, pid: state.pid};
});

ipcMain.handle("openbutler:get-minecontext-status", async () => probeMineContext());

ipcMain.handle("openbutler:choose-minecontext-installer", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 MineContext 安装程序",
    properties: ["openFile"],
    filters: [
      {name: "安装程序", extensions: ["exe", "msi"]},
      {name: "所有文件", extensions: ["*"]},
    ],
  });
  if (result.canceled || !result.filePaths[0]) {
    return {canceled: true};
  }
  selectedMineContextInstaller = result.filePaths[0];
  return {canceled: false, selected: true};
});

ipcMain.handle("openbutler:start-minecontext", async () => {
  const candidates = [
    process.env.OPENBUTLER_MINECONTEXT_EXE,
    path.join(app.getPath("home"), "AppData", "Local", "Programs", "MineContext", "MineContext.exe"),
    path.join(app.getPath("home"), "AppData", "Local", "MineContext", "MineContext.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "MineContext", "MineContext.exe"),
  ].filter(Boolean);
  const executable = candidates.find((item) => fs.existsSync(item));
  if (executable) {
    const result = await shell.openPath(executable);
    return {ok: !result, action: "started", message: result || "已尝试启动 MineContext。"};
  }
  if (selectedMineContextInstaller) {
    const result = await shell.openPath(selectedMineContextInstaller);
    return {ok: !result, action: "installer_opened", message: result || "已打开你选择的安装程序。"};
  }
  return {ok: false, action: "not_found", message: "未找到 MineContext。请先选择安装程序，或手动启动 MineContext。"};
});

ipcMain.handle("openbutler:test-minecontext-model-config", async (_event, config) => {
  const missing = validateModelConfig(config);
  const status = await probeMineContext();
  return {
    ok: missing.length === 0 && status.reachable,
    missing,
    minecontextReachable: status.reachable,
    message: status.reachable
      ? missing.length ? "请补全模型配置后再保存。" : "MineContext 可达，配置可以写入。"
      : "MineContext 后台不可达，请先启动 MineContext。",
  };
});

ipcMain.handle("openbutler:apply-minecontext-model-config", async (_event, config) => {
  const missing = validateModelConfig(config);
  if (missing.length) {
    return {ok: false, missing, message: "请补全模型配置后再保存。"};
  }
  const payload = {
    config: {
      modelPlatform: String(config.modelPlatform || "").trim(),
      modelId: String(config.modelId || "").trim(),
      baseUrl: String(config.baseUrl || "").trim(),
      apiKey: String(config.apiKey || "").trim(),
      embeddingModelId: String(config.embeddingModelId || "").trim(),
      embeddingBaseUrl: String(config.embeddingBaseUrl || "").trim(),
      embeddingApiKey: String(config.embeddingApiKey || "").trim(),
      embeddingModelPlatform: String(config.embeddingModelPlatform || "").trim(),
    },
  };
  try {
    const response = await fetchWithTimeout(`${mineContextBaseUrl}/api/model_settings/update`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    }, 8000);
    if (!response.ok) {
      return {ok: false, status: response.status, message: `MineContext 返回 ${response.status}，配置没有保存。`};
    }
    const state = writeDesktopState({
      minecontextModelConfiguredAt: new Date().toISOString(),
      minecontextModelSummary: redactModelConfig(payload.config),
    });
    return {
      ok: true,
      configuredAt: state.minecontextModelConfiguredAt,
      model: state.minecontextModelSummary,
      message: "模型配置已写入 MineContext。",
    };
  } catch {
    return {ok: false, message: "无法连接 MineContext 后台，请确认它已经启动。"};
  }
});

ipcMain.handle("openbutler:show-main-window", async () => {
  showMainWindow();
  return {ok: true};
});

ipcMain.handle("openbutler:quit-app", async () => {
  isQuitting = true;
  stopBackend();
  app.quit();
  return {ok: true};
});

ipcMain.handle("openbutler:choose-minecontext-home", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择本机记录目录",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return {canceled: true};
  }
  selectedMineContextHome = result.filePaths[0];
  await restartBackend();
  return {canceled: false, path: selectedMineContextHome};
});

ipcMain.handle("openbutler:open-data-folder", async () => {
  await shell.openPath(userDataDir());
  return {ok: true};
});

app.whenReady().then(createWindow);
app.whenReady().then(createTray);

app.on("second-instance", showMainWindow);

app.on("window-all-closed", () => {
  if (isQuitting) {
    stopBackend();
    if (process.platform !== "darwin") app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});
