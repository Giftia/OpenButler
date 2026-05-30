import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-demo-api.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const requiredSnippets = [
  "/api/butler/demo/run",
  "OPENBUTLER_API_BASE_URL",
  "external_model_used === false",
  "copied_screenshots === 0",
  "minecontext_source_deleted === 0",
  "evidence_boundary",
  "readiness_refresh",
];

for (const snippet of requiredSnippets) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler demo smoke assertion: ${snippet}`);
  }
}

if (packageJson.scripts["smoke:butler-demo"] !== "node scripts/smoke-butler-demo-api.mjs") {
  throw new Error("Missing smoke:butler-demo package script.");
}

console.log(JSON.stringify({checked: "butler-demo-smoke-script", ok: true}, null, 2));
