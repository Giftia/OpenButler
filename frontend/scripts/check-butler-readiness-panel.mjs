import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");

const requiredAppSnippets = [
  "getButlerReadiness",
  "MVP 可演示状态",
  "readiness?.checks",
  "自检显示数据不足",
  "不触碰 MineContext 原始数据",
];

for (const snippet of requiredAppSnippets) {
  if (!app.includes(snippet)) {
    throw new Error(`Missing Butler readiness panel snippet: ${snippet}`);
  }
}

if (!api.includes('"/api/butler/readiness"')) {
  throw new Error("Missing /api/butler/readiness API wrapper");
}

for (const className of [".readiness-ready", ".readiness-data_insufficient", ".readiness-attention_needed"]) {
  if (!css.includes(className)) {
    throw new Error(`Missing readiness CSS class: ${className}`);
  }
}

console.log(JSON.stringify({checked: "butler-readiness-panel", ok: true}, null, 2));
