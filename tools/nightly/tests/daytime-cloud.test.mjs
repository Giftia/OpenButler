import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  evaluateCloudDiff,
  evaluateSpecificationFreshness,
  issueSpecificationFingerprint,
  parseCloudTaskId,
  parseCloudTaskStatus,
  withinDaytimeWindow,
} from "../daytime-cloud-lib.mjs";
import {runDaytimeDispatcher} from "../daytime-cloud-controller.mjs";
import {acquireOwnedLock, releaseOwnedLock, requiredTestsForPaths} from "../daytime-cloud-services.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const daytime = () => new Date(2026, 7, 12, 10, 0, 0);
const readyIssue = (overrides = {}) => ({
  number: 34,
  title: "Implement dispatcher",
  body: "## Done when\n- bounded",
  labels: [{name: "ready-for-agent"}],
  createdAt: "2026-08-12T00:00:00Z",
  lastEditedAt: null,
  ...overrides,
});
const readyTimeline = [{event: "labeled", label: {name: "ready-for-agent"}, created_at: "2026-08-12T01:00:00Z"}];
const safeDiff = [
  "diff --git a/tools/nightly/example.mjs b/tools/nightly/example.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tools/nightly/example.mjs",
  "@@ -0,0 +1 @@",
  "+export const ok = true;",
  "",
].join("\n");

function activeState(issue = readyIssue(), overrides = {}) {
  return {
    schema_version: 1,
    run_id: "run-1",
    issue: issue.number,
    base_sha: "abc",
    task_id: "task_123",
    branch: "codex/cloud-34-run1",
    specification_fingerprint: issueSpecificationFingerprint(issue),
    status: "pending",
    reason: null,
    ...overrides,
  };
}

function mockServices(options = {}) {
  let issue = options.issue ?? readyIssue();
  let state = options.state ?? null;
  const calls = [];
  const withLease = () => {
    const labels = (issue.labels ?? []).filter((label) => (label.name ?? label) !== "cloud-running");
    issue = {...issue, labels: [...labels, {name: "cloud-running"}]};
  };
  const withoutLease = () => {
    issue = {...issue, labels: (issue.labels ?? []).filter((label) => (label.name ?? label) !== "cloud-running")};
  };
  return {
    calls,
    get state() { return state; },
    loadState: () => state,
    saveState: (next) => { calls.push(["save", next.status]); state = {...next}; return state; },
    completeState: (next) => { calls.push(["complete", next.status]); state = null; return {...next}; },
    preflight: () => options.authenticated ?? true,
    baseSha: () => options.currentBase ?? "abc",
    queue: () => ({
      issues: options.issues ?? [issue],
      closedIssues: new Set(options.closedIssues ?? []),
      pullRequests: options.pullRequests ?? [],
    }),
    issue: () => options.currentIssue ?? issue,
    timeline: () => options.timeline ?? readyTimeline,
    claim: () => { calls.push(["claim"]); if (options.claimOk === false) return false; withLease(); return true; },
    release: () => { calls.push(["release"]); if (options.releaseOk === false) return false; withoutLease(); return true; },
    transitionToReview: () => { calls.push(["transition"]); withoutLease(); return options.transitionOk ?? true; },
    submit: () => { calls.push(["submit"]); return options.submitted ?? {ok: true, taskId: "task_123"}; },
    recoverTask: () => { calls.push(["recover"]); return options.recoveredTask ?? null; },
    taskStatus: () => options.taskStatus ?? "pending",
    taskDiff: () => options.diff ?? safeDiff,
    openPullRequests: () => options.openPullRequests ?? [],
    materialize: () => { calls.push(["materialize"]); if (options.materializeError) throw new Error(options.materializeError); return {number: 77}; },
  };
}

test("daytime window is inclusive at 08:30 and exclusive at 19:30", () => {
  assert.equal(withinDaytimeWindow(new Date(2026, 7, 12, 8, 29)), false);
  assert.equal(withinDaytimeWindow(new Date(2026, 7, 12, 8, 30)), true);
  assert.equal(withinDaytimeWindow(new Date(2026, 7, 12, 19, 29)), true);
  assert.equal(withinDaytimeWindow(new Date(2026, 7, 12, 19, 30)), false);
});

test("missing environment and failed authentication fail closed", async () => {
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "", services: mockServices()})).reason, "Cloud environment is not configured");
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({authenticated: false})})).reason, "Cloud authentication failed");
});

test("authentication outage retains an existing Cloud lease and reports its Issue", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const services = mockServices({issue, state: activeState(issue), authenticated: false});
  const result = await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "blocked");
  assert.equal(result.issue, 34);
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("competing lease and open implementation PR are not eligible", async () => {
  for (const lease of ["nightly-running", "cloud-running"]) {
    const leased = readyIssue({labels: [{name: "ready-for-agent"}, {name: lease}]});
    assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({issue: leased})})).status, "no-op");
  }
  const pr = {number: 9, title: "Fixes #34", body: "", headRefName: "other"};
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({pullRequests: [pr]})})).status, "no-op");
});

