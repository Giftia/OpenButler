import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.cwd();
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const snippet of [
  "expandedInsightId",
  "查看证据详情",
  "收起证据详情",
  "InsightEvidenceDetails",
  "evidence_refs",
  "evidence_boundary",
  "confidence",
  "source",
  "generated_by",
  "截图证据仅显示路径引用，不复制或读取内容",
  "path only · no screenshot copy",
  "暂无 evidence_refs",
  "数据不足或该洞察没有可展开证据引用",
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

