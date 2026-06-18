import {readFileSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const required = [
  "package.json",
  "src/main.cjs",
  "src/preload.cjs",
  "assets/openbutler.ico",
  "backend_entry.py",
  "desktop_backend.spec",
];

for (const file of required) {
  const path = join(root, file);
  if (!existsSync(path)) {
    throw new Error(`Missing desktop file: ${file}`);
  }
}

const main = readFileSync(join(root, "src/main.cjs"), "utf8");
const preload = readFileSync(join(root, "src/preload.cjs"), "utf8");
const backendEntry = readFileSync(join(root, "backend_entry.py"), "utf8");
const packageJson = readFileSync(join(root, "package.json"), "utf8");

const expectations = [
  ["main binds backend to loopback", main.includes("127.0.0.1")],
  ["main sets strict privacy", main.includes('OPENBUTLER_DEFAULT_PRIVACY_MODE: "strict"')],
  ["main disables seed events", main.includes('OPENBUTLER_DISABLE_SEED_EVENTS: "1"')],
  ["main blocks screenshot copy", main.includes('OPENBUTLER_COPY_SCREENSHOTS: "0"')],
  ["main blocks external models", main.includes('OPENBUTLER_EXTERNAL_MODEL_ALLOWED: "0"')],
  ["preload exposes runtime getter", preload.includes("getRuntime")],
  ["preload exposes backend restart", preload.includes("restartBackend")],
  ["preload exposes directory chooser", preload.includes("chooseMineContextHome")],
  ["preload exposes data folder opener", preload.includes("openDataFolder")],
  ["preload exposes MineContext status", preload.includes("getMineContextStatus")],
  ["preload exposes model config apply", preload.includes("applyMineContextModelConfig")],
  ["main implements tray", main.includes("new Tray") && main.includes("打开 OpenButler")],
  ["main loads tray icon from file", main.includes("openbutler.ico") && main.includes("nativeImage.createFromPath")],
  ["main checks empty tray icon", main.includes("isEmpty()") && main.includes("托盘图标")],
  ["main implements single instance", main.includes("requestSingleInstanceLock") && main.includes("second-instance")],
  ["main has desktop load error page", main.includes("loadDesktopErrorPage") && main.includes("did-fail-load")],
  ["main writes packaged smoke state", main.includes("OPENBUTLER_DESKTOP_SMOKE_FILE") && main.includes("bodyTextLength")],
  ["backend entry guards missing standard streams", backendEntry.includes("_ensure_standard_streams") && backendEntry.includes("sys.stderr is None")],
  ["backend entry disables uvicorn default log config", backendEntry.includes("log_config=None") && backendEntry.includes("access_log=False")],
  ["windows prototype build skips signing/editing", packageJson.includes('"signAndEditExecutable": false')],
  ["desktop frontend build uses relative asset mode", packageJson.includes("build-frontend-for-desktop")],
  ["desktop installer build bumps version", packageJson.includes("build-installer.mjs")],
  ["MineContext model config posts only to loopback", main.includes("127.0.0.1:1733") && main.includes("/api/model_settings/update")],
  ["MineContext model config redacts keys", main.includes("apiKeyConfigured") && !main.includes("apiKey: payload.config.apiKey")],
  ["main can scan MineContext installations", main.includes("scanMineContextInstallations") && main.includes("OPENBUTLER_MINECONTEXT_EXE")],
  ["main can download latest MineContext release", main.includes("downloadMineContextInstaller") && main.includes("api.github.com/repos/volcengine/MineContext/releases/latest")],
  ["main gates MineContext install behind approval", main.includes("installMineContextWithApproval") && main.includes("showMessageBox")],
  ["preload exposes MineContext scan", preload.includes("scanMineContextInstallations")],
  ["preload exposes MineContext download/install", preload.includes("downloadMineContextInstaller") && preload.includes("installMineContextWithApproval")],
  ["preload exposes MineContext download page", preload.includes("openMineContextDownloadPage")],
  ["windows build config uses app icon", packageJson.includes('"icon": "assets/openbutler.ico"')],
  ["electron builder packages desktop assets", packageJson.includes('"from": "assets"') && packageJson.includes('"to": "assets"')],
];

const failed = expectations.filter(([, ok]) => !ok);
if (failed.length) {
  throw new Error(`Desktop contract failed: ${failed.map(([name]) => name).join(", ")}`);
}

console.log("desktop contract ok");
