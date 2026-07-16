import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const requested = process.argv.slice(2).map((value) => Number(String(value).replace(/^#/, ""))).filter(Number.isInteger);
if (!requested.length) throw new Error("Pass one or more approved PR numbers.");

const latest = readFileSync(join(root, "data", "nightly", "latest-run.txt"), "utf8").trim();
const pack = JSON.parse(readFileSync(join(root, "data", "nightly", latest, "acceptance-pack.json"), "utf8"));
const requiredChecks = new Set(["Butler Core", "PC Activity", "Workstation Vision", "Frontend Build", "Desktop Contract", "Loop Governance"]);

function gh(args) {
  return execFileSync("gh", args, {cwd: root, encoding: "utf8", windowsHide: true});
}

function validatePullRequest(number) {
  const expected = (pack.pull_requests ?? []).find((pr) => pr.number === number);
  if (!expected) throw new Error(`PR #${number} is not in the active acceptance pack.`);
  const actual = JSON.parse(gh(["pr", "view", String(number), "--repo", "Giftia/OpenButler", "--json", "headRefOid,isDraft,reviewDecision,statusCheckRollup,labels,state"]));
  if (actual.state !== "OPEN" || actual.isDraft) throw new Error(`PR #${number} is not open and ready.`);
  if (actual.headRefOid !== expected.head_sha) throw new Error(`PR #${number} changed after acceptance pack generation.`);
  if (!(actual.labels ?? []).some((label) => label.name === "acceptance-ready")) throw new Error(`PR #${number} lacks acceptance-ready.`);
  if (actual.reviewDecision === "CHANGES_REQUESTED") throw new Error(`PR #${number} has requested changes.`);
  const checks = actual.statusCheckRollup ?? [];
  const byName = new Map(checks.map((check) => [check.name ?? check.context, check]));
  const missing = [...requiredChecks].filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`PR #${number} is missing required checks: ${missing.join(", ")}.`);
  const failed = [...requiredChecks].map((name) => byName.get(name)).filter((check) => check.status !== "COMPLETED" || check.conclusion !== "SUCCESS");
  if (failed.length) throw new Error(`PR #${number} does not have all-green required checks.`);
  return expected;
}

let approvedMainSha = "";
for (const number of requested) {
  const expected = validatePullRequest(number);
  gh(["pr", "merge", String(number), "--repo", "Giftia/OpenButler", "--squash", "--delete-branch", "--match-head-commit", expected.head_sha]);
  const merged = JSON.parse(gh(["pr", "view", String(number), "--repo", "Giftia/OpenButler", "--json", "mergeCommit,state"]));
  if (merged.state !== "MERGED" || !merged.mergeCommit?.oid) throw new Error(`PR #${number} merged without a readable merge commit.`);
  approvedMainSha = merged.mergeCommit.oid;
  console.log(`Merged PR #${number}`);
}

execFileSync("git", ["fetch", "origin", "main"], {cwd: root, encoding: "utf8", windowsHide: true});
const observedMainSha = execFileSync("git", ["rev-parse", "origin/main"], {cwd: root, encoding: "utf8", windowsHide: true}).trim();
if (observedMainSha !== approvedMainSha) throw new Error(`origin/main advanced outside the approved merge set: expected ${approvedMainSha}, got ${observedMainSha}.`);

console.log("Approved PRs merged. Stable build/release remains a separate post-main-CI operation.");

const release = spawnSync("node", [join(here, "post-approval-release.mjs")], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  timeout: 4 * 60 * 60 * 1000,
  env: {...process.env, OPENBUTLER_APPROVED_MAIN_SHA: approvedMainSha},
});
if (release.error) throw release.error;
if (release.status !== 0) throw new Error(`Stable release failed with ${release.status}. Merged PRs remain merged; no installer was applied.`);
