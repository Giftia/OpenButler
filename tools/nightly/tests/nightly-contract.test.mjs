import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("automatic merge is bound to dual verification and accepted head SHA", () => {
  const source = read("tools/nightly/auto-merge-controller.mjs");
  assert.match(source, /--match-head-commit/);
  assert.match(source, /acceptance\.head_sha/);
  assert.match(source, /canAutoMergePullRequest/);
  assert.match(source, /createRevertPullRequest/);
  assert.match(source, /issueApprovalStillCurrent/);
  assert.match(source, /issue_content_fingerprint/);
  for (const check of ["Butler Core", "PC Activity", "Workstation Vision", "Context Engine", "Frontend Build", "Desktop Contract", "Loop Governance", "Nightly Controller", "Merge Authorization"]) {
    assert.match(source, new RegExp(check));
  }
});

test("stable release waits for the complete required check set and has rollback", () => {
  const source = read("tools/nightly/post-approval-release.mjs");
  for (const check of ["Butler Core", "PC Activity", "Workstation Vision", "Context Engine", "Frontend Build", "Desktop Contract", "Loop Governance", "Nightly Controller"]) {
    assert.match(source, new RegExp(check));
  }
  assert.match(source, /restoreStableInstall/);
  assert.match(source, /if \(!stableInstallMutated\) return/);
  assert.match(source, /OPENBUTLER_APPROVED_MAIN_SHA/);
  assert.match(source, /smoke:installer-lifecycle/);
});

test("morning report publishes a redacted blocker report for incomplete runs", () => {
  const source = read("tools/nightly/morning-report.mjs");
  assert.match(source, /isFreshAcceptancePack/);
  assert.match(source, /publishFailureReport/);
  assert.match(source, /MORNING_REPORT\.md/);
  assert.match(source, /process\.exit\(0\)/);
  assert.match(source, /rmSync\(publishedPackPath/);
  assert.match(source, /Nightly 隔离库已写入/);
  assert.match(source, /来源数据已修改/);
  assert.match(source, /稳定版发布仍需单独批准/);
  assert.doesNotMatch(source, /当前批准命令/);
  const runner = read("tools/nightly/run-morning.ps1");
  assert.match(runner, /if \(\$reportExitCode -ne 0\)/);
});

test("finalize treats a missing acceptance pack as a safe no-op", () => {
  const source = read("tools/nightly/auto-merge-controller.mjs");
  assert.match(source, /status: "no_fresh_acceptance_pack"/);
  assert.match(source, /auto_merge_attempted: false/);
  assert.match(source, /process\.exit\(0\)/);
});

test("Preview delivery verifies install result, exact version, and lifecycle", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /!install\.ok/);
  assert.match(controller, /OPENBUTLER_EXPECTED_PREVIEW_VERSION/);
  assert.match(controller, /smoke:preview-installer-lifecycle/);
  assert.match(controller, /preview-install-backup/);
});

test("Windows scheduler supports four bounded delivery phases", () => {
  const source = read("tools/nightly/install-scheduled-tasks.ps1");
  assert.match(source, /AllowStartIfOnBatteries/);
  assert.match(source, /DontStopIfGoingOnBatteries/);
  assert.match(source, /\[string\]\$Mode = "dry-run"/);
  assert.match(source, /Get-ScheduledTaskInfo/);
  assert.match(source, /scheduled task verification failed/);
  assert.match(source, /SupervisedSha requires dry-run mode/);
  for (const time of ["20:00", "07:15", "08:20", "08:30"]) assert.match(source, new RegExp(time));
});

test("merge authorization is a server-side required check refreshed by Issue changes", () => {
  const ci = read(".github/workflows/ci.yml");
  const refresh = read(".github/workflows/merge-authorization.yml");
  const authorization = read("tools/nightly/merge-authorization.mjs");
  assert.match(ci, /name: Merge Authorization/);
  assert.match(refresh, /types: \[labeled, unlabeled, edited, closed, reopened\]/);
  assert.match(refresh, /statuses: write/);
  assert.match(authorization, /context=Merge Authorization/);
  assert.match(authorization, /changed after approval/);
});

test("supervised scheduler smoke is dry-run only and bound to exact HEAD", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  const runner = read("tools/nightly/run-nightly.ps1");
  assert.match(controller, /mode === "dry-run"/);
  assert.match(controller, /\^\[0-9a-f\]\{40\}\$/i);
  assert.match(controller, /head\.stdout\.trim\(\)\.toLowerCase\(\) === supervisedSha\.toLowerCase\(\)/);
  assert.match(controller, /supervised SHA is allowed only for a dry-run at the exact current HEAD/);
  assert.match(runner, /--supervised-sha=\$SupervisedSha/);
});

