import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-demo-pack.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/api/butler/demo/run",
  "/api/butler/productization/demo-pack",
  "/api/butler/demo/reset",
  "productization_demo_pack_v1",
  "goals_source",
  ".openbutler/goals.yaml",
  "success_criteria",
  "external_model_used",
  "external_model_allowed",
  "system_notification_enabled",
  "minecontext_source_deleted",
  "copied_screenshots",
  "strict_mode_respected",
  "pc_activity_events_preserved",
  "evidence_boundary",
  "does not inspect, copy, delete, or mutate MineContext",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler demo pack smoke assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-demo-pack"] !== "node scripts/smoke-butler-demo-pack.mjs") {
  throw new Error("Missing smoke:butler-demo-pack package script.");
}

if (packageJson.scripts["test:demo-pack-script"] !== "node scripts/check-butler-demo-pack-script.mjs") {
  throw new Error("Missing test:demo-pack-script package script.");
}

console.log(JSON.stringify({checked: "butler-demo-pack-script", ok: true}, null, 2));
