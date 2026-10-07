const {app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage,
  desktopCapturer, powerMonitor, screen, safeStorage} = require("electron");
const {spawn, execFile, spawnSync} = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const {randomBytes} = require("node:crypto");
const {SESSION_HEADER, createLocalApiRequest, isTrustedSender, restrictNavigation} = require("./local-api.cjs");
const {CaptureController, fullDesktopUnavailable} = require("./capture-controller.cjs");
const {PublicWindowProvider} = require("./public-window-provider.cjs");
const {PublicWindowController, SCOPE: PUBLIC_WINDOW_SCOPE} = require("./public-window-controller.cjs");
const {createLocalModelDiscovery, localEndpoint, installedIds} = require("./local-model-discovery.cjs");
const {createModelCatalog} = require("./model-catalog.cjs");
const {createJournal} = require("./model-catalog-journal.cjs");
const packageMetadata = require("../package.json");

const desktopChannel = process.env.OPENBUTLER_DESKTOP_CHANNEL
  || packageMetadata.openbutlerChannel
  || (String(packageMetadata.productName || "").includes("Preview") ? "preview" : "stable");
const isPreviewChannel = desktopChannel === "preview";
const isWindowsRc = packageMetadata.productName === "OpenButler Preview Windows RC";
const backendImageName = isWindowsRc ? "openbutler-backend-windows-rc.exe"
  : packageMetadata.productName === "OpenButler Preview Windows Trial"
  ? "openbutler-backend-windows-trial.exe"
  : isPreviewChannel ? "openbutler-backend-preview.exe" : "openbutler-backend.exe";

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendSessionToken = "";
let backendStartPromise = null;
let backendGeneration = 0;
let backendDiagnostics = {stage: "idle", errorCode: null, exitCode: null};
let isQuitting = false;
let orderlyStopPromise = null;
let quitPromise = null;
let smokeQuitScheduled = false;
let backendState = {
  apiBase: "",
  port: null,
  pid: null,
  running: false,
};
let selectedMineContextHome = "";
let selectedMineContextInstaller = "";
let captureController = null;
let publicWindowController = null;
let publicWindowProvider = null;
// Memory-only: a backend update may succeed before encrypted persistence fails.
let modelRoutesPersistenceUncertain = false;
let modelRoutesSaveInProgress = false;
let sessionModelRoutes = null;
let sessionModelEpoch = 0;
let sessionModelValidationPending = false;
let sessionModelStopPromise = null;
let offlineOcr = null;
let retentionTimer = null;

// Optional, current-app-only rendering fallback for the native Linux trial.
// This does not disable sandboxing, alter permissions or change capture sources.
if (process.platform === "linux" && process.env.OPENBUTLER_SOFTWARE_RENDERING === "1") {
  app.disableHardwareAcceleration();
}

function backendDiagnostic(stage, details = {}) {
  backendDiagnostics = {stage, errorCode: details.errorCode || null,
    exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null};
  if (process.env.OPENBUTLER_STARTUP_DIAGNOSTICS === "1") {
    // Fixed lifecycle codes only. Never log exceptions, endpoints, tokens,
    // request/response bodies, app titles, OCR or image bytes.
    console.warn("OpenButler backend lifecycle " + JSON.stringify(backendDiagnostics));
  }
}

const mineContextBaseUrl = "http://127.0.0.1:1733";
const mineContextReleasesUrl = "https://github.com/volcengine/MineContext/releases";
const mineContextLatestReleaseApi = "https://api.github.com/repos/volcengine/MineContext/releases/latest";
const discoverLocalModels = createLocalModelDiscovery();
// Construction and catalog/status reads do not probe any model endpoint.
const builtinModelCatalog = createModelCatalog({...createJournal(userDataDir)});

if (process.env.OPENBUTLER_DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPENBUTLER_DESKTOP_USER_DATA_DIR);
} else if (isPreviewChannel) {
  app.setPath("userData", path.join(app.getPath("appData"),
    isWindowsRc ? "OpenButler Preview Windows RC"
      : packageMetadata.productName === "OpenButler Preview Windows Trial" ? "OpenButler Preview Windows Trial" : "OpenButler Preview"));
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

function modelRoutesPath() {
  return path.join(userDataDir(), "model-routes.enc");
}

function secureModelStorageAvailable() {
  try {
    if (safeStorage?.isEncryptionAvailable() !== true) return false;
    return process.platform !== "linux" || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]
      .includes(safeStorage.getSelectedStorageBackend?.());
  } catch { return false; }
}

function readEncryptedModelRoutes() {
  try {
    if (!secureModelStorageAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(modelRoutesPath())).toString());
  } catch {
    return null;
  }
}

const PRIVATE_API_PATHS = new Set([
  "/api/context-engine/capture/configure", "/api/context-engine/capture/start",
  "/api/context-engine/capture/pause", "/api/context-engine/observations",
  "/api/context-engine/retention/run", "/api/model_settings/get", "/api/model_settings/update",
]);

async function privateApi(apiPath, body) {
  if (!backendState.running || !backendSessionToken || !PRIVATE_API_PATHS.has(apiPath)) {
    throw new Error("local_service_unavailable");
  }
  const response = await fetch(new URL(apiPath, backendState.apiBase), {
    method: body === undefined ? "GET" : "POST",
    headers: {"Content-Type": "application/json", [SESSION_HEADER]: backendSessionToken},
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("local_operation_failed");
  return response.json();
}

async function privateEvidence(evidenceId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evidenceId || "")
      || !backendState.running || !backendSessionToken) return {ok: false, error: "evidence_unavailable"};
  try {
    const response = await fetch(new URL(`/api/context-engine/evidence/${evidenceId}`, backendState.apiBase), {
      headers: {[SESSION_HEADER]: backendSessionToken}, redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png"
        || Number(response.headers.get("content-length") || 0) > 8 * 1024 * 1024) {
      return {ok: false, error: "evidence_expired_or_unavailable"};
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024 || !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return {ok: false, error: "evidence_unavailable"};
    }
    return {ok: true, dataUrl: `data:image/png;base64,${buffer.toString("base64")}`};
  } catch {
    return {ok: false, error: "evidence_unavailable"};
  }
}

function powershellScript(name) {
  const script = path.join(__dirname, name);
  return app.isPackaged ? script.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep) : script;
}

