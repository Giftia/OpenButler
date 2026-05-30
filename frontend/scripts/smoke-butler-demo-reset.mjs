const baseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function postJson(path, payload = {}) {
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
  const result = await postJson("/api/butler/demo/reset");
  assertCondition(result.status === "reset", "Demo reset did not complete.");
  assertCondition(result.reset?.deleted_scope?.includes("unified_timeline_events"), "Reset must delete unified timeline events.");
  assertCondition(result.reset?.preserved_scope?.includes("pc_activity_events"), "Reset must preserve PC Activity events.");
  assertCondition(result.reset?.preserved_scope?.includes("minecontext_source_database"), "Reset must preserve MineContext source data.");
  assertCondition(result.preserved?.pc_activity_events_preserved === true, "PC Activity events were not preserved.");
  assertCondition(result.privacy?.external_model_used === false, "Reset must not use external models.");
  assertCondition(result.privacy?.minecontext_source_deleted === 0, "Reset must not delete MineContext source data.");
  assertCondition(result.privacy?.deleted_only_openbutler_derived_data === true, "Reset must only delete OpenButler-derived data.");
  assertCondition(Boolean(result.evidence_boundary), "Reset must return an evidence boundary.");

  console.log(JSON.stringify({
    checked: "butler-demo-reset",
    ok: true,
    baseUrl,
    deleted: {
      timeline: result.reset.timeline,
      metrics: result.reset.metrics,
      insights: result.reset.insights,
      briefings: result.reset.briefings,
    },
    preserved: result.preserved,
    privacy: result.privacy,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-demo-reset",
    ok: false,
    baseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
