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
  ["desktop type exposes minecontext status", dts.includes("getMineContextStatus")],
  ["desktop type exposes minecontext scan", dts.includes("scanMineContextInstallations")],
  ["desktop type exposes minecontext installer picker", dts.includes("chooseMineContextInstaller")],
  ["desktop type exposes minecontext auto install", dts.includes("downloadMineContextInstaller") && dts.includes("installMineContextWithApproval")],
  ["desktop type exposes minecontext releases page", dts.includes("openMineContextDownloadPage")],
  ["desktop type exposes model config tools", dts.includes("testMineContextModelConfig") && dts.includes("applyMineContextModelConfig")],
  ["me page shows local status", app.includes("我的 OpenButler") && app.includes("本机服务")],
  ["me page shows full local mode checks", app.includes("本地完全体检查") && app.includes("模型配置")],
  ["first run uses local-mode language", app.includes("让 OpenButler 整理我的本机记录")],
  ["ordinary copy states no import before confirmation", app.includes("授权前只会检测和预览，不会导入真实活动")],
  ["first run exposes model provider setup", app.includes("模型供应商") && app.includes("Embedding API Key")],
  ["first run exposes minecontext scan/install path", app.includes("扫描本机 MineContext") && app.includes("自动安装") && app.includes("手动安装")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  throw new Error(`Desktop runtime bridge smoke failed: ${failed.map(([name]) => name).join(", ")}`);
}

console.log("desktop runtime bridge smoke ok");
