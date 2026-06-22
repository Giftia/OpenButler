import {readFileSync} from "node:fs";
import {resolve} from "node:path";

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const app = readFileSync(resolve("src/App.tsx"), "utf8");
const styles = readFileSync(resolve("src/styles.css"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

assertCondition(app.includes("本机记录组件"), "Ordinary setup copy should call the local recorder a 本机记录组件.");
assertCondition(app.includes("我该从哪里获得 API Key"), "Model setup must include a plain API Key help card.");
assertCondition(app.includes("一把钥匙") || app.includes("不内置云模型"), "API Key help should explain what a key is and why it is needed in ordinary language.");
assertCondition(app.includes("获取并打开 OpenButler 桌面版") || app.includes("获取桌面版"), "Full setup guidance should tell web-demo users the concrete desktop next step.");
assertCondition(app.includes("准备 API Key"), "Home setup guidance should name API Key preparation as a concrete step.");
assertCondition(app.includes("API Key 去哪里拿"), "Web setup guidance should show where ordinary users can get an API Key.");
assertCondition(app.includes("打开 Ark 控制台"), "Setup guidance should include a concrete Ark console entry.");
assertCondition(app.includes("查看桌面版发布页"), "Setup guidance should include a concrete desktop release-page entry.");
assertCondition(app.includes("大多数用户不用改这里"), "Technical model fields should be kept behind advanced connection info.");
assertCondition(app.includes("桌面版从哪里获取"), "Web setup guidance should explain where to get the desktop app.");
assertCondition(!app.includes("desktop/dist/OpenButler-Setup"), "Ordinary setup copy should not expose developer installer paths.");
assertCondition(app.includes("不会读取活动明细"), "Local mode boundary should say activity details are not read before confirmation.");
assertCondition(app.includes("本机记录来源"), "Ordinary setup copy should explain the local record source in less technical language.");
assertCondition(app.includes("已把这条建议展开在下面"), "Primary suggestion click should show a visible user-facing feedback message.");
assertCondition(app.includes("打开完整设置"), "Home should expose a clear full setup entry after sample mode.");
assertCondition(app.includes("重新打开引导"), "Settings should let users reopen onboarding in ordinary language.");

assertCondition(
  /\.setup-link-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/.test(styles),
  "Web setup guidance should be presented as a readable two-card grid on desktop.",
);

assertCondition(
  /\.inline-action-feedback\s*\{[\s\S]*?font-weight:\s*700\s*;/.test(styles),
  "Focused suggestion cards should show a strong inline feedback message.",
);

assertCondition(
  /\.action-feedback\s*\{[\s\S]*?background:\s*rgb\(239 246 255 \/ 92%\)\s*;/.test(styles),
  "Suggestion click feedback should be visibly styled.",
);

assertCondition(
  /\.scene-dashboard-panel\s+\.scene-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(styles),
  "Scene signal cards should use a single readable column in the narrow dashboard panel.",
);
assertCondition(
  /\.scene-dashboard-panel\s+\.scene-card\s+strong\s*\{[\s\S]*?justify-self:\s*start\s*;/.test(styles),
  "Scene signal values should align with the copy instead of being squeezed into a right rail.",
);
assertCondition(
  /\.sidebar\s*\{[\s\S]*?position:\s*fixed\s*;/.test(styles),
  "Desktop sidebar should stay fixed while the content scrolls.",
);

assertCondition(
  packageJson.scripts["test:product-shell-ordinary-ux"] === "node scripts/check-product-shell-ordinary-ux.mjs",
  "Package script must expose test:product-shell-ordinary-ux.",
);

console.log(JSON.stringify({checked: "product-shell-ordinary-ux", ok: true}, null, 2));
