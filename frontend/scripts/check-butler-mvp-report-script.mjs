import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-mvp-report.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/api/butler/demo/run",
  "/api/butler/mvp-report",
  "/api/butler/demo/reset",
  "butler_mvp_report_v1",
  "external_model_used",
  "external_model_allowed",
  "minecontext_source_deleted",
  "copied_screenshots",
  "pc_activity_events_preserved",
  "next_action",
  "evidence_boundary",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler MVP report smoke assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-mvp-report"] !== "node scripts/smoke-butler-mvp-report.mjs") {
  throw new Error("Missing smoke:butler-mvp-report package script.");
}

if (packageJson.scripts["test:mvp-report-script"] !== "node scripts/check-butler-mvp-report-script.mjs") {
  throw new Error("Missing test:mvp-report-script package script.");
}

console.log(JSON.stringify({checked: "butler-mvp-report-script", ok: true}, null, 2));
