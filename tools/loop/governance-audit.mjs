import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const REQUIRED_FILES = [
  "AGENTS.md",
  "LOOP.md",
  "STATE.md",
  "loop-budget.md",
  "loop-constraints.md",
  "loop-run-log.md",
  ".openbutler/goals.yaml",
  ".openbutler/task_queue.yaml",
  ".codex/skills/loop-triage/SKILL.md",
  ".codex/agents/verifier.toml",
  ".github/workflows/ci.yml",
  ".github/workflows/loop-audit.yml"
];
const REQUIRED_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix"
];
const ROADMAP_GOALS = [
  "OB-GOAL-028",
  "OB-GOAL-029",
  "OB-GOAL-030",
  "OB-GOAL-031",
  "OB-GOAL-032",
  "OB-GOAL-033"
];

function safeRun(command, args, cwd, options = {}) {
  try {
    return {
      ok: true,
      value: execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeout ?? 20_000,
        env: { ...process.env, NO_COLOR: "1" }
      }).trim()
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    return {
      ok: false,
      code: Number.isInteger(error?.status) ? error.status : null,
      error: stderr ? stderr.split(/\r?\n/, 1)[0] : "command unavailable"
    };
  }
}

function readYaml(root, relativePath, partial) {
  const fullPath = path.join(root, relativePath);
  try {
    return YAML.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    partial.push({
      code: "invalid_yaml",
      area: relativePath,
      message: `${relativePath} cannot be parsed: ${error.message}`,
      circuit_breaker: true
    });
    return null;
  }
}

function allGoalIds(goals) {
  const sections = ["active_objectives", "planned_objectives", "paused_objectives", "archived_objectives"];
  return new Set(sections.flatMap((section) => Array.isArray(goals?.[section]) ? goals[section] : []).map((item) => item?.id).filter(Boolean));
}

function looksLikeEvidencePath(value) {
  return typeof value === "string"
    && /[\\/]/.test(value)
    && !/^https?:\/\//i.test(value)
    && !/\b(commit|remote|branch|points to)\b/i.test(value);
}

function checkLocalRepository(root, findings, partial) {
  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(path.join(root, relativePath))) {
      findings.push({ code: "missing_required_file", area: relativePath, message: `Missing ${relativePath}` });
    }
  }

  const goals = readYaml(root, ".openbutler/goals.yaml", partial);
  const queue = readYaml(root, ".openbutler/task_queue.yaml", partial);
  if (!goals || !queue) return { activeGoalId: null, taskCount: 0 };

  const active = Array.isArray(goals.active_objectives) ? goals.active_objectives : [];
  if (active.length !== 1) {
    partial.push({
      code: "active_goal_count",
      area: ".openbutler/goals.yaml",
      message: `Expected exactly one active objective, found ${active.length}`,
      circuit_breaker: true
    });
  }
  const activeGoalId = active[0]?.id ?? null;
  const goalIds = allGoalIds(goals);
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];

  for (const task of tasks) {
    if (!goalIds.has(task?.goal_id)) {
      findings.push({
        code: "task_goal_missing",
        area: task?.id ?? "unknown-task",
        message: `${task?.id ?? "Task"} references undeclared goal ${task?.goal_id ?? "unknown"}`
      });
    }
    for (const blocker of Array.isArray(task?.blocked_by) ? task.blocked_by : []) {
      if (!tasks.some((candidate) => candidate?.id === blocker)) {
        findings.push({
          code: "task_blocker_missing",
          area: task?.id ?? "unknown-task",
          message: `${task?.id ?? "Task"} references missing blocker ${blocker}`
        });
      }
    }
    if (task?.status === "done") {
      for (const evidence of Array.isArray(task?.evidence) ? task.evidence : []) {
        if (looksLikeEvidencePath(evidence) && !existsSync(path.join(root, evidence))) {
          findings.push({
            code: "evidence_path_missing",
            area: task?.id ?? "unknown-task",
            message: `Claimed evidence path is missing: ${evidence}`
          });
        }
      }
    }
  }

  const stateText = existsSync(path.join(root, "current_state.md"))
    ? readFileSync(path.join(root, "current_state.md"), "utf8")
    : "";
  if (activeGoalId && !stateText.includes(activeGoalId)) {
    findings.push({
      code: "current_state_goal_drift",
      area: "current_state.md",
      message: `current_state.md does not name active objective ${activeGoalId}`
    });
  }

  const branch = safeRun("git", ["branch", "--show-current"], root);
  const remoteRefs = ["OpenButler/main", "origin/main"];
  const canonicalRef = remoteRefs.find((ref) => safeRun("git", ["rev-parse", "--verify", ref], root).ok);
  if (!branch.ok || !canonicalRef) {
    partial.push({ code: "git_evidence_unavailable", area: "git", message: "Current branch or canonical main ref is unavailable" });
  } else {
    const ancestry = safeRun("git", ["merge-base", "--is-ancestor", canonicalRef, "HEAD"], root);
    if (!ancestry.ok) {
      partial.push({
        code: "canonical_history_unrelated",
        area: "git",
        message: `Current branch ${branch.value} is not descended from ${canonicalRef}`,
        circuit_breaker: true
      });
    }
  }

  return { activeGoalId, taskCount: tasks.length };
}

