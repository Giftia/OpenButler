import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-demo-reset.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const requiredSnippets = [
  "/api/butler/demo/reset",
  "pc_activity_events_preserved === true",
  "external_model_used === false",
  "minecontext_source_deleted === 0",
  "deleted_only_openbutler_derived_data === true",
  "evidence_boundary",
  "minecontext_source_database",
];

for (const snippet of requiredSnippets) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler demo reset assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-reset"] !== "node scripts/smoke-butler-demo-reset.mjs") {
  throw new Error("Missing smoke:butler-reset package script.");
}

console.log(JSON.stringify({checked: "butler-demo-reset-script", ok: true}, null, 2));
