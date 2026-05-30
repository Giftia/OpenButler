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
  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.status === "completed", "Demo run did not complete before MVP report.");
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");

  const report = await requestJson("/api/butler/mvp-report");
  assertCondition(report.schema_version === "butler_mvp_report_v1", "Unexpected MVP report schema version.");
  assertCondition(report.status === "ready", `MVP report is not ready: ${report.status}`);
  assertCondition(Boolean(report.evidence_boundary), "MVP report must include evidence boundary.");
  assertCondition(report.privacy?.external_model_used === false, "MVP report must not report external model use.");
  assertCondition(report.privacy?.external_model_allowed === false, "MVP report must keep external model disabled.");
  assertCondition(report.privacy?.minecontext_source_deleted === 0, "MVP report must preserve MineContext source data.");
  assertCondition(report.privacy?.copied_screenshots === 0, "MVP report must not copy screenshots by default.");
  assertCondition(Array.isArray(report.acceptance) && report.acceptance.length >= 8, "MVP report must include acceptance checks.");
  assertCondition(report.acceptance.every((item) => item.evidence_boundary), "Every MVP report check must preserve evidence boundary.");
  assertCondition(report.acceptance.every((item) => item.next_action?.label), "Every MVP report check must include next action.");
  assertCondition(report.acceptance.every((item) => item.status === "passed"), "All MVP report checks must pass after demo run.");

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.status === "reset", "Demo reset did not complete after MVP report.");
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Demo reset must preserve PC Activity events.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Demo reset must not delete MineContext source data.");

  console.log(JSON.stringify({
    checked: "butler-mvp-report",
    ok: true,
    apiBaseUrl,
    status: report.status,
    acceptance: report.acceptance.length,
    mvp_chain: report.mvp_chain.map((item) => `${item.stage}:${item.status}:${item.count}`).join(" | "),
    privacy: {
      external_model_used: report.privacy.external_model_used,
      external_model_allowed: report.privacy.external_model_allowed,
      minecontext_source_deleted: report.privacy.minecontext_source_deleted,
      copied_screenshots: report.privacy.copied_screenshots,
    },
    reset: {
      pc_activity_events_preserved: resetResult.preserved?.pc_activity_events_preserved,
      minecontext_source_deleted: resetResult.privacy?.minecontext_source_deleted,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-mvp-report",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
