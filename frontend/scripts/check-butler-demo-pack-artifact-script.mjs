import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "write-butler-demo-pack-artifact.mjs"), "utf8");
const fileCheck = readFileSync(join(root, "scripts", "check-butler-demo-pack-artifact-file.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "/api/butler/demo/run",
  "/api/butler/productization/demo-pack",
  "/api/butler/demo/reset",
  "openbutler_productization_demo_pack_artifact_v1",
  "../data/productization/productization-demo-pack.json",
  "contains_minecontext_source_records",
  "contains_screenshot_content",
  "contains_raw_godview_output",
  "external_model_used",
  "external_model_allowed",
  "minecontext_source_deleted",
  "copied_screenshots",
  "evidence_boundary",
  "writeFileSync",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler demo pack artifact assertion: ${snippet}`);
  }
}

if (packageJson.scripts["artifact:butler-demo-pack"] !== "node scripts/write-butler-demo-pack-artifact.mjs") {
  throw new Error("Missing artifact:butler-demo-pack package script.");
}

if (packageJson.scripts["test:demo-pack-artifact-script"] !== "node scripts/check-butler-demo-pack-artifact-script.mjs") {
  throw new Error("Missing test:demo-pack-artifact-script package script.");
}

for (const snippet of [
  "openbutler_productization_demo_pack_artifact_v1",
  "../data/productization/productization-demo-pack.json",
  "contains_minecontext_source_records",
  "contains_screenshot_content",
  "contains_raw_godview_output",
  "productization_demo_pack_v1",
  "external_model_used",
  "minecontext_source_deleted",
  "evidence_boundary",
]) {
  if (!fileCheck.includes(snippet)) {
    throw new Error(`Missing Butler demo pack artifact file check assertion: ${snippet}`);
  }
}

if (packageJson.scripts["test:demo-pack-artifact-file"] !== "node scripts/check-butler-demo-pack-artifact-file.mjs") {
  throw new Error("Missing test:demo-pack-artifact-file package script.");
}

console.log(JSON.stringify({checked: "butler-demo-pack-artifact-script", ok: true}, null, 2));
