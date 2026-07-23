import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8"));
const channel = process.argv.includes("--channel=preview") ? "preview" : "stable";
const productName = channel === "preview" ? "OpenButler Preview" : "OpenButler";
const executableName = `${productName}.exe`;
const backendName = channel === "preview" ? "openbutler-backend-preview.exe" : "openbutler-backend.exe";
const distName = channel === "preview" ? "dist-preview" : "dist";
const distPath = resolve(desktopRoot, distName);
const defaultSetupPath = channel === "preview" && existsSync(distPath)
  ? readdirSync(distPath).filter((name) => /^OpenButler-Preview-Setup-.*\.exe$/i.test(name)).sort().at(-1)
  : `${productName}-Setup-${packageJson.version}.exe`;
const setupPath = process.env.OPENBUTLER_INSTALLER_PATH || resolve(distPath, defaultSetupPath || "missing-preview-installer.exe");
const unpackedExe = resolve(desktopRoot, distName, "win-unpacked", executableName);
const installDir = process.env.OPENBUTLER_INSTALL_DIR || join(process.env.LOCALAPPDATA || "", "Programs", productName);
const installedExe = join(installDir, executableName);
const smokeDir = resolve(desktopRoot, ".tmp", `installer-lifecycle-smoke-${channel}`);

if (!existsSync(setupPath)) throw new Error(`Missing installer: ${setupPath}`);
if (!existsSync(unpackedExe)) throw new Error(`Missing unpacked exe: ${unpackedExe}`);
if (!process.env.LOCALAPPDATA && !process.env.OPENBUTLER_INSTALL_DIR) {
  throw new Error("LOCALAPPDATA is unavailable and OPENBUTLER_INSTALL_DIR was not provided");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSync(command, args, label) {
  const result = spawnSync(command, args, {stdio: "inherit", windowsHide: true, timeout: 180000});
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== -1073741819) throw new Error(`${label} exited with ${result.status}`);
  if (result.status === -1073741819) console.warn(`${label} returned known NSIS post-run status 0xC0000005; validating postconditions.`);
}

function taskkillRuntime() {
  for (const image of [executableName, backendName]) {
    spawnSync("taskkill", ["/IM", image, "/T", "/F"], {stdio: "ignore", windowsHide: true});
  }
}

function processCsvLines() {
  const result = spawnSync("wmic", ["process", "where", `name='${executableName}' or name='${backendName}'`, "get", "ProcessId,CommandLine,Name", "/format:csv"], {encoding: "utf8", windowsHide: true});
  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Node,"));
}

function runtimeProcessesContaining(fragment) {
  const normalized = fragment.toLowerCase();
  return processCsvLines().filter((line) => line.toLowerCase().includes(normalized));
}

async function waitForNoRuntimeContaining(fragment, label) {
  const startedAt = Date.now();
  let leaked = [];
  while (Date.now() - startedAt < 20000) {
    leaked = runtimeProcessesContaining(fragment);
    if (!leaked.length) return;
    await wait(500);
  }
  throw new Error(`${label} still has runtime processes: ${leaked.join(" | ")}`);
}

async function waitForPathMissing(path, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    if (!existsSync(path)) return;
    await wait(500);
  }
  throw new Error(`${label} still exists: ${path}`);
}

async function startApp(exePath, label) {
  const stateDir = resolve(smokeDir, label.replace(/[^a-z0-9_-]/gi, "-"));
  const smokeFile = resolve(stateDir, "state.json");
  const userDataDir = resolve(stateDir, "user-data");
  mkdirSync(stateDir, {recursive: true});
  const child = spawn(exePath, [], {
    env: {
      ...process.env,
      OPENBUTLER_DESKTOP_SMOKE_FILE: smokeFile,
      OPENBUTLER_DESKTOP_USER_DATA_DIR: userDataDir,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (existsSync(smokeFile)) {
      const payload = JSON.parse(readFileSync(smokeFile, "utf8"));
      if (payload.status === "error") throw new Error(`${label} rendered error: ${JSON.stringify(payload)}`);
      if (payload.bodyTextLength > 40 && payload.hasDesktopBridge) {
        const expectedPreviewVersion = process.env.OPENBUTLER_EXPECTED_PREVIEW_VERSION;
        if (channel === "preview" && expectedPreviewVersion && payload.previewVersion !== expectedPreviewVersion) {
          throw new Error(`${label} preview version mismatch: expected ${expectedPreviewVersion}, got ${payload.previewVersion || "missing"}`);
        }
        return child;
      }
    }
    if (child.exitCode !== null) throw new Error(`${label} exited before smoke state was ready`);
    await wait(500);
  }
  throw new Error(`${label} did not become ready`);
}

async function waitForExit(child, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    if (child.exitCode !== null || child.killed) return;
    await wait(250);
  }
  throw new Error(`${label} was not stopped by installer lifecycle cleanup`);
}

function findUninstaller() {
  if (!existsSync(installDir)) throw new Error(`Install dir not found: ${installDir}`);
  const match = readdirSync(installDir).find((name) => /^uninstall.*\.exe$/i.test(name));
  if (!match) throw new Error(`Uninstaller not found in ${installDir}`);
  return join(installDir, match);
}

async function main() {
  rmSync(smokeDir, {recursive: true, force: true});
  mkdirSync(smokeDir, {recursive: true});
  taskkillRuntime();
  await wait(1000);

  const unpackedChild = await startApp(unpackedExe, "running-before-install");
  runSync(setupPath, ["/S"], "silent install over running app");
  await waitForExit(unpackedChild, "unpacked app");
  await waitForNoRuntimeContaining(`desktop\\${distName}\\win-unpacked`, "install cleanup");
  if (!existsSync(installedExe)) throw new Error(`Installed app not found after setup: ${installedExe}`);

  const installedChild = await startApp(installedExe, "running-before-uninstall");
  const uninstaller = findUninstaller();
  runSync(uninstaller, ["/S"], "silent uninstall over running app");
  await waitForExit(installedChild, "installed app");
  await waitForNoRuntimeContaining(installDir, "uninstall cleanup");
  await waitForPathMissing(installedExe, "installed executable after uninstall");

  runSync(setupPath, ["/S"], "final silent install");
  if (!existsSync(installedExe)) throw new Error(`Final installed app not found: ${installedExe}`);
  await wait(1000);
  await waitForNoRuntimeContaining(installDir, "final install should not leave app running");
  console.log(`installer lifecycle smoke ok (${channel}): ${setupPath}`);
}

try {
  await main();
} finally {
  taskkillRuntime();
}
