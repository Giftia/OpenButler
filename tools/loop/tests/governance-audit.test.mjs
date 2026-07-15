import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditRepository } from "../governance-audit.mjs";

function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function fixture({ activeGoals = ["OB-GOAL-027"], taskGoal = "OB-GOAL-027", evidence = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "openbutler-loop-test-"));
  for (const file of [
    "AGENTS.md", "LOOP.md", "STATE.md", "loop-budget.md", "loop-constraints.md", "loop-run-log.md",
    ".codex/skills/loop-triage/SKILL.md", ".codex/agents/verifier.toml",
    ".github/workflows/ci.yml", ".github/workflows/loop-audit.yml"
  ]) write(root, file, `${file}\n`);

  write(root, ".openbutler/goals.yaml", [
    "active_objectives:",
    ...activeGoals.flatMap((id) => [`  - id: ${id}`, "    title: Test", "    status: active"]),
    "planned_objectives:",
    ...["028", "029", "030", "031", "032", "033"].flatMap((suffix) => [`  - id: OB-GOAL-${suffix}`, "    title: Planned"])
  ].join("\n"));
  write(root, ".openbutler/task_queue.yaml", [
    "tasks:",
    "  - id: OB-TASK-TEST",
    `    goal_id: ${taskGoal}`,
    "    status: done",
    ...(evidence.length ? ["    evidence:", ...evidence.map((item) => `      - ${JSON.stringify(item)}`)] : [])
  ].join("\n"));
  write(root, "current_state.md", `Current objective: ${activeGoals[0] ?? "none"}\n`);

  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loop@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
  execFileSync("git", ["fetch", "origin", "main"], { cwd: root, stdio: "ignore" });
  return root;
}

test("clean fixture returns clean without GitHub access", () => {
  const root = fixture();
  const report = auditRepository({ root, github: false, requireGithub: false, writeReports: false });
  assert.equal(report.outcome, "clean");
  assert.equal(report.summary.product_mutations, 0);
  assert.equal(report.summary.github_mutations, 0);
});

test("multiple active goals trigger a partial circuit breaker", () => {
  const root = fixture({ activeGoals: ["OB-GOAL-027", "OB-GOAL-028"] });
  const report = auditRepository({ root, github: false, requireGithub: false, writeReports: false });
  assert.equal(report.outcome, "partial");
  assert.ok(report.partial_evidence.some((item) => item.code === "active_goal_count" && item.circuit_breaker));
});

test("task referencing an undeclared goal is drift", () => {
  const root = fixture({ taskGoal: "OB-GOAL-999" });
  const report = auditRepository({ root, github: false, requireGithub: false, writeReports: false });
  assert.equal(report.outcome, "drift");
  assert.ok(report.findings.some((item) => item.code === "task_goal_missing"));
});

test("evidence prose containing slashes is not treated as a file path", () => {
  const root = fixture({
    evidence: [
      "@cobusgreyling/loop-init@1.4.0 Codex daily-triage scaffold",
      "tools/loop/package-lock.json pins scoped loop CLIs",
      "upstream loop-audit score 100/100"
    ]
  });
  const report = auditRepository({ root, github: false, requireGithub: false, writeReports: false });
  assert.equal(report.outcome, "clean");
});