test("daytime Cloud scheduling is bounded and never auto-merges", () => {
  const scheduler = read("tools/nightly/install-scheduled-tasks.ps1");
  const controller = read("tools/nightly/daytime-cloud-controller.mjs");
  const services = read("tools/nightly/daytime-cloud-services.mjs");
  const morning = read("tools/nightly/morning-report.mjs");
  const smoke = read("tools/nightly/daytime-cloud-smoke.mjs");
  assert.match(scheduler, /OpenButler-Daytime-Cloud/);
  assert.match(scheduler, /8 \* 60 \+ 30/);
  assert.match(scheduler, /19 \* 60 \+ 30/);
  assert.match(controller, /Issue specification changed after Cloud submission/);
  assert.match(controller, /origin\/main changed after Cloud submission/);
  assert.match(controller, /"cleanup-required"/);
  assert.match(services, /const createdPullRequest = ghJson[\s\S]*verifyIssueContract\(\)[\s\S]*openForBranch/);
  assert.match(services, /cloud", "exec"/);
  assert.match(services, /cloud", "diff"/);
  assert.match(services, /waitForChecks/);
  assert.match(services, /requiredChecks/);
  assert.match(services, /"Context Engine"/);
  assert.match(services, /"Nightly Controller"/);
  assert.match(services, /normalizeUnifiedDiff/);
  assert.match(services, /Cloud-authored code is never executed/);
  assert.doesNotMatch(services, /for \(const test of requiredTestsForPaths\(paths, worktree\)\)/);
  assert.match(services, /origin\/main changed during Cloud result verification/);
  assert.match(services, /Issue specification changed during Cloud result verification/);
  assert.match(services, /--force-with-lease/);
  assert.match(services, /rollback could not prove remote branch deletion/);
  assert.match(services, /Product code has not been executed on this PC; required tests run in CI/);
  assert.match(services, /"--head", state\.branch/);
  assert.match(services, /--draft/);
  assert.match(controller, /pull request or remote branch cleanup could not be proven/);
  assert.doesNotMatch(controller, /pr", "merge"/);
  assert.doesNotMatch(services, /pr", "merge"/);
  assert.match(morning, /白天 Cloud 工作/);
  assert.match(morning, /PR 已就绪/);
  assert.match(smoke, /github_mutated: false/);
  assert.match(smoke, /personal_data_read: false/);
});

test("high-risk work uses a second product and privacy verifier", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /product-privacy-verifier/);
  assert.match(controller, /product_privacy_verifier/);
  assert.match(controller, /code_verifier_head_sha/);
  assert.match(controller, /product_privacy_verifier_head_sha/);
  assert.match(controller, /independent verifier evidence does not match the reviewed commit/);
  assert.match(controller, /automation-blocked/);
});

test("Windows automation resolves the native Codex executable before a command shim", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  const cloud = read("tools/nightly/cloud-preflight.mjs");
  const library = read("tools/nightly/nightly-lib.mjs");
  assert.match(controller, /resolveCodexCommand/);
  assert.match(cloud, /resolveCodexCommand/);
  assert.match(library, /node_modules", "@openai", "codex", "bin", "codex\.js"/);
  assert.match(library, /command: process\.execPath/);
  assert.match(library, /where\.exe", \["codex\.exe"\]/);
  assert.match(library, /OPENBUTLER_CODEX_EXE/);
  assert.match(controller, /errorCode: result\.error\?\.code/);
});

test("fresh issue worktrees install npm dependencies before focused checks", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /function installNpmDependencies/);
  assert.match(controller, /"npm\.cmd", \["ci", "--no-audit", "--no-fund"\]/);
  assert.match(controller, /installNpmDependencies\("Frontend", join\(worktree, "frontend"\)/);
  assert.match(controller, /installNpmDependencies\("Desktop", join\(worktree, "desktop"\)/);
  assert.match(controller, /installNpmDependencies\("Loop Governance", join\(worktree, "tools", "loop"\)/);
});

test("an issue moves from its execution lease to review as soon as its pull request exists", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  const daytimeServices = read("tools/nightly/daytime-cloud-services.mjs");
  assert.match(controller, /claimedIssueNumbers/);
  assert.match(controller, /--remove-label", "ready-for-agent"/);
  assert.match(controller, /--add-label", "review-pending"/);
  assert.match(controller, /--remove-label", "nightly-running"/);
  const transitionBlock = controller.slice(controller.indexOf("const queueTransition"), controller.indexOf("const readyPullRequest"));
  assert.doesNotMatch(transitionBlock, /--remove-label", "ready-for-agent"/);
  const daytimeTransition = daytimeServices.split(/\r?\n/).find((line) => line.includes("transitionToReview")) ?? "";
  assert.doesNotMatch(daytimeTransition, /ready-for-agent/);
});

test("nightly retries use unique branches and clean local branch state", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /runId\.replace\(\/\[\^0-9A-Za-z\]\/g, ""\)\.slice\(0, 22\)/);
  assert.match(controller, /\["branch", "-D", branchName\]/);
});

test("nightly claim is revalidated before maker execution", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /claimedIssue = ghJson/);
  assert.match(controller, /postClaimEvaluation = evaluateIssueEligibility/);
  assert.match(controller, /ownedLease: "nightly-running"/);
  assert.match(controller, /closedIssues: postClaimClosed/);
  assert.match(controller, /claimedIssues: competingPullRequests/);
  assert.match(controller, /Issue specification changed while claiming/);
});

test("nightly failures preserve useful recovery state and leave the queue", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /recovery-worktree\.json/);
  assert.match(controller, /rev-list", "--count", "origin\/main\.\.HEAD/);
  assert.match(controller, /shouldClearLocalQuarantine/);
  assert.match(controller, /rmSync\(quarantinePath/);
  assert.match(controller, /preserveWorktree/);
  assert.match(controller, /--add-label", "nightly-failed"/);
  assert.match(controller, /if \(!quarantined\.ok\) releaseExecutionLease = false/);
  assert.match(controller, /if \(leaseAcquired && releaseExecutionLease\) ghCommand/);
  assert.match(controller, /commandWithRetry/);
});

test("Cloud and Nightly dispatchers share a fail-closed execution gate", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  const daytime = read("tools/nightly/daytime-cloud-controller.mjs");
  assert.match(controller, /daytimeStatePath/);
  assert.match(controller, /--label", "cloud-running"/);
  assert.match(controller, /executionClaimLockPath/);
  assert.match(controller, /an unresolved Nightly execution lease is active/);
  assert.match(controller, /orphan Nightly execution lease recovered at startup/);
  assert.match(controller, /evaluateSpecificationFreshness/);
  assert.match(daytime, /executionLeases/);
  assert.match(daytime, /acquireExecutionClaimLock/);
  assert.match(daytime, /another Cloud or Nightly execution lease is active/);
});

test("a quarantined Nightly failure returns control to the serial queue", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /blocker: `Issue #\$\{issue\.number\} 已隔离/);
  assert.match(controller, /if \(issueResult\.blocker\) pack\.blockers\.push/);
  assert.match(controller, /if \(issueResult\.githubMutated\) pack\.privacy\.github_mutated = true/);
  assert.match(controller, /issue_failed_before_isolation/);
  assert.match(controller, /continue;/);
});

test("Nightly revalidates the Issue before and after pull request creation", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /verifyCurrentIssueContract\(\);[\s\S]*git", \["push"/);
  assert.match(controller, /const prUrl = createdPullRequest\.stdout\.trim\(\);[\s\S]*verifyCurrentIssueContract\(\)/);
  assert.match(controller, /"pr", "close", prUrl[\s\S]*"--delete-branch"/);
  assert.match(controller, /if \(!readyPullRequest\.ok\) throw/);
  assert.match(controller, /if \(!acceptanceLabels\.ok\) throw/);
});

test("real data smoke is isolated, bounded, and redacted", () => {
  const source = read("tools/nightly/real-data-smoke.py");
  assert.match(source, /lookback_days=2/);
  assert.match(source, /include_screenshot_paths=False/);
  assert.match(source, /copy_screenshots=False/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS settings/);
  assert.match(source, /raw_output_persisted/);
  assert.match(source, /data.*nightly.*real-data/s);
});

test("automation policy keeps stable release manual", () => {
  const source = read(".openbutler/automation-policy.yaml");
  assert.match(source, /loop_level: L2/);
  assert.match(source, /stable_release: manual/);
  assert.match(source, /nightly_release: automatic/);
  assert.match(source, /retention_hours: 48/);
});
