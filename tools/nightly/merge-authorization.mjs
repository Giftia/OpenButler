import {spawnSync} from "node:child_process";

const repo = process.env.GITHUB_REPOSITORY || "Giftia/OpenButler";
const trustedApprover = "Giftia";
const requiredLabels = new Set(["ready-for-agent"]);
const blockingLabels = new Set(["automation-blocked", "nightly-failed"]);

function gh(args, {allowFailure = false} = {}) {
  const result = spawnSync("gh", args, {encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || `gh ${args.join(" ")} failed`);
  return result;
}

function ghJson(args) {
  return JSON.parse(gh(args).stdout || "null");
}

function linkedIssueNumbers(pullRequest) {
  const text = `${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}`;
  const numbers = new Set();
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) numbers.add(Number(match[1]));
  for (const match of text.matchAll(/\(#(\d+)\)/g)) numbers.add(Number(match[1]));
  return [...numbers];
}

function authorizationForIssue(number) {
  const issue = ghJson(["issue", "view", String(number), "--repo", repo, "--json", "state,labels"]);
  const labels = new Set((issue.labels ?? []).map((label) => label.name));
  if (issue.state !== "OPEN") return {authorized: false, reason: `Issue #${number} is not open`};
  for (const label of requiredLabels) if (!labels.has(label)) return {authorized: false, reason: `Issue #${number} is missing ${label}`};
  for (const label of blockingLabels) if (labels.has(label)) return {authorized: false, reason: `Issue #${number} has ${label}`};

  const timeline = ghJson(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate"]);
  const readyEvents = timeline.filter((event) => event.event === "labeled" && event.label?.name === "ready-for-agent");
  const latestReady = readyEvents.at(-1);
  if (!latestReady || latestReady.actor?.login !== trustedApprover) {
    return {authorized: false, reason: `Issue #${number} lacks a current approval from ${trustedApprover}`};
  }
  const latestReadyAt = Date.parse(latestReady.created_at) || 0;
  const workflowLabels = new Set(["cloud-running", "nightly-running", "review-pending", "acceptance-ready", "auto-merge-eligible"]);
  const harmlessEvents = new Set(["cross-referenced", "connected", "referenced", "mentioned", "subscribed", "unsubscribed"]);
  const changedAfterApproval = timeline.some((event) => {
    const at = Math.max(Date.parse(event.created_at) || 0, Date.parse(event.updated_at) || 0);
    if (at <= latestReadyAt) return false;
    if (["labeled", "unlabeled"].includes(event.event) && workflowLabels.has(event.label?.name)) return false;
    if (event.event === "commented" && String(event.body ?? "").startsWith("[OpenButler automation marker]")) return false;
    return !harmlessEvents.has(event.event);
  });
  if (changedAfterApproval) return {authorized: false, reason: `Issue #${number} changed after approval`};
  const latestEvent = timeline.at(-1);
  const latestEventId = latestEvent?.id
    ?? latestEvent?.source?.issue?.id
    ?? latestEvent?.commit_id
    ?? `${latestEvent?.event}:${latestEvent?.created_at}:${latestEvent?.updated_at ?? ""}`;
  const nonce = `${latestReady.id ?? latestReady.node_id}:${latestEventId}`;
  return {authorized: true, reason: `Issue #${number} authorization is current`, nonce};
}

function authorizationForPullRequest(number) {
  const pullRequest = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "title,body,headRefOid,state"]);
  if (pullRequest.state !== "OPEN") return {authorized: false, reason: `PR #${number} is not open`, pullRequest};
  const issues = linkedIssueNumbers(pullRequest);
  if (issues.length !== 1) return {authorized: false, reason: `PR #${number} must link exactly one Issue`, pullRequest};
  return {...authorizationForIssue(issues[0]), pullRequest, issueNumber: issues[0]};
}

function verifyPullRequest(number) {
  const result = authorizationForPullRequest(number);
  console.log(result.reason);
  if (!result.authorized) process.exitCode = 1;
}

function refreshIssue(number) {
  const pullRequests = ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,body,headRefOid"]);
  for (const pullRequest of pullRequests) {
    if (!linkedIssueNumbers(pullRequest).includes(Number(number))) continue;
    const result = authorizationForPullRequest(pullRequest.number);
    gh([
      "api", "--method", "POST", `repos/${repo}/statuses/${pullRequest.headRefOid}`,
      "-f", `state=${result.authorized ? "success" : "failure"}`,
      "-f", "context=Merge Authorization",
      "-f", `description=${result.authorized ? `issue=${number};nonce=${result.nonce}` : result.reason.slice(0, 140)}`,
    ]);
    console.log(`PR #${pullRequest.number}: ${result.reason}`);
  }
}

const [command] = process.argv.slice(2);
if (command === "verify-pr") verifyPullRequest(Number(process.env.OPENBUTLER_PR_NUMBER));
else if (command === "refresh-issue") refreshIssue(Number(process.env.OPENBUTLER_ISSUE_NUMBER));
else throw new Error(`Unknown command: ${command ?? "<missing>"}`);
