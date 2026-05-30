import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-data-insufficient-drill.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/api/butler/demo/data-insufficient-drill",
  "/api/butler/mvp-report",
  "butler_data_insufficient_drill_v1",
  "data_insufficient",
  "dry_run",
  "mutates_data",
  "external_model_used",
  "external_model_allowed",
  "system_notification_enabled",
  "minecontext_source_deleted",
  "copied_screenshots",
  "import_pc_activity",
  "rebuild_timeline",
  "generate_metrics",
  "generate_insights",
  "generate_briefing",
  "evidence_boundary",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler data-insufficient drill smoke assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-data-insufficient-drill"] !== "node scripts/smoke-butler-data-insufficient-drill.mjs") {
  throw new Error("Missing smoke:butler-data-insufficient-drill package script.");
}

if (packageJson.scripts["test:data-insufficient-drill-script"] !== "node scripts/check-butler-data-insufficient-drill-script.mjs") {
  throw new Error("Missing test:data-insufficient-drill-script package script.");
}

console.log(JSON.stringify({checked: "butler-data-insufficient-drill-script", ok: true}, null, 2));