function checkGitHub(root, findings, partial) {
  let calls = 0;
  const gh = (args) => {
    calls += 1;
    if (calls > 20) return { ok: false, code: null, error: "GitHub read budget exceeded" };
    return safeRun("gh", args, root, { timeout: 30_000 });
  };

  const repository = gh(["repo", "view", "Giftia/OpenButler", "--json", "visibility,defaultBranchRef,nameWithOwner"]);
  if (!repository.ok) {
    partial.push({ code: "github_repository_unavailable", area: "github", message: repository.error });
    return { calls };
  }
  const repositoryData = JSON.parse(repository.value);
  if (repositoryData.visibility !== "PUBLIC" || repositoryData.defaultBranchRef?.name !== "main") {
    findings.push({ code: "github_canonical_drift", area: "github", message: "Repository must be public with main as default branch" });
  }

  const labels = gh(["label", "list", "--repo", "Giftia/OpenButler", "--limit", "100", "--json", "name"]);
  if (!labels.ok) {
    partial.push({ code: "github_labels_unavailable", area: "github", message: labels.error });
  } else {
    const names = new Set(JSON.parse(labels.value).map((item) => item.name));
    for (const required of REQUIRED_LABELS) {
      if (!names.has(required)) findings.push({ code: "github_label_missing", area: "github", message: `Missing label ${required}` });
    }
  }

  const issues = gh(["issue", "list", "--repo", "Giftia/OpenButler", "--state", "open", "--limit", "100", "--json", "number,title,labels"]);
  if (!issues.ok) {
    partial.push({ code: "github_issues_unavailable", area: "github", message: issues.error });
  } else {
    const titles = JSON.parse(issues.value).map((item) => item.title);
    for (const goal of ROADMAP_GOALS) {
      if (!titles.some((title) => title.includes(goal))) findings.push({ code: "roadmap_issue_missing", area: "github", message: `No open issue found for ${goal}` });
    }
  }

  const workflows = gh(["workflow", "list", "--repo", "Giftia/OpenButler", "--json", "name,path,state"]);
  if (!workflows.ok) {
    partial.push({ code: "github_workflows_unavailable", area: "github", message: workflows.error });
  } else {
    const paths = new Set(JSON.parse(workflows.value).map((item) => item.path));
    for (const required of [".github/workflows/ci.yml", ".github/workflows/loop-audit.yml"]) {
      if (!paths.has(required)) findings.push({ code: "github_workflow_missing", area: "github", message: `Workflow not active on main: ${required}` });
    }
  }

  const protection = gh(["api", "repos/Giftia/OpenButler/branches/main/protection"]);
  if (!protection.ok) {
    if (protection.code === 1 && /404|Branch not protected/i.test(protection.error)) {
      findings.push({ code: "main_not_protected", area: "github", message: "main branch protection is not configured" });
    } else {
      partial.push({ code: "branch_protection_unavailable", area: "github", message: protection.error });
    }
  }

  return { calls };
}

function renderMarkdown(report) {
  const lines = [
    "# OpenButler L1 Governance Audit",
    "",
    `- Run: ${report.run_id}`,
    `- Outcome: **${report.outcome}**`,
    `- Active goal: ${report.summary.active_goal ?? "unknown"}`,
    `- Findings: ${report.findings.length}`,
    `- Partial evidence: ${report.partial_evidence.length}`,
    `- GitHub reads: ${report.summary.github_read_calls}`,
    "",
    "## Findings",
    ""
  ];
  lines.push(...(report.findings.length ? report.findings.map((item) => `- [${item.code}] ${item.message}`) : ["- None."]));
  lines.push("", "## Partial Evidence", "");
  lines.push(...(report.partial_evidence.length ? report.partial_evidence.map((item) => `- [${item.code}] ${item.message}`) : ["- None."]));
  lines.push(
    "",
    "## Safety",
    "",
    "- Product files mutated: no",
    "- GitHub mutated: no",
    "- MineContext data read: no",
    "- Screenshots copied: no",
    "- External model or webhook called: no",
    ""
  );
  return lines.join("\n");
}

export function auditRepository(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const findings = [];
  const partial = [];
  const local = checkLocalRepository(root, findings, partial);
  const github = options.github ? checkGitHub(root, findings, partial) : { calls: 0 };
  if (options.requireGithub && !options.github) {
    partial.push({ code: "github_check_skipped", area: "github", message: "GitHub evidence was required but not requested" });
  }

  const outcome = partial.length ? "partial" : findings.length ? "drift" : "clean";
  const report = {
    schema_version: "openbutler_loop_governance_audit_v1",
    run_id: options.runId ?? new Date().toISOString().replace(/[:.]/g, "-"),
    outcome,
    findings,
    partial_evidence: partial,
    summary: {
      active_goal: local.activeGoalId,
      task_count: local.taskCount,
      github_read_calls: github.calls,
      product_mutations: 0,
      github_mutations: 0,
      minecontext_reads: 0,
      copied_screenshots: 0,
      external_model_calls: 0,
      external_webhook_calls: 0
    }
  };

  if (options.writeReports !== false) {
    const outputRoot = path.resolve(options.outputRoot ?? path.join(root, "data", "loop-runs"));
    const runDirectory = path.join(outputRoot, report.run_id);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(path.join(runDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(path.join(runDirectory, "report.md"), `${renderMarkdown(report)}\n`, "utf8");
    report.report_directory = runDirectory;
  }
  return report;
}

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, github: false, requireGithub: false, writeReports: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--github") {
      options.github = true;
      options.requireGithub = true;
    } else if (value === "--no-write") {
      options.writeReports = false;
    } else if (value === "--root") {
      options.root = argv[index + 1];
      index += 1;
    } else if (value === "--output") {
      options.outputRoot = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = auditRepository(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({
    outcome: report.outcome,
    findings: report.findings.length,
    partial_evidence: report.partial_evidence.length,
    report_directory: report.report_directory ?? null,
    safety: report.summary
  }, null, 2));
  process.exitCode = report.outcome === "clean" ? 0 : report.outcome === "drift" ? 2 : 3;
}

