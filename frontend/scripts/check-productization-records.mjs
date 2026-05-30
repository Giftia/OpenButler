import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const rootDir = resolve(process.cwd(), "..");
const changelogPath = resolve(rootDir, "CHANGELOG.md");
const demoRecordPath = resolve(rootDir, "docs", "productization", "DEMO_RECORD.md");

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(text, snippet, label) {
  assertCondition(text.includes(snippet), `${label} missing required snippet: ${snippet}`);
}

function assertExcludes(text, snippet, label) {
  assertCondition(!text.includes(snippet), `${label} must not include sensitive snippet: ${snippet}`);
}

const changelog = readFileSync(changelogPath, "utf8");
const demoRecord = readFileSync(demoRecordPath, "utf8");
const combined = `${changelog}\n${demoRecord}`;

for (const snippet of [
  "Productization Harness",
  "npm run verify:productization",
  "npm run smoke:butler-demo-pack",
  "npm run smoke:butler-l1-audit",
  "npm run smoke:butler-browser",
  "npm run artifact:butler-demo-pack",
  "npm run test:demo-pack-artifact-file",
  "data/productization/productization-demo-pack.json",
  "external_model_used=false",
  "external_model_allowed=false",
  "minecontext_source_deleted=0",
  "copied_screenshots=0",
  "MineContext source records",
  "raw godview output",
  "screenshot content",
  "remote repositories",
  "CI",
  "Yunxiao",
  "deployments",
  "online services",
  "live verification",
]) {
  assertIncludes(combined, snippet, "Productization records");
}

for (const snippet of [
  "GET /api/butler/productization/l1-audit",
  "GET /api/butler/productization/demo-pack",
  "GET /api/butler/mvp-report",
  "GET /api/butler/readiness",
  "objective count: 3",
  "success criteria count: 13",
  "`proven`: 13",
  "`missing_evidence`: 0",
  "`out_of_scope`: 0",
  "does not contain MineContext source records",
]) {
  assertIncludes(demoRecord, snippet, "Productization demo record");
}

for (const snippet of [
  "C:\\Users\\admin\\AppData\\Local\\MineContext",
  "screenshots\\",
  ".png",
  "persist\\sqlite\\app.db",
  "raw_output",
]) {
  assertExcludes(combined, snippet, "Productization records");
}

console.log(JSON.stringify({
  checked: "productization-records",
  ok: true,
  files: [
    "CHANGELOG.md",
    "docs/productization/DEMO_RECORD.md",
  ],
}, null, 2));

