import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");

for (const snippet of [
  "getButlerMVPReport",
  "getButlerDataInsufficientDrill",
  "getButlerLatestHarnessRuns",
  "getButlerProductizationObjectiveStatus",
  "getButlerProductizationDemoPack",
  "mvpReport?.acceptance",
  "Productization Harness",
  "最近 Harness 结果",
  "目标完成度自检",
  "缺少 evidence mapper",
  "evidence_mapper_missing",
  "success_criteria",
  "source_ref",
  "一页演示包",
  "demoPack?.schema_version",
  "active objectives",
  "数据不足恢复演练",
  "演练空数据路径",
  "drillReport",
  "dry_run",
  "mutates_data",
  "/api/butler/demo/data-insufficient-drill",
  "验收边界",
  "next_action",
  "handleMvpNextAction",
  "mvpActionBusy",
  "下一步",
  "可执行修复建议",
  "执行建议",
  "import_pc_activity",
  "rebuild_timeline",
  "generate_metrics",
  "generate_insights",
  "generate_briefing",
  "external_model_used",
  "external_model_allowed",
  "minecontext_source_deleted",
  "copied_screenshots",
]) {
  if (!app.includes(snippet)) {
    throw new Error(`Missing Butler MVP report panel snippet: ${snippet}`);
  }
}

if (!api.includes('"/api/butler/mvp-report"')) {
  throw new Error("Missing /api/butler/mvp-report API wrapper");
}

if (!api.includes('"/api/butler/demo/data-insufficient-drill"')) {
  throw new Error("Missing /api/butler/demo/data-insufficient-drill API wrapper");
}

if (!api.includes('"/api/butler/harness/runs/latest"')) {
  throw new Error("Missing /api/butler/harness/runs/latest API wrapper");
}

if (!api.includes('"/api/butler/productization/objectives/status"')) {
  throw new Error("Missing /api/butler/productization/objectives/status API wrapper");
}

if (!api.includes('"/api/butler/productization/demo-pack"')) {
  throw new Error("Missing /api/butler/productization/demo-pack API wrapper");
}

for (const className of [".mvp-report-panel", ".mvp-chain", ".action-suggestion"]) {
  if (!css.includes(className)) {
    throw new Error(`Missing MVP report CSS class: ${className}`);
  }
}

console.log(JSON.stringify({checked: "butler-mvp-report-panel", ok: true}, null, 2));
