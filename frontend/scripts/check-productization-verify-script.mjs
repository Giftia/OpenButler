import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "verify-productization.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/health",
  "check-butler-demo-pack-script.mjs",
  "check-butler-demo-pack-artifact-script.mjs",
  "check-butler-browser-smoke-script.mjs",
  "check-butler-l1-audit-script.mjs",
  "check-productization-records.mjs",
  "check-butler-metrics-trend-panel.mjs",
  "check-butler-inbox-evidence-panel.mjs",
  "build",
  "smoke-butler-demo-pack.mjs",
  "smoke-butler-l1-audit.mjs",
  "write-butler-demo-pack-artifact.mjs",
  "check-butler-demo-pack-artifact-file.mjs",
  "smoke-butler-browser.mjs",
  "OPENBUTLER_API_BASE_URL",
  "external_model_used",
  "external_model_allowed",
  "system_notification_enabled",
  "minecontext_source_deleted",
  "copied_screenshots",
  "static_productization_records",
  "static_metrics_trend_panel",
  "static_inbox_evidence_panel",
  "does not call external models",
  "delete MineContext source data",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Productization verify script assertion: ${snippet}`);
  }
}

if (packageJson.scripts["verify:productization"] !== "node scripts/verify-productization.mjs") {
  throw new Error("Missing verify:productization package script.");
}

if (packageJson.scripts["test:productization-verify-script"] !== "node scripts/check-productization-verify-script.mjs") {
  throw new Error("Missing test:productization-verify-script package script.");
}

if (packageJson.scripts["test:productization-records"] !== "node scripts/check-productization-records.mjs") {
  throw new Error("Missing test:productization-records package script.");
}

if (packageJson.scripts["test:metrics-trend-panel"] !== "node scripts/check-butler-metrics-trend-panel.mjs") {
  throw new Error("Missing test:metrics-trend-panel package script.");
}

if (packageJson.scripts["test:inbox-evidence-panel"] !== "node scripts/check-butler-inbox-evidence-panel.mjs") {
  throw new Error("Missing test:inbox-evidence-panel package script.");
}

console.log(JSON.stringify({checked: "productization-verify-script", ok: true}, null, 2));
