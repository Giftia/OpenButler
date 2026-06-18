import {readFileSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const required = [
  "package.json",
  "src/main.cjs",
  "src/preload.cjs",
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
];

const failed = expectations.filter(([, ok]) => !ok);
if (failed.length) {
  throw new Error(`Desktop contract failed: ${failed.map(([name]) => name).join(", ")}`);
}

console.log("desktop contract ok");
