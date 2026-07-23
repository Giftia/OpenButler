import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runId = process.env.OPENBUTLER_PREVIEW_RUN_ID || new Date().toISOString().slice(0, 10).replaceAll("-", "");
const sequence = process.env.OPENBUTLER_PREVIEW_SEQUENCE || "1";
const version = pkg.version;
const previewVersion = `${pkg.version}-preview.${runId}.${sequence}`;
const tmp = join(root, ".tmp", "preview-build");
const output = join(root, "dist-preview");
mkdirSync(tmp, {recursive: true});

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
const stableBackend = join(root, "dist", "openbutler-backend.exe");
if (!existsSync(stableBackend)) run("npm run build:backend");
const previewBackend = join(tmp, "openbutler-backend-preview.exe");
copyFileSync(stableBackend, previewBackend);

const build = structuredClone(pkg.build);
build.appId = "moe.giftia.openbutler.preview";
build.productName = "OpenButler Preview";
build.directories = {...build.directories, output};
build.artifactName = undefined;
build.win = {...build.win, artifactName: `OpenButler-Preview-Setup-${previewVersion}.\${ext}`};
build.nsis = {...build.nsis, include: "installer/installer-preview.nsh", shortcutName: "OpenButler Preview"};
build.extraMetadata = {version, productName: "OpenButler Preview", openbutlerChannel: "preview", openbutlerPreviewVersion: previewVersion};
build.extraResources = build.extraResources.map((resource) => resource.to === "backend/openbutler-backend.exe"
  ? {from: previewBackend, to: "backend/openbutler-backend-preview.exe"}
  : resource);

const configPath = join(tmp, "electron-builder-preview.json");
writeFileSync(configPath, `${JSON.stringify(build, null, 2)}\n`, "utf8");
runNodeScript(join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"), ["--win", "nsis", "--config", configPath]);
console.log(JSON.stringify({channel: "preview", version: previewVersion, output}, null, 2));