test("unmet dependency, hard stop, and stale specification are refused", async () => {
  const dependency = readyIssue({body: "Depends on #12"});
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({issue: dependency})})).status, "no-op");
  const hardStop = readyIssue({body: "Disable tests to finish"});
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({issue: hardStop})})).status, "no-op");
  const stale = readyIssue({updatedAt: "2026-08-12T02:00:00Z"});
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({issue: stale})})).status, "no-op");
});

test("GitHub ready-label timestamp drift is tolerated but later updates are stale", () => {
  const readyAt = "2026-08-14T02:00:00.000Z";
  const timeline = [{event: "labeled", label: {name: "ready-for-agent"}, created_at: readyAt}];
  assert.equal(evaluateSpecificationFreshness({createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-14T02:00:01.000Z"}, timeline).fresh, true);
  assert.equal(evaluateSpecificationFreshness({createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-14T02:00:03.000Z"}, timeline).fresh, false);
});

test("eligible execute submission acquires one lease and persists task metadata", async () => {
  const services = mockServices();
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services, runId: "run-1"});
  assert.equal(result.status, "submitted");
  assert.equal(result.issue, 34);
  assert.equal(result.base_sha, "abc");
  assert.equal(result.task_id, "task_123");
  assert.deepEqual(services.calls.filter(([name]) => ["claim", "submit"].includes(name)), [["claim"], ["submit"]]);
});

test("implementation PR appearing during claim prevents Cloud submission", async () => {
  const pr = {number: 9, title: "Fixes #34", body: "", headRefName: "other"};
  const services = mockServices({openPullRequests: [pr]});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services, runId: "run-1"});
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /pull request appeared/);
  assert.equal(services.calls.some(([name]) => name === "submit"), false);
  assert.equal(services.calls.some(([name]) => name === "release"), true);
});

test("pending, failed, and cancelled task states preserve or clean the lease", async () => {
  for (const taskStatus of ["pending", "failed", "cancelled"]) {
    const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
    const services = mockServices({issue, state: activeState(issue), taskStatus});
    const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
    assert.equal(result.status, taskStatus);
    assert.equal(services.calls.some(([name]) => name === "release"), taskStatus !== "pending");
  }
});

test("stale pending Cloud task retains its Issue lease when cancellation is unavailable", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const state = activeState(issue, {claimed_at: "2026-08-11T10:00:00.000Z"});
  const services = mockServices({issue, state, taskStatus: "pending"});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "cleanup-required");
  assert.match(result.reason, /cancellation is unavailable/);
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("unavailable or unknown Cloud status retains the lease", async () => {
  for (const taskStatus of ["unavailable", "unknown"]) {
    const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
    const services = mockServices({issue, state: activeState(issue), taskStatus});
    const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
    assert.equal(result.status, "pending");
    assert.match(result.reason, /lease retained/);
    assert.equal(services.calls.some(([name]) => name === "release"), false);
  }
});

test("stale unavailable Cloud status requires reconciliation without releasing the lease", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const state = activeState(issue, {claimed_at: "2026-08-11T10:00:00.000Z"});
  const services = mockServices({issue, state, taskStatus: "unavailable"});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "cleanup-required");
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("ready result becomes PR-ready only after materialization and label transition", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const services = mockServices({issue, state: activeState(issue), taskStatus: "ready"});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "pr-ready");
  assert.equal(result.pr_number, 77);
  assert.deepEqual(services.calls.filter(([name]) => ["materialize", "transition"].includes(name)), [["materialize"], ["transition"]]);
});

test("diff privacy and forbidden path violations fail and release the lease", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const forbidden = "diff --git a/data/private.db b/data/private.db\n+++ b/data/private.db\n+token=abcdefghijk\n";
  const services = mockServices({issue, state: activeState(issue), taskStatus: "ready", diff: forbidden});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /forbidden path|privacy/);
  assert.equal(services.calls.some(([name]) => name === "release"), true);
});

test("stale base SHA and changed Issue specification block ready results", async () => {
  const leased = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const staleBase = mockServices({issue: leased, state: activeState(leased), taskStatus: "ready", currentBase: "def"});
  assert.match((await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services: staleBase})).reason, /origin\/main changed/);

  const original = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const changed = {...original, body: "changed acceptance"};
  const changedSpec = mockServices({issue: original, currentIssue: changed, state: activeState(original)});
  assert.match((await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services: changedSpec})).reason, /specification changed/);
});

