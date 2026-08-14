import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {canAutoMergePullRequest, isFreshAcceptancePack, parseDependencies, readJson, sanitizeAcceptanceValue} from "./nightly-lib.mjs";
import {approvalTimelineIsCurrent, issueContentFingerprint} from "./daytime-cloud-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const nightlyRoot = join(root, "data", "nightly");
const requiredChecks = new Set([
  "Butler Core",
  "PC Activity",
  "Workstation Vision",
  "Context Engine",
  "Frontend Build",
  "Desktop Contract",
  "Loop Governance",
  "Nightly Controller",
  "Merge Authorization",
]);

function gh(args, {allowFailure = false, timeout = 120_000} = {}) {
  const result = spawnSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || `gh ${args.join(" ")} failed`);
  return result;
}

function ghJson(args) {
  const result = gh(args);
  return JSON.parse(result.stdout || "null");
}

function issueApprovalStillCurrent(acceptance) {
  if (!acceptance.issue_number || !acceptance.issue_content_fingerprint || !acceptance.issue_approved_at) return false;
  const issue = ghJson(["issue", "view", String(acceptance.issue_number), "--repo", "Giftia/OpenButler", "--json", "number,title,body,state"]);
  if (issue.state !== "OPEN" || issueContentFingerprint(issue) !== acceptance.issue_content_fingerprint) return false;
  const dependencies = parseDependencies(issue.body);
  if (dependencies.length) {
    const closed = new Set((ghJson(["issue", "list", "--repo", "Giftia/OpenButler", "--state", "closed", "--limit", "200", "--json", "number"]) ?? []).map((item) => item.number));
    if (dependencies.some((number) => !closed.has(number))) return false;
  }
  const timeline = ghJson(["api", `repos/Giftia/OpenButler/issues/${acceptance.issue_number}/timeline`, "--paginate"]);
  return approvalTimelineIsCurrent(timeline, acceptance.issue_approved_at);
}

function createRevertPullRequest(mergeSha, prNumber) {
  const branch = `codex/auto-revert-${prNumber}-${mergeSha.slice(0, 8)}`;
  const worktree = join(nightlyRoot, "revert-worktrees", branch.replaceAll("/", "-"));
  try {
    mkdirSync(dirname(worktree), {recursive: true});
    execFileSync("git", ["fetch", "origin", "main"], {cwd: root, encoding: "utf8", windowsHide: true});
    execFileSync("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], {cwd: root, encoding: "utf8", windowsHide: true});
    execFileSync("git", ["revert", "--no-edit", mergeSha], {cwd: worktree, encoding: "utf8", windowsHide: true});
    execFileSync("git", ["push", "-u", "origin", branch], {cwd: worktree, encoding: "utf8", windowsHide: true});
    gh([
      "pr", "create", "--repo", "Giftia/OpenButler", "--base", "main", "--head", branch,
      "--title", `revert: automated rollback for PR #${prNumber}`,
      "--body", `Automated rollback proposal for merged PR #${prNumber} after required main checks failed.\n\nThis pull request is not auto-merged.`,
    ]);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {cwd: root, encoding: "utf8", windowsHide: true});
  }
}

function waitForMainChecks(mergeSha, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = ghJson([
      "run", "list", "--repo", "Giftia/OpenButler", "--commit", mergeSha, "--limit", "20",
      "--json", "databaseId,workflowName,status,conclusion,headSha",
    ]) ?? [];
    const ci = runs.find((run) => run.workflowName === "OpenButler CI" && run.headSha === mergeSha);
    if (ci?.status === "completed") return ci.conclusion === "success";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  return false;
}

const latestPath = join(nightlyRoot, "latest-run.txt");
if (!existsSync(latestPath)) process.exit(0);
const runId = readFileSync(latestPath, "utf8").trim();
const runDir = join(nightlyRoot, runId);
const packPath = join(runDir, "acceptance-pack.json");
const state = readJson(join(runDir, "state.json"), null);
const pack = readJson(packPath, null);
if (!isFreshAcceptancePack(pack, state)) {
  console.log(JSON.stringify({
    status: "no_fresh_acceptance_pack",
    run_id: runId,
    auto_merge_attempted: false,
  }, null, 2));
  process.exit(0);
}

