import {spawnSync} from "node:child_process";
import {existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {evaluateSpecificationFreshness, issueSpecificationFingerprint, normalizeUnifiedDiff, parseCloudTaskId, parseCloudTaskStatus, redactedCloudStatus} from "./daytime-cloud-lib.mjs";
import {claimedIssueNumbers, evaluateIssueEligibility, resolveCodexCommand, runWithRetry} from "./nightly-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const runtimeRoot = join(repoRoot, "data", "daytime-cloud");
const activePath = join(runtimeRoot, "active-run.json");
const latestStatusPath = join(runtimeRoot, "latest-status.json");
const lockPath = join(runtimeRoot, "controller.lock");
const executionClaimLockPath = join(repoRoot, "data", "automation", "execution-claim.lock");
const repo = "Giftia/OpenButler";

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireOwnedLock(path, {pid = process.pid, token = `${pid}-${randomUUID()}`, isAlive = processIsAlive} = {}) {
  const create = (target, ownerToken) => {
    const candidate = `${path}.candidate-${randomUUID()}`;
    try {
      writeFileSync(candidate, `${JSON.stringify({pid, token: ownerToken})}\n`, {encoding: "utf8", flag: "wx"});
      linkSync(candidate, target);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(candidate, {force: true});
    }
  };
  if (create(path, token)) return {acquired: true, token};

  let owner = null;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  if (owner?.pid && isAlive(Number(owner.pid))) return {acquired: false, token: null};

  // Only one contender may inspect and replace a stale owner. A stale reclaim
  // lock is deliberately fail-closed and requires operator cleanup.
  const reclaimPath = `${path}.reclaim`;
  const reclaimToken = `reclaim-${token}`;
  if (!create(reclaimPath, reclaimToken)) {
    let reclaimOwner = null;
    try { reclaimOwner = JSON.parse(readFileSync(reclaimPath, "utf8")); } catch {}
    if (reclaimOwner?.pid && isAlive(Number(reclaimOwner.pid))) return {acquired: false, token: null};
    const staleReclaimPath = `${reclaimPath}.stale-${randomUUID()}`;
    try {
      renameSync(reclaimPath, staleReclaimPath);
      rmSync(staleReclaimPath, {force: true});
    } catch {
      return {acquired: false, token: null};
    }
    if (!create(reclaimPath, reclaimToken)) return {acquired: false, token: null};
  }
  try {
    try {
      owner = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      owner = null;
    }
    if (owner?.pid && isAlive(Number(owner.pid))) return {acquired: false, token: null};
    const stalePath = `${path}.stale-${randomUUID()}`;
    try {
      renameSync(path, stalePath);
      rmSync(stalePath, {force: true});
    } catch (error) {
      if (error?.code !== "ENOENT") return {acquired: false, token: null};
    }
    return create(path, token) ? {acquired: true, token} : {acquired: false, token: null};
  } finally {
    releaseOwnedLock(reclaimPath, reclaimToken);
  }
}

export function releaseOwnedLock(path, token) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!token || owner.token !== token) return false;
  const releasedPath = `${path}.released-${randomUUID()}`;
  try {
    renameSync(path, releasedPath);
  } catch {
    return false;
  }
  rmSync(releasedPath, {force: true});
  return true;
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: {...process.env, NO_COLOR: "1", PYTHONUTF8: "1", ...(options.env ?? {})},
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: result.error?.code ?? null,
  };
}

function commandWithRetry(executable, args, options = {}) {
  return runWithRetry(
    () => command(executable, args, options),
    {attempts: options.attempts ?? 3, delays: options.delays},
  );
}

function ghCommand(args, options = {}) {
  return commandWithRetry("gh", args, {timeout: 60_000, attempts: 3, ...options});
}

