import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const script = readFileSync(join(root, "scripts", "smoke-butler-browser.mjs"), "utf8");
const verifyScript = readFileSync(join(root, "scripts", "verify-productization.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "OPENBUTLER_BROWSER_PATH",
  "remote-debugging-port",
  "WebSocket",
  "/butler",
  "/api/butler/demo/run",
  "/api/butler/demo/reset",
  "Productization Harness",
  "目标完成度自检",
  "一页演示包",
  "演练空数据路径",
  "dry_run=true",
  "mutates_data=false",
  "strict: external_model_used=false",
  "minecontext_source_deleted=0",
  "copied_screenshots=0",
  "不调用外部模型",
  "不删除 MineContext 源数据",
]) {
  if (!script.includes(snippet)) {
    throw new Error(`Missing Butler browser smoke assertion: ${snippet}`);
  }
}

if (!verifyScript.includes("smoke-butler-browser.mjs")) {
  throw new Error("Productization verify command must include browser smoke.");
}

if (packageJson.scripts["smoke:butler-browser"] !== "node scripts/smoke-butler-browser.mjs") {
  throw new Error("Missing smoke:butler-browser package script.");
}

if (packageJson.scripts["test:butler-browser-smoke-script"] !== "node scripts/check-butler-browser-smoke-script.mjs") {
  throw new Error("Missing test:butler-browser-smoke-script package script.");
}

console.log(JSON.stringify({checked: "butler-browser-smoke-script", ok: true}, null, 2));
