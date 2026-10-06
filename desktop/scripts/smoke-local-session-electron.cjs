const assert = require("node:assert/strict");
const {mkdtempSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const {_electron} = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const profile = mkdtempSync(path.join(tmpdir(), "openbutler-auth-electron-"));
  const env = {...process.env, OPENBUTLER_DESKTOP_CHANNEL: "preview",
    OPENBUTLER_DESKTOP_USER_DATA_DIR: profile};
  for (const key of ["ELECTRON_RUN_AS_NODE", "MINECONTEXT_HOME", "OPENBUTLER_MINECONTEXT_HOME",
    "OPENBUTLER_ENABLE_DEMO_DATA", "OPENBUTLER_DEPLOY_TARGET", "OPENBUTLER_DESKTOP_SMOKE_FILE"]) delete env[key];
  const app = await _electron.launch({args: [root], env,
    executablePath: process.env.OPENBUTLER_ELECTRON_PATH || require("electron"), timeout: 30000});
  let apiBase;
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForSelector("#root > *");
    const result = await page.evaluate(async () => {
      const bridge = window.openbutlerDesktop;
      const response = await bridge.requestApi("/api/events");
      return {response, apiBase: (await bridge.getRuntime()).apiBase,
        exposed: Object.keys(bridge).filter(key => /token|credential/i.test(key))};
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.data.count, 0);
    assert.deepEqual(result.exposed, []);
    apiBase = result.apiBase;
    assert.equal((await fetch(`${apiBase}/api/events`)).status, 401);
    assert.equal((await fetch(`${apiBase}/health`).then(response => response.json())).privacy_mode, "strict");
    await page.evaluate(() => {
      localStorage.setItem("openbutler:first_run_activation:v1", "demo_selected");
      history.replaceState(null, "", "#/timeline");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.reload();
    await page.getByRole("button", {name: "时间线", exact: true}).click();
    const afterRoute = await page.evaluate(() => window.openbutlerDesktop.requestApi("/api/events"));
    assert.equal(afterRoute.status, 200);
    const restarted = await page.evaluate(() => window.openbutlerDesktop.restartBackend());
    assert.equal(restarted.running, true);
    const afterRestart = await page.evaluate(() => window.openbutlerDesktop.requestApi("/api/events"));
    assert.equal(afterRestart.status, 200);
    apiBase = restarted.apiBase;
    console.log("Electron auth smoke: nonblank, strict, protected read, hash navigation, restart and empty synthetic store passed.");
  } finally {
    await app.close();
  }
  if (apiBase) {
    let stopped = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try { await fetch(`${apiBase}/health`, {signal: AbortSignal.timeout(500)}); }
      catch { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(stopped, "Desktop quit must stop its backend");
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
