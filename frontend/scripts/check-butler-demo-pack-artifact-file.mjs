import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const artifactPath = resolve(process.env.OPENBUTLER_DEMO_PACK_ARTIFACT ?? "../data/productization/productization-demo-pack.json");

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const pack = artifact.productization_demo_pack ?? {};
  const privacy = artifact.privacy ?? {};
  const packPrivacy = pack.privacy ?? {};

  assertCondition(
    artifact.artifact_schema_version === "openbutler_productization_demo_pack_artifact_v1",
    "Unexpected artifact schema version."
  );
  assertCondition(artifact.generated_by === "npm run artifact:butler-demo-pack", "Unexpected artifact generator.");
  assertCondition(Boolean(artifact.evidence_boundary), "Artifact must include evidence boundary.");
  assertCondition(pack.schema_version === "productization_demo_pack_v1", "Unexpected demo pack schema.");
  assertCondition(isAcceptableDemoPackStatus(pack), `Demo pack artifact has unexpected status: ${pack.status}`);
  assertCondition(["ready", "data_insufficient"].includes(pack.readiness?.status), "Readiness must be ready or data_insufficient.");
  assertCondition(["ready", "data_insufficient"].includes(pack.mvp_report?.status), "MVP report must be ready or data_insufficient.");
  assertCondition(isAcceptableObjectiveStatus(pack.objective_status), "Objective status must be proven or explicitly show active L2 needs_attention state.");
  assertCondition(pack.objective_status?.goals_source?.loaded === true, "Artifact must include loaded goals source.");
  assertCondition(Array.isArray(pack.objective_status?.objectives), "Artifact must include objectives.");
  assertCondition(pack.objective_status.objectives.length >= 3, "Artifact must include active objectives.");
  assertCondition(Array.isArray(pack.mvp_report?.acceptance), "Artifact must include MVP acceptance checks.");
  assertCondition(pack.mvp_report.acceptance.every((item) => item.evidence_boundary), "Every acceptance check must include evidence boundary.");

  assertCondition(privacy.external_model_used === false, "Artifact must not report external model use.");
  assertCondition(privacy.external_model_allowed === false, "Artifact must not allow external models.");
  assertCondition(privacy.system_notification_enabled === false, "Artifact must not enable system notifications.");
  assertCondition(privacy.minecontext_source_deleted === 0, "Artifact must preserve MineContext source data.");
  assertCondition(privacy.copied_screenshots === 0, "Artifact must not copy screenshots.");
  assertCondition(privacy.contains_minecontext_source_records === false, "Artifact must not contain MineContext source records.");
  assertCondition(privacy.contains_screenshot_content === false, "Artifact must not contain screenshot content.");
  assertCondition(privacy.contains_raw_godview_output === false, "Artifact must not contain raw godview output.");

  assertCondition(packPrivacy.external_model_used === false, "Demo pack must not report external model use.");
  assertCondition(packPrivacy.external_model_allowed === false, "Demo pack must not allow external models.");
  assertCondition(packPrivacy.minecontext_source_deleted === 0, "Demo pack must preserve MineContext source data.");
  assertCondition(packPrivacy.copied_screenshots === 0, "Demo pack must not copy screenshots.");
  assertCondition(Boolean(pack.evidence_boundary), "Demo pack must include evidence boundary.");

  console.log(JSON.stringify({
    checked: "butler-demo-pack-artifact-file",
    ok: true,
    artifactPath,
    schema: artifact.artifact_schema_version,
    status: pack.status,
    objectives: pack.objective_status.objectives.length,
    acceptance: pack.mvp_report.acceptance.length,
    privacy,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-demo-pack-artifact-file",
    ok: false,
    artifactPath,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
