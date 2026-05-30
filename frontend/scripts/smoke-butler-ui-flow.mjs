import {readFileSync} from "node:fs";
import {join} from "node:path";

const apiBaseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";
const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");

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
  const source = `${app}\n${api}`;
  assertCondition(source.includes("onClick={runDemoPath}"), "Missing run demo button binding.");
  assertCondition(source.includes("onClick={resetDemoPath}"), "Missing reset demo button binding.");
  assertCondition(source.includes("runButlerDemoPath"), "Missing run demo API wrapper usage.");
  assertCondition(source.includes("resetButlerDemo"), "Missing reset demo API wrapper usage.");
  assertCondition(source.includes("getButlerMVPReport"), "Missing MVP report API wrapper usage.");
  assertCondition(source.includes("Productization Harness"), "Missing MVP report panel copy.");
  assertCondition(source.includes("handleMvpNextAction"), "Missing safe MVP next action handler.");
  assertCondition(source.includes("执行建议"), "Missing visible next action button copy.");
  assertCondition(source.includes("getButlerDataInsufficientDrill"), "Missing data-insufficient drill API wrapper usage.");
  assertCondition(source.includes("getButlerLatestHarnessRuns"), "Missing latest harness runs API wrapper usage.");
  assertCondition(source.includes("getButlerProductizationObjectiveStatus"), "Missing productization objective status API wrapper usage.");
  assertCondition(source.includes("getButlerProductizationDemoPack"), "Missing productization demo pack API wrapper usage.");
  assertCondition(source.includes("最近 Harness 结果"), "Missing visible latest harness run copy.");
  assertCondition(source.includes("目标完成度自检"), "Missing visible objective status copy.");
  assertCondition(source.includes("缺少 evidence mapper"), "Missing visible missing evidence mapper copy.");
  assertCondition(source.includes("evidence_mapper_missing"), "Missing missing-mapper criterion handling.");
  assertCondition(source.includes("一页演示包"), "Missing visible productization demo pack copy.");
  assertCondition(source.includes("onClick={runDataInsufficientDrill}"), "Missing data-insufficient drill button binding.");
  assertCondition(source.includes("演练空数据路径"), "Missing visible data-insufficient drill button copy.");
  assertCondition(source.includes("dry_run"), "Missing data-insufficient drill dry-run copy.");
  assertCondition(source.includes("不会删除 PC Activity、MineContext 数据库或 MineContext 截图文件。"), "Missing visible reset preservation copy.");

  const runResult = await requestJson("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify({lookback_hours: 24, limit: 200, briefing_type: "evening"}),
  });
  assertCondition(runResult.status === "completed", "Demo run did not complete.");
  assertCondition(runResult.steps?.timeline_rebuild?.status === "completed", "Demo run did not rebuild timeline.");
  assertCondition(runResult.steps?.insight_generation?.status === "completed", "Demo run did not generate insights.");
  assertCondition(runResult.privacy?.external_model_used === false, "Demo run must not use external models.");
  assertCondition(runResult.privacy?.minecontext_source_deleted === 0, "Demo run must not delete MineContext source data.");
  assertCondition(Boolean(runResult.evidence_boundary), "Demo run must return an evidence boundary.");

  const homeAfterRun = await requestJson("/api/butler/home");
  assertCondition(Boolean(homeAfterRun.overview?.evidence_boundary), "Butler home must preserve evidence boundary after demo run.");
  assertCondition(homeAfterRun.privacy?.external_model_used === false, "Butler home must not report external model use.");

  const resetResult = await requestJson("/api/butler/demo/reset", {method: "POST", body: "{}"});
  assertCondition(resetResult.status === "reset", "Demo reset did not complete.");
  assertCondition(resetResult.preserved?.pc_activity_events_preserved === true, "Demo reset must preserve PC Activity events.");
  assertCondition(Number.isFinite(resetResult.reset?.harness_runs), "Demo reset must report deleted harness summaries.");
  assertCondition(resetResult.privacy?.minecontext_source_deleted === 0, "Demo reset must not delete MineContext source data.");
  assertCondition(resetResult.privacy?.deleted_only_openbutler_derived_data === true, "Demo reset must only delete OpenButler-derived data.");
  assertCondition(Boolean(resetResult.evidence_boundary), "Demo reset must return an evidence boundary.");

  const readinessAfterReset = await requestJson("/api/butler/readiness");
  assertCondition(readinessAfterReset.privacy?.external_model_used === false, "Readiness must not report external model use after reset.");
  assertCondition(readinessAfterReset.privacy?.minecontext_source_deleted === 0, "Readiness must report MineContext source preserved after reset.");
  assertCondition(Boolean(readinessAfterReset.evidence_boundary), "Readiness must return an evidence boundary.");

  const drill = await requestJson("/api/butler/demo/data-insufficient-drill");
  assertCondition(drill.status === "data_insufficient", "Data-insufficient drill must return data_insufficient.");
  assertCondition(drill.dry_run === true, "Data-insufficient drill must be dry-run.");
  assertCondition(drill.mutates_data === false, "Data-insufficient drill must not mutate data.");
  assertCondition(drill.privacy?.external_model_used === false, "Data-insufficient drill must not use external models.");
  assertCondition(drill.privacy?.minecontext_source_deleted === 0, "Data-insufficient drill must preserve MineContext source data.");
  assertCondition(Boolean(drill.evidence_boundary), "Data-insufficient drill must return an evidence boundary.");

  const latestHarness = await requestJson("/api/butler/harness/runs/latest");
  assertCondition(Array.isArray(latestHarness.items), "Latest harness runs must return items.");
  assertCondition(latestHarness.items.length >= 1, "Latest harness runs must include at least one persisted summary.");
  assertCondition(Boolean(latestHarness.evidence_boundary), "Latest harness runs must preserve evidence boundary.");
  const drillRun = latestHarness.items.find((item) => item.kind === "data_insufficient_drill");
  assertCondition(drillRun?.dry_run === true, "Latest harness drill summary must be dry-run.");
  assertCondition(drillRun?.mutates_data === false, "Latest harness drill summary must not mutate data.");
  assertCondition(drillRun?.privacy?.external_model_used === false, "Latest harness summary must not use external models.");
  assertCondition(drillRun?.privacy?.minecontext_source_deleted === 0, "Latest harness summary must preserve MineContext source data.");

  const objectiveStatus = await requestJson("/api/butler/productization/objectives/status");
  assertCondition(objectiveStatus.schema_version === "productization_objective_status_v1", "Unexpected objective status schema.");
  assertCondition(isAcceptableObjectiveStatus(objectiveStatus), "Productization objectives must be proven or explicitly show active L2 needs_attention state.");
  assertCondition(objectiveStatus.privacy?.external_model_used === false, "Objective status must not use external models.");
  assertCondition(objectiveStatus.privacy?.minecontext_source_deleted === 0, "Objective status must preserve MineContext source data.");
  assertCondition(objectiveStatus.goals_source?.loaded === true, "Objective status must load .openbutler/goals.yaml.");
  assertCondition(Boolean(objectiveStatus.evidence_boundary), "Objective status must preserve evidence boundary.");
  for (const goalId of ["OB-GOAL-001", "OB-GOAL-002", "OB-GOAL-003"]) {
    const objective = objectiveStatus.objectives.find((item) => item.id === goalId);
    assertCondition(objective?.status === "proven", `${goalId} must be proven.`);
    assertCondition(objective?.proven_count === objective?.criteria_count, `${goalId} must have all criteria proven.`);
    assertCondition(objective?.source_ref?.path === ".openbutler/goals.yaml", `${goalId} must reference goals.yaml.`);
  }

  const demoPack = await requestJson("/api/butler/productization/demo-pack");
  assertCondition(demoPack.schema_version === "productization_demo_pack_v1", "Unexpected productization demo pack schema.");
  assertCondition(isAcceptableDemoPackStatus(demoPack), "Productization demo pack must be ready or explicitly show active L2 attention state.");
  assertCondition(["ready", "data_insufficient"].includes(demoPack.readiness?.status), "Demo pack readiness must be ready or data_insufficient.");
  assertCondition(["ready", "data_insufficient"].includes(demoPack.mvp_report?.status), "Demo pack MVP report must be ready or data_insufficient.");
  assertCondition(isAcceptableObjectiveStatus(demoPack.objective_status), "Demo pack objective status must be proven or explicitly show active L2 needs_attention state.");
  assertCondition(demoPack.latest_harness_runs?.count >= 1, "Demo pack must include latest harness runs.");
  assertCondition(demoPack.privacy?.external_model_used === false, "Demo pack must not use external models.");
  assertCondition(demoPack.privacy?.external_model_allowed === false, "Demo pack must not allow external models.");
  assertCondition(demoPack.privacy?.minecontext_source_deleted === 0, "Demo pack must preserve MineContext source data.");
  assertCondition(demoPack.privacy?.copied_screenshots === 0, "Demo pack must not copy screenshots.");
  assertCondition(Boolean(demoPack.evidence_boundary), "Demo pack must preserve evidence boundary.");

  console.log(JSON.stringify({
    checked: "butler-ui-flow",
    ok: true,
    apiBaseUrl,
    run: {
      imported: runResult.steps.pc_activity_import?.count ?? 0,
      timeline_events: runResult.steps.timeline_rebuild?.count ?? 0,
      insights: runResult.steps.insight_generation?.count ?? 0,
      readiness: runResult.steps.readiness_refresh?.status,
    },
    reset: {
      timeline: resetResult.reset?.timeline ?? 0,
      metrics: resetResult.reset?.metrics ?? 0,
      insights: resetResult.reset?.insights ?? 0,
      briefings: resetResult.reset?.briefings ?? 0,
      harness_runs: resetResult.reset?.harness_runs ?? 0,
      pc_activity_events_preserved: resetResult.preserved?.pc_activity_events_preserved,
    },
    drill: {
      status: drill.status,
      dry_run: drill.dry_run,
      mutates_data: drill.mutates_data,
    },
    latest_harness: {
      count: latestHarness.count,
      kinds: latestHarness.items.map((item) => item.kind).join(","),
    },
    objective_status: {
      status: objectiveStatus.status,
      objectives: objectiveStatus.objectives.map((item) => `${item.id}:${item.status}`).join(","),
    },
    demo_pack: {
      status: demoPack.status,
      latest_harness_count: demoPack.latest_harness_runs?.count,
    },
    privacy: {
      external_model_used: false,
      minecontext_source_deleted: 0,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "butler-ui-flow",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
