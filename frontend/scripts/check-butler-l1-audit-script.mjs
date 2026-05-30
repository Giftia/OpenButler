import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-l1-audit.mjs"), "utf8");
const verifyScript = readFileSync(join(root, "scripts", "verify-productization.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/api/butler/productization/l1-audit",
  "l1_active_objectives_audit_v1",
  ".openbutler/goals.yaml",
  "proven",
  "needs_attention",
  "missing_evidence",
  "out_of_scope",
  "evidence_refs",
  "evidence_boundary",
  "external_model_used",
  "external_model_allowed",
  "system_notification_enabled",
  "minecontext_source_deleted",
  "copied_screenshots",
  "L1 audit must state MineContext source boundary",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler L1 audit smoke assertion: ${snippet}`);
  }
}

if (!verifyScript.includes("smoke-butler-l1-audit.mjs")) {
  throw new Error("Productization verify command must include L1 audit smoke.");
}

if (packageJson.scripts["smoke:butler-l1-audit"] !== "node scripts/smoke-butler-l1-audit.mjs") {
  throw new Error("Missing smoke:butler-l1-audit package script.");
}

if (packageJson.scripts["test:l1-audit-script"] !== "node scripts/check-butler-l1-audit-script.mjs") {
  throw new Error("Missing test:l1-audit-script package script.");
}

console.log(JSON.stringify({checked: "butler-l1-audit-script", ok: true}, null, 2));
