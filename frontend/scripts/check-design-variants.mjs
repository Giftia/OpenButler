import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
const design = readFileSync(resolve(root, "src/pages/DesignVariants.tsx"), "utf8");
const css = readFileSync(resolve(root, "src/styles.css"), "utf8");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredAppSnippets = [
  'designLab: "/design-lab"',
  'designMijia: "/design/mijia"',
  'designIos: "/design/ios"',
  'designDeck: "/design/deck"',
  'label: "设计实验室"',
  'activationGateOpen = !isDesignPage',
  '!isDesignPage && !primaryNavItems.some',
  'scene-dashboard-main',
  'from "./pages/DesignVariants"',
];

for (const snippet of requiredAppSnippets) {
  assertCondition(app.includes(snippet), `missing App snippet: ${snippet}`);
}

const requiredDesignSnippets = [
  'export function DesignLabPage',
  'export function DesignConceptPage',
  'function MijiaConcept',
  'function IosConcept',
  'function DeckConcept',
  'function DesignVariantFooter',
  'function SetupPathPanel',
  '米家式状态中控',
  'iOS Home 式私人管家',
  '大屏 PPT 式汇报版',
  '先看样例，再用桌面版整理你的本机记录',
  '本机记录和智能整理钥匙是什么',
  '获取桌面版',
  '创建智能整理钥匙',
  '桌面版里会继续带你完成',
  '查看依据',
  '证据片段',
  '09:22 的样例相册线索',
];

for (const snippet of requiredDesignSnippets) {
  assertCondition(design.includes(snippet), `missing design snippet: ${snippet}`);
}

const requiredCssSnippets = [
  '.design-lab-page',
  '.concept-mijia',
  '.concept-ios',
  '.concept-deck',
  '.mijia-tile-grid',
  '.mijia-action-strip',
  '.design-variant-footer',
  '.setup-path-panel',
  '.setup-preview-mini',
  '.concept-evidence',
  '.ios-card-stack',
  '.deck-hero',
  '.scene-dashboard-main .scene-dashboard-grid',
];

for (const snippet of requiredCssSnippets) {
  assertCondition(css.includes(snippet), `missing CSS snippet: ${snippet}`);
}

const forbidden = ["MineContext", "PCActivity", "UnifiedTimelineEvent", "mock", "seed", "Provider", "Webhook", "source_event_id", "raw_ref", "PRODUCT DEMO", "Vercel demo", "fixture"];
const leaked = forbidden.filter((term) => design.includes(term));
assertCondition(leaked.length === 0, `internal terms leaked in design concepts: ${leaked.join(", ")}`);

console.log(JSON.stringify({checked: "design-variants", ok: true}, null, 2));
