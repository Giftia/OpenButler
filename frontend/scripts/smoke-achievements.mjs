import {readFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const root = resolve("..");
const appText = readFileSync(resolve("src/App.tsx"), "utf8");
const achievementAdapterText = readFileSync(resolve("src/lib/achievementUiAdapter.ts"), "utf8");
const packageText = readFileSync(resolve("package.json"), "utf8");
const achievementDocPath = resolve(root, "docs/product/ACHIEVEMENT_LAYER_RECOVERY.md");

assertCondition(packageText.includes("smoke:achievements"), "Package script must expose smoke:achievements.");
assertCondition(appText.includes("achievements: \"/achievements\""), "Missing /achievements route mapping.");
assertCondition(appText.includes("label: \"成就\""), "Primary navigation must include 成就.");
assertCondition(appText.includes("function AchievementsPage"), "Missing AchievementsPage component.");

const pageStart = appText.indexOf("function AchievementsPage");
const pageEnd = appText.indexOf("function Dashboard", pageStart + "function AchievementsPage".length);
const appPageSnippet = appText.slice(pageStart, pageEnd > pageStart ? pageEnd : appText.length);
const textSurface = [appPageSnippet, achievementAdapterText].join("\n");

for (const text of ["今天有哪些值得记录的小进展", "今天的小成就", "连续记录", "下一枚可解锁", "查看依据", "边界说明", "样例体验，未读取你的真实数据"]) {
  assertCondition(textSurface.includes(text), `Achievements page missing user-facing text: ${text}`);
}

for (const forbidden of ["mock", "seed", "event_type", "PCActivity", "source_event_id", "raw_ref", "evidence_refs", "C:\\\\Users", "screenshots\\\\"]) {
  assertCondition(!appPageSnippet.includes(forbidden), `Achievements ordinary UI leaks internal term: ${forbidden}`);
}

assertCondition(existsSync(achievementDocPath), "Missing achievement layer product doc.");

console.log(JSON.stringify({
  checked: "achievements",
  route: "/achievements",
  primary_navigation: "成就",
  internal_terms: "not found in AchievementsPage ordinary UI",
}, null, 2));
