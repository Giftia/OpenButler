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

function hasActiveL2Objective(objectiveStatus) {
  return objectiveStatus?.objectives?.some((item) => item.id === "OB-GOAL-004" && item.status === "needs_attention") === true;
}

function hasOnlyExpectedOpenObjectiveGaps(objectiveStatus) {
  const objectives = objectiveStatus?.objectives ?? [];
  const open = objectives.filter((item) => item.status !== "proven");
  return open.length > 0 && open.every((item) => ["OB-GOAL-001", "OB-GOAL-004"].includes(item.id));
}

function isAcceptableObjectiveStatus(objectiveStatus) {
  return objectiveStatus?.status === "proven"
    || (objectiveStatus?.status === "needs_attention" && (hasActiveL2Objective(objectiveStatus) || hasOnlyExpectedOpenObjectiveGaps(objectiveStatus)));
}

function isAcceptableDemoPackStatus(pack) {
  return pack.status === "ready"
    || (["attention_needed", "data_insufficient"].includes(pack.status) && isAcceptableObjectiveStatus(pack.objective_status));
}

try {
  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.status === "completed", "Demo run did not complete before demo pack.");
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");

  const pack = await requestJson("/api/butler/productization/demo-pack");
  assertCondition(pack.schema_version === "productization_demo_pack_v1", "Unexpected productization demo pack schema.");
  assertCondition(isAcceptableDemoPackStatus(pack), `Productization demo pack has unexpected status: ${pack.status}`);
  assertCondition(["ready", "data_insufficient"].includes(pack.readiness?.status), `Demo pack readiness has unexpected status: ${pack.readiness?.status}`);
  assertCondition(["ready", "data_insufficient"].includes(pack.mvp_report?.status), `Demo pack MVP report has unexpected status: ${pack.mvp_report?.status}`);
  assertCondition(isAcceptableObjectiveStatus(pack.objective_status), "Demo pack objective status must be proven or have an active L2 needs_attention objective.");
  assertCondition(pack.objective_status?.goals_source?.loaded === true, "Demo pack objective status must load .openbutler/goals.yaml.");
  assertCondition(pack.objective_status?.goals_source?.active_objective_count >= 3, "Demo pack must include active objectives from goals.yaml.");
  assertCondition(pack.objective_status.objectives.every((item) => item.source_ref?.path === ".openbutler/goals.yaml"), "Every objective must reference goals.yaml.");
  assertCondition(pack.objective_status.objectives.every((item) => Array.isArray(item.success_criteria) && item.success_criteria.length > 0), "Every objective must include declared success criteria.");
  assertCondition(Array.isArray(pack.mvp_report?.acceptance), "Demo pack must include MVP acceptance checks.");
  assertCondition(pack.mvp_report.acceptance.every((item) => item.evidence_boundary), "Every MVP acceptance check must keep an evidence boundary.");
  assertCondition(pack.latest_harness_runs?.count >= 1, "Demo pack must include latest harness run summaries.");
  assertCondition(Array.isArray(pack.demo_commands), "Demo pack must include local demo commands.");
  assertCondition(pack.demo_commands.includes("POST /api/butler/demo/run"), "Demo pack must include demo run command.");
  assertCondition(pack.demo_commands.includes("GET /api/butler/productization/demo-pack"), "Demo pack must include demo pack command.");
  assertCondition(pack.privacy?.external_model_used === false, "Demo pack must not use external models.");
  assertCondition(pack.privacy?.external_model_allowed === false, "Demo pack must not allow external models.");
  assertCondition(pack.privacy?.system_notification_enabled === false, "Demo pack must not enable system notifications.");
  assertCondition(pack.privacy?.minecontext_source_deleted === 0, "Demo pack must preserve MineContext source data.");
  assertCondition(pack.privacy?.copied_screenshots === 0, "Demo pack must not copy screenshots.");
  assertCondition(pack.privacy?.strict_mode_respected === true, "Demo pack must respect strict mode.");
  assertCondition(Boolean(pack.evidence_boundary), "Demo pack must include an evidence boundary.");
  assertCondition(pack.limitations.join(" ").includes("does not inspect, copy, delete, or mutate MineContext"), "Demo pack must state MineContext source boundary.");

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.status === "reset", "Demo reset did not complete after demo pack smoke.");
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Demo reset must preserve PC Activity events.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Demo reset must not delete MineContext source data.");

  console.log(JSON.stringify({
    checked: "butler-demo-pack",
    ok: true,
    apiBaseUrl,
    status: pack.status,
    readiness: pack.readiness.status,
    mvp_report: pack.mvp_report.status,
    objective_status: pack.objective_status.status,
    latest_harness_runs: pack.latest_harness_runs.count,
    privacy: {
      external_model_used: pack.privacy.external_model_used,
      external_model_allowed: pack.privacy.external_model_allowed,
      system_notification_enabled: pack.privacy.system_notification_enabled,
      minecontext_source_deleted: pack.privacy.minecontext_source_deleted,
      copied_screenshots: pack.privacy.copied_screenshots,
    },
    reset: {
      pc_activity_events_preserved: resetResult.preserved?.pc_activity_events_preserved,
      minecontext_source_deleted: resetResult.privacy?.minecontext_source_deleted,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-demo-pack",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
