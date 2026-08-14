import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalCommand,
  canAutoMergePullRequest,
  claimedIssueNumbers,
  evaluateCanonicalCheckout,
  evaluateIssueEligibility,
  isTransientCommandFailure,
  runWithRetry,
  isFreshAcceptancePack,
  mayStartIssue,
  parseCurrentLevel,
  sanitizeAcceptanceValue,
  shouldClearLocalQuarantine,
  shouldPreserveRecovery,
  tokenUsageFromJsonl,
} from "../nightly-lib.mjs";

test("parses loop level", () => {
  assert.equal(parseCurrentLevel("Current level: L1 active"), "L1");
});

test("requires the ready label and no execution lease", () => {
  const ready = {title: "copy change", body: "", labels: [{name: "ready-for-agent"}]};
  const running = {...ready, labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]};
  assert.equal(evaluateIssueEligibility(ready).eligible, true);
  assert.equal(evaluateIssueEligibility(running).eligible, false);
});

test("failed nightly work is quarantined until explicitly retriaged", () => {
  const issue = {
    title: "bounded repair",
    body: "",
    labels: [{name: "ready-for-agent"}, {name: "nightly-failed"}],
  };
  const result = evaluateIssueEligibility(issue);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join("; "), /nightly-failed/);
});

test("transient GitHub failures retry but permanent failures fail immediately", () => {
  let calls = 0;
  const recovered = runWithRetry(() => {
    calls += 1;
    return calls < 3
      ? {ok: false, status: 1, stderr: "Post https://api.github.com/graphql: EOF"}
      : {ok: true, status: 0, stdout: "ok", stderr: ""};
  }, {attempts: 3, sleep: () => {}});
  assert.equal(recovered.ok, true);
  assert.equal(calls, 3);

  calls = 0;
  const permanent = runWithRetry(() => {
    calls += 1;
    return {ok: false, status: 1, stderr: "validation failed"};
  }, {attempts: 3, sleep: () => {}});
  assert.equal(permanent.ok, false);
  assert.equal(calls, 1);
  assert.equal(isTransientCommandFailure({stderr: "HTTP 502 Bad Gateway"}), true);
  assert.equal(isTransientCommandFailure({stderr: "permission denied"}), false);
});

test("rejects an issue that already has an open implementation pull request", () => {
  const issue = {
    number: 42,
    title: "copy change",
    body: "",
    labels: [{name: "ready-for-agent"}],
  };
  const result = evaluateIssueEligibility(issue, {claimedIssues: new Set([42])});
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /open implementation pull request/);
});

test("extracts claimed issue numbers from open nightly pull requests", () => {
  const claimed = claimedIssueNumbers([
    {title: "Fix local setup (#42)", body: "Closes #42"},
    {title: "Docs", body: "Resolves #51 and fixes #52"},
  ]);
  assert.deepEqual([...claimed].sort((a, b) => a - b), [42, 51, 52]);
});

test("claims direct implementation titles and Cloud or Nightly branches", () => {
  const claimed = claimedIssueNumbers([
    {title: "Implement #34: bounded fix", body: "", headRefName: "codex/cloud-34-run"},
    {title: "Issue #35 follow-up", body: "", headRefName: "codex/nightly-35-run"},
    {title: "Unrelated", body: "", headRefName: "codex/issue-36-recovery"},
  ]);
  assert.deepEqual([...claimed].sort((a, b) => a - b), [34, 35, 36]);
});

test("recovery preservation covers dirty and committed worktrees", () => {
  assert.equal(shouldPreserveRecovery({dirty: false, aheadCount: 0}), false);
  assert.equal(shouldPreserveRecovery({dirty: true, aheadCount: 0}), true);
  assert.equal(shouldPreserveRecovery({dirty: false, aheadCount: 1}), true);
});

test("local quarantine clears only after an explicit ready reapproval", () => {
  const quarantine = {failed_at: "2026-08-14T10:00:00Z"};
  const issue = {labels: [{name: "ready-for-agent"}]};
  assert.equal(shouldClearLocalQuarantine({issue, quarantine, timeline: []}), false);
  assert.equal(shouldClearLocalQuarantine({issue: {...issue, labels: [...issue.labels, {name: "nightly-failed"}]}, quarantine, timeline: [{event: "labeled", label: {name: "ready-for-agent"}, created_at: "2026-08-14T11:00:00Z"}]}), false);
  assert.equal(shouldClearLocalQuarantine({issue, quarantine, timeline: [{event: "labeled", label: {name: "ready-for-agent"}, created_at: "2026-08-14T09:00:00Z"}]}), false);
  assert.equal(shouldClearLocalQuarantine({issue, quarantine, timeline: [{event: "labeled", label: {name: "ready-for-agent"}, created_at: "2026-08-14T11:00:00Z"}]}), true);
});

