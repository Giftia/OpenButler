import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");

const requiredAppSnippets = [
  "数据保留与删除",
  "不会删除 MineContext 原始数据",
  "DELETE BUTLER",
  "删除 Butler 派生数据",
  "PC Activity 事件、MineContext 源数据库、截图路径指向的文件都不会被删除",
];

for (const snippet of requiredAppSnippets) {
  if (!app.includes(snippet)) {
    throw new Error(`Missing Butler data-control UI snippet: ${snippet}`);
  }
}

if (!api.includes("deleteButlerData")) {
  throw new Error("Missing deleteButlerData API wrapper");
}

if (!api.includes('"/api/butler/data"')) {
  throw new Error("Missing /api/butler/data API path");
}

console.log(JSON.stringify({checked: "butler-data-controls", ok: true}, null, 2));
