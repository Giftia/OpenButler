import {spawnSync} from "node:child_process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(desktopRoot, "..");

const result = spawnSync("npm", ["--prefix", "frontend", "run", "build"], {
  cwd: repoRoot,
  env: {...process.env, OPENBUTLER_DESKTOP_BUILD: "1"},
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
