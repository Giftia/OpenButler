import {sourceLabel} from "./userFacingLabels";

export type AchievementCard = {
  id: string;
  title: string;
  summary: string;
  timeLabel: string;
  source: string;
  confidence: string;
  boundary: string;
  privacy: string;
  sample: boolean;
};

export type AchievementViewModel = {
  dataMode: "sample" | "local";
  headline: string;
  subheadline: string;
  today: AchievementCard[];
  streaks: Array<{id: string; title: string; value: string; summary: string}>;
  nextUnlock: Array<{id: string; title: string; summary: string; action: string}>;
};

const fallbackAchievements: AchievementCard[] = [
  {
    id: "sample-achievement-focus",
    title: "一段专注被记录下来",
    summary: "今天有一段比较稳定的工作时间，适合在复盘时回看。",
    timeLabel: "今天上午",
    source: "管家整理",
    confidence: "中",
    boundary: "这是样例成就，只展示 OpenButler 会如何记录进展，不代表你的真实活动。",
    privacy: "样例体验，未读取你的真实数据。",
    sample: true,
  },
  {
    id: "sample-achievement-review",
    title: "有一项待办适合收尾",
    summary: "有一条事项被整理为可以回看和处理的进展线索。",
    timeLabel: "今天下午",
    source: "时间线整理",
    confidence: "中",
    boundary: "这条样例只说明成就页的呈现方式，真实模式需要本机运行并主动授权。",
    privacy: "样例体验，未读取你的真实数据。",
    sample: true,
  },
  {
    id: "sample-achievement-rhythm",
    title: "一次短暂休息被保留下来",
    summary: "OpenButler 会把有助于节律的片段也记为进展，而不是只记录工作输出。",
    timeLabel: "今天傍晚",
    source: "管家整理",
    confidence: "中",
    boundary: "这不是健康判断，只是对样例时间线中可见节律的温和记录。",
    privacy: "样例体验，未读取你的真实数据。",
    sample: true,
  },
];

function formatTime(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "今天";
  return new Intl.DateTimeFormat("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"}).format(date);
}

function isAchievementLike(item: Record<string, any>): boolean {
  const text = [
    item.event_type,
    item.type,
    item.title,
    item.summary,
    item.eventLabel,
    item.category,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  return text.includes("achievement") || text.includes("成就") || text.includes("小成就");
}

function confidenceLabel(value: unknown): string {
  const numeric = Number(value ?? 0);
  if (numeric >= 0.78) return "较高";
  if (numeric > 0) return "中";
  return "待确认";
}

function toAchievementCard(item: Record<string, any>, index: number): AchievementCard {
  const sample = JSON.stringify(item).toLowerCase().includes("demo") || String(item.id ?? "").includes("sample");
  return {
    id: String(item.id ?? `achievement-${index}`),
    title: String(item.title ?? "一个小成就被记录了"),
    summary: String(item.summary ?? "这条记录来自 OpenButler 已整理的本地时间线。"),
    timeLabel: formatTime(item.started_at ?? item.timestamp ?? item.startedAt),
    source: sourceLabel(item.source ?? item.source_type ?? item.sourceKey ?? "butler_core"),
    confidence: confidenceLabel(item.confidence),
    boundary: sample
      ? "这是样例成就，只展示 OpenButler 会如何记录进展，不代表你的真实活动。"
      : String(item.evidence_boundary ?? "这条成就来自已授权的本地线索整理；外部系统状态需要回到原处确认。"),
    privacy: sample ? "样例体验，未读取你的真实数据。" : "只展示结构化依据，不复制本地截图，不上传原始数据。",
    sample,
  };
}

export function buildAchievementViewModel(
  events: Array<Record<string, any>>,
  timelineItems: Array<Record<string, any>>
): AchievementViewModel {
  const sourceItems = [...events, ...timelineItems].filter(isAchievementLike);
  const cards = sourceItems.map(toAchievementCard).slice(0, 6);
  const today = cards.length ? cards : fallbackAchievements;
  const sampleMode = today.every((item) => item.sample);

  return {
    dataMode: sampleMode ? "sample" : "local",
    headline: "今天有哪些值得记录的小进展？",
    subheadline: sampleMode
      ? "这里先用样例展示成就页的样子。真实模式需要在本机运行并主动授权。"
      : "这些小成就来自你已授权的本地线索，适合在复盘时回看。",
    today,
    streaks: [
      {id: "streak-review", title: "连续复盘", value: sampleMode ? "样例 2 天" : `${Math.max(1, today.length)} 条`, summary: "把值得回看的片段留下来，而不是只看待办是否完成。"},
      {id: "streak-focus", title: "稳定投入", value: today.length ? `${Math.min(today.length, 3)} 段` : "待记录", summary: "记录稳定推进的时段，帮助你看见自己的节奏。"},
    ],
    nextUnlock: [
      {id: "next-evening", title: "完成一次晚间回看", summary: "今晚花 3 分钟看一下时间线，确认哪些进展值得留下。", action: "去时间线回看"},
      {id: "next-local", title: "开启本地模式后记录真实进展", summary: "本地模式需要你主动授权，OpenButler 才会整理真实线索。", action: "了解本地模式"},
    ],
  };
}
