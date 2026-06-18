import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const dts = readFileSync(join(root, "src/desktop.d.ts"), "utf8");

const checks = [
  ["api uses desktop apiBase before env", /window\.openbutlerDesktop\?\.apiBase/.test(api)],
  ["api exposes desktop status", api.includes("getDesktopStatus") && api.includes("/api/desktop/status")],
  ["desktop type exposes runtime", dts.includes("getRuntime") && dts.includes("restartBackend")],
  ["desktop type exposes minecontext chooser", dts.includes("chooseMineContextHome")],
  ["me page shows local status", app.includes("我的 OpenButler") && app.includes("本机服务")],
  ["first run uses local-mode language", app.includes("让 OpenButler 整理我的本机记录")],
  ["ordinary copy states no import before confirmation", app.includes("授权前只会检测和预览，不会导入真实活动")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  throw new Error(`Desktop runtime bridge smoke failed: ${failed.map(([name]) => name).join(", ")}`);
}

console.log("desktop runtime bridge smoke ok");
