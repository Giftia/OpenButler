const apiBaseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(path, init) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {"Content-Type": "application/json", ...(init?.headers ?? {})},
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function hasActiveL2Objective(audit) {
  return audit.objectives?.some((objective) => objective.id === "OB-GOAL-004" && objective.objective_status === "needs_attention") === true;
}

function hasOnlyExpectedOpenObjectiveGaps(audit) {
  const open = audit.objectives?.filter((objective) => objective.objective_status !== "proven") ?? [];
  return open.length > 0 && open.every((objective) => ["OB-GOAL-001", "OB-GOAL-004"].includes(objective.id));
}

function isAcceptableAuditStatus(audit) {
  return audit.status === "proven"
    || (audit.status === "needs_attention" && (hasActiveL2Objective(audit) || hasOnlyExpectedOpenObjectiveGaps(audit)));
}

try {
  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.status === "completed", "Demo run did not complete before L1 audit.");
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");

  const audit = await requestJson("/api/butler/productization/l1-audit");
  assertCondition(audit.schema_version === "l1_active_objectives_audit_v1", "Unexpected L1 audit schema.");
  assertCondition(isAcceptableAuditStatus(audit), `L1 audit has unexpected active-objective status: ${audit.status}`);
  assertCondition(audit.source?.goals_path === ".openbutler/goals.yaml", "L1 audit must reference goals.yaml.");
  assertCondition(audit.source?.objective_status_api === "GET /api/butler/productization/objectives/status", "L1 audit must reference objective status API.");
  assertCondition(audit.summary?.objective_count >= 3, "L1 audit must include active objectives.");
  assertCondition(audit.summary?.success_criteria_count >= 13, "L1 audit must include declared success criteria.");
  assertCondition(audit.summary?.missing_evidence === 0, "Current active objectives must not have missing evidence.");
  assertCondition(audit.summary?.out_of_scope === 0, "Current active objectives must not include out-of-scope success criteria.");
  assertCondition(audit.allowed_results?.includes("proven"), "L1 audit must distinguish proven.");
  assertCondition(audit.allowed_results?.includes("needs_attention"), "L1 audit must distinguish needs_attention.");
  assertCondition(audit.allowed_results?.includes("missing_evidence"), "L1 audit must distinguish missing_evidence.");
  assertCondition(audit.allowed_results?.includes("out_of_scope"), "L1 audit must distinguish out_of_scope.");
  assertCondition(
    audit.objectives.every((objective) => objective.objective_status === "proven" || ["OB-GOAL-001", "OB-GOAL-004"].includes(objective.id)),
    "Only the active L2 objective or documented data-insufficient objective may remain needs_attention.",
  );
  assertCondition(audit.objectives.every((objective) => objective.success_criteria.every((item) => item.evidence_refs?.length)), "Every success criterion must include evidence refs.");
  assertCondition(audit.objectives.every((objective) => objective.success_criteria.every((item) => item.evidence_boundary)), "Every success criterion must include evidence boundary.");
  assertCondition(audit.privacy?.external_model_used === false, "L1 audit must not use external models.");
  assertCondition(audit.privacy?.external_model_allowed === false, "L1 audit must not allow external models.");
  assertCondition(audit.privacy?.system_notification_enabled === false, "L1 audit must not enable system notifications.");
  assertCondition(audit.privacy?.minecontext_source_deleted === 0, "L1 audit must preserve MineContext source data.");
  assertCondition(audit.privacy?.copied_screenshots === 0, "L1 audit must not copy screenshots.");
  assertCondition(audit.privacy?.strict_mode_respected === true, "L1 audit must respect strict mode.");
  assertCondition(Boolean(audit.evidence_boundary), "L1 audit must include evidence boundary.");
  assertCondition(
    audit.evidence_boundary.includes("MineContext")
      && audit.evidence_boundary.includes("inspect")
      && audit.evidence_boundary.includes("mutate"),
    "L1 audit must state MineContext source boundary.",
  );

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.status === "reset", "Demo reset did not complete after L1 audit smoke.");
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Demo reset must preserve PC Activity events.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Demo reset must not delete MineContext source data.");

  console.log(JSON.stringify({
    checked: "butler-l1-audit",
    ok: true,
    apiBaseUrl,
    status: audit.status,
    objective_count: audit.summary.objective_count,
    success_criteria_count: audit.summary.success_criteria_count,
    result_counts: {
      proven: audit.summary.proven,
      needs_attention: audit.summary.needs_attention,
      missing_evidence: audit.summary.missing_evidence,
      out_of_scope: audit.summary.out_of_scope,
    },
    privacy: {
      external_model_used: audit.privacy.external_model_used,
      external_model_allowed: audit.privacy.external_model_allowed,
      system_notification_enabled: audit.privacy.system_notification_enabled,
      minecontext_source_deleted: audit.privacy.minecontext_source_deleted,
      copied_screenshots: audit.privacy.copied_screenshots,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-l1-audit",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
