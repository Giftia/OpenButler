import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalCommand,
  evaluateCanonicalCheckout,
  evaluateIssueEligibility,
  isFreshAcceptancePack,
  mayStartIssue,
  parseCurrentLevel,
  sanitizeAcceptanceValue,
} from "../nightly-lib.mjs";

test("parses loop level", () => {
  assert.equal(parseCurrentLevel("Current level: L1 active"), "L1");
});

test("requires both nightly labels", () => {
  const issue = {title: "copy change", body: "", labels: [{name: "ready-for-agent"}]};
  assert.equal(evaluateIssueEligibility(issue).eligible, false);
});

test("requires fresh Giftia approval for high-risk work", () => {
  const issue = {
    title: "Electron lifecycle change",
    body: "",
    createdAt: "2026-07-16T10:00:00Z",
    updatedAt: "2026-07-16T12:00:00Z",
    lastEditedAt: "2026-07-16T12:00:00Z",
    specificationAuditAvailable: true,
    labels: [{name: "ready-for-agent"}, {name: "nightly-approved"}],
  };
  const stale = [{event: "labeled", label: {name: "nightly-approved"}, actor: {login: "Giftia"}, created_at: "2026-07-16T11:00:00Z"}];
  const fresh = [{event: "labeled", label: {name: "nightly-approved"}, actor: {login: "Giftia"}, created_at: "2026-07-16T13:00:00Z"}];
  assert.equal(evaluateIssueEligibility(issue, {timeline: stale}).eligible, false);
  assert.equal(evaluateIssueEligibility(issue, {timeline: fresh}).eligible, true);
});

test("requires approval after an explicit specification edit", () => {
  const issue = {
    title: "Electron lifecycle change",
    body: "",
    createdAt: "2026-07-16T10:00:00Z",
    updatedAt: "2026-07-16T14:00:00Z",
    lastEditedAt: "2026-07-16T14:00:00Z",
    specificationAuditAvailable: true,
    labels: [{name: "ready-for-agent"}, {name: "nightly-approved"}],
  };
  const timeline = [{event: "labeled", label: {name: "nightly-approved"}, actor: {login: "Giftia"}, created_at: "2026-07-16T13:00:00Z"}];
  assert.equal(evaluateIssueEligibility(issue, {timeline}).eligible, false);
});

test("does not treat label-driven issue updatedAt as a specification edit", () => {
  const issue = {
    title: "Electron lifecycle change",
    createdAt: "2026-07-16T10:00:00Z",
    updatedAt: "2026-07-16T13:00:02Z",
    lastEditedAt: null,
    specificationAuditAvailable: true,
    labels: [{name: "ready-for-agent"}, {name: "nightly-approved"}],
  };
  const timeline = [{event: "labeled", label: {name: "nightly-approved"}, actor: {login: "Giftia"}, created_at: "2026-07-16T13:00:00Z"}];
  assert.equal(evaluateIssueEligibility(issue, {timeline}).eligible, true);
});

test("rejects high-risk work when the specification edit timestamp cannot be audited", () => {
  const issue = {
    title: "Electron lifecycle change",
    createdAt: "2026-07-16T10:00:00Z",
    labels: [{name: "ready-for-agent"}, {name: "nightly-approved"}],
  };
  const timeline = [{event: "labeled", label: {name: "nightly-approved"}, actor: {login: "Giftia"}, created_at: "2026-07-16T13:00:00Z"}];
  const result = evaluateIssueEligibility(issue, {timeline});
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /specification edit timestamp unavailable/);
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