async function foregroundApplication() {
  if (process.platform !== "win32") return "";
  const result = await execFileText("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    powershellScript("active-app.ps1"),
  ], 5000);
  return result.ok ? result.stdout.trim().slice(0, 120) : "";
}

async function visibleApplications(displayId) {
  if (process.platform !== "win32") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"], thumbnailSize: {width: 0, height: 0},
  });
  const source = sources.find(item => item.id === displayId);
  const display = screen.getAllDisplays().find(item => String(item.id) === source?.display_id);
  if (!display) return null;
  const bounds = display.bounds;
  const result = await execFileText("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    powershellScript("visible-apps.ps1"), "-X", String(bounds.x), "-Y", String(bounds.y),
    "-Width", String(bounds.width), "-Height", String(bounds.height),
  ], 8000);
  return result.ok ? result.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : null;
}

async function captureDisplays() {
  // Do not enumerate or acquire screen sources while full desktop is unavailable.
  return [];
}

async function captureSelectedDisplay() {
  fullDesktopUnavailable();
}

function controller() {
  if (captureController) return captureController;
  captureController = new CaptureController({
    captureScreen: captureSelectedDisplay,
    foregroundApp: foregroundApplication,
    windowNames: visibleApplications,
    ocr: {recognize: async buffer => {
      if (!offlineOcr) {
        const {createOfflineOcr} = require("./offline-ocr.cjs");
        offlineOcr = await createOfflineOcr({resourcesPath: app.isPackaged ? process.resourcesPath : undefined});
      }
      return offlineOcr.recognize(buffer);
    }},
    postObservation: payload => privateApi("/api/context-engine/observations", payload),
    configureBackend: payload => privateApi("/api/context-engine/capture/configure", payload),
    startBackendCapture: () => privateApi("/api/context-engine/capture/start", {}),
    pauseBackendCapture: payload => privateApi("/api/context-engine/capture/pause", payload),
  });
  return captureController;
}

function windowProvider() {
  if (!publicWindowProvider) publicWindowProvider = process.platform === 'win32'
    ? new (require('./windows-public-window-provider.cjs').WindowsPublicWindowProvider)()
    : new PublicWindowProvider();
  return publicWindowProvider;
}

function publicController() {
  if (!publicWindowController) publicWindowController = new PublicWindowController({
    provider: windowProvider(),
    ocr: {recognize: async buffer => {
      if (!offlineOcr) {
        const {createOfflineOcr} = require("./offline-ocr.cjs");
        offlineOcr = await createOfflineOcr({resourcesPath: app.isPackaged ? process.resourcesPath : undefined});
      }
      return offlineOcr.recognize(buffer);
    }},
    postObservation: payload => privateApi("/api/context-engine/observations", payload),
    configureBackend: payload => privateApi("/api/context-engine/capture/configure", payload),
    startBackendCapture: () => privateApi("/api/context-engine/capture/start", {}),
    pauseBackendCapture: payload => privateApi("/api/context-engine/capture/pause", payload),
  });
  return publicWindowController;
}

function selectedController(config) {
  if (config?.capture_scope !== PUBLIC_WINDOW_SCOPE) fullDesktopUnavailable();
  if (captureController?.active || captureController?.busy || captureController?.starting) {
    throw new Error("capture_already_active");
  }
  return publicController();
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
  return path.join(process.resourcesPath, "backend", backendImageName);
}

function acceptancePackPath() {
  return process.env.OPENBUTLER_ACCEPTANCE_PACK || path.join(userDataDir(), "acceptance-pack.json");
}

