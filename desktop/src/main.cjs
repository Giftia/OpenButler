const {app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage} = require("electron");
const {spawn, execFile, spawnSync} = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

let mainWindow = null;
let tray = null;
let backendProcess = null;
let isQuitting = false;
let smokeQuitScheduled = false;
let backendState = {
  apiBase: "",
  port: null,
  pid: null,
  running: false,
};
let selectedMineContextHome = "";
let selectedMineContextInstaller = "";
let staleBackendCleanupDone = false;

const mineContextBaseUrl = "http://127.0.0.1:1733";
const mineContextReleasesUrl = "https://github.com/volcengine/MineContext/releases";
const mineContextLatestReleaseApi = "https://api.github.com/repos/volcengine/MineContext/releases/latest";

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

function installerDownloadDir() {
  const dir = path.join(userDataDir(), "installers");
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function desktopAssetPath(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", name);
  }
  return path.join(__dirname, "..", "assets", name);
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

function execFileText(command, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(command, args, {windowsHide: true, timeout}, (error, stdout, stderr) => {
      resolve({ok: !error, stdout: stdout || "", stderr: stderr || "", error: error?.message || ""});
    });
  });
}

function uniqueExistingCandidates(items) {
  const seen = new Set();
  return items
    .filter((item) => item && item.path)
    .map((item) => ({...item, path: path.normalize(item.path)}))
    .filter((item) => {
      const key = item.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return item.runningProcess || fs.existsSync(item.path);
    });
}

function knownMineContextPaths() {
  const home = app.getPath("home");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return [
    process.env.OPENBUTLER_MINECONTEXT_EXE,
    path.join(localAppData, "Programs", "MineContext", "MineContext.exe"),
    path.join(localAppData, "MineContext", "MineContext.exe"),
    path.join(programFiles, "MineContext", "MineContext.exe"),
    path.join(programFilesX86, "MineContext", "MineContext.exe"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "MineContext.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "MineContext.lnk"),
  ].filter(Boolean);
}

async function queryRegistryMineContextCandidates() {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const candidates = [];
  for (const root of roots) {
    const result = await execFileText("reg", ["query", root, "/s"], 5000);
    if (!result.ok && !result.stdout) continue;
    const chunks = result.stdout.split(/\r?\n\r?\n/);
    for (const chunk of chunks) {
      if (!/MineContext/i.test(chunk)) continue;
      const displayIcon = chunk.match(/DisplayIcon\s+REG_\w+\s+(.+)/i)?.[1]?.trim();
      const installLocation = chunk.match(/InstallLocation\s+REG_\w+\s+(.+)/i)?.[1]?.trim();
      const iconPath = displayIcon ? displayIcon.replace(/^"|"$/g, "").split(",")[0] : "";
      const installExe = installLocation ? path.join(installLocation.replace(/^"|"$/g, ""), "MineContext.exe") : "";
      if (iconPath) candidates.push({source: "registry", path: iconPath, label: "注册表安装记录"});
      if (installExe) candidates.push({source: "registry", path: installExe, label: "注册表安装目录"});
    }
  }
  return candidates;
}

async function isMineContextProcessRunning() {
  if (process.platform !== "win32") return false;
  const result = await execFileText("tasklist", ["/FI", "IMAGENAME eq MineContext.exe", "/FO", "CSV", "/NH"], 3000);
  return /MineContext\.exe/i.test(result.stdout);
}

async function scanMineContextInstallations() {
  const pathCandidates = knownMineContextPaths().map((candidatePath) => ({
    source: candidatePath === process.env.OPENBUTLER_MINECONTEXT_EXE ? "environment" : "known_path",
    path: candidatePath,
    label: candidatePath.endsWith(".lnk") ? "开始菜单快捷方式" : "常见安装路径",
  }));
  const registryCandidates = await queryRegistryMineContextCandidates();
  const runningProcess = await isMineContextProcessRunning();
  const candidates = uniqueExistingCandidates([
    ...pathCandidates,
    ...registryCandidates,
    runningProcess ? {source: "process", path: "MineContext.exe", label: "正在运行的 MineContext", runningProcess: true} : null,
  ]);
  return {
    found: candidates.length > 0 || runningProcess,
    runningProcess,
    candidates: candidates.map((candidate) => ({
      source: candidate.source,
      label: candidate.label,
      startable: !candidate.runningProcess,
      // Keep concrete paths in Electron IPC for starting only; ordinary UI shows label/count.
      path: candidate.path,
    })),
    privacy: {
      activityRead: false,
      screenshotCopied: false,
      externalModelCalled: false,
    },
  };
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
  const scan = await scanMineContextInstallations();
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
      found: scan.found,
      runningProcess: scan.runningProcess,
      candidates: scan.candidates.map((candidate) => ({
        source: candidate.source,
        label: candidate.label,
        startable: candidate.startable,
      })),
      installerSelected: Boolean(selectedMineContextInstaller),
      silentInstallEnabled: true,
      releasesUrl: mineContextReleasesUrl,
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
  cleanupStaleBackendProcessesOnce();

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

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {stdio: "ignore", windowsHide: true});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

function killProcessByImageName(imageName) {
  if (!imageName || process.platform !== "win32") return;
  spawnSync("taskkill", ["/IM", imageName, "/T", "/F"], {stdio: "ignore", windowsHide: true});
}

function cleanupStaleBackendProcessesOnce() {
  if (staleBackendCleanupDone) return;
  staleBackendCleanupDone = true;
  // Clear backend processes left behind by a previous crash, installer run, or older app version.
  killProcessByImageName("openbutler-backend.exe");
}

function stopBackend() {
  const pid = backendProcess?.pid ?? backendState.pid;
  if (pid) {
    killProcessTree(pid);
  }
  killProcessByImageName("openbutler-backend.exe");
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
    icon: desktopAssetPath("openbutler.ico"),
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
    const smokeQuitAfterMs = Number(process.env.OPENBUTLER_DESKTOP_SMOKE_QUIT_AFTER_MS || 0);
    if (smokeQuitAfterMs > 0 && !smokeQuitScheduled) {
      smokeQuitScheduled = true;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          void mainWindow.webContents.executeJavaScript("window.openbutlerDesktop?.quitApp?.()");
        }
      }, smokeQuitAfterMs);
    }
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
  let image = nativeImage.createFromPath(desktopAssetPath("openbutler.ico"));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(desktopAssetPath("openbutler.png"));
  }
  if (image.isEmpty()) {
    void loadDesktopErrorPage("OpenButler 托盘图标加载失败", "没有找到可用的桌面图标资源。", desktopAssetPath("openbutler.ico"));
  }
  tray = new Tray(image);
  tray.setToolTip("OpenButler");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "打开 OpenButler", click: showMainWindow},
    {label: `本机服务：${backendState.running ? "运行中" : "未运行"}`, enabled: false},
    {label: "重启本机服务", click: async () => { await restartBackend(); showMainWindow(); }},
    {label: "打开本地数据文件夹", click: async () => { await shell.openPath(userDataDir()); }},
    {type: "separator"},
    {label: "退出", click: () => { isQuitting = true; stopBackend(); app.exit(0); }},
  ]));
  tray.on("click", showMainWindow);
  return tray;
}

