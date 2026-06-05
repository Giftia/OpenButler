import {readFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const root = resolve("..");
const appText = readFileSync(resolve("src/App.tsx"), "utf8");
const todayAdapterText = readFileSync(resolve("src/lib/butlerUiAdapter.ts"), "utf8");
const packageText = readFileSync(resolve("package.json"), "utf8");
const boundaryDocPath = resolve(root, "docs/product/DEMO_LOCAL_MODE_BOUNDARY.md");
const localModeDocPath = resolve(root, "docs/product/LOCAL_REAL_MODE_ACTIVATION_PATH.md");
const evidenceDocPath = resolve(root, "docs/product/EVIDENCE_TRUST_LAYER_V1.md");
const routerText = readFileSync(resolve(root, "backend/app/modules/butler_core/router.py"), "utf8");

const forbiddenTerms = ["mock", "seed", "fixture", "debug", "internal source"];
const ordinarySnippets = [
  appText.split("function PCActivityContext")[0],
  todayAdapterText,
].join("\n");

assertCondition(existsSync(boundaryDocPath), "Missing Demo / Local boundary product doc.");
assertCondition(existsSync(localModeDocPath), "Missing local real mode activation path doc.");
assertCondition(existsSync(evidenceDocPath), "Missing evidence trust layer doc.");

assertCondition(appText.includes("样例体验"), "Public UI must mark the hosted experience as sample mode.");
assertCondition((appText + todayAdapterText).includes("未读取你的真实数据"), "Sample mode must state that real data was not read.");
assertCondition(appText.includes("了解本地模式"), "Hosted demo should point to local-mode explanation, not a direct data connection.");
assertCondition(appText.includes("线上版本不会读取你的真实本机活动"), "Hosted demo must not imply real local data is connected.");
assertCondition(appText.includes("本机运行") && appText.includes("主动授权"), "Local mode copy must mention local run and active authorization.");
assertCondition(appText.includes("查看依据") && appText.includes("边界说明"), "Trust layer copy must be visible in ordinary UI.");
assertCondition(!routerText.includes("/insights/{insight_id}/evidence"), "Do not add a dedicated insight evidence endpoint in this round.");

for (const term of forbiddenTerms) {
  assertCondition(!ordinarySnippets.includes(term), `Ordinary UI source still contains forbidden engineering term: ${term}`);
}

assertCondition(packageText.includes("smoke:demo-local-boundary"), "Package script must expose this smoke.");

console.log(JSON.stringify({
  checked: "demo-local-boundary",
  sample_mode_marked: true,
  local_mode_requires_authorization: true,
  no_dedicated_evidence_endpoint: true,
  forbidden_terms: "not found in ordinary snippets",
}, null, 2));
