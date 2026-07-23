import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const desktopTypes = readFileSync(join(root, "src/desktop.d.ts"), "utf8");

const checks = [
  ["preview defaults to acceptance page", app.includes('channel === "preview" ? "acceptance"')],
  ["acceptance has three decisions", app.includes("有条件通过") && app.includes("不通过") && app.includes("通过")],
  ["acceptance generates exact approval command", app.includes("批准合并 PR")],
  ["acceptance shows privacy checks", app.includes("真实活动读取") && app.includes("截图复制")],
  ["acceptance styles are responsive", styles.includes(".acceptance-center") && styles.includes("@media (max-width: 760px)")],
  ["desktop bridge exposes acceptance IO", desktopTypes.includes("getAcceptancePack") && desktopTypes.includes("saveAcceptanceFeedback")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) throw new Error(`Nightly acceptance center failed: ${failed.map(([name]) => name).join(", ")}`);
console.log("nightly acceptance center ok");