export function requiredTestsForPaths(paths, root) {
  const pythonEnv = {PYTHONPATH: join(root, "backend")};
  const tests = [];
  if (paths.some((path) => path.startsWith("backend/app/modules/butler_core/"))) {
    tests.push({name: "Butler Core", command: "python", args: ["-m", "unittest", "discover", "-s", "backend/app/modules/butler_core/tests"], env: pythonEnv});
  }
  if (paths.some((path) => path.startsWith("backend/app/modules/pc_activity_context/"))) {
    tests.push({name: "PC Activity", command: "python", args: ["-m", "unittest", "discover", "-s", "backend/app/modules/pc_activity_context/tests"], env: pythonEnv});
  }
  if (paths.some((path) => path.startsWith("backend/app/modules/workstation_vision/"))) {
    tests.push({name: "Workstation Vision", command: "python", args: ["-m", "unittest", "discover", "-s", "backend/app/modules/workstation_vision/tests"], env: pythonEnv});
  }
  if (paths.some((path) => path.startsWith("backend/app/modules/context_engine/"))) {
    tests.push({name: "Context Engine", command: "python", args: ["-m", "unittest", "discover", "-s", "backend/app/modules/context_engine/tests"], env: pythonEnv});
  }
  const knownBackendPrefixes = [
    "backend/app/modules/butler_core/",
    "backend/app/modules/pc_activity_context/",
    "backend/app/modules/workstation_vision/",
    "backend/app/modules/context_engine/",
  ];
  if (paths.some((path) => path.startsWith("backend/") && !knownBackendPrefixes.some((prefix) => path.startsWith(prefix)))) {
    for (const [name, testPath] of [
      ["Butler Core", "backend/app/modules/butler_core/tests"],
      ["PC Activity", "backend/app/modules/pc_activity_context/tests"],
      ["Workstation Vision", "backend/app/modules/workstation_vision/tests"],
    ]) {
      if (!tests.some((test) => test.name === name)) tests.push({name, command: "python", args: ["-m", "unittest", "discover", "-s", testPath], env: pythonEnv});
    }
    if (existsSync(join(root, "backend", "app", "modules", "context_engine", "tests")) && !tests.some((test) => test.name === "Context Engine")) {
      tests.push({name: "Context Engine", command: "python", args: ["-m", "unittest", "discover", "-s", "backend/app/modules/context_engine/tests"], env: pythonEnv});
    }
  }
  if (paths.some((path) => path.startsWith("frontend/"))) tests.push({name: "Frontend Build", command: "npm.cmd", args: ["run", "build"], cwd: "frontend", install: true});
  if (paths.some((path) => path.startsWith("desktop/"))) tests.push({name: "Desktop Contract", command: "npm.cmd", args: ["run", "check"], cwd: "desktop", install: true});
  if (paths.some((path) => path.startsWith("tools/nightly/"))) tests.push({name: "Nightly Controller", command: "node", args: ["--test", "tests"], cwd: "tools/nightly"});
  if (!tests.length) tests.push({name: "Loop Governance", command: "npm.cmd", args: ["test"], cwd: "tools/loop", install: true});
  return tests;
}

function diffBody(value) {
  const text = String(value ?? "");
  const start = text.indexOf("diff --git ");
  return start >= 0 ? text.slice(start) : text;
}

