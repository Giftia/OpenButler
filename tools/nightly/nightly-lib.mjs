import {readFileSync} from "node:fs";

export const NIGHTLY_TOKEN_CAP = 750_000;
export const NIGHTLY_START_THRESHOLD = 600_000;
export const ISSUE_TOKEN_CAP = 160_000;
export const CUTOFF_HOUR = 6;
export const CUTOFF_MINUTE = 15;

const highRiskTerms = [
  "privacy", "consent", "authorization", "authentication", "origin", "sensor",
  "minecontext", "electron", "installer", "tray", "lifecycle", "schema", "migration",
  "retention", "webhook", "external write", "摄像头", "麦克风", "隐私", "授权",
  "鉴权", "安装", "托盘", "传感器", "数据迁移"
];

const forbiddenAcceptanceKeys = new Set([
  "apiKey", "embeddingApiKey", "raw", "raw_output", "raw_ref", "screenshot_paths",
  "local_path", "database_path", "activity_title", "window_title", "url"
]);

export function parseCurrentLevel(markdown) {
  const match = markdown.match(/Current level:\s*(L\d)\s+active/i);
  return match?.[1]?.toUpperCase() ?? "UNKNOWN";
}

export function classifyHighRisk(issue) {
  const labels = (issue.labels ?? []).map((label) => String(label.name ?? label).toLowerCase());
  const haystack = `${issue.title ?? ""}\n${issue.body ?? ""}\n${labels.join(" ")}`.toLowerCase();
  return highRiskTerms.some((term) => haystack.includes(term));
}

export function parseDependencies(body = "") {
  const dependencies = new Set();
  for (const line of String(body).split(/\r?\n/)) {
    if (!/(blocked[_ -]?by|depends? on|依赖|阻塞于)/i.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) dependencies.add(Number(match[1]));
  }
  return [...dependencies];
}

export function latestNightlyApproval(timeline = []) {
  return timeline
    .filter((event) => event.event === "labeled" && event.label?.name === "nightly-approved")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

export function latestSpecificationChange(issue, timeline = []) {
  const candidates = [
    issue.createdAt ?? issue.created_at ?? 0,
    issue.lastEditedAt ?? issue.last_edited_at ?? 0,
  ];
  for (const event of timeline) {
    if (event.event === "renamed") candidates.push(event.created_at ?? 0);
  }
  return new Date(Math.max(...candidates.map((value) => Date.parse(value) || 0))).toISOString();
}

export function claimedIssueNumbers(pullRequests = []) {
  const claimed = new Set();
  for (const pullRequest of pullRequests) {
    const text = `${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}`;
    for (const match of text.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi)) {
      claimed.add(Number(match[1]));
    }
    for (const match of String(pullRequest.title ?? "").matchAll(/\(#(\d+)\)/g)) {
      claimed.add(Number(match[1]));
    }
  }
  return claimed;
}

export function evaluateIssueEligibility(issue, {timeline = [], closedIssues = new Set(), claimedIssues = new Set()} = {}) {
  const labels = new Set((issue.labels ?? []).map((label) => label.name ?? label));
  const reasons = [];
  if (!labels.has("ready-for-agent")) reasons.push("missing ready-for-agent");
  if (!labels.has("nightly-approved")) reasons.push("missing nightly-approved");
  if (claimedIssues.has(Number(issue.number))) reasons.push("open implementation pull request already claims issue");

  const dependencies = parseDependencies(issue.body);
  const unresolved = dependencies.filter((number) => !closedIssues.has(number));
  if (unresolved.length) reasons.push(`unresolved dependencies: ${unresolved.map((item) => `#${item}`).join(", ")}`);

  const highRisk = classifyHighRisk(issue);
  const approval = latestNightlyApproval(timeline);
  if (highRisk) {
    if (issue.specificationAuditAvailable !== true) {
      reasons.push("high-risk specification edit timestamp unavailable");
    } else if (!approval) {
      reasons.push("high-risk approval event unavailable");
    } else {
      if (String(approval.actor?.login ?? "").toLowerCase() !== "giftia") {
        reasons.push("high-risk approval was not applied by Giftia");
      }
      if (Date.parse(approval.created_at) <= Date.parse(latestSpecificationChange(issue, timeline))) {
        reasons.push("high-risk approval predates latest issue update");
      }
    }
  }

  return {eligible: reasons.length === 0, reasons, highRisk, dependencies};
}

export function beforeNightlyCutoff(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 19 * 60 || minutes < CUTOFF_HOUR * 60 + CUTOFF_MINUTE;
}

export function mayStartIssue(tokensUsed, now = new Date()) {
  return tokensUsed < NIGHTLY_START_THRESHOLD && beforeNightlyCutoff(now);
}

export function evaluateCanonicalCheckout({branch, head, originMain}) {
  const reasons = [];
  if (String(branch).trim() !== "main") reasons.push("branch is not main");
  if (!head || !originMain || String(head).trim() !== String(originMain).trim()) reasons.push("HEAD does not match origin/main");
  return {eligible: reasons.length === 0, reasons};
}

export function tokenUsageFromJsonl(text) {
  let total = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const usage = event.usage ?? event.item?.usage ?? event.data?.usage;
      if (!usage || typeof usage !== "object") continue;
      total += Number(usage.input_tokens ?? usage.inputTokens ?? 0);
      total += Number(usage.output_tokens ?? usage.outputTokens ?? 0);
      total += Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0);
    } catch {
      // Non-JSON diagnostic lines do not contribute to the budget.
    }
  }
  return total;
}

function sanitizeString(value) {
  return String(value)
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s"']+/g, "<redacted-local-path>")
    .replace(/https?:\/\/(?!github\.com\/Giftia\/OpenButler)[^\s)]+/gi, "<redacted-url>")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
}

export function sanitizeAcceptanceValue(value, key = "") {
  if (forbiddenAcceptanceKeys.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAcceptanceValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeAcceptanceValue(childValue, childKey);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  return typeof value === "string" ? sanitizeString(value) : value;
}

export function buildApprovalCommand(pack, feedback = {}) {
  const passed = (pack.pull_requests ?? [])
    .filter((pr) => feedback[String(pr.number)]?.status === "passed")
    .map((pr) => `#${pr.number}`);
  if (!passed.length) return "尚无可批准的 PR";
  return `批准合并 PR ${passed.join(" ")}`;
}

export function isFreshAcceptancePack(pack, state, now = new Date(), maxAgeHours = 16) {
  if (!pack || !state || state.run_id !== pack.run_id || state.outcome !== "completed") return false;
  const generatedAt = Date.parse(pack.generated_at ?? "");
  if (!Number.isFinite(generatedAt)) return false;
  const ageHours = (now.getTime() - generatedAt) / 3_600_000;
  return ageHours >= 0 && ageHours <= maxAgeHours;
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
