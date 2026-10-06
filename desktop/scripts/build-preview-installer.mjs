import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runId = process.env.OPENBUTLER_PREVIEW_RUN_ID || new Date().toISOString().slice(0, 10).replaceAll("-", "");
if (!/^\d{8}$/.test(runId)) throw new Error("Preview run ID must be YYYYMMDD");
const tmp = join(root, ".tmp", "preview-build");
const output = join(root, "dist-preview");
mkdirSync(tmp, {recursive: true});
mkdirSync(output, {recursive: true});
const isolatedTrial = process.env.OPENBUTLER_PREVIEW_ISOLATED_TRIAL === "1";
const parallelRc = process.env.OPENBUTLER_PREVIEW_PARALLEL_RC === "1";
if (isolatedTrial && parallelRc) throw new Error("Choose one Windows package identity");
const artifactPrefix = parallelRc ? "OpenButler-Preview-Windows-RC" : isolatedTrial ? "OpenButler-Preview-Windows-Trial" : "OpenButler-Preview";
const existing = readdirSync(output).flatMap((name) => {
  const match = name.match(new RegExp(`^${artifactPrefix}-Setup-0\\.2\\.0-preview\\.${runId}\\.(\\d+)\\.exe$`));
  return match ? [Number(match[1])] : [];
});
const sequence = process.env.OPENBUTLER_PREVIEW_SEQUENCE || String(Math.max(0, ...existing) + 1);
if (!/^\d+$/.test(sequence) || Number(sequence) < 1) throw new Error("Invalid preview sequence");
const previewVersion = `0.2.0-preview.${runId}.${sequence}`;
const installerName = `${artifactPrefix}-Setup-${previewVersion}.exe`;
if (existsSync(join(output, installerName))) throw new Error("Preview installer version already exists");
const productName = parallelRc ? "OpenButler Preview Windows RC" : isolatedTrial ? "OpenButler Preview Windows Trial" : "OpenButler Preview";

function run(commandLine, env = {}) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
    cwd: root,
    stdio: "inherit",
    env: {...process.env, ...env},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandLine} exited with ${result.status}`);
}

function runNodeScript(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    env: {...process.env, ...env},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

run("npm run build:frontend", {OPENBUTLER_DESKTOP_CHANNEL: "preview"});
run("powershell.exe -NoProfile -File scripts/build-windows-public-window.ps1");
run("npm run build:backend -- --clean");
runNodeScript(join(root, "scripts", "copy-offline-ocr-assets.cjs"), []);
const stableBackend = join(root, "dist", "openbutler-backend.exe");
if (!existsSync(stableBackend)) throw new Error("Fresh backend build produced no executable");
const backendName = parallelRc ? "openbutler-backend-windows-rc.exe" : isolatedTrial ? "openbutler-backend-windows-trial.exe" : "openbutler-backend-preview.exe";
const previewBackend = join(tmp, backendName);
copyFileSync(stableBackend, previewBackend);

const build = structuredClone(pkg.build);
build.appId = parallelRc ? "moe.giftia.openbutler.preview.windows-rc" : isolatedTrial ? "moe.giftia.openbutler.preview.windows-trial" : "moe.giftia.openbutler.preview";
build.productName = productName;
build.asarUnpack = [...build.asarUnpack, "src/windows-public-window.exe"];
build.directories = {...build.directories, output};
build.artifactName = undefined;
build.win = {...build.win, artifactName: `${artifactPrefix}-Setup-${previewVersion}.\${ext}`};
build.nsis = {...build.nsis, include: parallelRc ? "installer/installer-windows-rc.nsh" : isolatedTrial ? "installer/installer-windows-trial.nsh" : "installer/installer-preview.nsh", shortcutName: productName};
if (isolatedTrial || parallelRc) {
  build.nsis.allowToChangeInstallationDirectory = false;
  build.nsis.allowElevation = false;
}
build.extraMetadata = {version: previewVersion, productName, openbutlerChannel: "preview", openbutlerPreviewVersion: previewVersion};
build.extraResources = build.extraResources.map((resource) => resource.to === "backend/openbutler-backend.exe"
  ? {from: previewBackend, to: `backend/${backendName}`}
  : resource);

const configPath = join(tmp, "electron-builder-preview.json");
writeFileSync(configPath, `${JSON.stringify(build, null, 2)}\n`, "utf8");
runNodeScript(join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"), ["--win", "nsis", "--config", configPath]);
console.log(JSON.stringify({channel: "preview", version: previewVersion, output}, null, 2));
