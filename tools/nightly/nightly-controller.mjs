import {execFileSync, spawnSync} from "node:child_process";
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  ISSUE_TOKEN_CAP,
  NIGHTLY_TOKEN_CAP,
  claimedIssueNumbers,
  evaluateCanonicalCheckout,
  evaluateIssueEligibility,
  mayStartIssue,
  parseCurrentLevel,
  resolveCodexCommand,
  sanitizeAcceptanceValue,
  tokenUsageFromJsonl,
} from "./nightly-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=", 2);
  return [key, value];
}));
const mode = args.get("mode") ?? "dry-run";
const now = new Date();
const runId = (args.get("run-id") ?? now.toISOString()).replace(/[:.]/g, "-");
const runDir = join(repoRoot, "data", "nightly", runId);
const lockPath = join(repoRoot, "data", "nightly", "active-run.json");
const cutoffFlag = join(repoRoot, "data", "nightly", "control", "stop-new-issues.flag");
const eventsPath = join(runDir, "events.jsonl");
const codexCommand = resolveCodexCommand();
mkdirSync(runDir, {recursive: true});

function log(type, detail = {}) {
  const event = sanitizeAcceptanceValue({at: new Date().toISOString(), type, ...detail});
  writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, {encoding: "utf8", flag: "a"});
}

function millisecondsUntilLocalDeadline(now = new Date()) {
  const deadline = new Date(now);
  deadline.setHours(8, 10, 0, 0);
  if (now.getHours() >= 12) deadline.setDate(deadline.getDate() + 1);
  return Math.max(1_000, deadline.getTime() - now.getTime());
}