pack.auto_merge = pack.auto_merge ?? {attempted: 0, merged: [], blocked: []};
for (const acceptance of pack.pull_requests ?? []) {
  if (acceptance.status !== "acceptance_ready") continue;
  pack.auto_merge.attempted += 1;
  const pullRequest = ghJson([
    "pr", "view", String(acceptance.number), "--repo", "Giftia/OpenButler",
    "--json", "number,state,isDraft,headRefOid,reviewDecision,statusCheckRollup,labels",
  ]);
  const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));
  if (!labels.has("acceptance-ready") || !labels.has("auto-merge-eligible")) {
    pack.auto_merge.blocked.push({pr: acceptance.number, reasons: ["required merge labels missing"]});
    continue;
  }
  if (!issueApprovalStillCurrent(acceptance)) {
    pack.auto_merge.blocked.push({pr: acceptance.number, reasons: ["Issue approval is stale or cannot be verified"]});
    continue;
  }
  const gate = canAutoMergePullRequest({
    pullRequest,
    acceptance,
    requiredChecks,
    requireNightly: acceptance.risk === "high",
  });
  if (!gate.eligible) {
    pack.auto_merge.blocked.push({pr: acceptance.number, reasons: gate.reasons});
    continue;
  }
  // Re-read the user approval immediately before the SHA-bound merge. GitHub
  // does not offer a transaction spanning Issue state and PR merge, so any
  // observed approval drift fails closed at the last possible boundary.
  if (!issueApprovalStillCurrent(acceptance)) {
    pack.auto_merge.blocked.push({pr: acceptance.number, reasons: ["Issue approval changed during final merge preflight"]});
    continue;
  }
  const finalPullRequest = ghJson([
    "pr", "view", String(acceptance.number), "--repo", "Giftia/OpenButler",
    "--json", "number,state,isDraft,headRefOid,reviewDecision,statusCheckRollup,labels",
  ]);
  const finalGate = canAutoMergePullRequest({
    pullRequest: finalPullRequest,
    acceptance,
    requiredChecks,
    requireNightly: acceptance.risk === "high",
  });
  if (!finalGate.eligible) {
    pack.auto_merge.blocked.push({pr: acceptance.number, reasons: ["PR state changed during final merge preflight", ...finalGate.reasons]});
    continue;
  }
  gh([
    "pr", "merge", String(acceptance.number), "--repo", "Giftia/OpenButler", "--squash",
    "--delete-branch", "--match-head-commit", acceptance.head_sha,
  ], {timeout: 10 * 60 * 1000});
  const merged = ghJson([
    "pr", "view", String(acceptance.number), "--repo", "Giftia/OpenButler",
    "--json", "state,mergeCommit",
  ]);
  const mergeSha = merged.mergeCommit?.oid;
  if (merged.state !== "MERGED" || !mergeSha) throw new Error(`PR #${acceptance.number} merge result is unreadable`);
  const mainPassed = waitForMainChecks(mergeSha);
  pack.auto_merge.merged.push({pr: acceptance.number, head_sha: acceptance.head_sha, merge_sha: mergeSha, main_ci: mainPassed ? "passed" : "failed"});
  acceptance.status = mainPassed ? "merged" : "merged_main_failed";
  acceptance.merge_sha = mergeSha;
  if (!mainPassed) {
    createRevertPullRequest(mergeSha, acceptance.number);
    pack.blockers = [...(pack.blockers ?? []), `PR #${acceptance.number} 合并后主线检查失败，已创建回滚 PR。`];
    break;
  }
}

writeFileSync(packPath, `${JSON.stringify(sanitizeAcceptanceValue(pack), null, 2)}\n`, "utf8");
console.log(JSON.stringify(pack.auto_merge, null, 2));
