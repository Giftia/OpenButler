import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const require = createRequire(import.meta.url);
const {chromium} = require("playwright");
const index = pathToFileURL(resolve("dist/index.html")).href;
const output = resolve("../data/preview-020-smoke");
mkdirSync(output, {recursive: true});
const browser = await chromium.launch({channel: "msedge", headless: true, args: ["--allow-file-access-from-files"]});
try {
  for (const viewport of [{width: 1440, height: 960}, {width: 390, height: 844}]) {
    const context = await browser.newContext({viewport});
    const errors = [];
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem("openbutler:first_run_activation:v1", "demo_selected");
      window.openbutlerDesktop = {
        channel: "stable", apiBase: "http://127.0.0.1:9",
        requestApi: async path => {
          if (path === "/api/butler/home") return {ok: false, status: 503, error: "Synthetic unavailable source"};
          return {ok: true, status: 200, data: {items: [], count: 0, mode: "strict", privacy_mode: "strict"}};
        },
        getRuntime: async () => ({mode: "desktop", backend: {running: true}}),
        getMineContextStatus: async () => ({reachable: false, configured: false}),
      };
    });
    await page.goto(index);
    await page.getByRole("button", {name: "时间线", exact: true}).click();
    await page.waitForURL(url => url.hash === "#/timeline");
    assert.equal(page.url().split("#")[0], index);
    await page.getByRole("button", {name: "今日", exact: true}).click();
    await page.waitForURL(url => url.hash === "#/butler");
    await page.getByRole("button", {name: "查看时间线", exact: true}).click();
    await page.waitForURL(url => url.hash === "#/timeline");
    const dimensions = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
    assert.ok(dimensions.scroll <= dimensions.width);
    assert.deepEqual(errors, []);
    await page.screenshot({path: resolve(output, `navigation-${viewport.width}.png`), fullPage: true});
    await context.close();
  }
  console.log("Desktop file navigation: desktop/mobile click paths passed; synthetic bridge, no network.");
} finally {
  await browser.close();
}