function sanitizeAcceptanceValue(value, key = "") {
  const forbidden = new Set(["apiKey", "embeddingApiKey", "raw", "raw_output", "raw_ref", "screenshot_paths", "local_path", "database_path", "activity_title", "window_title", "url"]);
  if (forbidden.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeAcceptanceValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeAcceptanceValue(childValue, childKey);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  if (typeof value === "string") {
    return value
      .replace(/[A-Za-z]:\\\\Users\\\\[^\\\\\s]+\\\\[^\s"']+/g, "<redacted-local-path>")
      .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
  }
  return value;
}

function readAcceptancePack() {
  try {
    return sanitizeAcceptanceValue(JSON.parse(fs.readFileSync(acceptancePackPath(), "utf8")));
  } catch {
    return null;
  }
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

async function waitForHealth(apiBase, token, isCurrent, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (isCurrent() && Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchWithTimeout(`${apiBase}/health`, {
        headers: {[SESSION_HEADER]: token}, redirect: "error", credentials: "omit",
      }, Math.min(2500, timeoutMs - (Date.now() - startedAt)));
      if (response.ok && !response.redirected && isCurrent()) return true;
    } catch {
      // Retry readiness without logging transport errors or session credentials.
    }
    if (!isCurrent()) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
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

function startBackend() {
  if (isQuitting) return Promise.resolve(backendState);
  if (orderlyStopPromise) return Promise.resolve(backendState);
  if (sessionModelStopPromise) return Promise.resolve(backendState);
  if (backendStartPromise) return backendStartPromise;
  if (backendProcess && backendState.running) return Promise.resolve(backendState);
  const generation = ++backendGeneration;
  const pending = launchBackend(generation).finally(() => {
    if (backendStartPromise === pending) backendStartPromise = null;
  });
  backendStartPromise = pending;
  return pending;
}

async function launchBackend(generation) {
  try {
    backendDiagnostic("starting");
    const port = await findFreePort();
    if (generation !== backendGeneration || isQuitting) return backendState;
    const dataDir = userDataDir();
    backendSessionToken = randomBytes(32).toString("hex");
    const env = {
      ...process.env,
      OPENBUTLER_DESKTOP: "1",
      OPENBUTLER_HOST: "127.0.0.1",
      OPENBUTLER_PORT: String(port),
      OPENBUTLER_SESSION_TOKEN: backendSessionToken,
      OPENBUTLER_DATA_DIR: dataDir,
      OPENBUTLER_DEFAULT_PRIVACY_MODE: "strict",
      OPENBUTLER_DISABLE_SEED_EVENTS: "1",
      OPENBUTLER_COPY_SCREENSHOTS: "0",
      OPENBUTLER_EXTERNAL_MODEL_ALLOWED: "0",
      OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED: "0",
      PYTHONPATH: path.join(repoRoot(), "backend"),
    };
    if (isPreviewChannel) {
      env.OPENBUTLER_PREVIEW_BUILTIN = "1";
      delete env.MINECONTEXT_HOME;
      delete env.OPENBUTLER_MINECONTEXT_HOME;
    } else if (selectedMineContextHome) {
      env.MINECONTEXT_HOME = selectedMineContextHome;
    }

    const packagedExe = packagedBackendPath();
    let command;
    let args;
    const options = {env, windowsHide: true, stdio: "ignore"};

    if (app.isPackaged && fs.existsSync(packagedExe)) {
      command = packagedExe;
      args = [];
      options.cwd = path.dirname(packagedExe);
    } else {
      command = process.platform === "win32" ? "python" : (process.env.OPENBUTLER_PYTHON || "python3");
      args = ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--no-proxy-headers"];
      options.cwd = path.join(repoRoot(), "backend");
    }

    let child;
    try {
      child = spawn(command, args, options);
    } finally {
      delete env.OPENBUTLER_SESSION_TOKEN;
    }
    backendProcess = child;
    const clearSession = () => {
      if (backendProcess !== child) return;
      sessionModelRoutes = null;
      sessionModelValidationPending = false;
      ++sessionModelEpoch;
      backendSessionToken = "";
      backendProcess = null;
      backendState = {apiBase: "", port: null, running: false, pid: null};
    };
    child.on("exit", code => {
      if (backendProcess !== child) return;
      backendDiagnostic("backend_exited", {exitCode: code});
      clearSession();
    });
    child.on("error", error => {
      if (backendProcess !== child) return;
      backendDiagnostic("spawn_error", {errorCode: error?.code === "ENOENT" ? "python_not_found"
        : error?.code === "EACCES" ? "python_not_executable" : "spawn_failed"});
      clearSession();
    });
    backendState = {
      apiBase: `http://127.0.0.1:${port}`,
      port,
      pid: child.pid ?? null,
      running: false,
    };
    backendDiagnostic("awaiting_health");
    const isCurrent = () => generation === backendGeneration && backendProcess === child;
    const healthy = await waitForHealth(backendState.apiBase, backendSessionToken, isCurrent);
    if (isCurrent()) {
      if (healthy) { backendState = {...backendState, running: true}; backendDiagnostic("healthy"); }
      else { stopBackend(); backendDiagnostic("health_timeout"); }
    }
  } catch {
    if (generation === backendGeneration) { stopBackend(); backendDiagnostic("startup_failed"); }
  }
  return backendState;
}

// Stop only a child created by this instance. On Windows a packaged one-file
// backend has a launcher and Python descendant, so launcher exit alone is not
// proof that its requests and in-memory credentials have stopped.
function stopOwnedSessionBackend() {
  if (sessionModelStopPromise) return sessionModelStopPromise;
  const child = backendProcess;
  if (!child) { stopBackend({terminateProcess: false}); return Promise.resolve(true); }
  const alreadyExited = child.exitCode !== null && child.exitCode !== undefined || Boolean(child.signalCode);
  if (alreadyExited) {
    stopBackend({terminateProcess: false});
    return Promise.resolve(true);
  }
  let finish, timer, exitObserved = false, terminationAccepted = false;
  const pending = new Promise(resolve => { finish = resolve; });
  sessionModelStopPromise = pending;
  stopBackend({terminateProcess: false});
  const confirmed = () => {
    if (!exitObserved || !terminationAccepted) return;
    clearTimeout(timer);
    if (sessionModelStopPromise === pending) sessionModelStopPromise = null;
    finish(true);
  };
  child.once("exit", () => { exitObserved = true; confirmed(); });
  timer = setTimeout(() => {
    backendDiagnostic("stop_unconfirmed", {errorCode: "backend_stop_unconfirmed"});
    finish(false);
  }, 5000);
  try {
    if (process.platform === "win32") {
      // The PID belongs to the retained, still-live ChildProcess; never fall
      // back to a cached status PID, image name, or a global process search.
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true, timeout: 5000,
        });
        terminationAccepted = result.status === 0 && !result.error;
      }
    } else {
      terminationAccepted = child.kill("SIGKILL") === true;
    }
  } catch { /* An uncertain stop stays guarded; no replacement may start. */ }
  confirmed();
  // A failed tree command cannot be certified merely because its launcher
  // later exits. A successful command may finish after the bounded timeout;
  // only that observed owned exit releases its guard.
  return pending;
}

function stopBackend({terminateProcess = true} = {}) {
  if (terminateProcess) return stopOwnedSessionBackend();
  sessionModelRoutes = null;
  sessionModelValidationPending = false;
  ++sessionModelEpoch;
  backendDiagnostic("stopped");
  if (publicWindowController) void publicWindowController.pause("service_restarted").catch(() => {});
  if (captureController) {
    captureController.active = false;
    if (captureController.timer) clearInterval(captureController.timer);
    captureController.timer = null;
    captureController.preview = null;
  }
  ++backendGeneration;
  backendStartPromise = null;
  backendSessionToken = "";
  backendProcess = null;
  backendState = {apiBase: "", port: null, running: false, pid: null};
  refreshTrayStatus();
}

function stopBackendForLifecycle() {
  if (orderlyStopPromise) return orderlyStopPromise;
  // Never delay an in-flight model-validation revocation or an uncertain kill.
  if (sessionModelValidationPending || sessionModelStopPromise || !backendState.running) {
    return Promise.resolve(stopBackend());
  }
  const generation = backendGeneration;
  const pending = (async () => {
    let timer;
    // Controllers stop locally before their first await. Keep the backend token
    // alive briefly to acknowledge the durable stop before a Windows force-kill.
    const stops = [captureController, publicWindowController].filter(Boolean).map(target => {
      try { return Promise.resolve(target.pause("shutdown")); }
      catch { return Promise.resolve(); }
    });
    stops.push(privateApi("/api/context-engine/capture/pause", {reason: "shutdown"}));
    try {
      await Promise.race([Promise.allSettled(stops), new Promise(resolve => {
        timer = setTimeout(resolve, 1000);
      })]);
    } finally { clearTimeout(timer); }
    // A concurrent forced stop must not cause this older operation to kill a
    // replacement process. Unacknowledged stops recover as unknown gaps.
    return generation === backendGeneration ? stopBackend() : false;
  })().finally(() => { if (orderlyStopPromise === pending) orderlyStopPromise = null; });
  orderlyStopPromise = pending;
  return pending;
}

function quitApplication() {
  if (quitPromise) return quitPromise;
  isQuitting = true;
  builtinModelCatalog.close();
  if (retentionTimer) clearInterval(retentionTimer);
  quitPromise = stopBackendForLifecycle().then(stopped => {
    if (stopped === false) {
      isQuitting = false;
      quitPromise = null;
      backendDiagnostic("stop_unconfirmed", {errorCode: "backend_stop_unconfirmed"});
      try {
        void Promise.resolve(dialog?.showMessageBox?.(mainWindow, {type: "error", title: "本机服务尚未确认停止",
          message: "本机服务尚未确认完全停止，已阻止重启和正常退出。请检查本机服务状态。"})).catch(() => {});
      } catch { /* The stop guard remains authoritative if the window is unavailable. */ }
      return false;
    }
    app.exit(0);
    return true;
  });
  return quitPromise;
}

async function restartBackend() {
  if (await stopBackendForLifecycle() === false) return backendState;
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
      sandbox: true,
      additionalArguments: [
        `--openbutler-api-base=${state.apiBase}`,
        `--openbutler-app-version=${app.getVersion()}`,
        `--openbutler-channel=${desktopChannel}`,
      ],
    },
  });

  restrictNavigation(mainWindow.webContents, frontendIndexPath());

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
    builtinModelCatalog.close();
    if (sessionModelValidationPending) void stopOwnedSessionBackend();
    if (publicWindowController) void publicWindowController.pause("renderer_unavailable").catch(() => {});
    void loadDesktopErrorPage("页面渲染进程异常退出", details.reason || "unknown", "");
  });

  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      console.warn("OpenButler renderer reported an error.");
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
    payload.desktopChannel = desktopChannel;
    payload.previewVersion = packageMetadata.openbutlerPreviewVersion || "";
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
  refreshTrayStatus();
  tray.on("click", showMainWindow);
  return tray;
}

