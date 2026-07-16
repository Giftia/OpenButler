import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.OPENBUTLER_RELEASE_VERSION;
if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("OPENBUTLER_RELEASE_VERSION must be a stable semantic version.");
const tmp = join(root, ".tmp", "stable-release-build");
const output = join(root, "dist-release");
mkdirSync(tmp, {recursive: true});

function run(commandLine) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {cwd: root, stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandLine} exited with ${result.status}`);
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {cwd: root, stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

run("npm run build:frontend");
if (!existsSync(join(root, "dist", "openbutler-backend.exe"))) run("npm run build:backend");

const build = structuredClone(pkg.build);
build.directories = {...build.directories, output};
build.extraMetadata = {version, productName: "OpenButler", openbutlerChannel: "stable"};
build.win = {...build.win, artifactName: "OpenButler-Setup-${version}.${ext}"};
const configPath = join(tmp, "electron-builder-release.json");
writeFileSync(configPath, `${JSON.stringify(build, null, 2)}\n`, "utf8");
runNodeScript(join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"), ["--win", "nsis", "--config", configPath]);
console.log(JSON.stringify({channel: "stable", version, output}, null, 2));