test("hard-stop work is never eligible for automation", () => {
  const issue = {
    title: "Upload screenshots to a remote service",
    body: "",
    labels: [{name: "ready-for-agent"}],
  };
  const result = evaluateIssueEligibility(issue);
  assert.equal(result.eligible, false);
  assert.equal(result.hardStop, true);
});

test("redacts local paths, external URLs, and raw fields", () => {
  const value = sanitizeAcceptanceValue({
    summary: "C:\\Users\\example\\secret\\screen.png https://example.com/private",
    screenshot_paths: ["C:\\Users\\example\\screen.png"],
    apiKey: "secret",
  });
  assert.equal("screenshot_paths" in value, false);
  assert.equal("apiKey" in value, false);
  assert.match(value.summary, /redacted-local-path/);
  assert.match(value.summary, /redacted-url/);
});

test("approval command includes only passed PRs", () => {
  const pack = {pull_requests: [{number: 21}, {number: 22}]};
  assert.equal(buildApprovalCommand(pack, {"21": {status: "passed"}, "22": {status: "failed"}}), "批准合并 PR #21");
});

test("budget stops new work at 80 percent", () => {
  const evening = new Date("2026-07-16T20:00:00");
  assert.equal(mayStartIssue(599_999, evening), true);
  assert.equal(mayStartIssue(600_000, evening), false);
  assert.equal(mayStartIssue(0, new Date("2026-07-17T07:14:00")), true);
  assert.equal(mayStartIssue(0, new Date("2026-07-17T07:15:00")), false);
});

test("token budget counts uncached input and output without double-counting cache hits", () => {
  const jsonl = JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 3_597_620,
      cached_input_tokens: 3_469_568,
      output_tokens: 27_064,
    },
  });
  assert.equal(tokenUsageFromJsonl(jsonl), 155_116);
});

test("automatic merge requires fresh dual-verifier and CI evidence", () => {
  const checks = ["Butler Core", "PC Activity"].map((name) => ({
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  }));
  const pullRequest = {
    state: "OPEN",
    isDraft: false,
    headRefOid: "abc",
    reviewDecision: "",
    statusCheckRollup: checks,
  };
  const acceptance = {
    head_sha: "abc",
    code_verifier: "APPROVE",
    code_verifier_head_sha: "abc",
    product_privacy_verifier: "APPROVE",
    product_privacy_verifier_head_sha: "abc",
    nightly_status: "passed",
  };
  assert.equal(canAutoMergePullRequest({
    pullRequest,
    acceptance,
    requiredChecks: new Set(["Butler Core", "PC Activity"]),
    requireNightly: true,
  }).eligible, true);
  assert.equal(canAutoMergePullRequest({
    pullRequest: {...pullRequest, headRefOid: "changed"},
    acceptance,
    requiredChecks: new Set(["Butler Core", "PC Activity"]),
    requireNightly: true,
  }).eligible, false);
});

test("morning pack must be completed, matching, and fresh", () => {
  const now = new Date("2026-07-17T08:00:00+08:00");
  const pack = {run_id: "night-1", generated_at: "2026-07-16T19:00:00+08:00"};
  assert.equal(isFreshAcceptancePack(pack, {run_id: "night-1", outcome: "completed"}, now), true);
  assert.equal(isFreshAcceptancePack(pack, {run_id: "night-2", outcome: "completed"}, now), false);
  assert.equal(isFreshAcceptancePack({...pack, generated_at: "2026-07-15T08:00:00+08:00"}, {run_id: "night-1", outcome: "completed"}, now), false);
});

test("nightly execution requires canonical main checkout", () => {
  assert.equal(evaluateCanonicalCheckout({branch: "main", head: "abc", originMain: "abc"}).eligible, true);
  assert.equal(evaluateCanonicalCheckout({branch: "codex/change", head: "abc", originMain: "abc"}).eligible, false);
  assert.equal(evaluateCanonicalCheckout({branch: "main", head: "def", originMain: "abc"}).eligible, false);
});
