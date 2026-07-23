import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, rmSync, statSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nightlyRoot = join(root, "data", "nightly");
const retentionMs = 48 * 60 * 60 * 1000;

for (const image of ["OpenButler Preview.exe", "openbutler-backend-preview.exe"]) {
  spawnSync("taskkill", ["/IM", image, "/T", "/F"], {windowsHide: true, encoding: "utf8"});
}

const realDataRoot = join(nightlyRoot, "real-data");
if (existsSync(realDataRoot)) {
  for (const name of readdirSync(realDataRoot)) {
    const path = join(realDataRoot, name);
    if (Date.now() - statSync(path).mtimeMs >= retentionMs) rmSync(path, {recursive: true, force: true});
  }
}

console.log(JSON.stringify({preview_processes_stopped: true, real_data_retention_hours: 48}, null, 2));
