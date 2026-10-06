import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const desktopTypes = readFileSync(join(root, "src/desktop.d.ts"), "utf8");
const navigation = readFileSync(join(root, "src/lib/navigation.ts"), "utf8");
const routeSource = app.match(/function pageForPath\(path: string\): PageKey \{[\s\S]*?\n\}/)?.[0];
assert.ok(routeSource, "actual application route mapper must be present");
const context = vm.createContext({exports: {}, window: {location: {protocol: "file:", hash: ""}}});
vm.runInContext(ts.transpileModule(navigation, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context);
vm.runInContext(ts.transpileModule(routeSource, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context);
assert.equal(context.exports.currentAppPath(), "/butler", "fresh desktop must open Today");
assert.equal(vm.runInContext('pageForPath("/butler")', context), "butler");
context.window.location.hash = "#/acceptance";
assert.equal(context.exports.currentAppPath(), "/acceptance");
assert.equal(vm.runInContext('pageForPath("/acceptance")', context), "acceptance");

const checks = [
  ["explicit acceptance route remains available beside the Today default", app.includes("acceptance: <AcceptanceCenter />") && app.includes('page !== "acceptance"')],
  ["acceptance has three decisions", app.includes("有条件通过") && app.includes("不通过") && app.includes("通过")],
  ["acceptance generates exact approval command", app.includes("批准合并 PR")],
  ["acceptance shows privacy checks", app.includes("真实活动读取") && app.includes("截图复制")],
  ["acceptance styles are responsive", styles.includes(".acceptance-center") && styles.includes("@media (max-width: 760px)")],
  ["desktop bridge exposes acceptance IO", desktopTypes.includes("getAcceptancePack") && desktopTypes.includes("saveAcceptanceFeedback")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) throw new Error(`Nightly acceptance center failed: ${failed.map(([name]) => name).join(", ")}`);
console.log("nightly acceptance center ok");
