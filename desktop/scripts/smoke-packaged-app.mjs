import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, rmSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exePath = resolve(desktopRoot, "dist", "win-unpacked", "OpenButler.exe");
const smokeDir = resolve(desktopRoot, ".tmp", "packaged-smoke");
const smokeFile = resolve(smokeDir, "state.json");
const userDataDir = resolve(smokeDir, "user-data");

if (!existsSync(exePath)) {
  throw new Error(`Packaged app not found: ${exePath}`);
}

rmSync(smokeDir, {recursive: true, force: true});
mkdirSync(smokeDir, {recursive: true});

const child = spawn(exePath, [], {
  env: {
    ...process.env,
    OPENBUTLER_DESKTOP_SMOKE_FILE: smokeFile,
    OPENBUTLER_DESKTOP_USER_DATA_DIR: userDataDir,
  },
  stdio: "ignore",
  windowsHide: true,
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  let payload = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (existsSync(smokeFile)) {
      payload = JSON.parse(readFileSync(smokeFile, "utf8"));
      if (payload.bodyTextLength > 40 || payload.status === "error") break;
    }
    await wait(500);
  }

  if (!payload) {
    throw new Error("Packaged app did not write smoke state");
  }
  if (payload.status === "error") {
    throw new Error(`Packaged app rendered error page: ${payload.error || payload.title || "unknown"}`);
  }
  if (!payload.hasDesktopBridge) {
    throw new Error("Packaged app did not expose window.openbutlerDesktop");
  }
  if (!payload.apiBase || !payload.apiBase.startsWith("http://127.0.0.1:")) {
    throw new Error(`Packaged app has invalid apiBase: ${payload.apiBase}`);
  }
  if (payload.bodyTextLength < 40 || payload.rootChildren < 1) {
    throw new Error(`Packaged app appears blank: ${JSON.stringify(payload)}`);
  }

  const health = await fetch(`${payload.apiBase}/health`).then((response) => response.json());
  if (!health.ok || health.privacy_mode !== "strict") {
    throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
  }

  console.log("packaged desktop smoke ok");
} finally {
  if (child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {stdio: "ignore"});
  }
}
