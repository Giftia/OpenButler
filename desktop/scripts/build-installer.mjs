import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported desktop version format: ${version}`);
  }
  const [, major, minor, patch] = match.map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function run(commandLine) {
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd: root,
      stdio: "inherit",
    })
    : spawnSync("sh", ["-lc", commandLine], {
    cwd: root,
    stdio: "inherit",
    });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${commandLine} exited with ${result.status}`);
  }
}

const previousPackageRaw = readFileSync(packagePath, "utf8");
const previousLockRaw = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
const pkg = JSON.parse(previousPackageRaw);
const version = nextPatch(pkg.version);

try {
  pkg.version = version;
  writeJson(packagePath, pkg);

  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = version;
    if (lock.packages?.[""]) {
      lock.packages[""].version = version;
    }
    writeJson(lockPath, lock);
  }

  console.log(`desktop installer version ${JSON.parse(previousPackageRaw).version} -> ${version}`);
  run("npm run build:frontend");

  const builder = process.platform === "win32"
    ? ".\\node_modules\\.bin\\electron-builder.cmd"
    : "./node_modules/.bin/electron-builder";
  run(`${builder} --win nsis`);
} catch (error) {
  writeFileSync(packagePath, previousPackageRaw, "utf8");
  if (previousLockRaw !== null) {
    writeFileSync(lockPath, previousLockRaw, "utf8");
  }
  console.error(`desktop installer build failed; restored version. ${error.message}`);
  process.exit(1);
}