function refreshTrayStatus() {
  if (!tray) return;
  const recording = Boolean(captureController?.active || publicWindowController?.active);
  tray.setToolTip(`OpenButler · ${recording ? "正在记录本机屏幕" : "未记录屏幕"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "打开 OpenButler", click: showMainWindow},
    {label: `本机记录：${recording ? "进行中" : "已暂停"}`, enabled: false},
    {label: `本机服务：${backendState.running ? "运行中" : "未运行"}`, enabled: false},
    {label: "重启本机服务", click: async () => { await restartBackend(); showMainWindow(); }},
    {label: "打开本地数据文件夹", click: async () => { await shell.openPath(userDataDir()); }},
    {type: "separator"},
    {label: "退出", click: () => { void quitApplication(); }},
  ]));
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

function handleDesktopRequest(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, mainWindow, frontendIndexPath())) {
      throw new Error("Desktop request denied.");
    }
    if ((isQuitting || orderlyStopPromise) && channel !== "openbutler:quit-app") {
      throw new Error("Desktop service is stopping.");
    }
    if (isPreviewChannel && channel.includes("minecontext")) {
      throw new Error("Legacy source is unavailable in Preview.");
    }
    return handler(event, ...args);
  });
}

ipcMain.handle("openbutler:request-api", createLocalApiRequest({
  getWindow: () => mainWindow,
  getFrontendIndexPath: frontendIndexPath,
  getBackendState: () => backendState,
  getSessionToken: () => isQuitting || orderlyStopPromise ? "" : backendSessionToken,
}));

handleDesktopRequest("openbutler:get-runtime", async () => ({
  apiBase: backendState.apiBase,
  mode: "desktop",
  platform: process.platform,
  appVersion: app.getVersion(),
  channel: desktopChannel,
  acceptancePackAvailable: Boolean(readAcceptancePack()),
  backend: {
    pid: backendState.pid,
    running: backendState.running,
    diagnostics: {...backendDiagnostics},
  },
  userDataReady: fs.existsSync(userDataDir()),
}));

handleDesktopRequest("openbutler:get-capture-displays", async () => captureDisplays());

handleDesktopRequest("openbutler:get-capture-capabilities", async () => ({
  public_window: {supported: windowProvider().probe ? await windowProvider().probe().catch(() => false) : windowProvider().available(),
    platform: windowProvider().platform || "linux-x11",
    lock_state: windowProvider().lockState || "unknown",
    lock_protection_supported: windowProvider().lockProtectionSupported === true,
    reason: windowProvider().available() ? "requires_verified_window_preview" : "public_window_platform_unsupported"},
  full_desktop: {supported: false, reason: "full_desktop_unavailable"},
}));

handleDesktopRequest("openbutler:get-capture-windows", async () => {
  try { return {ok: true, sources: await windowProvider().listSources()}; }
  catch (error) { return {ok: false, sources: [], error: error.message || "window_source_unavailable"}; }
});

handleDesktopRequest("openbutler:get-masked-capture-preview", async (_event, config) => {
  if (modelRoutesSaveInProgress) return {ok: false, error_code: "model_routes_save_in_progress",
    error: "模型配置正在验证，请完成后重新查看隐私预览。"};
  try {
    return await selectedController(config).previewMasked(config);
  } catch (error) {
    const code = /^[a-z_]{1,80}$/.test(error?.message || "") ? error.message : "privacy_processing_failed";
    return {ok: false, error_code: code, error: code === "full_desktop_unavailable"
      ? "完整桌面采集尚未通过隐私验证，当前不可用。请单独确认专用公开窗口范围。"
      : config?.capture_scope === PUBLIC_WINDOW_SCOPE
      ? `专用窗口预览已安全停止（${code}）。请重新检查窗口身份、前台排除和本机识字组件。`
      : "隐私预览失败。请检查本机识字组件或选择其他显示器。"};
  }
});

handleDesktopRequest("openbutler:start-builtin-capture", async (_event, config) => {
  if (modelRoutesSaveInProgress) return {ok: false, error_code: "model_routes_save_in_progress",
    error: "模型配置正在验证，记录保持暂停。"};
  try {
    const state = await selectedController(config).start(config);
    refreshTrayStatus();
    return {ok: true, ...state};
  } catch (error) {
    const code = /^[a-z_]{1,80}$/.test(error?.message || "") ? error.message : "capture_start_failed";
    return {ok: false, error_code: code, error: code === "full_desktop_unavailable"
      ? "完整桌面采集尚未通过隐私验证，当前不可用。请单独确认专用公开窗口范围。"
      : error?.message === "privacy_preview_required"
      ? "请先查看遮挡预览，再开始记录。" : "未能开始记录。请检查本机服务和授权。"};
  }
});

handleDesktopRequest("openbutler:pause-builtin-capture", async () => {
  try {
    const target = publicWindowController && (publicWindowController.active || publicWindowController.preview
      || publicWindowController.busy) ? publicWindowController : controller();
    const state = await target.pause();
    refreshTrayStatus();
    return {ok: true, ...state};
  } catch {
    return {ok: false, error: "本机服务不可用，记录已在桌面端停止。"};
  }
});

handleDesktopRequest("openbutler:get-capture-state", async () =>
  (captureController?.active ? captureController.state() : null)
    || publicWindowController?.state() || captureController?.state()
    || {active: false, intervalSeconds: 60, lastResult: "idle"});

handleDesktopRequest("openbutler:get-masked-evidence", async (_event, evidenceId) =>
  privateEvidence(evidenceId));

// Session-only local model routes never enter the encrypted file or desktop state.
function keylessSessionConfiguration(proposed) {
  const record = (item, keys) => item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every(key => keys.includes(key));
  if (!record(proposed, ["image", "text", "external_consent", "masked_data_consent"])
      || ![undefined, false].includes(proposed.external_consent)
      || ![undefined, false].includes(proposed.masked_data_consent)) throw new Error("session_models_invalid_configuration");
  const payload = {external_consent: false, masked_data_consent: false};
  for (const target of ["image", "text"]) {
    const route = proposed[target];
    if (!record(route, ["mode", "protocol", "endpoint", "model", "api_key", "thinking"])
        || route.mode !== "local" || route.protocol !== "ollama_native"
        || ![undefined, null, ""].includes(route.api_key)
        || (route.thinking !== undefined && typeof route.thinking !== "boolean")) {
      throw new Error("session_models_invalid_configuration");
    }
    const endpoint = localEndpoint(route.endpoint).endpoint;
    // Reject noncanonical alternate host/port spellings, never silently retarget.
    if (new URL(endpoint).origin !== endpoint) throw new Error("session_models_invalid_configuration");
    installedIds({models: [{name: route.model}]});
    payload[target] = {mode: "local", protocol: "ollama_native", endpoint,
      model: route.model, thinking: route.thinking === true};
  }
  return payload;
}

function sessionModelMetadata(configuration) {
  const safe = route => ({mode: route.mode, protocol: route.protocol, endpoint: route.endpoint,
    model: route.model, thinking: route.thinking === true, apiKeyConfigured: false});
  return {image: safe(configuration.image), text: safe(configuration.text)};
}

function sessionModelFailure(error_code) {
  return {ok: false, ready: false, persistence: "session_only", savedConfigurationAvailable: false,
    persistenceUncertain: false, requiresRevalidation: true, error_code,
    error: "本次临时模型配置未启用，请检查本机服务并重新验证。"};
}

function sameDesktopRequest(event, sender, frame, initialUrl) {
  try { return event.sender === sender && event.senderFrame === frame && frame.url === initialUrl
    && isTrustedSender(event, mainWindow, frontendIndexPath()); } catch { return false; }
}

handleDesktopRequest("openbutler:get-builtin-model-routes", async (event) => {
  const sender = event.sender, frame = event.senderFrame;
  let initialUrl;
  try { initialUrl = frame.url; } catch { return sessionModelFailure("session_models_cancelled"); }
  const epoch = sessionModelEpoch;
  try {
    const state = await privateApi("/api/model_settings/get");
    if (epoch !== sessionModelEpoch || !sameDesktopRequest(event, sender, frame, initialUrl))
      return sessionModelFailure("session_models_cancelled");
    if (sessionModelRoutes) return {...state, persistence: "session_only", routes: sessionModelMetadata(sessionModelRoutes),
      savedConfigurationAvailable: false, persistenceUncertain: false,
      requiresRevalidation: state.ready !== true, external_consent: false, masked_data_consent: false};
    const saved = readEncryptedModelRoutes();
    const safeRoute = (route) => route ? {
      mode: route.mode, protocol: route.protocol, endpoint: route.endpoint,
      model: route.model, thinking_mode: route.thinking_mode,
      thinking_transport: route.thinking_transport,
      apiKeyConfigured: Boolean(route.api_key),
    } : null;
    return {...state, savedConfigurationAvailable: Boolean(saved),
      persistenceUncertain: modelRoutesPersistenceUncertain,
      requiresRevalidation: Boolean(modelRoutesPersistenceUncertain || (saved && !state.ready)),
      ...(saved ? {routes: {image: safeRoute(saved.image), text: safeRoute(saved.text)},
        external_consent: saved.external_consent === true,
        masked_data_consent: saved.masked_data_consent === true} : {})};
  } catch {
    if (!sameDesktopRequest(event, sender, frame, initialUrl)) return sessionModelFailure("session_models_cancelled");
    if (sessionModelRoutes) return {...sessionModelFailure("local_service_unavailable"),
      routes: sessionModelMetadata(sessionModelRoutes)};
    return {ready: false, error_code: "local_service_unavailable",
      persistenceUncertain: modelRoutesPersistenceUncertain,
      requiresRevalidation: modelRoutesPersistenceUncertain};
  }
});

handleDesktopRequest("openbutler:list-builtin-local-models", async (event, input) => {
  const sender = event.sender, frame = event.senderFrame, initialUrl = frame.url;
  const result = await discoverLocalModels(input);
  let current = false;
  try { current = event.sender === sender && event.senderFrame === frame && frame.url === initialUrl
    && isTrustedSender(event, mainWindow, frontendIndexPath()); } catch {}
  if (!current) {
    return {ok: false, models: [], endpoint: '', error_code: 'local_discovery_cancelled'};
  }
  return result;
});

handleDesktopRequest("openbutler:get-builtin-model-catalog", () => builtinModelCatalog.getCatalog());
handleDesktopRequest("openbutler:open-builtin-model-catalog-link", async (_event, input) => {
  const url = builtinModelCatalog.catalogLink(input);
  if (!url) return {ok: false, error_code: "catalog_invalid_link"};
  try { await shell.openExternal(url); return {ok: true}; }
  catch { return {ok: false, error_code: "catalog_link_unavailable"}; }
});
handleDesktopRequest("openbutler:get-builtin-model-download", (_event, input) => builtinModelCatalog.status(input));
handleDesktopRequest("openbutler:cancel-builtin-model-download", (_event, input) => builtinModelCatalog.cancel(input));
handleDesktopRequest("openbutler:inspect-builtin-model-host", async (event, input) => {
  const sender = event.sender, frame = event.senderFrame, initialUrl = frame.url;
  const isCurrent = () => sameDesktopRequest(event, sender, frame, initialUrl);
  const result = await builtinModelCatalog.inspect(input, {isCurrent});
  return isCurrent() ? result : {ok: false, endpoint: "", error_code: "catalog_inspection_stale"};
});
handleDesktopRequest("openbutler:start-builtin-model-download", (event, input) => {
  const sender = event.sender, frame = event.senderFrame, initialUrl = frame.url;
  return builtinModelCatalog.start(input, {isCurrent: () => sameDesktopRequest(event, sender, frame, initialUrl)});
});

handleDesktopRequest("openbutler:use-builtin-local-models-for-session", async (event, proposed) => {
  if (modelRoutesSaveInProgress) return sessionModelFailure("model_routes_save_in_progress");
  let payload;
  try { payload = keylessSessionConfiguration(proposed); }
  catch { return sessionModelFailure("session_models_invalid_configuration"); }
  const sender = event.sender, frame = event.senderFrame;
  let initialUrl;
  try { initialUrl = frame.url; } catch { return sessionModelFailure("session_models_cancelled"); }
  const epoch = ++sessionModelEpoch, backend = backendGeneration;
  modelRoutesSaveInProgress = true;
  sessionModelValidationPending = true;
  let dispatched = false;
  const current = () => epoch === sessionModelEpoch && backend === backendGeneration
    && sameDesktopRequest(event, sender, frame, initialUrl);
  const cancelOwnedBackend = async () => {
    if (dispatched && backend === backendGeneration) return stopOwnedSessionBackend();
    return true;
  };
  try {
    // Consume all previews as well as active sampling; enabling never resumes capture.
    if (captureController) await captureController.pause("model_reconfigured");
    if (!current()) return sessionModelFailure("session_models_cancelled");
    if (publicWindowController) await publicWindowController.pause("model_reconfigured");
    if (!current()) return sessionModelFailure("session_models_cancelled");
    refreshTrayStatus();
    if (!backendState.running) return sessionModelFailure("local_service_unavailable");
    dispatched = true;
    const result = await privateApi("/api/model_settings/update", payload);
    if (!current()) {
      const stopped = await cancelOwnedBackend();
      return sessionModelFailure(stopped ? "session_models_cancelled" : "session_models_stop_unconfirmed");
    }
    if (result?.ok !== true || result?.ready !== true) {
      const stopped = await cancelOwnedBackend();
      const localityFailure = ["local_model_remote", "local_model_unverified", "local_provider_unsupported"].includes(result?.error_code)
        ? result.error_code : "session_models_validation_failed";
      return sessionModelFailure(stopped ? localityFailure : "session_models_stop_unconfirmed");
    }
    sessionModelRoutes = payload;
    // A prior uncertain encrypted save cannot label a deliberately unsaved RAM pair.
    modelRoutesPersistenceUncertain = false;
    const routes = sessionModelMetadata(payload);
    const status = {ready: true, image: routes.image, text: routes.text,
      external_consent: false, masked_data_consent: false};
    for (const [key, maximum] of [["local_total_timeout_seconds", 120], ["external_total_timeout_seconds", 10]]) {
      if (typeof result[key] === "number" && Number.isFinite(result[key]) && result[key] > 0 && result[key] <= maximum) {
        status[key] = result[key];
      }
    }
    return {ok: true, ...status, status, routes, persistence: "session_only",
      savedConfigurationAvailable: false, persistenceUncertain: false, requiresRevalidation: false};
  } catch {
    const errorCode = current() ? "session_models_validation_failed" : "session_models_cancelled";
    const stopped = await cancelOwnedBackend();
    return sessionModelFailure(stopped ? errorCode : "session_models_stop_unconfirmed");
  } finally {
    sessionModelValidationPending = false;
    modelRoutesSaveInProgress = false;
  }
});

handleDesktopRequest("openbutler:revoke-builtin-session-models", async (event) => {
  const sender = event.sender, frame = event.senderFrame;
  let initialUrl;
  try { initialUrl = frame.url; } catch { return sessionModelFailure("session_models_cancelled"); }
  if (sessionModelRoutes || sessionModelValidationPending || sessionModelStopPromise || modelRoutesPersistenceUncertain || modelRoutesSaveInProgress) {
    // An unconfirmed encrypted save may have changed live routes after clearing
    // the session marker. It must be revoked through the same owned stop.
    // Terminating only our backend also cancels an unconfirmed in-flight update.
    // The fresh backend has no routes; no stored configuration is restored.
    if (!await stopOwnedSessionBackend()) return sessionModelFailure("session_models_stop_unconfirmed");
  }
  if (!sameDesktopRequest(event, sender, frame, initialUrl)) return sessionModelFailure("session_models_cancelled");
  // Explicit recovery is also useful after a failed attempt already cleared RAM.
  if (!backendState.running) await startBackend();
  if (!sameDesktopRequest(event, sender, frame, initialUrl)) return sessionModelFailure("session_models_cancelled");
  return {ok: true, ready: false, persistence: "session_only", sessionRevoked: true,
    savedConfigurationAvailable: false, persistenceUncertain: false, requiresRevalidation: true,
    backendRunning: backendState.running};
});

handleDesktopRequest("openbutler:save-builtin-model-routes", async (_event, proposed) => {
  if (modelRoutesSaveInProgress) {
    return {ok: false, error: "模型配置正在验证或保存，请等待完成后重试。",
      error_code: "model_routes_save_in_progress"};
  }
  modelRoutesSaveInProgress = true;
  const saveBackendGeneration = backendGeneration;
  try {
    if (!secureModelStorageAvailable()) {
      return {ok: false, error: "本机密钥存储不可用，配置未保存。"};
    }
    if (!proposed || typeof proposed !== "object" || !proposed.image || !proposed.text) {
      return {ok: false, error: "模型配置不完整。"};
    }
    if (captureController?.active) {
      try {
        await captureController.pause("model_reconfigured");
        refreshTrayStatus();
      } catch {
        return {ok: false, error: "录制尚未安全暂停，模型配置未更改。"};
      }
    }
    if (publicWindowController?.active || publicWindowController?.busy || publicWindowController?.preview) {
      await publicWindowController.pause("model_reconfigured");
    }
    const saved = readEncryptedModelRoutes();
    const current = {};
    for (const target of ["image", "text"]) {
      const item = proposed[target];
      const old = saved?.[target];
      if (!item || typeof item !== "object") return {ok: false, error: "模型配置不完整。"};
      const sameEndpoint = old && old.endpoint === item.endpoint && old.protocol === item.protocol
        && old.mode === item.mode;
      current[target] = {...item, api_key: item.api_key || (sameEndpoint ? old.api_key : null) || null};
    }
    const payload = {
      image: current.image, text: current.text,
      external_consent: proposed.external_consent === true,
      masked_data_consent: proposed.masked_data_consent === true,
    };
    const destinations = (routes) => ["image", "text"].map((target) => {
      const route = routes?.[target];
      return route?.mode === "custom" ? `${target}:${route.endpoint}` : `${target}:local`;
    }).join("|");
    const external = [current.image, current.text].some((route) => route.mode === "custom");
    if (external && (!payload.external_consent || !payload.masked_data_consent)) {
      return {ok: false, error: "外部模型需要明确同意联网调用和发送遮挡后数据。"};
    }
    if (external && (destinations(saved) !== destinations(current)
        || !saved?.external_consent || !saved?.masked_data_consent)) {
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: "warning", title: "确认外部模型接收方",
        message: "要把遮挡后的本机记录发送给以下模型服务吗？",
        detail: [current.image, current.text].filter((route) => route.mode === "custom")
          .map((route) => route.endpoint).join("\n")
          + "\n已发送的请求无法撤回。只有确认后才保存这次接收方授权。",
        buttons: ["确认接收方", "取消"], defaultId: 1, cancelId: 1,
      });
      if (confirmation.response !== 0) return {ok: false, error: "已取消外部模型授权。"};
    }
    if (saveBackendGeneration !== backendGeneration) return {ok: false, error_code: "model_routes_save_cancelled",
      error: "配置保存已取消，本机服务已更换。请重新检查后手动验证。"};
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(payload));
      const previousUncertainty = modelRoutesPersistenceUncertain;
      modelRoutesPersistenceUncertain = true;
      const priorSession = sessionModelRoutes;
      sessionModelRoutes = null;
      const result = await privateApi("/api/model_settings/update", payload);
      if (saveBackendGeneration !== backendGeneration) throw new Error("model_update_cancelled");
      if (result?.ok === false) {
        // An explicit validation rejection leaves the previously active pair unchanged.
        modelRoutesPersistenceUncertain = previousUncertainty;
        sessionModelRoutes = priorSession;
        return {ok: false, error: "模型验证未通过，请检查连接和授权。",
          error_code: result.error_code};
      }
      if (result?.ok !== true) throw new Error("model_update_result_unconfirmed");
      sessionModelRoutes = null;
      ++sessionModelEpoch;
      const temp = modelRoutesPath() + ".tmp";
      fs.writeFileSync(temp, encrypted, {mode: 0o600});
      fs.renameSync(temp, modelRoutesPath());
      modelRoutesPersistenceUncertain = false;
      return {ok: true, status: result};
    } catch {
      return {ok: false, error: "模型配置未保存，请检查本机服务和密钥存储。"};
    }
  } finally {
    modelRoutesSaveInProgress = false;
  }
});

handleDesktopRequest("openbutler:get-acceptance-pack", async () => readAcceptancePack());

handleDesktopRequest("openbutler:save-acceptance-feedback", async (_event, feedback) => {
  if (!isPreviewChannel) return {ok: false, message: "验收反馈只在 Preview 中可用。"};
  const pack = readAcceptancePack();
  if (!pack) return {ok: false, message: "没有可用的验收包。"};
  const safeFeedback = sanitizeAcceptanceValue(feedback || {});
  const result = {
    run_id: pack.run_id,
    saved_at: new Date().toISOString(),
    feedback: safeFeedback,
  };
  fs.writeFileSync(path.join(userDataDir(), "acceptance-feedback.json"), JSON.stringify(result, null, 2), "utf8");
  return {ok: true, savedAt: result.saved_at};
});

handleDesktopRequest("openbutler:restart-backend", async () => {
  const state = await restartBackend();
  return {running: state.running, apiBase: state.apiBase, pid: state.pid,
    ...(sessionModelStopPromise ? {error_code: "backend_stop_unconfirmed",
      error: "本机服务尚未确认完全停止，已阻止重启。请检查本机服务状态。"} : {})};
});

handleDesktopRequest("openbutler:get-minecontext-status", async () => probeMineContext());

handleDesktopRequest("openbutler:scan-minecontext-installations", async () => scanMineContextInstallations());

handleDesktopRequest("openbutler:download-minecontext-installer", async () => downloadMineContextInstaller());

handleDesktopRequest("openbutler:install-minecontext-with-approval", async () => installMineContextWithApproval());

handleDesktopRequest("openbutler:open-minecontext-download-page", async () => {
  await shell.openExternal(mineContextReleasesUrl);
  return {ok: true, url: mineContextReleasesUrl};
});

handleDesktopRequest("openbutler:choose-minecontext-installer", async () => {
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

handleDesktopRequest("openbutler:start-minecontext", async () => {
  const fromScan = await startMineContextFromScan();
  if (fromScan.ok || fromScan.action !== "not_found") return fromScan;
  if (selectedMineContextInstaller) {
    const result = await shell.openPath(selectedMineContextInstaller);
    return {ok: !result, action: "installer_opened", message: result || "已打开你选择的安装程序。"};
  }
  return {ok: false, action: "not_found", message: "未找到 MineContext。请先选择安装程序，或手动启动 MineContext。"};
});

handleDesktopRequest("openbutler:test-minecontext-model-config", async (_event, config) => {
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

handleDesktopRequest("openbutler:apply-minecontext-model-config", async (_event, config) => {
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

handleDesktopRequest("openbutler:show-main-window", async () => {
  showMainWindow();
  return {ok: true};
});

handleDesktopRequest("openbutler:quit-app", async () => {
  const stopped = await quitApplication();
  return stopped === false ? {ok: false, error_code: "backend_stop_unconfirmed"} : {ok: true};
});

handleDesktopRequest("openbutler:choose-minecontext-home", async () => {
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

handleDesktopRequest("openbutler:open-data-folder", async () => {
  await shell.openPath(userDataDir());
  return {ok: true};
});

app.whenReady().then(createWindow);
app.whenReady().then(createTray);
app.whenReady().then(() => {
  for (const eventName of ["lock-screen", "suspend"]) {
    powerMonitor.on(eventName, () => {
      if (publicWindowController?.active || publicWindowController?.busy || publicWindowController?.preview) {
        void publicWindowController.pause(eventName).catch(() => {}).finally(refreshTrayStatus);
      }
      if (captureController?.active) {
        void captureController.pause(eventName).catch(() => {}).finally(refreshTrayStatus);
      }
    });
  }
  void privateApi("/api/context-engine/retention/run", {}).catch(() => {});
  retentionTimer = setInterval(() => {
    void privateApi("/api/context-engine/retention/run", {}).catch(() => {});
  }, 60 * 60 * 1000);
  retentionTimer.unref();
});

app.on("second-instance", showMainWindow);

app.on("window-all-closed", () => {
  if (isQuitting) {
    stopBackend();
    if (process.platform !== "darwin") app.quit();
  }
});

app.on("before-quit", event => {
  event?.preventDefault();
  void quitApplication();
});

app.on("will-quit", () => {
  builtinModelCatalog.close();
  isQuitting = true;
  stopBackend();
});

process.on("exit", () => {
  builtinModelCatalog.close();
  stopBackend();
});