function command(commandName, commandArgs, options = {}) {
  const requestedTimeout = options.timeout ?? 120_000;
  const result = spawnSync(commandName, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: Math.min(requestedTimeout, millisecondsUntilLocalDeadline()),
    env: {...process.env, PYTHONUTF8: "1", ...(options.env ?? {})},
  });
  return {
    ok: result.status === 0,
    status: result.status,
    errorCode: result.error?.code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function ghJson(commandArgs) {
  const result = command("gh", commandArgs, {timeout: 60_000});
  if (!result.ok) throw new Error(result.stderr || `gh ${commandArgs.join(" ")} failed`);
  return JSON.parse(result.stdout || "null");
}

function installNpmDependencies(name, directory) {
  const result = command("npm.cmd", ["ci", "--no-audit", "--no-fund"], {
    cwd: directory,
    timeout: 20 * 60 * 1000,
  });
  if (!result.ok) throw new Error(`${name} dependency installation failed: ${result.stderr || result.stdout}`);
}

function runFocusedTests(worktree) {
  const changed = command("git", ["diff", "--name-only", "origin/main...HEAD"], {cwd: worktree});
  if (!changed.ok) throw new Error("unable to determine changed files for focused tests");
  const files = changed.stdout.split(/\r?\n/).filter(Boolean);
  const checks = [];
  const run = (name, executable, executableArgs, options = {}) => {
    const result = command(executable, executableArgs, {cwd: options.cwd ?? worktree, timeout: options.timeout ?? 20 * 60 * 1000, env: options.env});
    checks.push({name, ok: result.ok});
    if (!result.ok) throw new Error(`${name} failed: ${result.stderr || result.stdout}`);
  };
  const pythonEnv = {PYTHONPATH: join(worktree, "backend")};
  if (files.some((file) => file.startsWith("backend/app/modules/butler_core/"))) {
    run("Butler Core", "python", ["-m", "unittest", "discover", "-s", "backend/app/modules/butler_core/tests"], {env: pythonEnv});
  }
  if (files.some((file) => file.startsWith("backend/app/modules/pc_activity_context/"))) {
    run("PC Activity", "python", ["-m", "unittest", "discover", "-s", "backend/app/modules/pc_activity_context/tests"], {env: pythonEnv});
  }
  if (files.some((file) => file.startsWith("backend/app/modules/workstation_vision/"))) {
    run("Workstation Vision", "python", ["-m", "unittest", "discover", "-s", "backend/app/modules/workstation_vision/tests"], {env: pythonEnv});
  }
  if (files.some((file) => file.startsWith("frontend/"))) {
    installNpmDependencies("Frontend", join(worktree, "frontend"));
    run("Frontend Build", "npm.cmd", ["run", "build"], {cwd: join(worktree, "frontend")});
  }
  if (files.some((file) => file.startsWith("desktop/"))) {
    installNpmDependencies("Desktop", join(worktree, "desktop"));
    run("Desktop Contract", "npm.cmd", ["run", "check"], {cwd: join(worktree, "desktop")});
  }
  if (files.some((file) => file.startsWith("tools/nightly/"))) {
    run("Nightly Controller", "node", ["--test", "tests/nightly-lib.test.mjs"], {cwd: join(worktree, "tools", "nightly")});
  }
  if (!checks.length) {
    installNpmDependencies("Loop Governance", join(worktree, "tools", "loop"));
    run("Loop Governance", "npm.cmd", ["test"], {cwd: join(worktree, "tools", "loop")});
  }
  return checks;
}

function runRealDataSmoke(pack) {
  if (process.env.OPENBUTLER_ENABLE_REAL_DATA_NIGHTLY !== "1") {
    pack.real_data = {status: "disabled", lookback_hours: 48};
    return;
  }
  const isolatedDir = join(repoRoot, "data", "nightly", "real-data", runId);
  const result = command("python", [join(here, "real-data-smoke.py")], {
    timeout: 10 * 60 * 1000,
    env: {
      OPENBUTLER_NIGHTLY_REAL_DATA_DIR: isolatedDir,
      OPENBUTLER_PRIVACY_MODE: "strict",
      OPENBUTLER_DISABLE_SEED_EVENTS: "1",
    },
  });
  if (!result.ok) {
    pack.real_data = {status: "failed", lookback_hours: 48, reason: "bounded local preview failed"};
    pack.blockers.push("48 小时真实数据只读预览失败；后续产品验证只允许标记为合成数据。");
    return;
  }
  const aggregate = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  pack.real_data = aggregate;
  pack.privacy.real_activity_read = aggregate.status === "preview_ready";
  pack.privacy.database_written = Boolean(aggregate.nightly_database_written);
  pack.privacy.screenshots_copied = Boolean(aggregate.screenshots_copied);
  pack.privacy.external_model_called = Boolean(aggregate.external_model_called);
  pack.privacy.external_webhook_called = Boolean(aggregate.external_webhook_called);
  pack.privacy.source_data_modified = Boolean(aggregate.source_modified);
  log("real_data_smoke", aggregate);
}

function fail(reason, exitCode = 3) {
  log("run_stopped", {reason});
  const state = {run_id: runId, mode, outcome: "stopped", reason, database_written: false, screenshots_copied: false, external_model_called: false};
  writeFileSync(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(join(repoRoot, "data", "nightly", "latest-run.txt"), `${runId}\n`, "utf8");
  console.error(reason);
  process.exit(exitCode);
}

if (!new Set(["dry-run", "execute"]).has(mode)) fail(`unsupported mode: ${mode}`);

const fetchedMain = command("git", ["fetch", "origin", "main"], {timeout: 10 * 60 * 1000});
if (!fetchedMain.ok) fail("unable to refresh canonical origin/main");
const branch = command("git", ["branch", "--show-current"]);
const head = command("git", ["rev-parse", "HEAD"]);
const canonicalHead = command("git", ["rev-parse", "origin/main"]);
if (!branch.ok || !head.ok || !canonicalHead.ok) fail("unable to verify canonical checkout");
const canonicalCheckout = evaluateCanonicalCheckout({branch: branch.stdout, head: head.stdout, originMain: canonicalHead.stdout});
if (!canonicalCheckout.eligible) fail(`nightly controller requires canonical main: ${canonicalCheckout.reasons.join(", ")}`);
const canonicalState = command("git", ["show", "origin/main:STATE.md"]);
if (!canonicalState.ok) fail("unable to read canonical STATE.md");
const stateMarkdown = canonicalState.stdout;
const level = parseCurrentLevel(stateMarkdown);
if (/loop-pause-all:\s*true/i.test(stateMarkdown)) fail("loop-pause-all is active", 0);
if (mode === "execute" && level !== "L2") fail(`execute requires canonical L2 active; current level is ${level}`);

const existingLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
if (existingLock && existingLock.pid !== process.pid) {
  try {
    process.kill(existingLock.pid, 0);
    fail(`another nightly run is active: ${existingLock.run_id}`);
  } catch {
    rmSync(lockPath, {force: true});
  }
}
writeFileSync(lockPath, `${JSON.stringify({run_id: runId, pid: process.pid, mode, started_at: now.toISOString()}, null, 2)}\n`, "utf8");

const cleanup = () => rmSync(lockPath, {force: true});
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  const status = command("git", ["status", "--porcelain=v1"]);
  if (!status.ok || status.stdout.trim()) fail("working tree is not clean");
  const issues = ghJson([
    "issue", "list", "--repo", "Giftia/OpenButler", "--state", "open",
    "--label", "ready-for-agent", "--limit", "100",
    "--json", "number,title,body,labels,createdAt,updatedAt,url"
  ]) ?? [];
  const closed = new Set((ghJson([
    "issue", "list", "--repo", "Giftia/OpenButler", "--state", "closed", "--limit", "200", "--json", "number"
  ]) ?? []).map((item) => item.number));
  const claimed = claimedIssueNumbers(ghJson([
    "pr", "list", "--repo", "Giftia/OpenButler", "--state", "open", "--limit", "200",
    "--json", "number,title,body,headRefName,url"
  ]) ?? []);

  const evaluated = issues.map((issue) => ({
    ...issue,
    evaluation: evaluateIssueEligibility(issue, {
      closedIssues: closed,
      claimedIssues: claimed,
    }),
  }));

  const eligible = evaluated.filter((issue) => issue.evaluation.eligible);
  const pack = {
    schema_version: 1,
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode,
    loop_level: level,
    candidate_version: null,
    summary: mode === "dry-run"
      ? `夜间演练完成，发现 ${eligible.length} 个可执行候选；本轮未修改代码或 GitHub。`
      : `夜间执行开始，共有 ${eligible.length} 个候选。`,
    pull_requests: [],
    scenarios: eligible.map((issue) => ({
      id: `issue-${issue.number}`,
      issue_number: issue.number,
      title: issue.title,
      purpose: "确认 Issue 已满足夜间执行门禁。",
      steps: ["查看 Issue 规格与授权标签", "确认依赖和风险边界"],
      expected: "Issue 只有在双标签、依赖和授权均有效时才会被选择。",
      status: "pending",
    })),
    rejected_candidates: evaluated.filter((issue) => !issue.evaluation.eligible).map((issue) => ({
      issue_number: issue.number,
      reasons: issue.evaluation.reasons,
    })),
    privacy: {
      real_activity_read: false,
      database_written: false,
      screenshots_copied: false,
      external_model_called: false,
      external_webhook_called: false,
      source_data_modified: false,
      github_mutated: false,
    },
    execution_surface: "local",
    blockers: mode === "execute" ? [] : ["L1 dry-run：仅验证队列、预算、隐私和调度，不执行 Issue。"],
  };

  if (mode === "execute") {
    runRealDataSmoke(pack);
    let tokensUsed = 0;
    for (const issue of eligible) {
      if (existsSync(cutoffFlag) || !mayStartIssue(tokensUsed, new Date())) {
        pack.blockers.push("达到夜间启动阈值、07:15 截止时间或外部停止标记，未继续领取 Issue。");
        break;
      }
      log("issue_selected", {issue: issue.number, high_risk: issue.evaluation.highRisk});
      const issueResult = await executeIssue(issue, {tokensUsed});
      tokensUsed += issueResult.tokens;
      if (issueResult.pullRequest) pack.pull_requests.push(issueResult.pullRequest);
      pack.scenarios.push(...issueResult.scenarios);
      if (issueResult.stop) break;
    }
    pack.tokens_used = tokensUsed;
    pack.privacy.github_mutated = pack.pull_requests.length > 0;
    if (pack.pull_requests.some((pullRequest) => pullRequest.status === "acceptance_ready")) {
      const preview = buildPreviewCandidate(pack);
      if (preview) {
        pack.candidate_version = preview.version;
        pack.preview_installer = preview.installer_name;
        pack.preview_prs = preview.pull_requests;
        for (const pullRequest of pack.pull_requests) {
          if (preview.pull_requests.includes(pullRequest.number)) pullRequest.nightly_status = "passed";
        }
      }
    }
  }

  const sanitizedPack = sanitizeAcceptanceValue(pack);
  writeFileSync(join(runDir, "acceptance-pack.json"), `${JSON.stringify(sanitizedPack, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "state.json"), `${JSON.stringify({
    run_id: runId,
    mode,
    outcome: "completed",
    eligible_issues: eligible.length,
    pull_requests: pack.pull_requests.length,
    privacy: pack.privacy,
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(repoRoot, "data", "nightly", "latest-run.txt"), `${runId}\n`, "utf8");
  log("run_completed", {eligible_issues: eligible.length, pull_requests: pack.pull_requests.length});
  console.log(JSON.stringify({run_id: runId, mode, level, eligible_issues: eligible.length, run_dir: runDir}, null, 2));
} catch (error) {
  const state = {run_id: runId, mode, outcome: "stopped", reason: error.message, database_written: false, screenshots_copied: false, external_model_called: false};
  writeFileSync(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(join(repoRoot, "data", "nightly", "latest-run.txt"), `${runId}\n`, "utf8");
  throw error;
} finally {
  cleanup();
}

async function executeIssue(issue, {tokensUsed}) {
  const branchName = `codex/nightly-${issue.number}-${runId.slice(0, 10)}`;
  const worktree = join(repoRoot, "data", "nightly", "worktrees", `${issue.number}-${runId}`);
  mkdirSync(dirname(worktree), {recursive: true});
  const add = command("git", ["worktree", "add", "-b", branchName, worktree, "origin/main"], {timeout: 120_000});
  if (!add.ok) throw new Error(`worktree creation failed for #${issue.number}: ${add.stderr}`);

  let totalTokens = 0;
  try {
    const lease = command("gh", [
      "issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler",
      "--add-label", "nightly-running",
    ]);
    if (!lease.ok) throw new Error(lease.stderr || `failed to acquire local lease for #${issue.number}`);
    let verifierFeedback = "";
    let approved = false;
    let codeVerifierVerdict = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const prompt = attempt === 1
        ? `Implement GitHub Issue #${issue.number}: ${issue.title}\n\n${issue.body}\n\nRead AGENTS.md, LOOP.md and loop-constraints.md. Work only in this worktree. Do not push, merge, deploy, read personal data, or change GitHub state. Run focused tests. Return the required JSON result.`
        : `Correct only the verifier findings for Issue #${issue.number}. Preserve the existing scope and tests. Verifier evidence:\n${verifierFeedback}`;
      const eventsFile = join(runDir, `issue-${issue.number}-maker-attempt-${attempt}.jsonl`);
      const maker = command(codexCommand.command, [
        ...codexCommand.argsPrefix, "exec", "-C", worktree, "-s", "workspace-write", "--json",
        "--output-schema", join(here, "schemas", "maker-output.schema.json"),
        "--output-last-message", join(runDir, `issue-${issue.number}-maker-attempt-${attempt}.json`), prompt
      ], {cwd: worktree, timeout: 3 * 60 * 60 * 1000});
      writeFileSync(eventsFile, maker.stdout, "utf8");
      totalTokens += tokenUsageFromJsonl(maker.stdout);
      if (!maker.ok || totalTokens > ISSUE_TOKEN_CAP || tokensUsed + totalTokens > NIGHTLY_TOKEN_CAP) {
        throw new Error(`maker failed (${maker.errorCode ?? maker.status ?? "unknown"}) or exceeded budget for #${issue.number}`);
      }

      const changed = command("git", ["status", "--porcelain=v1"], {cwd: worktree});
      if (!changed.stdout.trim()) throw new Error(`maker produced no changes for #${issue.number} attempt ${attempt}`);
      const forbidden = /(^|\s)(\.env|.*\.(db|sqlite3?)|.*screenshots?|.*MineContext)/i;
      if (changed.stdout.split(/\r?\n/).some((line) => forbidden.test(line))) {
        throw new Error(`sensitive or forbidden file detected for #${issue.number}`);
      }
      command("git", ["add", "--all"], {cwd: worktree});
      const diffCheck = command("git", ["diff", "--cached", "--check"], {cwd: worktree});
      if (!diffCheck.ok) throw new Error(diffCheck.stderr || "git diff --check failed");
      const commitArgs = attempt === 1
        ? ["commit", "-m", `fix: resolve issue #${issue.number}`]
        : ["commit", "--amend", "--no-edit"];
      const committed = command("git", commitArgs, {cwd: worktree});
      if (!committed.ok) throw new Error(committed.stderr || "commit failed");
      const checks = runFocusedTests(worktree);
      log("issue_tests_passed", {issue: issue.number, attempt, checks});

      const verdictPath = join(runDir, `issue-${issue.number}-verifier-attempt-${attempt}.json`);
      const review = command(codexCommand.command, [
        ...codexCommand.argsPrefix, "exec", "review", "--base", "origin/main", "--json",
        "--output-schema", join(here, "schemas", "verifier-output.schema.json"),
        "--output-last-message", verdictPath,
        "Apply .codex/agents/verifier.toml. Check issue scope, real test evidence, privacy, unrelated changes, and return only the structured verdict."
      ], {cwd: worktree, timeout: 2 * 60 * 60 * 1000});
      writeFileSync(join(runDir, `issue-${issue.number}-verifier-attempt-${attempt}.jsonl`), review.stdout, "utf8");
      totalTokens += tokenUsageFromJsonl(review.stdout);
      if (totalTokens > ISSUE_TOKEN_CAP || tokensUsed + totalTokens > NIGHTLY_TOKEN_CAP) {
        command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
        return {tokens: totalTokens, stop: true, pullRequest: null, scenarios: []};
      }
      const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
      if (review.ok && verdict.verdict === "APPROVE") {
        approved = true;
        codeVerifierVerdict = verdict;
        break;
      }
      verifierFeedback = JSON.stringify(verdict);
      if (verdict.verdict === "ESCALATE_HUMAN") {
        command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
        return {tokens: totalTokens, stop: true, pullRequest: null, scenarios: []};
      }
    }
    if (!approved) {
      command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
      return {tokens: totalTokens, stop: false, pullRequest: null, scenarios: []};
    }

    const productVerdictPath = join(runDir, `issue-${issue.number}-product-privacy-verifier.json`);
    const productReview = command(codexCommand.command, [
      ...codexCommand.argsPrefix, "exec", "review", "--base", "origin/main", "--json",
      "--output-schema", join(here, "schemas", "verifier-output.schema.json"),
      "--output-last-message", productVerdictPath,
      "Independently review the change as an ordinary-user product and privacy checker. Verify the Issue acceptance criteria, user-facing clarity, strict privacy invariants, hard-stop policy, rollback path, and absence of internal or personal data. Return only the structured verdict."
    ], {cwd: worktree, timeout: 2 * 60 * 60 * 1000});
    writeFileSync(join(runDir, `issue-${issue.number}-product-privacy-verifier.jsonl`), productReview.stdout, "utf8");
    totalTokens += tokenUsageFromJsonl(productReview.stdout);
    if (!productReview.ok || totalTokens > ISSUE_TOKEN_CAP || tokensUsed + totalTokens > NIGHTLY_TOKEN_CAP) {
      command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
      return {tokens: totalTokens, stop: true, pullRequest: null, scenarios: []};
    }
    const productVerifierVerdict = JSON.parse(readFileSync(productVerdictPath, "utf8"));
    if (productVerifierVerdict.verdict !== "APPROVE") {
      const blockLabel = productVerifierVerdict.verdict === "ESCALATE_HUMAN" ? "automation-blocked" : "nightly-failed";
      command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", blockLabel]);
      return {tokens: totalTokens, stop: productVerifierVerdict.verdict === "ESCALATE_HUMAN", pullRequest: null, scenarios: []};
    }

    const push = command("git", ["push", "-u", "origin", branchName], {cwd: worktree, timeout: 10 * 60 * 1000});
    if (!push.ok) throw new Error(push.stderr || "push failed");
    const createdPullRequest = command("gh", [
      "pr", "create", "--repo", "Giftia/OpenButler", "--draft", "--base", "main", "--head", branchName,
      "--title", `${issue.title} (#${issue.number})`, "--body", `Closes #${issue.number}\n\nNightly run: ${runId}\n\nTwo independent verifiers are required before delegated merge.`
    ], {cwd: worktree});
    if (!createdPullRequest.ok) throw new Error(createdPullRequest.stderr || `pull request creation failed for #${issue.number}`);
    const prUrl = createdPullRequest.stdout.trim();
    const queueTransition = command("gh", [
      "issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler",
      "--remove-label", "ready-for-agent",
      "--add-label", "review-pending",
    ]);
    if (!queueTransition.ok) throw new Error(queueTransition.stderr || `failed to move #${issue.number} to human review`);
    log("issue_claimed_by_pull_request", {issue: issue.number, pull_request_url: prUrl});
    const pr = ghJson(["pr", "view", prUrl, "--repo", "Giftia/OpenButler", "--json", "number,url,headRefOid,title,commits"]);
    const checks = command("gh", ["pr", "checks", String(pr.number), "--repo", "Giftia/OpenButler", "--watch", "--fail-fast"], {cwd: worktree, timeout: 45 * 60 * 1000});
    if (!checks.ok) {
      command("gh", ["pr", "edit", String(pr.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
      command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--add-label", "nightly-failed"]);
      return {tokens: totalTokens, stop: false, pullRequest: {...pr, head_sha: pr.headRefOid, status: "ci_failed"}, scenarios: []};
    }
    command("gh", ["pr", "ready", String(pr.number), "--repo", "Giftia/OpenButler"]);
    command("gh", [
      "pr", "edit", String(pr.number), "--repo", "Giftia/OpenButler",
      "--remove-label", "review-pending",
      "--add-label", "acceptance-ready",
      "--add-label", "auto-merge-eligible",
    ]);
    return {
      tokens: totalTokens,
      stop: false,
      pullRequest: {
        number: pr.number,
        url: pr.url,
        head_sha: pr.headRefOid,
        commit_shas: (pr.commits ?? []).map((commit) => commit.oid),
        title: pr.title,
        status: "acceptance_ready",
        risk: issue.evaluation?.highRisk ? "high" : "normal",
        code_verifier: codeVerifierVerdict?.verdict ?? "UNKNOWN",
        product_privacy_verifier: productVerifierVerdict.verdict,
        nightly_status: "pending",
        execution_surface: "local",
      },
      scenarios: [{id: `pr-${pr.number}`, pr_number: pr.number, title: issue.title, purpose: "验证本次修复", steps: ["打开对应产品入口", "执行 Issue 验收步骤"], expected: "行为符合 Issue done_when，且无隐私回归。", status: "pending"}],
    };
  } finally {
    command("gh", ["issue", "edit", String(issue.number), "--repo", "Giftia/OpenButler", "--remove-label", "nightly-running"]);
    command("git", ["worktree", "remove", "--force", worktree], {timeout: 120_000});
  }
}

function buildPreviewCandidate(pack) {
  const accepted = pack.pull_requests.filter((pullRequest) => pullRequest.status === "acceptance_ready");
  if (!accepted.length) return null;

  const integrationRoot = join(repoRoot, "data", "nightly", "integration");
  const integrationWorktree = join(integrationRoot, runId);
  mkdirSync(integrationRoot, {recursive: true});
  const fetch = command("git", ["fetch", "origin", "main"], {timeout: 10 * 60 * 1000});
  if (!fetch.ok) {
    pack.blockers.push("Preview 未生成：无法刷新远端 main。已保留上一份可用 Preview。");
    log("preview_failed", {reason: "origin main fetch failed"});
    return null;
  }
  const add = command("git", ["worktree", "add", "--detach", integrationWorktree, "origin/main"], {timeout: 120_000});
  if (!add.ok) {
    pack.blockers.push("Preview 未生成：无法创建临时集成工作区。已保留上一份可用 Preview。");
    log("preview_failed", {reason: "integration worktree creation failed"});
    return null;
  }

  const included = [];
  const installedDir = join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenButler Preview");
  const installedExecutable = join(installedDir, "OpenButler Preview.exe");
  const previewBackupDir = join(runDir, "preview-install-backup");
  let previewBackupCreated = false;
  let previewInstallMutated = false;
  try {
    for (const pullRequest of accepted) {
      const commits = pullRequest.commit_shas?.length ? pullRequest.commit_shas : [pullRequest.head_sha];
      let applied = true;
      for (const sha of commits) {
        const cherryPick = command("git", ["cherry-pick", sha], {cwd: integrationWorktree, timeout: 10 * 60 * 1000});
        if (!cherryPick.ok) {
          command("git", ["cherry-pick", "--abort"], {cwd: integrationWorktree});
          pack.blockers.push(`Preview 安全截断：PR #${pullRequest.number} 与之前的候选发生冲突，未自动解决。`);
          log("preview_truncated", {pr: pullRequest.number, included});
          applied = false;
          break;
        }
      }
      if (!applied) break;
      included.push(pullRequest.number);
    }
    if (!included.length) return null;

    const frontendInstall = command("npm.cmd", ["ci"], {cwd: join(integrationWorktree, "frontend"), timeout: 20 * 60 * 1000});
    const desktopInstall = command("npm.cmd", ["ci"], {cwd: join(integrationWorktree, "desktop"), timeout: 20 * 60 * 1000});
    if (!frontendInstall.ok || !desktopInstall.ok) throw new Error("Preview dependency installation failed");

    const datePart = runId.slice(0, 10).replaceAll("-", "");
    const build = command("npm.cmd", ["run", "dist:preview"], {
      cwd: join(integrationWorktree, "desktop"),
      timeout: 3 * 60 * 60 * 1000,
      env: {OPENBUTLER_PREVIEW_RUN_ID: datePart, OPENBUTLER_PREVIEW_SEQUENCE: "1"},
    });
    if (!build.ok) throw new Error("Preview package build failed");

    const output = join(integrationWorktree, "desktop", "dist-preview");
    const installer = readdirSync(output)
      .filter((name) => /^OpenButler-Preview-Setup-.*\.exe$/i.test(name))
      .map((name) => join(output, name))[0];
    if (!installer || !existsSync(installer)) throw new Error("Preview installer was not produced");
    const installerName = installer.split(/[\\/]/).at(-1);
    const version = installerName.match(/^OpenButler-Preview-Setup-(.+)\.exe$/i)?.[1];
    if (!version) throw new Error("Preview installer version could not be determined");
    const preservedInstaller = join(runDir, installerName);
    copyFileSync(installer, preservedInstaller);
    if (existsSync(installedDir)) {
      cpSync(installedDir, previewBackupDir, {recursive: true});
      previewBackupCreated = true;
    }
    command("taskkill", ["/IM", "OpenButler Preview.exe", "/T", "/F"]);
    command("taskkill", ["/IM", "openbutler-backend-preview.exe", "/T", "/F"]);
    previewInstallMutated = true;
    const install = command(preservedInstaller, ["/S"], {timeout: 20 * 60 * 1000});
    if (!install.ok || !existsSync(installedExecutable)) throw new Error(`Preview silent installation failed with status ${install.status}`);
    const installedSmoke = command("node", [join(integrationWorktree, "desktop", "scripts", "smoke-packaged-app.mjs"), "--channel=preview"], {
      cwd: integrationWorktree,
      timeout: 5 * 60 * 1000,
      env: {OPENBUTLER_DESKTOP_EXE_PATH: installedExecutable, OPENBUTLER_EXPECTED_PREVIEW_VERSION: version},
    });
    if (!installedSmoke.ok) throw new Error("Installed Preview failed packaged smoke");
    const lifecycle = command("npm.cmd", ["run", "smoke:preview-installer-lifecycle"], {
      cwd: join(integrationWorktree, "desktop"),
      timeout: 20 * 60 * 1000,
      env: {OPENBUTLER_INSTALLER_PATH: preservedInstaller, OPENBUTLER_EXPECTED_PREVIEW_VERSION: version},
    });
    if (!lifecycle.ok) throw new Error("Preview installer lifecycle smoke failed");

    rmSync(previewBackupDir, {recursive: true, force: true});
    log("preview_installed", {version, pull_requests: included, installer_status: install.status});
    return {version, installer_name: installerName, pull_requests: included};
  } catch (error) {
    if (previewInstallMutated) {
      command("taskkill", ["/IM", "OpenButler Preview.exe", "/T", "/F"]);
      command("taskkill", ["/IM", "openbutler-backend-preview.exe", "/T", "/F"]);
      rmSync(installedDir, {recursive: true, force: true});
      if (previewBackupCreated && existsSync(previewBackupDir)) {
        mkdirSync(installedDir, {recursive: true});
        cpSync(previewBackupDir, installedDir, {recursive: true});
      }
    }
    pack.blockers.push(`Preview 未生成：${error.message}。已保留上一份可用 Preview。`);
    log("preview_failed", {reason: error.message, included});
    return null;
  } finally {
    command("git", ["worktree", "remove", "--force", integrationWorktree], {timeout: 120_000});
    rmSync(integrationWorktree, {recursive: true, force: true});
  }
}
