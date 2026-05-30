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

try {
  const before = await requestJson("/api/butler/mvp-report");
  const drill = await requestJson("/api/butler/demo/data-insufficient-drill");
  const after = await requestJson("/api/butler/mvp-report");

  assertCondition(drill.schema_version === "butler_data_insufficient_drill_v1", "Unexpected drill schema version.");
  assertCondition(drill.status === "data_insufficient", `Drill must report data_insufficient, got ${drill.status}.`);
  assertCondition(drill.dry_run === true, "Drill must be a dry run.");
  assertCondition(drill.mutates_data === false, "Drill must not mutate data.");
  assertCondition(Boolean(drill.evidence_boundary), "Drill must include evidence boundary.");
  assertCondition(drill.privacy?.external_model_used === false, "Drill must not use external models.");
  assertCondition(drill.privacy?.external_model_allowed === false, "Drill must keep external models disabled.");
  assertCondition(drill.privacy?.system_notification_enabled === false, "Drill must not enable system notifications.");
  assertCondition(drill.privacy?.minecontext_source_deleted === 0, "Drill must not delete MineContext source data.");
  assertCondition(drill.privacy?.copied_screenshots === 0, "Drill must not copy screenshots.");
  assertCondition(Array.isArray(drill.acceptance) && drill.acceptance.length >= 8, "Drill must include acceptance checks.");
  assertCondition(drill.acceptance.every((item) => item.evidence_boundary), "Every drill check must include evidence boundary.");
  assertCondition(drill.acceptance.every((item) => item.next_action?.type), "Every drill check must include next action.");

  const checks = Object.fromEntries(drill.acceptance.map((item) => [item.id, item]));
  for (const [id, type] of [
    ["pc_activity_source_events", "import_pc_activity"],
    ["unified_timeline_ready", "rebuild_timeline"],
    ["today_metrics_ready", "generate_metrics"],
    ["active_insights_ready", "generate_insights"],
    ["briefing_ready", "generate_briefing"],
  ]) {
    assertCondition(checks[id]?.status === "needs_attention", `${id} must need attention in drill.`);
    assertCondition(checks[id]?.next_action?.type === type, `${id} must suggest ${type}.`);
  }
  assertCondition(checks.strict_privacy_ready?.status === "passed", "Strict privacy must pass in drill.");
  assertCondition(checks.minecontext_source_preserved?.status === "passed", "MineContext preservation must pass in drill.");
  assertCondition(after.privacy?.minecontext_source_deleted === 0, "MVP report after drill must preserve MineContext source data.");
  assertCondition(
    before.readiness?.summary?.pc_activity_events === after.readiness?.summary?.pc_activity_events,
    "Drill must not change PC Activity event count.",
  );

  console.log(JSON.stringify({
    checked: "butler-data-insufficient-drill",
    ok: true,
    apiBaseUrl,
    status: drill.status,
    dry_run: drill.dry_run,
    mutates_data: drill.mutates_data,
    next_actions: drill.acceptance.map((item) => `${item.id}:${item.next_action.type}`).join(" | "),
    privacy: drill.privacy,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-data-insufficient-drill",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
