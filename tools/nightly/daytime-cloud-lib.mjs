import {createHash} from "node:crypto";

export const DAYTIME_START_MINUTES = 8 * 60 + 30;
export const DAYTIME_END_MINUTES = 19 * 60 + 30;
export const CLOUD_DIFF_BYTE_CAP = 256 * 1024;
export const CLOUD_FILE_CAP = 5;

const forbiddenPathPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:data|runtime|storage|uploads|media|screenshots|logs)(?:\/|$)/i,
  /^(?:minecontext|minecontext_data|minecontext_exports)(?:\/|$)/i,
  /(^|\/)(?:secrets?|credentials?|cookies?)(?:\/|$)/i,
  /\.(?:db|sqlite3?|pem|key|p12|pfx|crt|log)$/i,
];

const forbiddenDiffPatterns = [
  /OPENBUTLER_CODEX_CLOUD_ENV_ID\s*[:=]\s*\S+/i,
  /(?:api[_ -]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /[A-Za-z]:\\Users\\[^\\\s]+\\/,
  /(?:MineContext|screenshot|window_title|activity_title).*?(?:raw|path|content)/i,
];

export function withinDaytimeWindow(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= DAYTIME_START_MINUTES && minutes < DAYTIME_END_MINUTES;
}

function normalizedLabels(issue) {
  return (issue.labels ?? []).map((label) => label.name ?? label).map(String).sort();
}

export function issueSpecificationFingerprint(issue) {
  const contract = {
    number: Number(issue.number),
    title: String(issue.title ?? "").trim(),
    body: String(issue.body ?? "").replace(/\r\n/g, "\n").trim(),
    labels: normalizedLabels(issue).filter((label) => !["cloud-running", "nightly-running"].includes(label)),
  };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export function issueContentFingerprint(issue) {
  return createHash("sha256").update(JSON.stringify({
    number: Number(issue.number),
    title: String(issue.title ?? "").trim(),
    body: String(issue.body ?? "").replace(/\r\n/g, "\n").trim(),
  })).digest("hex");
}

export function evaluateSpecificationFreshness(issue, timeline = []) {
  const readyEvents = timeline.filter((event) => event.event === "labeled" && event.label?.name === "ready-for-agent");
  const latestReadyAt = Math.max(...readyEvents.map((event) => Date.parse(event.created_at) || 0), 0);
  const labels = new Set(normalizedLabels(issue));
  const hasExecutionLease = labels.has("cloud-running") || labels.has("nightly-running");
  // GitHub also changes updatedAt for workflow-label churn, so specification
  // freshness comes from the timeline. During an active lease, an unexplained
  // updatedAt is still treated as a possible edit and fails closed below.
  const specificationTimes = [issue.createdAt, issue.created_at]
    .map((value) => Date.parse(value) || 0);
  for (const event of timeline) {
    if (event.event === "renamed") specificationTimes.push(Date.parse(event.created_at) || 0);
  }
  const latestSpecificationAt = Math.max(...specificationTimes, 0);
  const reasons = [];
  if (!latestReadyAt) reasons.push("ready-for-agent approval event is unavailable");
  // GitHub updates the Issue timestamp when the ready label itself is applied.
  // Allow only a small clock-resolution margin; later comments or edits require re-triage.
  if (latestReadyAt && latestSpecificationAt > latestReadyAt) reasons.push("specification changed after ready-for-agent approval");
  const allowedExecutionEvents = new Set(["cloud-running", "nightly-running"]);
  let latestExplainedUpdateAt = latestReadyAt;
  const postApprovalChanges = timeline.filter((event) => {
    const at = Math.max(Date.parse(event.created_at) || 0, Date.parse(event.updated_at) || 0);
    if (!latestReadyAt || at <= latestReadyAt) return false;
    if (event.event === "commented" && String(event.body ?? "").startsWith("[OpenButler automation marker]")) {
      latestExplainedUpdateAt = Math.max(latestExplainedUpdateAt, at);
      return false;
    }
    if (["labeled", "unlabeled"].includes(event.event) && allowedExecutionEvents.has(event.label?.name)) {
      latestExplainedUpdateAt = Math.max(latestExplainedUpdateAt, at);
      return false;
    }
    if (["subscribed", "unsubscribed", "cross-referenced", "connected", "referenced", "mentioned"].includes(event.event)) {
      latestExplainedUpdateAt = Math.max(latestExplainedUpdateAt, at);
      return false;
    }
    return true;
  });
  if (postApprovalChanges.length) reasons.push("Issue activity changed after ready-for-agent approval");
  const issueUpdatedAt = Math.max(Date.parse(issue.updatedAt) || 0, Date.parse(issue.updated_at) || 0);
  if (issueUpdatedAt > latestExplainedUpdateAt) reasons.push("Issue updatedAt is not explained by an approved workflow event");
  return {fresh: reasons.length === 0, reasons, latestReadyAt, latestSpecificationAt};
}

export function trustedCloudTaskMarker({comments = [], timeline = [], actor}) {
  if (!actor) return null;
  const leaseAt = Math.max(...timeline
    .filter((event) => event.event === "labeled" && event.label?.name === "cloud-running")
    .map((event) => Date.parse(event.created_at) || 0), 0);
  if (!leaseAt) return null;
  return [...comments]
    .filter((comment) => {
      const createdAt = Date.parse(comment.createdAt ?? comment.created_at) || 0;
      const claimedAtText = String(comment.body ?? "").match(/Claimed at:\s*([^\s]+)/)?.[1] ?? "";
      const claimedAt = Date.parse(claimedAtText) || 0;
      // GitHub timestamps have second-level resolution. Same-second markers
      // are ambiguous across a remove/re-add lease epoch and must fail closed.
      return createdAt > leaseAt
        && claimedAt > 0
        && Math.abs(claimedAt - leaseAt) <= 5_000
        && comment.author?.login === actor
        && String(comment.body ?? "").startsWith("[OpenButler automation marker]");
    })
    .sort((left, right) => (
      (Date.parse(right.createdAt ?? right.created_at) || 0)
      - (Date.parse(left.createdAt ?? left.created_at) || 0)
    ))[0] ?? null;
}

export function approvalTimelineIsCurrent(timeline = [], approvedAtValue) {
  const approvedAt = Date.parse(approvedAtValue);
  if (!Number.isFinite(approvedAt)) return false;
  const workflowLabels = new Set(["nightly-running", "review-pending", "acceptance-ready", "auto-merge-eligible"]);
  const workflowEvents = new Set(["cross-referenced", "connected", "referenced", "mentioned", "subscribed", "unsubscribed"]);
  return !timeline.some((event) => {
    const at = Math.max(Date.parse(event.created_at) || 0, Date.parse(event.updated_at) || 0);
    if (at <= approvedAt) return false;
    if (event.event === "labeled" && event.label?.name === "ready-for-agent") return true;
    if (event.event === "unlabeled" && event.label?.name === "ready-for-agent") return false;
    if (event.event === "commented" && String(event.body ?? "").startsWith("[OpenButler automation marker]")) return false;
    if (["labeled", "unlabeled"].includes(event.event) && workflowLabels.has(event.label?.name)) return false;
    return !workflowEvents.has(event.event);
  });
}

export function parseCloudTaskId(output) {
  const text = String(output ?? "");
  return text.match(/\btask_[A-Za-z0-9_-]+\b/)?.[0]
    ?? text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0]
    ?? null;
}

export function parseCloudTaskStatus(output) {
  const value = String(output ?? "").toLowerCase();
  if (/\bcancel(?:led|ed|ing)?\b/.test(value)) return "cancelled";
  if (/\b(?:failed|failure|error)\b/.test(value)) return "failed";
  if (/\b(?:ready|completed|complete|succeeded|success)\b/.test(value)) return "ready";
  if (/\b(?:pending|queued|running|in[_ -]?progress|processing)\b/.test(value)) return "pending";
  return "unknown";
}

export function pathsFromUnifiedDiff(diff) {
  const paths = new Set();
  for (const match of String(diff ?? "").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    paths.add(match[1]);
    paths.add(match[2]);
  }
  return [...paths].sort();
}

export function evaluateCloudDiff(diff) {
  const paths = pathsFromUnifiedDiff(diff);
  const reasons = [];
  if (!String(diff ?? "").trim()) reasons.push("Cloud result has no diff");
  if (Buffer.byteLength(String(diff ?? ""), "utf8") > CLOUD_DIFF_BYTE_CAP) reasons.push("Cloud result exceeds the verified diff byte cap");
  if (paths.length > CLOUD_FILE_CAP) reasons.push("Cloud result exceeds the verified file cap");
  if (!paths.length && String(diff ?? "").trim()) reasons.push("Cloud result is not a recognized unified diff");
  for (const path of paths) {
    if (forbiddenPathPatterns.some((pattern) => pattern.test(path))) reasons.push(`forbidden path: ${path}`);
  }
  if (forbiddenDiffPatterns.some((pattern) => pattern.test(String(diff ?? "")))) reasons.push("diff contains a privacy or secret boundary violation");
  return {accepted: reasons.length === 0, reasons, paths};
}

export function normalizeUnifiedDiff(diff) {
  return String(diff ?? "").replace(/\r\n/g, "\n").trimEnd();
}

export function buildCloudPrompt({issue, baseSha, runId}) {
  return [
    `[OpenButler daytime run ${runId}] Implement GitHub Issue #${issue.number}: ${issue.title}`,
    "",
    String(issue.body ?? "").trim(),
    "",
    `Base commit: ${baseSha}`,
    "Before editing, require git rev-parse HEAD to equal that base commit. If it differs, make no changes and report a stale checkout.",
    "Work only in the existing checkout. Produce one bounded diff for this Issue.",
    "Read AGENTS.md, LOOP.md, loop-constraints.md, and repository tests before editing.",
    "Do not push, merge, deploy, mutate GitHub, read personal data, screenshots, databases, credentials, or stable app data.",
    "Do not weaken tests, privacy constraints, branch protection, or governance.",
    "Keep combined uncached input and output below 160000 tokens. The dispatcher also enforces one attempt, a 14-hour wall-time lease, at most 5 changed files, and a 256 KiB verified diff.",
    "Run focused tests and report changed paths and test results. Never include environment identifiers or local paths.",
  ].join("\n");
}

export function redactedCloudStatus(state) {
  const safeReason = state.reason == null ? null : String(state.reason)
    .replace(/forbidden path:\s*[^;]+/gi, "forbidden path: <redacted>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s]+/g, "<redacted-local-path>");
  return {
    schema_version: 1,
    updated_at: state.updated_at,
    run_id: state.run_id ?? null,
    issue: state.issue ?? null,
    base_sha: state.base_sha ?? null,
    task_id: state.task_id ?? null,
    status: state.status,
    pr_number: state.pr_number ?? null,
    reason: safeReason,
  };
}