test("restart recovery resumes a persisted submission without duplicate submit", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const state = activeState(issue, {status: "submitting", task_id: null});
  const services = mockServices({issue, state, recoveredTask: "task_recovered", taskStatus: "pending"});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "pending");
  assert.equal(result.task_id, "task_recovered");
  assert.equal(services.calls.some(([name]) => name === "submit"), false);
});

test("restart recovery resumes a claimed Issue before any Cloud submission", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const state = activeState(issue, {status: "claiming", task_id: null});
  const services = mockServices({issue, state});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "submitted");
  assert.equal(result.task_id, "task_123");
  assert.equal(services.calls.filter(([name]) => name === "submit").length, 1);
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("restart recovery closes an unacquired claiming state without querying a null task", async () => {
  const issue = readyIssue();
  const state = activeState(issue, {status: "claiming", task_id: null});
  const services = mockServices({issue, state});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "failed");
  assert.equal(services.calls.some(([name]) => name === "submit"), false);
});

test("unconfirmed submission retains its lease until remote recovery is conclusive", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const services = mockServices({issue, state: activeState(issue, {status: "submitting", task_id: null})});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "submission-uncertain");
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("ambiguous initial submission keeps the Cloud lease and does not duplicate submit", async () => {
  const services = mockServices({submitted: {ok: false, taskId: null}});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services, runId: "run-ambiguous"});
  assert.equal(result.status, "submission-uncertain");
  assert.equal(services.calls.filter(([name]) => name === "submit").length, 1);
  assert.equal(services.calls.some(([name]) => name === "release"), false);
});

test("owned lock cannot be removed by a non-owner and safely replaces a stale lock", () => {
  const root = mkdtempSync(join(tmpdir(), "openbutler-cloud-lock-"));
  const lock = join(root, "controller.lock");
  try {
    writeFileSync(lock, JSON.stringify({pid: 999999, token: "stale"}), "utf8");
    const acquired = acquireOwnedLock(lock, {pid: 1234, token: "owner-a", isAlive: () => false});
    assert.equal(acquired.acquired, true);
    assert.equal(releaseOwnedLock(lock, "owner-b"), false);
    assert.equal(existsSync(lock), true);
    assert.equal(releaseOwnedLock(lock, "owner-a"), true);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("Windows PowerShell 5 runner executes without unsupported Tee-Object parameters", {skip: process.platform !== "win32"}, () => {
  const script = resolve(here, "..", "run-daytime-cloud.ps1");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "dry-run", "-Now", "2026-08-14T20:00:00+08:00"], {
    cwd: resolve(here, "..", "..", ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ParameterBindingException|Tee-Object/);
});

test("backend test routing covers generic backend and Context Engine changes", () => {
  const generic = requiredTestsForPaths(["backend/app/main.py"], "C:/repo").map((item) => item.name);
  assert.deepEqual(generic, ["Butler Core", "PC Activity", "Workstation Vision"]);
  const context = requiredTestsForPaths(["backend/app/modules/context_engine/service.py"], "C:/repo").map((item) => item.name);
  assert.deepEqual(context, ["Context Engine"]);
});

test("failed lease cleanup remains active for deterministic restart retry", async () => {
  const issue = readyIssue({labels: [{name: "ready-for-agent"}, {name: "cloud-running"}]});
  const services = mockServices({issue, state: activeState(issue), taskStatus: "failed", releaseOk: false});
  const result = await runDaytimeDispatcher({mode: "execute", now: daytime(), environmentId: "configured", services});
  assert.equal(result.status, "cleanup-required");
  assert.equal(services.state.status, "cleanup-required");
});

test("cutoff and empty queue are safe no-ops", async () => {
  const services = mockServices();
  assert.equal((await runDaytimeDispatcher({now: new Date(2026, 7, 12, 19, 30), environmentId: "configured", services})).status, "outside-window");
  assert.equal((await runDaytimeDispatcher({now: daytime(), environmentId: "configured", services: mockServices({issues: []})})).status, "no-op");
});

test("Cloud CLI output parsers and diff guard fail closed", () => {
  assert.equal(parseCloudTaskId("Created task task_abc123"), "task_abc123");
  assert.equal(parseCloudTaskId("Task ID: 019d1234-5678-7abc-8def-0123456789ab"), "019d1234-5678-7abc-8def-0123456789ab");
  assert.equal(parseCloudTaskStatus("Status: RUNNING"), "pending");
  assert.equal(parseCloudTaskStatus("Status: COMPLETED"), "ready");
  assert.equal(parseCloudTaskStatus("something new"), "unknown");
  assert.equal(evaluateCloudDiff(safeDiff).accepted, true);
  assert.equal(evaluateCloudDiff("not a diff").accepted, false);
});
