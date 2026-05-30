import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const api = readFileSync(join(root, "src", "lib", "api.ts"), "utf8");

const requiredSnippets = [
  "runDemoPath",
  "runButlerDemoPath",
  "resetDemoPath",
  "resetButlerDemo",
  "运行演示闭环",
  "重置演示数据",
  "导入今日 PC Activity",
  "/api/butler/demo/run",
  "/api/butler/demo/reset",
  "briefing_type: \"evening\"",
  "refreshHome()",
  "不会删除 PC Activity、MineContext 数据库或 MineContext 截图文件。",
  "MineContext 原始数据删除数为",
  "演示路径执行失败，请检查后端服务或 MineContext 接入状态。",
];

for (const snippet of requiredSnippets) {
  if (!`${app}\n${api}`.includes(snippet)) {
    throw new Error(`Missing Butler demo path snippet: ${snippet}`);
  }
}

console.log(JSON.stringify({checked: "butler-demo-path", ok: true}, null, 2));
