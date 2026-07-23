import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {isFreshAcceptancePack, readJson, sanitizeAcceptanceValue} from "./nightly-lib.mjs";

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
lines.push(
  `- 来源记录已读取：${pack.privacy?.real_activity_read ? "是" : "否"}`,
  `- Nightly 隔离库已写入：${pack.privacy?.database_written ? "是" : "否"}`,
  `- 来源数据已修改：${pack.privacy?.source_data_modified ? "是" : "否"}`,
  `- 截图已复制：${pack.privacy?.screenshots_copied ? "是" : "否"}`,
  `- 外部模型已调用：${pack.privacy?.external_model_called ? "是" : "否"}`,
  `- 外部回调已调用：${pack.privacy?.external_webhook_called ? "是" : "否"}`,
  `- GitHub 已产生实现变更：${pack.privacy?.github_mutated ? "是" : "否"}`,
);
if (pack.real_data) {
  lines.push(
    "",
    "## 本地数据验证",
    "",
    `- 状态：${pack.real_data.status ?? "unknown"}`,
    `- 时间范围：最近 ${pack.real_data.lookback_hours ?? 48} 小时`,
    `- 预计来源记录：${pack.real_data.estimated_source_events ?? 0}`,
    `- 预计新增记录：${pack.real_data.estimated_new_events ?? 0}`,
    `- 预计重复记录：${pack.real_data.estimated_duplicate_events ?? 0}`,
    "- 说明：只读来源，结果仅写入 Nightly 隔离库。",
  );
}
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
lines.push(
  "",
  "## 下一步",
  "",
  pack.auto_merge?.blocked?.length
    ? "- 查看自动合并阻塞原因；控制器不会绕过门禁。"
    : "- 没有需要人工批准的合并；稳定版发布仍需单独批准。",
  "",
);
if ((pack.blockers ?? []).length) {
  lines.push("## 阻塞", "", ...pack.blockers.map((item) => `- ${item}`), "");
}

const report = `${lines.join("\n")}\n`;
writeFileSync(join(runDir, "MORNING_ACCEPTANCE.md"), report, "utf8");
writeFileSync(join(nightlyRoot, "LATEST_MORNING_REPORT.md"), report, "utf8");

mkdirSync(previewDataDir, {recursive: true});
writeFileSync(publishedPackPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
console.log(report);
