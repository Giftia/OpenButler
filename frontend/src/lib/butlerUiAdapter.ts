import {insightTypeLabel, isDemoLike, statusLabel, userFacingDemoText} from "./userFacingLabels";
import {toTimelineMoment, type TimelineMoment} from "./timelineUiAdapter";

export type TodayMode = "new_user" | "connected_no_insights" | "active";

export type TodayStatusCard = {
  title: string;
  value: string;
  description: string;
  tone: "blue" | "green" | "amber" | "red";
};

export type SuggestionCard = {
  id: string;
  title: string;
  summary: string;
  status: string;
  type: string;
  priority: number;
  confidence: number;
  evidenceBoundary: string;
  raw: Record<string, any>;
};

export type TodayHomeViewModel = {
  mode: TodayMode;
  headline: string;
  subheadline: string;
  primaryAction: string;
  summaryLine: string;
  demoMode: boolean;
  statusCards: TodayStatusCard[];
  topSuggestions: SuggestionCard[];
  sceneCards: TodayStatusCard[];
  timelinePreview: TimelineMoment[];
  dataQualityText: string;
};

function numberText(value: unknown, suffix = ""): string {
  const num = Number(value ?? 0);
  return `${Number.isFinite(num) ? Math.round(num) : 0}${suffix}`;
}

export function buildTodayHomeViewModel(
  home: Record<string, any> | null,
  timelineItems: Array<Record<string, any>>,
): TodayHomeViewModel {
  const metrics = home?.metrics ?? {};
  const insights = Array.isArray(home?.insights) ? home.insights : [];
  const sourceCount = Number(metrics.source_event_count ?? 0);
  const focusMinutes = Number(metrics.focus_minutes ?? 0);
  const insightCount = insights.length;
  const demoMode = isDemoLike(home) || isDemoLike(timelineItems);
  const nonDataQualityInsights = insights.filter((item: Record<string, any>) => item.type !== "data_quality_notice");
  const mode: TodayMode = sourceCount <= 0
    ? "new_user"
    : nonDataQualityInsights.length
      ? "active"
      : "connected_no_insights";

  const headline = mode === "new_user"
    ? "先让 OpenButler 认识你的一天。"
    : `今天已整理 ${sourceCount} 条生活信号`;

  const subheadline = mode === "new_user"
    ? "连接一个本地数据源后，它会整理时间线、生成今日概览，并在需要时提醒你。"
    : `其中 ${insightCount} 条值得关注，约 ${Math.round(focusMinutes)} 分钟稳定专注时段。`;

  const topSuggestions = insights
    .slice()
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(b.priority ?? 0) - Number(a.priority ?? 0))
    .slice(0, 3)
    .map((item: Record<string, any>) => ({
      id: String(item.id),
      title: userFacingDemoText(item.title ?? insightTypeLabel(item.type), insightTypeLabel(item.type)),
      summary: userFacingDemoText(item.summary ?? "这是一条管家提醒。"),
      status: statusLabel(item.status),
      type: insightTypeLabel(item.type),
      priority: Number(item.priority ?? 0),
      confidence: Number(item.confidence ?? 0),
      evidenceBoundary: String(item.evidence_boundary ?? "依据来自本地时间线，远程系统状态需要回源确认。"),
      raw: item,
    }));

  return {
    mode,
    headline,
    subheadline,
    primaryAction: mode === "new_user" ? "开始整理今天" : "查看管家建议",
    summaryLine: mode === "new_user"
      ? "连接一个本地数据源后开始整理。"
      : `${sourceCount} 条信号 · ${insightCount} 条提醒 · ${Math.round(focusMinutes)} 分钟专注`,
    demoMode,
    statusCards: [
      {
        title: "今日整理",
        value: numberText(metrics.source_event_count, " 条"),
        description: "已纳入今日概览的本地信号",
        tone: "blue",
      },
      {
        title: "管家提醒",
        value: numberText(insights.length, " 条"),
        description: "值得关注的提醒和建议",
        tone: "red",
      },
      {
        title: "专注时段",
        value: numberText(metrics.focus_minutes, " 分钟"),
        description: "从本地时间线估算的稳定工作片段",
        tone: "green",
      },
      {
        title: "数据质量",
        value: mode === "new_user" ? "待连接" : "可用",
        description: mode === "new_user" ? "连接数据后开始整理" : "当前结论带有边界说明",
        tone: "amber",
      },
    ],
    topSuggestions,
    sceneCards: [
      {
        title: "工作节奏",
        value: numberText(metrics.context_switch_count, " 次"),
        description: "今日上下文切换量",
        tone: "amber",
      },
      {
        title: "生活记录",
        value: numberText(timelineItems.length, " 条"),
        description: "已经整理进时间线的片段",
        tone: "blue",
      },
      {
        title: "自动化候选",
        value: numberText(metrics.workflow_candidate_count ?? 0, " 个"),
        description: "可能值得沉淀的重复流程",
        tone: "green",
      },
      {
        title: "数据源状态",
        value: mode === "new_user" ? "未就绪" : "已连接",
        description: "优先使用本地观察和完全本地模式",
        tone: "red",
      },
    ],
    timelinePreview: timelineItems.slice(0, 5).map(toTimelineMoment),
    dataQualityText: mode === "new_user"
      ? "当前还没有足够数据，OpenButler 不会编造今日结论。"
      : "所有提醒都保留依据和边界说明。",
  };
}
