import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {buildApprovalCommand, isFreshAcceptancePack, readJson, sanitizeAcceptanceValue} from "./nightly-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const nightlyRoot = join(root, "data", "nightly");
const previewDataDir = process.env.OPENBUTLER_PREVIEW_DATA_DIR
  || join(process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"), "OpenButler Preview", "data");
const publishedPackPath = join(previewDataDir, "acceptance-pack.json");
const latest = existsSync(join(nightlyRoot, "latest-run.txt"))
  ? readFileSync(join(nightlyRoot, "latest-run.txt"), "utf8").trim()
  : "";
if (!latest) {
  rmSync(publishedPackPath, {force: true});
  console.error("No nightly run is available.");
  process.exit(2);
}

const runDir = join(nightlyRoot, latest);
const state = readJson(join(runDir, "state.json"), null);
const rawPack = readJson(join(runDir, "acceptance-pack.json"), null);
if (!isFreshAcceptancePack(rawPack, state)) {
  rmSync(publishedPackPath, {force: true});
  console.error("The latest nightly acceptance pack is missing, incomplete, mismatched, or older than 16 hours.");
  process.exit(2);
}
const pack = sanitizeAcceptanceValue(rawPack);
const lines = [
  "# OpenButler 晨间验收",
  "",
  `- 运行：\`${pack.run_id ?? latest}\``,
  `- 模式：\`${pack.mode ?? "unknown"}\``,
  `- Loop 等级：\`${pack.loop_level ?? "unknown"}\``,
  `- Preview：${pack.candidate_version ?? "本轮没有可安装候选"}`,
  `- 执行面：${pack.execution_surface ?? "unknown"}`,
  "",
  "## 昨夜结果",
  "",
  pack.summary ?? "没有可用摘要。",
  "",
  "## 待测场景",
  "",
];
for (const scenario of pack.scenarios ?? []) {
  lines.push(`### ${scenario.title}`, "", scenario.purpose ?? "", "");
  for (const step of scenario.steps ?? []) lines.push(`- ${step}`);
  lines.push(`- 预期：${scenario.expected ?? "未提供"}`, "");
}
lines.push("## 隐私检查", "");
for (const [key, value] of Object.entries(pack.privacy ?? {})) lines.push(`- ${key}: ${value}`);
if (pack.auto_merge) {
  lines.push(
    "",
    "## 自动合并",
    "",
    `- 已尝试：${pack.auto_merge.attempted ?? 0}`,
    `- 已合并：${(pack.auto_merge.merged ?? []).length}`,
    `- 已阻塞：${(pack.auto_merge.blocked ?? []).length}`,
  );
}
lines.push("", "## 当前批准命令", "", `\`${buildApprovalCommand(pack, {})}\``, "");
if ((pack.blockers ?? []).length) {
  lines.push("## 阻塞", "", ...pack.blockers.map((item) => `- ${item}`), "");
}

const report = `${lines.join("\n")}\n`;
writeFileSync(join(runDir, "MORNING_ACCEPTANCE.md"), report, "utf8");
writeFileSync(join(nightlyRoot, "LATEST_MORNING_REPORT.md"), report, "utf8");

mkdirSync(previewDataDir, {recursive: true});
writeFileSync(publishedPackPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
console.log(report);
