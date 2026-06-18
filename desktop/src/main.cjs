const {app, BrowserWindow, dialog, ipcMain, shell} = require("electron");
const {spawn} = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

let mainWindow = null;
let backendProcess = null;
let backendState = {
  apiBase: "",
  port: null,
  pid: null,
  running: false,
};
let selectedMineContextHome = "";

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function userDataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, {recursive: true});
  return dir;
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

  const indexPath = frontendIndexPath();
  if (fs.existsSync(indexPath)) {
    await mainWindow.loadFile(indexPath);
  } else {
    await mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      "<h1>OpenButler 前端还没有构建</h1><p>请先运行 npm --prefix frontend run build。</p>"
    ));
  }
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

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);
