import {spawnSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const worktree = join(root, "data", "nightly", "release", runId);
const installedDir = join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenButler");
const installedExecutable = join(installedDir, "OpenButler.exe");
const backupDir = join(root, "data", "nightly", "release-backups", runId, "OpenButler");
const requiredChecks = new Set(["Butler Core", "PC Activity", "Workstation Vision", "Frontend Build", "Desktop Contract", "Loop Governance"]);

function rawCommand(name, args, options = {}) {
  const result = spawnSync(name, args, {cwd: options.cwd ?? root, encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 30 * 60 * 1000, env: {...process.env, ...(options.env ?? {})}, stdio: options.inherit ? "inherit" : "pipe"});
  if (result.error) throw result.error;
  return result;
}

function command(name, args, options = {}) {
  const result = rawCommand(name, args, options);
  if (result.status !== 0) throw new Error(result.stderr || `${name} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout ?? "";
}

function waitForMainChecks(expectedSha) {
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const output = command("gh", ["api", `repos/Giftia/OpenButler/commits/${expectedSha}/check-runs`]).trim();
    const checks = output ? JSON.parse(output).check_runs ?? [] : [];
    const byName = new Map(checks.map((check) => [check.name, check]));
    const required = [...requiredChecks].map((name) => byName.get(name)).filter(Boolean);
    if (required.some((check) => check.status === "completed" && check.conclusion !== "success")) {
      throw new Error(`main CI failed for ${expectedSha}`);
    }
    if (required.length === requiredChecks.size && required.every((check) => check.status === "completed" && check.conclusion === "success")) return required;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
  }
  throw new Error(`main CI did not complete for ${expectedSha} within 45 minutes`);
}

command("git", ["fetch", "origin", "main"]);
const sha = command("git", ["rev-parse", "origin/main"]).trim();
const approvedMainSha = String(process.env.OPENBUTLER_APPROVED_MAIN_SHA || "").trim();
if (!approvedMainSha) throw new Error("OPENBUTLER_APPROVED_MAIN_SHA is required.");
if (sha !== approvedMainSha) throw new Error(`origin/main changed after approval: expected ${approvedMainSha}, got ${sha}`);
waitForMainChecks(sha);
command("git", ["fetch", "origin", "main"]);
const verifiedMainSha = command("git", ["rev-parse", "origin/main"]).trim();
if (verifiedMainSha !== approvedMainSha) throw new Error(`origin/main advanced while waiting for CI: expected ${approvedMainSha}, got ${verifiedMainSha}`);
mkdirSync(dirname(worktree), {recursive: true});
command("git", ["worktree", "add", "--detach", worktree, sha]);

let stableBackupCreated = false;
let stableInstallMutated = false;
function stopStableRuntime() {
  rawCommand("taskkill", ["/IM", "OpenButler.exe", "/T", "/F"]);
  rawCommand("taskkill", ["/IM", "openbutler-backend.exe", "/T", "/F"]);
}

function restoreStableInstall() {
  if (!stableInstallMutated) return;
  stopStableRuntime();
  rmSync(installedDir, {recursive: true, force: true});
  if (stableBackupCreated && existsSync(backupDir)) {
    mkdirSync(installedDir, {recursive: true});
    cpSync(backupDir, installedDir, {recursive: true});
  }
}

try {
  const latestTag = command("gh", ["release", "list", "--repo", "Giftia/OpenButler", "--limit", "50", "--json", "tagName"]).trim();
  const releases = latestTag ? JSON.parse(latestTag) : [];
  const versions = releases.map((item) => /^desktop-v(\d+)\.(\d+)\.(\d+)$/.exec(item.tagName)).filter(Boolean);
  const packageVersion = JSON.parse(readFileSync(join(worktree, "desktop", "package.json"), "utf8")).version;
  const packageMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageVersion);
  if (!packageMatch) throw new Error(`Unsupported desktop version ${packageVersion}`);
  const baseline = versions.length
    ? versions.sort((a, b) => Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]) || Number(b[3]) - Number(a[3]))[0]
    : packageMatch;
  const version = `${baseline[1]}.${baseline[2]}.${Number(baseline[3]) + 1}`;

  command("npm.cmd", ["ci"], {cwd: join(worktree, "frontend"), timeout: 20 * 60 * 1000, inherit: true});
  command("npm.cmd", ["ci"], {cwd: join(worktree, "desktop"), timeout: 20 * 60 * 1000, inherit: true});
  command("python", ["-m", "unittest", "discover", "-s", "backend/app/modules/butler_core/tests"], {cwd: worktree, env: {PYTHONPATH: join(worktree, "backend")}, inherit: true});
  command("python", ["-m", "unittest", "discover", "-s", "backend/app/modules/pc_activity_context/tests"], {cwd: worktree, env: {PYTHONPATH: join(worktree, "backend")}, inherit: true});
  command("python", ["-m", "unittest", "discover", "-s", "backend/app/modules/workstation_vision/tests"], {cwd: worktree, env: {PYTHONPATH: join(worktree, "backend")}, inherit: true});
  command("npm.cmd", ["run", "check"], {cwd: join(worktree, "desktop"), inherit: true});
  command("npm.cmd", ["run", "dist:release"], {cwd: join(worktree, "desktop"), env: {OPENBUTLER_RELEASE_VERSION: version}, timeout: 3 * 60 * 60 * 1000, inherit: true});

  const output = join(worktree, "desktop", "dist-release");
  const installer = readdirSync(output).map((name) => join(output, name)).find((path) => /OpenButler-Setup-.*\.exe$/i.test(path));
  if (!installer || !existsSync(installer)) throw new Error("Stable installer was not produced.");
  const unpackedExecutable = join(output, "win-unpacked", "OpenButler.exe");
  command("node", [join(worktree, "desktop", "scripts", "smoke-packaged-app.mjs")], {
    cwd: worktree,
    timeout: 5 * 60 * 1000,
    env: {OPENBUTLER_DESKTOP_EXE_PATH: unpackedExecutable},
    inherit: true,
  });

  stopStableRuntime();
  if (existsSync(installedDir)) {
    mkdirSync(dirname(backupDir), {recursive: true});
    cpSync(installedDir, backupDir, {recursive: true});
    stableBackupCreated = true;
  }
  stableInstallMutated = true;
  command("npm.cmd", ["run", "smoke:installer-lifecycle"], {
    cwd: join(worktree, "desktop"),
    timeout: 20 * 60 * 1000,
    env: {OPENBUTLER_INSTALLER_PATH: installer},
    inherit: true,
  });
  if (!existsSync(installedExecutable)) throw new Error("Stable installer lifecycle did not leave an installed application.");
  command("node", [join(worktree, "desktop", "scripts", "smoke-packaged-app.mjs")], {
    cwd: worktree,
    timeout: 5 * 60 * 1000,
    env: {OPENBUTLER_DESKTOP_EXE_PATH: installedExecutable},
    inherit: true,
  });

  const tag = `desktop-v${version}`;
  command("gh", ["release", "create", tag, installer, "--repo", "Giftia/OpenButler", "--target", sha, "--title", `OpenButler ${version}`, "--notes", `Human-approved nightly delivery based on ${sha}.`], {timeout: 20 * 60 * 1000});
  rmSync(dirname(backupDir), {recursive: true, force: true});
  console.log(JSON.stringify({version, tag, sha, installed: true}, null, 2));
} catch (error) {
  restoreStableInstall();
  throw error;
} finally {
  try {
    command("git", ["worktree", "remove", "--force", worktree]);
  } catch {
    // The release result is already known; cleanup failure is reported by the remaining directory.
  }
  rmSync(worktree, {recursive: true, force: true});
}
