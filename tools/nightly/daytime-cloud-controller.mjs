import {pathToFileURL} from "node:url";
import {
  buildCloudPrompt,
  evaluateCloudDiff,
  evaluateSpecificationFreshness,
  issueSpecificationFingerprint,
  redactedCloudStatus,
  withinDaytimeWindow,
} from "./daytime-cloud-lib.mjs";
import {EXECUTION_LEASE_HOURS, claimedIssueNumbers, evaluateIssueEligibility} from "./nightly-lib.mjs";
import {createProductionServices} from "./daytime-cloud-services.mjs";

function terminalFailure(services, state, reason, status = "blocked") {
  if (!services.quarantine(state.issue)) {
    return services.saveState({...state, status: "cleanup-required", reason: `failure quarantine could not be recorded after: ${reason}`});
  }
  if (!services.release(state.issue)) {
    return services.saveState({...state, status: "cleanup-required", reason: `cloud-running lease cleanup failed after: ${reason}`});
  }
  return services.completeState({...state, status, reason});
}

async function runDaytimeDispatcherUnlocked({
  mode = "dry-run",
  now = new Date(),
  environmentId = process.env.OPENBUTLER_CODEX_CLOUD_ENV_ID?.trim(),
  services = createProductionServices(),
  runId = now.toISOString().replace(/[:.]/g, "-"),
} = {}) {
  if (!withinDaytimeWindow(now)) return {status: "outside-window", issue: null};
  let state = services.loadState();
  if (!environmentId) {
    const result = {...state, status: "blocked", issue: state?.issue ?? null, reason: "Cloud environment is not configured"};
    services.recordStatus?.({...result, run_id: result.run_id ?? runId});
    return result;
  }
  if (!services.preflight()) {
    const result = {...state, status: "blocked", issue: state?.issue ?? null, reason: "Cloud authentication failed"};
    services.recordStatus?.({...result, run_id: result.run_id ?? runId});
    return result;
  }

  if (state?.status === "claiming" && !state.task_id) {
    const issue = services.issue(state.issue);
    const labels = new Set((issue.labels ?? []).map((label) => label.name ?? label));
    if (!labels.has("cloud-running")) {
      return services.completeState({...state, status: "failed", reason: "Cloud lease was not acquired before restart"});
    }
    return services.saveState({...state, status: "cleanup-required", reason: "Dispatcher stopped during Issue claim; label ownership cannot be proven, so no Cloud task was submitted and the lease is retained"});
  }

  if (["submitting", "submission-uncertain"].includes(state?.status) && !state.task_id) {
    const recovered = services.recoverTask({runId: state.run_id, environmentId});
    if (!recovered) {
      const claimedAt = Date.parse(state.claimed_at ?? "");
      const ageHours = Number.isFinite(claimedAt) ? (now.getTime() - claimedAt) / 3_600_000 : 0;
      const status = ageHours >= EXECUTION_LEASE_HOURS ? "cleanup-required" : "submission-uncertain";
      return services.saveState({...state, status, reason: "Cloud submission outcome is uncertain; lease retained to prevent duplicate execution"});
    }
    state = services.saveState({...state, task_id: recovered, status: "pending"});
  }

  if (state?.status === "cleanup-required" && !state.task_id) {
    const claimedAt = Date.parse(state.claimed_at ?? "");
    const ageHours = Number.isFinite(claimedAt) ? (now.getTime() - claimedAt) / 3_600_000 : 0;
    if (ageHours >= EXECUTION_LEASE_HOURS) {
      return terminalFailure(services, state, "Unconfirmed Cloud submission exceeded 14 hours; the unknown result is abandoned and the Issue is quarantined", "failed");
    }
    return services.saveState({...state, reason: "Cloud submission outcome remains uncertain; manual reconciliation is required and the lease is retained"});
  }

  if (state) {
    const issue = services.issue(state.issue);
    const labels = new Set((issue.labels ?? []).map((label) => label.name ?? label));
    if (issueSpecificationFingerprint(issue) !== state.specification_fingerprint) {
      return terminalFailure(services, state, "Issue specification changed after Cloud submission");
    }
    if (labels.has("nightly-running")) return terminalFailure(services, state, "competing local lease detected");
    if (!labels.has("cloud-running")) {
      services.restoreLease?.(state.issue);
      return services.saveState({...state, status: "cleanup-required", reason: "Cloud lease disappeared while a remote task may still exist; local state is retained and automation is blocked pending reconciliation"});
    }

    const taskStatus = services.taskStatus(state.task_id);
    const claimedAt = Date.parse(state.claimed_at ?? "");
    const ageHours = Number.isFinite(claimedAt) ? (now.getTime() - claimedAt) / 3_600_000 : 0;
    if (ageHours >= EXECUTION_LEASE_HOURS && !["failed", "cancelled"].includes(taskStatus)) {
      return terminalFailure(services, state, "Cloud task exceeded its 14-hour execution lease; its isolated result is abandoned and the Issue is quarantined", "failed");
    }
    if (taskStatus === "pending") {
      return services.saveState({...state, status: "pending", reason: null});
    }
    if (["unknown", "unavailable"].includes(taskStatus)) {
      return services.saveState({...state, status: "pending", reason: "Cloud task status is unavailable; lease retained"});
    }
    if (["failed", "cancelled"].includes(taskStatus)) {
      return terminalFailure(services, state, `Cloud task ended as ${taskStatus}`, taskStatus === "cancelled" ? "cancelled" : "failed");
    }

    const currentBase = services.baseSha();
    if (currentBase !== state.base_sha) return terminalFailure(services, state, "origin/main changed after Cloud submission");
    const pullRequests = services.openPullRequests();
    const claimedIssues = claimedIssueNumbers(pullRequests.filter((pr) => pr.headRefName !== state.branch));
    const currentEligibility = evaluateIssueEligibility(issue, {
      closedIssues: services.closedIssues(),
      claimedIssues,
      ownedLease: "cloud-running",
    });
    if (!currentEligibility.eligible) return terminalFailure(services, state, `Issue became ineligible after Cloud submission: ${currentEligibility.reasons.join(", ")}`);
    const competing = pullRequests.filter((pr) => claimedIssueNumbers([pr]).has(state.issue) && pr.headRefName !== state.branch);
    if (competing.length) return terminalFailure(services, state, "an implementation pull request appeared after Cloud submission");

    let diff;
    try {
      diff = services.taskDiff(state.task_id);
    } catch {
      return services.saveState({...state, status: "pending", reason: "Cloud diff is temporarily unavailable; lease retained"});
    }
    const evaluatedDiff = evaluateCloudDiff(diff);
    if (!evaluatedDiff.accepted) return terminalFailure(services, state, evaluatedDiff.reasons.join("; "));
    if (mode !== "execute") return services.saveState({...state, status: "ready", reason: "dry-run did not apply the Cloud result"});

    try {
      const pr = services.materialize({state, diff, paths: evaluatedDiff.paths});
      const issueAfterPullRequest = services.issue(state.issue);
      const afterPullRequestEligibility = evaluateIssueEligibility(issueAfterPullRequest, {
        closedIssues: services.closedIssues(),
        claimedIssues: new Set(),
        ownedLease: "cloud-running",
      });
      const afterPullRequestFreshness = evaluateSpecificationFreshness(issueAfterPullRequest, services.timeline(state.issue));
      if (!afterPullRequestEligibility.eligible
        || !afterPullRequestFreshness.fresh
        || issueSpecificationFingerprint(issueAfterPullRequest) !== state.specification_fingerprint) {
        services.closePullRequest?.(pr.number);
        return terminalFailure(services, state, "Issue changed after Cloud pull request creation", "failed");
      }
      if (!services.transitionToReview(state.issue)) {
        return terminalFailure(services, state, "pull request exists but Issue label transition failed", "failed");
      }
      return services.completeState({...state, status: "pr-ready", pr_number: pr.number, reason: null});
    } catch (error) {
      return terminalFailure(services, state, String(error?.message ?? error), "failed");
    }
  }

  const activeLeases = services.executionLeases?.() ?? [];
  if (activeLeases.length) {
    const orphanCloudLeases = activeLeases.filter((leasedIssue) => (leasedIssue.labels ?? []).some((label) => (label.name ?? label) === "cloud-running"));
    if (mode === "execute" && orphanCloudLeases.length === activeLeases.length) {
      for (const orphan of orphanCloudLeases) {
        if (!services.quarantine(orphan.number) || !services.release(orphan.number)) {
          return {status: "cleanup-required", issue: orphan.number, reason: "orphan Cloud lease could not be quarantined safely"};
        }
      }
    } else {
      const result = {status: "blocked", issue: null, reason: "another Cloud or Nightly execution lease is active"};
      services.recordStatus?.({...result, run_id: runId});
      return result;
    }
  }
  const queue = services.queue();
  const claimed = claimedIssueNumbers(queue.pullRequests);
  const candidates = [];
  for (const issue of queue.issues) {
    const eligibility = evaluateIssueEligibility(issue, {closedIssues: queue.closedIssues, claimedIssues: claimed});
    const freshness = evaluateSpecificationFreshness(issue, services.timeline(issue.number));
    if (eligibility.eligible && freshness.fresh) candidates.push(issue);
  }
  if (!candidates.length) {
    const result = {status: "no-op", issue: null};
    services.recordStatus?.({...result, run_id: runId});
    return result;
  }
  const issue = candidates.sort((a, b) => Number(a.number) - Number(b.number))[0];
  const baseSha = services.baseSha();
  if (mode !== "execute") {
    const result = {status: "eligible", issue: issue.number, base_sha: baseSha};
    services.recordStatus?.({...result, run_id: runId});
    return result;
  }

  if (!services.acquireExecutionClaimLock?.()) return {status: "blocked", issue: null, reason: "another execution surface is claiming work"};
  try {
    if ((services.executionLeases?.() ?? []).length) return {status: "blocked", issue: null, reason: "another Cloud or Nightly execution lease is active"};
    const issueDuringClaim = services.issue(issue.number);
    const freshnessDuringClaim = evaluateSpecificationFreshness(issueDuringClaim, services.timeline(issue.number));
    if (!freshnessDuringClaim.fresh || issueSpecificationFingerprint(issueDuringClaim) !== issueSpecificationFingerprint(issue)) {
      return {status: "blocked", issue: issue.number, reason: "Issue requires retriage before Cloud submission"};
    }
    state = services.saveState({
      schema_version: 1,
      run_id: runId,
      issue: issue.number,
      base_sha: baseSha,
      task_id: null,
      branch: `codex/cloud-${issue.number}-${runId.replace(/[^0-9A-Za-z]/g, "").slice(0, 20)}`,
      specification_fingerprint: issueSpecificationFingerprint(issue),
      claimed_at: now.toISOString(),
      status: "claiming",
      reason: null,
    });
    if (!services.claim(issue.number)) {
      return services.completeState({...state, status: "failed", reason: "unable to acquire cloud-running lease"});
    }
    const claimedIssue = services.issue(issue.number);
    const postClaimEvaluation = evaluateIssueEligibility(claimedIssue, {
      closedIssues: services.closedIssues(),
      claimedIssues: claimedIssueNumbers(services.openPullRequests()),
      ownedLease: "cloud-running",
    });
    const postClaimFreshness = evaluateSpecificationFreshness(claimedIssue, services.timeline(issue.number));
    if (!postClaimEvaluation.eligible || !postClaimFreshness.fresh) {
      return terminalFailure(services, state, `Issue became ineligible while claiming: ${[...postClaimEvaluation.reasons, ...postClaimFreshness.reasons].join(", ")}`);
    }
    if (issueSpecificationFingerprint(claimedIssue) !== state.specification_fingerprint) {
      return terminalFailure(services, state, "Issue specification changed while claiming");
    }
    if (services.baseSha() !== state.base_sha) {
      return terminalFailure(services, state, "origin/main changed while claiming");
    }
    const competingLeases = (services.executionLeases?.() ?? []).filter((leasedIssue) => Number(leasedIssue.number) !== Number(issue.number));
    if (competingLeases.length) return terminalFailure(services, state, "a competing execution lease appeared while claiming");
  } finally {
    services.releaseExecutionClaimLock?.();
  }

  state = services.saveState({...state, status: "submitting"});
  const submitted = services.submit({environmentId, prompt: buildCloudPrompt({issue, baseSha, runId})});
  if (!submitted.ok || !submitted.taskId) {
    return services.saveState({...state, status: "submission-uncertain", reason: "Cloud submission did not return a confirmed task ID; lease retained for recovery"});
  }
  return services.saveState({...state, task_id: submitted.taskId, status: "submitted", reason: null});
}

export async function runDaytimeDispatcher(options = {}) {
  const services = options.services ?? createProductionServices();
  if (services.acquireLock && !services.acquireLock()) return {status: "blocked", issue: null, reason: "another daytime Cloud dispatcher is active"};
  try {
    return await runDaytimeDispatcherUnlocked({...options, services});
  } finally {
    services.releaseLock?.();
  }
}

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=", 2);
    return [key, value];
  }));
  const mode = args.get("mode") ?? "dry-run";
  if (!new Set(["dry-run", "execute"]).has(mode)) throw new Error(`unsupported mode: ${mode}`);
  const now = mode === "dry-run" && args.has("now") ? new Date(args.get("now")) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid dry-run time");
  const result = await runDaytimeDispatcher({mode, now});
  console.log(JSON.stringify(redactedCloudStatus({updated_at: new Date().toISOString(), ...result}), null, 2));
  process.exit(["blocked", "failed"].includes(result.status) ? 2 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(3);
  });
}
