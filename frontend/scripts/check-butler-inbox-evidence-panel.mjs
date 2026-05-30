import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "expandedInsightId",
  "查看证据详情",
  "收起依据",
  "InsightEvidenceDetails",
  "evidence_refs",
  "边界说明",
  "可信度",
  "来源",
  "截图证据仅显示路径引用，不复制或读取内容",
  "仅显示路径 · 未复制截图",
  "暂无可展开依据",
  "数据不足或该提醒没有可展开依据引用",
]) {
  if (!app.includes(snippet)) {
    throw new Error(`Missing Butler Inbox evidence detail snippet: ${snippet}`);
  }
}

for (const className of [
  ".evidence-toggle",
  ".evidence-detail-panel",
  ".evidence-ref-list",
  ".evidence-ref-row",
]) {
  if (!css.includes(className)) {
    throw new Error(`Missing Butler Inbox evidence detail CSS class: ${className}`);
  }
}

if (packageJson.scripts["test:inbox-evidence-panel"] !== "node scripts/check-butler-inbox-evidence-panel.mjs") {
  throw new Error("Missing test:inbox-evidence-panel package script.");
}

console.log(JSON.stringify({checked: "butler-inbox-evidence-panel", ok: true}, null, 2));
