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
  for (const check of ["Butler Core", "PC Activity", "Workstation Vision", "Frontend Build", "Desktop Contract", "Loop Governance"]) {
    assert.match(source, new RegExp(check));
  }
});

test("stable release waits for the complete required check set and has rollback", () => {
  const source = read("tools/nightly/post-approval-release.mjs");
  for (const check of ["Butler Core", "PC Activity", "Workstation Vision", "Frontend Build", "Desktop Contract", "Loop Governance"]) {
    assert.match(source, new RegExp(check));
  }
  assert.match(source, /restoreStableInstall/);
  assert.match(source, /if \(!stableInstallMutated\) return/);
  assert.match(source, /OPENBUTLER_APPROVED_MAIN_SHA/);
  assert.match(source, /smoke:installer-lifecycle/);
});

test("morning report rejects stale or incomplete packs", () => {
  const source = read("tools/nightly/morning-report.mjs");
  assert.match(source, /isFreshAcceptancePack/);
  assert.match(source, /process\.exit\(2\)/);
  assert.match(source, /rmSync\(publishedPackPath/);
  assert.match(source, /Nightly 隔离库已写入/);
  assert.match(source, /来源数据已修改/);
  assert.match(source, /稳定版发布仍需单独批准/);
  assert.doesNotMatch(source, /当前批准命令/);
  const runner = read("tools/nightly/run-morning.ps1");
  assert.match(runner, /if \(\$reportExitCode -ne 0\)/);
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
  for (const time of ["20:00", "07:15", "08:20", "08:30"]) assert.match(source, new RegExp(time));
});

test("high-risk work uses a second product and privacy verifier", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /product-privacy-verifier/);
  assert.match(controller, /product_privacy_verifier/);
  assert.match(controller, /automation-blocked/);
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
  assert.match(controller, /claimedIssueNumbers/);
  assert.match(controller, /--remove-label", "ready-for-agent"/);
  assert.match(controller, /--add-label", "review-pending"/);
  assert.match(controller, /--remove-label", "nightly-running"/);
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
