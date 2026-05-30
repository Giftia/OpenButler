import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-ui-flow.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const requiredSnippets = [
  "onClick={runDemoPath}",
  "onClick={resetDemoPath}",
  "/api/butler/demo/run",
  "/api/butler/home",
  "/api/butler/demo/reset",
  "/api/butler/readiness",
  "getButlerMVPReport",
  "Productization Harness",
  "handleMvpNextAction",
  "执行建议",
  "getButlerDataInsufficientDrill",
  "getButlerLatestHarnessRuns",
  "getButlerProductizationObjectiveStatus",
  "getButlerProductizationDemoPack",
  "/api/butler/demo/data-insufficient-drill",
  "/api/butler/harness/runs/latest",
  "/api/butler/productization/objectives/status",
  "/api/butler/productization/demo-pack",
  "最近 Harness 结果",
  "目标完成度自检",
  "一页演示包",
  "goals_source",
  ".openbutler/goals.yaml",
  "缺少 evidence mapper",
  "evidence_mapper_missing",
  "演练空数据路径",
  "dry_run",
  "mutates_data",
  "external_model_used === false",
  "minecontext_source_deleted === 0",
  "resetResult.reset?.harness_runs",
  "pc_activity_events_preserved === true",
  "productization_demo_pack_v1",
  "evidence_boundary",
  "不会删除 PC Activity、MineContext 数据库或 MineContext 截图文件。",
];

for (const snippet of requiredSnippets) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler UI flow smoke assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-ui-flow"] !== "node scripts/smoke-butler-ui-flow.mjs") {
  throw new Error("Missing smoke:butler-ui-flow package script.");
}

console.log(JSON.stringify({checked: "butler-ui-flow-script", ok: true}, null, 2));
