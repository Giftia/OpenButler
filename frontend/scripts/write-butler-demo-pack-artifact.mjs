import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";

const apiBaseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";
const outputPath = resolve(process.env.OPENBUTLER_DEMO_PACK_ARTIFACT ?? "../data/productization/productization-demo-pack.json");

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

function isAcceptableDemoPackStatus(pack) {
  return pack.status === "ready"
    || (
      ["attention_needed", "data_insufficient"].includes(pack.status)
      && (
        pack.objective_status?.status === "proven"
        || (pack.objective_status?.status === "needs_attention" && (hasActiveL2Objective(pack.objective_status) || hasOnlyExpectedOpenObjectiveGaps(pack.objective_status)))
      )
    );
}

try {
  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.status === "completed", "Demo run did not complete before artifact export.");
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");

  const pack = await requestJson("/api/butler/productization/demo-pack");
  assertCondition(pack.schema_version === "productization_demo_pack_v1", "Unexpected productization demo pack schema.");
  assertCondition(isAcceptableDemoPackStatus(pack), `Productization demo pack has unexpected status: ${pack.status}`);
  assertCondition(pack.privacy?.external_model_used === false, "Artifact source must not use external models.");
  assertCondition(pack.privacy?.external_model_allowed === false, "Artifact source must not allow external models.");
  assertCondition(pack.privacy?.minecontext_source_deleted === 0, "Artifact source must preserve MineContext source data.");
  assertCondition(pack.privacy?.copied_screenshots === 0, "Artifact source must not copy screenshots.");
  assertCondition(Boolean(pack.evidence_boundary), "Artifact source must include evidence boundary.");

  const artifact = {
    artifact_schema_version: "openbutler_productization_demo_pack_artifact_v1",
    generated_by: "npm run artifact:butler-demo-pack",
    api_base_url: apiBaseUrl,
    output_path: outputPath,
    privacy: {
      external_model_used: false,
      external_model_allowed: false,
      system_notification_enabled: false,
      minecontext_source_deleted: 0,
      copied_screenshots: 0,
      contains_minecontext_source_records: false,
      contains_screenshot_content: false,
      contains_raw_godview_output: false,
    },
    evidence_boundary: (
      "This artifact is generated from local OpenButler Productization Harness APIs. It contains derived statuses, "
      + "privacy counters, goals evidence, and evidence boundaries only; it does not include MineContext source databases, "
      + "raw godview output, screenshot bytes, screenshot OCR, copied screenshots, or external-system state."
    ),
    productization_demo_pack: pack,
  };

  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.status === "reset", "Demo reset did not complete after artifact export.");
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Demo reset must preserve PC Activity events.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Demo reset must not delete MineContext source data.");

  console.log(JSON.stringify({
    checked: "butler-demo-pack-artifact",
    ok: true,
    apiBaseUrl,
    outputPath,
    status: pack.status,
    schema: artifact.artifact_schema_version,
    privacy: artifact.privacy,
    reset: {
      pc_activity_events_preserved: resetResult.preserved?.pc_activity_events_preserved,
      minecontext_source_deleted: resetResult.privacy?.minecontext_source_deleted,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-demo-pack-artifact",
    ok: false,
    apiBaseUrl,
    outputPath,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
