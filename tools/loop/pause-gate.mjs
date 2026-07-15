import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");

export function isLoopPaused(root = DEFAULT_ROOT) {
  const state = readFileSync(path.join(root, "STATE.md"), "utf8");
  return /^loop-pause-all:\s*true\s*$/im.test(state);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const paused = isLoopPaused();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `paused=${paused}\n`, "utf8");
  }
  console.log(paused ? "OpenButler loop is paused; audit will not run." : "OpenButler loop pause gate is open.");
}
