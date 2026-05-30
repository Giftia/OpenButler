import {spawnSync} from "node:child_process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const apiBaseUrl = process.env.OPENBUTLER_API_BASE_URL ?? "http://127.0.0.1:8010";
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptsDir, "..");
const artifactPath = process.env.OPENBUTLER_DEMO_PACK_ARTIFACT
  ?? "../data/productization/productization-demo-pack.json";

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function checkBackendHealth() {
  const response = await fetch(`${apiBaseUrl}/health`);
  assertCondition(response.ok, `/health returned ${response.status} ${response.statusText}`);
}

function runScriptStep(name, scriptName) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [resolve(scriptsDir, scriptName)], {
    cwd: frontendDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status ?? "unknown"}`);
  }

  return {
    name,
    status: "passed",
    duration_ms: Date.now() - startedAt,
  };
}

function runPackageStep(name, scriptName) {
  const startedAt = Date.now();
  const result = spawnSync("npm", ["run", scriptName], {
    cwd: frontendDir,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    const reason = result.error instanceof Error ? `: ${result.error.message}` : "";
    throw new Error(`${name} failed with exit code ${result.status ?? "unknown"}${reason}`);
  }

  return {
    name,
    status: "passed",
    duration_ms: Date.now() - startedAt,
  };
}

try {
  await checkBackendHealth();

  const steps = [
    runScriptStep("static_demo_pack_smoke_script", "check-butler-demo-pack-script.mjs"),
    runScriptStep("static_demo_pack_artifact_script", "check-butler-demo-pack-artifact-script.mjs"),
    runScriptStep("static_butler_browser_smoke_script", "check-butler-browser-smoke-script.mjs"),
    runScriptStep("static_l1_audit_script", "check-butler-l1-audit-script.mjs"),
    runScriptStep("static_productization_records", "check-productization-records.mjs"),
    runScriptStep("static_metrics_trend_panel", "check-butler-metrics-trend-panel.mjs"),
    runScriptStep("static_inbox_evidence_panel", "check-butler-inbox-evidence-panel.mjs"),
    runPackageStep("frontend_build", "build"),
    runScriptStep("runtime_demo_pack_smoke", "smoke-butler-demo-pack.mjs"),
    runScriptStep("runtime_l1_audit_smoke", "smoke-butler-l1-audit.mjs"),
    runScriptStep("write_demo_pack_artifact", "write-butler-demo-pack-artifact.mjs"),
    runScriptStep("offline_demo_pack_artifact_file", "check-butler-demo-pack-artifact-file.mjs"),
    runScriptStep("browser_butler_harness_smoke", "smoke-butler-browser.mjs"),
  ];

  console.log(JSON.stringify({
    checked: "productization-verify",
    ok: true,
    apiBaseUrl,
    artifact: artifactPath,
    steps,
    privacy: {
      external_model_used: false,
      external_model_allowed: false,
      system_notification_enabled: false,
      minecontext_source_deleted: 0,
      copied_screenshots: 0,
    },
    evidence_boundary: (
      "This verification command uses local OpenButler Productization Harness APIs and local script checks only. "
      + "It does not call external models, send external webhooks, copy screenshots, delete MineContext source data, "
      + "or verify remote repositories, CI, deployments, Yunxiao, or online services."
    ),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    checked: "productization-verify",
    ok: false,
    apiBaseUrl,
    error: error instanceof Error ? error.message : String(error),
    hint: "Start the backend first, for example: python -m uvicorn app.main:app --host 127.0.0.1 --port 8010",
  }, null, 2));
  process.exit(1);
}
