import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "getButlerMetricsRange",
  "getButlerMetricsRange(7)",
  "最近 7 天趋势",
  "TrendPanel",
  "pc_active_minutes",
  "focus_minutes",
  "context_switch_count",
  "最近 7 天数据不足",
  "data_insufficient_message",
  "external_model_used",
  "copied_screenshots",
  "minecontext_source_deleted",
  "evidence_boundary",
]) {
  if (!app.includes(snippet)) {
    throw new Error(`Missing Metrics trend UI snippet: ${snippet}`);
  }
}

if (!api.includes("/api/butler/metrics?days=")) {
  throw new Error("Missing /api/butler/metrics?days API wrapper.");
}

for (const className of [".trend-grid", ".trend-panel"]) {
  if (!css.includes(className)) {
    throw new Error(`Missing Metrics trend CSS class: ${className}`);
  }
}

if (packageJson.scripts["test:metrics-trend-panel"] !== "node scripts/check-butler-metrics-trend-panel.mjs") {
  throw new Error("Missing test:metrics-trend-panel package script.");
}

console.log(JSON.stringify({checked: "butler-metrics-trend-panel", ok: true}, null, 2));
