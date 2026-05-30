const baseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function postJson(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

try {
  const result = await postJson("/api/butler/demo/run", {
    lookback_hours: 24,
    limit: 200,
    briefing_type: "evening",
  });
  assertCondition(result.status === "completed", "Demo run did not complete.");
  assertCondition(result.steps?.pc_activity_import, "Missing PC Activity import step.");
  assertCondition(result.steps?.timeline_rebuild?.status === "completed", "Timeline rebuild step did not complete.");
  assertCondition(result.steps?.insight_generation?.status === "completed", "Insight generation step did not complete.");
  assertCondition(result.steps?.briefing_generation?.status === "completed", "Briefing generation step did not complete.");
  assertCondition(result.steps?.readiness_refresh?.status, "Missing readiness refresh status.");
  assertCondition(result.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(result.privacy?.copied_screenshots === 0, "Demo run must not copy screenshots by default.");
  assertCondition(result.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");
  assertCondition(Boolean(result.evidence_boundary), "Demo run must return an evidence boundary.");

  console.log(JSON.stringify({
    checked: "butler-demo-api",
    ok: true,
    baseUrl,
    import_status: result.steps.pc_activity_import.status,
    imported: result.steps.pc_activity_import.count,
    timeline_events: result.steps.timeline_rebuild.count,
    insights: result.steps.insight_generation.count,
    briefing_type: result.steps.briefing_generation.type,
    readiness: result.steps.readiness_refresh.status,
    privacy: result.privacy,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-demo-api",
    ok: false,
    baseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
