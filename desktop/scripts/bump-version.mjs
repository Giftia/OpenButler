import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");
const bumpPart = process.argv[2] ?? "patch";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function nextVersion(version, part) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported desktop version format: ${version}`);
  }

  const segments = match.slice(1).map(Number);
  const index = {major: 0, minor: 1, patch: 2}[part];
  if (index === undefined) {
    throw new Error(`Unsupported bump part: ${part}`);
  }

  segments[index] += 1;
  for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
    segments[cursor] = 0;
  }
  return segments.join(".");
}

const pkg = readJson(packagePath);
const previousVersion = pkg.version;
const version = nextVersion(previousVersion, bumpPart);
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

console.log(`desktop version bumped ${previousVersion} -> ${version}`);