async function startMineContextFromScan() {
  const scan = await scanMineContextInstallations();
  if (scan.runningProcess) {
    return {ok: true, action: "already_running", message: "已检测到 MineContext 正在运行。", scan};
  }
  const candidate = scan.candidates.find((item) => item.startable && item.path && fs.existsSync(item.path));
  if (candidate) {
    const result = await shell.openPath(candidate.path);
    return {ok: !result, action: "started", message: result || "已尝试启动 MineContext。", scan};
  }
  return {ok: false, action: "not_found", message: "未找到可启动的 MineContext。", scan};
}

function chooseMineContextReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => {
    const name = String(asset.name || "").toLowerCase();
    const url = String(asset.browser_download_url || "");
    return url && (name.endsWith(".exe") || name.endsWith(".msi")) && /(win|windows|setup|installer|minecontext)/i.test(name);
  }) || assets.find((asset) => {
    const name = String(asset.name || "").toLowerCase();
    const url = String(asset.browser_download_url || "");
    return url && (name.endsWith(".exe") || name.endsWith(".msi"));
  });
}

async function downloadMineContextInstaller() {
  const confirm = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["下载并准备安装", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "下载 MineContext",
    message: "OpenButler 将从 MineContext 官方 GitHub Releases 获取最新 Windows 安装包。",
    detail: "下载完成后仍会再次询问你是否安装。不会读取你的活动记录，也不会复制截图。",
  });
  if (confirm.response !== 0) {
    return {ok: false, canceled: true, message: "已取消下载。"};
  }
  try {
    const releaseResponse = await fetchWithTimeout(mineContextLatestReleaseApi, {
      headers: {"Accept": "application/vnd.github+json", "User-Agent": "OpenButler Desktop"},
    }, 12000);
    if (!releaseResponse.ok) {
      await shell.openExternal(mineContextReleasesUrl);
      return {ok: false, action: "manual_download", message: "无法读取最新发行包，已打开下载页面。"};
    }
    const release = await releaseResponse.json();
    const asset = chooseMineContextReleaseAsset(release);
    if (!asset?.browser_download_url) {
      await shell.openExternal(mineContextReleasesUrl);
      return {ok: false, action: "manual_download", version: release?.tag_name || "", message: "没有识别到 Windows 安装包，已打开下载页面。"};
    }
    const assetName = String(asset.name || "MineContext-Setup.exe").replace(/[\\/:*?"<>|]/g, "-");
    const installerPath = path.join(installerDownloadDir(), assetName);
    const response = await fetchWithTimeout(asset.browser_download_url, {
      headers: {"User-Agent": "OpenButler Desktop"},
    }, 60000);
    if (!response.ok) {
      await shell.openExternal(asset.browser_download_url);
      return {ok: false, action: "manual_download", message: "安装包下载失败，已打开浏览器下载页面。"};
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(installerPath, buffer);
    selectedMineContextInstaller = installerPath;
    return {
      ok: true,
      action: "downloaded",
      installerReady: true,
      version: release?.tag_name || "",
      assetName,
      message: "MineContext 安装包已下载，安装前会再次请求确认。",
    };
  } catch (error) {
    await shell.openExternal(mineContextReleasesUrl);
    return {ok: false, action: "manual_download", message: `自动下载失败，已打开下载页面。${error instanceof Error ? error.message : ""}`};
  }
}

function installCommandFor(installerPath) {
  if (installerPath.toLowerCase().endsWith(".msi")) {
    return {
      command: "msiexec",
      args: ["/i", installerPath, "/qn", "/norestart"],
    };
  }
  const envArgs = process.env.OPENBUTLER_MINECONTEXT_SILENT_ARGS;
  return {
    command: installerPath,
    args: envArgs ? envArgs.split(" ").filter(Boolean) : ["/S"],
  };
}

function runInstaller(command, args) {
  return new Promise((resolve) => {
    if (process.env.OPENBUTLER_MINECONTEXT_INSTALL_DRY_RUN === "1") {
      resolve({ok: true, code: 0, dryRun: true});
      return;
    }
    const child = spawn(command, args, {windowsHide: true, stdio: "ignore"});
    child.on("error", (error) => resolve({ok: false, code: null, error: error.message}));
    child.on("exit", (code) => resolve({ok: code === 0, code}));
  });
}

async function installMineContextWithApproval() {
  if (!selectedMineContextInstaller || !fs.existsSync(selectedMineContextInstaller)) {
    return {ok: false, action: "no_installer", message: "还没有可用的 MineContext 安装包。请先自动下载或手动选择安装程序。"};
  }
  const installPlan = installCommandFor(selectedMineContextInstaller);
  const confirm = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["开始安装", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "安装 MineContext",
    message: "即将安装 MineContext，并在安装后尝试启动它。",
    detail: "OpenButler 不会读取活动明细。安装完成后才会把你刚才填写的模型配置写入 MineContext 本机后台。",
  });
  if (confirm.response !== 0) {
    return {ok: false, canceled: true, action: "canceled", message: "已取消安装。"};
  }
  const result = await runInstaller(installPlan.command, installPlan.args);
  if (!result.ok) {
    return {ok: false, action: "install_failed", code: result.code, message: "MineContext 安装程序没有成功完成。你可以改用手动安装。"};
  }
  const scan = await scanMineContextInstallations();
  return {
    ok: true,
    action: result.dryRun ? "install_dry_run" : "installed",
    dryRun: Boolean(result.dryRun),
    scan,
    message: result.dryRun ? "安装 dry-run 已完成。" : "安装程序已完成，正在尝试连接 MineContext。",
  };
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

ipcMain.handle("openbutler:scan-minecontext-installations", async () => scanMineContextInstallations());

ipcMain.handle("openbutler:download-minecontext-installer", async () => downloadMineContextInstaller());

ipcMain.handle("openbutler:install-minecontext-with-approval", async () => installMineContextWithApproval());

ipcMain.handle("openbutler:open-minecontext-download-page", async () => {
  await shell.openExternal(mineContextReleasesUrl);
  return {ok: true, url: mineContextReleasesUrl};
});

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
  const fromScan = await startMineContextFromScan();
  if (fromScan.ok || fromScan.action !== "not_found") return fromScan;
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
  app.exit(0);
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

app.on("will-quit", () => {
  isQuitting = true;
  stopBackend();
});

process.on("exit", () => {
  stopBackend();
});