export function createProductionServices() {
  const codex = resolveCodexCommand();
  const codexRun = (args, options = {}) => command(codex.command, [...codex.argsPrefix, ...args], options);
  const codexReadWithRetry = (args, options = {}) => commandWithRetry(codex.command, [...codex.argsPrefix, ...args], options);
  const ghJson = (args) => {
    const result = ghCommand(args);
    if (!result.ok) throw new Error("GitHub read failed");
    return JSON.parse(result.stdout || "null");
  };
  const writeState = (state) => {
    mkdirSync(runtimeRoot, {recursive: true});
    const runDir = join(runtimeRoot, "runs", state.run_id);
    mkdirSync(runDir, {recursive: true});
    const next = {...state, updated_at: new Date().toISOString()};
    const temp = `${activePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, activePath);
    writeFileSync(join(runDir, "state.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    writeFileSync(latestStatusPath, `${JSON.stringify(redactedCloudStatus(next), null, 2)}\n`, "utf8");
    return next;
  };
  let lockToken = null;
  let executionClaimLockToken = null;

  return {
    acquireLock: () => {
      mkdirSync(runtimeRoot, {recursive: true});
      const result = acquireOwnedLock(lockPath);
      lockToken = result.token;
      return result.acquired;
    },
    releaseLock: () => {
      if (lockToken) releaseOwnedLock(lockPath, lockToken);
      lockToken = null;
    },
    acquireExecutionClaimLock: () => {
      mkdirSync(dirname(executionClaimLockPath), {recursive: true});
      const result = acquireOwnedLock(executionClaimLockPath);
      executionClaimLockToken = result.token;
      return result.acquired;
    },
    releaseExecutionClaimLock: () => {
      if (executionClaimLockToken) releaseOwnedLock(executionClaimLockPath, executionClaimLockToken);
      executionClaimLockToken = null;
    },
    recordStatus: (status) => {
      mkdirSync(runtimeRoot, {recursive: true});
      const next = redactedCloudStatus({...status, updated_at: new Date().toISOString()});
      writeFileSync(latestStatusPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return next;
    },
    loadState: () => existsSync(activePath) ? JSON.parse(readFileSync(activePath, "utf8")) : null,
    saveState: writeState,
    completeState: (state) => {
      const saved = writeState(state);
      rmSync(activePath, {force: true});
      return saved;
    },
    preflight: () => codexReadWithRetry(["cloud", "list", "--json", "--limit", "1"], {timeout: 30_000}).ok,
    baseSha: () => {
      if (!commandWithRetry("git", ["fetch", "origin", "main"], {timeout: 10 * 60_000}).ok) throw new Error("unable to refresh origin/main");
      const sha = command("git", ["rev-parse", "origin/main"]);
      if (!sha.ok) throw new Error("unable to read origin/main");
      return sha.stdout.trim();
    },
    queue: () => ({
      issues: ghJson(["issue", "list", "--repo", repo, "--state", "open", "--label", "ready-for-agent", "--limit", "100", "--json", "number,title,body,labels,createdAt,updatedAt,state,url"]),
      closedIssues: new Set(ghJson(["issue", "list", "--repo", repo, "--state", "closed", "--limit", "200", "--json", "number"]).map((item) => item.number)),
      pullRequests: ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName,url"]),
    }),
    issue: (number) => ghJson(["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,labels,createdAt,updatedAt,state,url"]),
    closedIssues: () => new Set(ghJson(["issue", "list", "--repo", repo, "--state", "closed", "--limit", "200", "--json", "number"]).map((item) => item.number)),
    executionLeases: () => ghJson(["issue", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,labels"])
      .filter((issue) => (issue.labels ?? []).some((label) => ["cloud-running", "nightly-running"].includes(label.name ?? label))),
    timeline: (number) => ghJson(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate"]),
    claim: (number) => ghCommand(["issue", "edit", String(number), "--repo", repo, "--add-label", "cloud-running"]).ok,
    release: (number) => ghCommand(["issue", "edit", String(number), "--repo", repo, "--remove-label", "cloud-running"]).ok,
    restoreLease: (number) => ghCommand(["issue", "edit", String(number), "--repo", repo, "--add-label", "cloud-running"]).ok,
    quarantine: (number) => ghCommand(["issue", "edit", String(number), "--repo", repo, "--remove-label", "ready-for-agent", "--add-label", "nightly-failed"]).ok,
    transitionToReview: (number) => ghCommand(["issue", "edit", String(number), "--repo", repo, "--remove-label", "ready-for-agent", "--remove-label", "cloud-running", "--add-label", "review-pending"]).ok,
    submit: ({environmentId, prompt}) => {
      const result = codexRun(["cloud", "exec", "--env", environmentId, "--attempts", "1", "--branch", "main", prompt], {timeout: 120_000});
      return {ok: result.ok, taskId: result.ok ? parseCloudTaskId(`${result.stdout}\n${result.stderr}`) : null};
    },
    recoverTask: ({runId, environmentId}) => {
      const result = codexReadWithRetry(["cloud", "list", "--json", "--env", environmentId, "--limit", "20"], {timeout: 30_000});
      if (!result.ok) return null;
      try {
        const parsed = JSON.parse(result.stdout);
        const tasks = Array.isArray(parsed) ? parsed : parsed.tasks ?? parsed.items ?? [];
        const match = tasks.find((task) => JSON.stringify(task).includes(`[OpenButler daytime run ${runId}]`));
        return match?.id ?? match?.task_id ?? null;
      } catch {
        return null;
      }
    },
    taskStatus: (taskId) => {
      const result = codexReadWithRetry(["cloud", "status", taskId], {timeout: 30_000});
      return result.ok ? parseCloudTaskStatus(result.stdout) : "unavailable";
    },
    taskDiff: (taskId) => {
      const result = codexReadWithRetry(["cloud", "diff", taskId, "--attempt", "1"], {timeout: 120_000});
      if (!result.ok) throw new Error("unable to read Cloud diff");
      return diffBody(result.stdout);
    },
    openPullRequests: () => ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName,url"]),
    materialize: ({state, diff, paths}) => {
      const worktree = join(runtimeRoot, "worktrees", state.run_id);
      mkdirSync(dirname(worktree), {recursive: true});
      const add = command("git", ["worktree", "add", "-B", state.branch, worktree, state.base_sha], {timeout: 120_000});
      if (!add.ok) throw new Error("unable to create isolated Cloud result worktree");
      try {
        const applied = codexRun(["cloud", "apply", state.task_id, "--attempt", "1"], {cwd: worktree, timeout: 10 * 60_000});
        if (!applied.ok) throw new Error("unable to apply Cloud result");
        const expectedPaths = new Set(paths);
        const preTestStatus = command("git", ["status", "--porcelain=v1", "--untracked-files=all"], {cwd: worktree});
        const preTestUnexpected = preTestStatus.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).filter((path) => !expectedPaths.has(path));
        if (!preTestStatus.ok || preTestUnexpected.length) throw new Error("Cloud apply created paths outside the verified diff before tests");
        if (!command("git", ["add", "-N", "--", ...paths], {cwd: worktree}).ok) throw new Error("unable to prepare exact Cloud diff verification");
        const exact = command("git", ["diff", "--no-ext-diff", "--binary"], {cwd: worktree});
        if (!exact.ok || normalizeUnifiedDiff(diffBody(exact.stdout)) !== normalizeUnifiedDiff(diff)) {
          throw new Error("applied diff does not exactly match verified Cloud diff");
        }
        const actualPaths = command("git", ["diff", "--name-only"], {cwd: worktree}).stdout.split(/\r?\n/).filter(Boolean).sort();
        if (JSON.stringify(actualPaths) !== JSON.stringify([...paths].sort())) throw new Error("applied paths do not exactly match verified Cloud paths");

        for (const test of requiredTestsForPaths(paths, worktree)) {
          const cwd = test.cwd ? join(worktree, test.cwd) : worktree;
          if (test.install && !command("npm.cmd", ["ci", "--no-audit", "--no-fund"], {cwd, timeout: 20 * 60_000}).ok) {
            throw new Error(`${test.name} dependency installation failed`);
          }
          if (!command(test.command, test.args, {cwd, env: test.env, timeout: 30 * 60_000}).ok) throw new Error(`${test.name} failed`);
        }

        const postTestDiff = command("git", ["diff", "--no-ext-diff", "--binary"], {cwd: worktree});
        if (!postTestDiff.ok || normalizeUnifiedDiff(diffBody(postTestDiff.stdout)) !== normalizeUnifiedDiff(diff)) {
          throw new Error("focused tests changed the verified Cloud diff");
        }
        const allowedPaths = new Set(paths);
        const status = command("git", ["status", "--porcelain=v1", "--untracked-files=all"], {cwd: worktree});
        const unexpected = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).filter((path) => !allowedPaths.has(path));
        if (unexpected.length) throw new Error("focused tests created paths outside the verified Cloud diff");

        const refreshBase = () => {
          if (!commandWithRetry("git", ["fetch", "origin", "main"], {cwd: worktree, timeout: 10 * 60_000}).ok) throw new Error("unable to refresh origin/main before pull request");
          const current = command("git", ["rev-parse", "origin/main"], {cwd: worktree});
          if (!current.ok || current.stdout.trim() !== state.base_sha) throw new Error("origin/main changed during Cloud result verification");
        };
        const verifyIssueContract = () => {
          const currentIssue = ghJson(["issue", "view", String(state.issue), "--repo", repo, "--json", "number,title,body,labels,createdAt,updatedAt,state,url"]);
          const currentPullRequests = ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName,url"]);
          const currentEligibility = evaluateIssueEligibility(currentIssue, {
            closedIssues: new Set(ghJson(["issue", "list", "--repo", repo, "--state", "closed", "--limit", "200", "--json", "number"]).map((item) => item.number)),
            claimedIssues: claimedIssueNumbers(currentPullRequests.filter((pr) => pr.headRefName !== state.branch)),
            ownedLease: "cloud-running",
          });
          if (!currentEligibility.eligible) throw new Error(`Issue became ineligible during Cloud result verification: ${currentEligibility.reasons.join(", ")}`);
          const currentFreshness = evaluateSpecificationFreshness(currentIssue, ghJson(["api", `repos/${repo}/issues/${state.issue}/timeline`, "--paginate"]));
          if (!currentFreshness.fresh) throw new Error(`Issue requires retriage during Cloud result verification: ${currentFreshness.reasons.join(", ")}`);
          if (issueSpecificationFingerprint(currentIssue) !== state.specification_fingerprint) throw new Error("Issue specification changed during Cloud result verification");
          const competing = currentPullRequests.filter((pr) => claimedIssueNumbers([pr]).has(state.issue) && pr.headRefName !== state.branch);
          if (competing.length) throw new Error("an implementation pull request appeared during Cloud result verification");
        };
        refreshBase();
        verifyIssueContract();

        if (!command("git", ["add", "--", ...paths], {cwd: worktree}).ok) throw new Error("unable to stage verified paths");
        if (!command("git", ["commit", "-m", `feat: implement Issue #${state.issue} with Codex Cloud`], {cwd: worktree}).ok) throw new Error("unable to commit verified Cloud diff");
        const pushed = commandWithRetry("git", ["push", "-u", "origin", state.branch], {cwd: worktree, timeout: 10 * 60_000});
        if (!pushed.ok && !commandWithRetry("git", ["push", "--force-with-lease", "-u", "origin", state.branch], {cwd: worktree, timeout: 10 * 60_000}).ok) {
          throw new Error("unable to push or safely update Cloud result branch");
        }
        refreshBase();
        verifyIssueContract();

        const existing = ghJson(["pr", "list", "--repo", repo, "--state", "open", "--head", state.branch, "--json", "number,url"])[0];
        if (existing) return existing;
        const created = ghCommand([
          "pr", "create", "--repo", repo, "--base", "main", "--head", state.branch, "--draft",
          "--title", `Implement #${state.issue}: Codex Cloud result`,
          "--body", `Closes #${state.issue}\n\nCreated by the daytime Cloud dispatcher after exact-diff, privacy, base-SHA, and focused-test verification. This controller never auto-merges.`,
        ], {cwd: worktree});
        if (!created.ok) throw new Error("unable to create draft pull request");
        return ghJson(["pr", "view", created.stdout.trim(), "--repo", repo, "--json", "number,url"]);
      } finally {
        command("git", ["worktree", "remove", "--force", worktree], {timeout: 120_000});
      }
    },
  };
}
