import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("merge approval is bound to the accepted head SHA", () => {
  const source = read("tools/nightly/approve-release.mjs");
  assert.match(source, /--match-head-commit/);
  assert.match(source, /expected\.head_sha/);
  for (const check of ["Butler Core", "PC Activity", "Workstation Vision", "Frontend Build", "Desktop Contract", "Loop Governance"]) {
    assert.match(source, new RegExp(check));
  }
  assert.match(source, /missing required checks/);
  assert.match(source, /OPENBUTLER_APPROVED_MAIN_SHA/);
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

test("Windows scheduler supports overnight laptop battery operation", () => {
  const source = read("tools/nightly/install-scheduled-tasks.ps1");
  assert.match(source, /AllowStartIfOnBatteries/);
  assert.match(source, /DontStopIfGoingOnBatteries/);
  assert.match(source, /\[string\]\$Mode = "dry-run"/);
});

test("high-risk approval uses GitHub's auditable specification edit timestamp", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  const library = read("tools/nightly/nightly-lib.mjs");
  assert.match(controller, /lastEditedAt/);
  assert.match(controller, /specificationAuditAvailable/);
  assert.match(library, /high-risk specification edit timestamp unavailable/);
});

test("fresh issue worktrees install npm dependencies before focused checks", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /function installNpmDependencies/);
  assert.match(controller, /"npm\.cmd", \["ci", "--no-audit", "--no-fund"\]/);
  assert.match(controller, /installNpmDependencies\("Frontend", join\(worktree, "frontend"\)/);
  assert.match(controller, /installNpmDependencies\("Desktop", join\(worktree, "desktop"\)/);
  assert.match(controller, /installNpmDependencies\("Loop Governance", join\(worktree, "tools", "loop"\)/);
});

test("an issue moves out of the nightly queue as soon as its pull request exists", () => {
  const controller = read("tools/nightly/nightly-controller.mjs");
  assert.match(controller, /claimedIssueNumbers/);
  assert.match(controller, /--remove-label", "ready-for-agent"/);
  assert.match(controller, /--remove-label", "nightly-approved"/);
  assert.match(controller, /--add-label", "ready-for-human"/);
});
