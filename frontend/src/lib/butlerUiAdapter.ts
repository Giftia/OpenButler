import {insightTypeLabel, isDemoLike, statusLabel, userFacingDemoText} from "./userFacingLabels";
import {toTimelineMoment, type TimelineMoment} from "./timelineUiAdapter";

export type TodayMode = "new_user" | "connected_no_insights" | "active";
export type ActivationMode = "demo" | "real_local" | "not_started";

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

export type TodayKeyNumber = {
  label: string;
  value: string;
  description: string;
};

export type TodayCommandCenter = {
  headline: string;
  oneLineStatus: string;
  primaryAction: string;
  topSuggestion: SuggestionCard | null;
  keyNumbers: TodayKeyNumber[];
  privacyHint: string;
  dataMode: "sample" | "local" | "not_connected";
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
  commandCenter: TodayCommandCenter;
};

function numberText(value: unknown, suffix = ""): string {
  const num = Number(value ?? 0);
  return `${Number.isFinite(num) ? Math.round(num) : 0}${suffix}`;
}

const demoSuggestions = [
  {
    title: "钥匙可能在玄关托盘附近",
    summary: "样例线索显示钥匙最后出现在玄关左侧托盘。你可以点开依据，看看管家如何说明不确定性。",
  },
  {
    title: "有一项会议后待办适合收尾",
    summary: "今天有一条事项被整理为待确认提醒。它不会替你判断远程任务状态，只建议回看确认。",
  },
  {
    title: "可以安排 5 分钟活动一下",
    summary: "演示节律显示你已经连续坐了一段时间，适合短暂活动肩颈或补充光照。",
  },
];

const demoTimelineItems = [
  {
    id: "demo-object-location",
    source: "phone_album_demo",
    event_type: "object_location",
    title: "钥匙可能在玄关托盘附近",
    summary: "样例线索显示钥匙最后出现在玄关左侧托盘。你可以查看依据，理解管家如何说明不确定性。",
    started_at: new Date().toISOString(),
    confidence: 0.78,
    evidence_boundary: "这是样例数据，只用于展示物品回溯体验；不代表你的真实相册或本机记录。",
    evidence_refs: [{source: "phone_album_demo", evidence_level: "demo_reference"}],
  },
  {
    id: "demo-follow-up",
    source: "butler_demo",
    event_type: "insight",
    title: "会议后有一项待办适合收尾",
    summary: "样例提醒显示一条会议后事项适合回看确认。OpenButler 不会替你判断远程任务状态。",
    started_at: new Date().toISOString(),
    confidence: 0.72,
    evidence_boundary: "这是样例数据，用于展示提醒和依据说明；真实模式需要你在本机运行并主动授权。",
    evidence_refs: [{source: "butler_demo", evidence_level: "demo_reference"}],
  },
  {
    id: "demo-rest-rhythm",
    source: "workstation_demo",
    event_type: "lighting_context",
    title: "可以安排 5 分钟活动一下",
    summary: "样例节律显示你已经连续坐了一段时间，适合短暂活动肩颈或补充光照。",
    started_at: new Date().toISOString(),
    confidence: 0.7,
    evidence_boundary: "这是样例数据，只说明 OpenButler 如何给出温和建议；不代表医学或心理判断。",
    evidence_refs: [{source: "workstation_demo", evidence_level: "demo_reference"}],
  },
];

export function buildTodayHomeViewModel(
  home: Record<string, any> | null,
  timelineItems: Array<Record<string, any>>,
  activationMode: ActivationMode = "not_started",
): TodayHomeViewModel {
  const metrics = home?.metrics ?? {};
  const insights = Array.isArray(home?.insights) ? home.insights : [];
  const sourceCount = Number(metrics.source_event_count ?? 0);
  const focusMinutes = Number(metrics.focus_minutes ?? 0);
  const insightCount = insights.length;
  const hasLocalSignals = sourceCount > 0 || timelineItems.some((item) => {
    const source = String(item?.source ?? "");
    return source === "pc_activity" || source === "minecontext" || source === "butler_core";
  });
  const demoMode = activationMode === "demo" || (!hasLocalSignals && (isDemoLike(home) || isDemoLike(timelineItems)));
  const nonDataQualityInsights = insights.filter((item: Record<string, any>) => item.type !== "data_quality_notice");
  const mode: TodayMode = activationMode === "demo"
    ? "active"
    : sourceCount <= 0
    ? "new_user"
    : nonDataQualityInsights.length
      ? "active"
      : "connected_no_insights";

  const headline = mode === "new_user"
    ? "先让 OpenButler 认识你的一天。"
    : "我已经帮你整理好今天值得回看的 3 件事";

  const subheadline = mode === "new_user"
    ? "本地模式需要你在自己的电脑上运行，并主动授权要读取的线索。"
    : demoMode
      ? "包括物品回溯、待办提醒和休息建议。所有内容都是演示，不会读取你的真实数据。"
      : `其中 ${insightCount} 条值得关注，约 ${Math.round(focusMinutes)} 分钟稳定专注时段。`;

  const sourceInsights = demoMode && !insights.length
    ? demoSuggestions.map((item, index) => ({
      id: `demo_suggestion_${index + 1}`,
      title: item.title,
      summary: item.summary,
      type: index === 0 ? "object_location" : index === 1 ? "task_followup" : "break_suggestion",
      status: "new",
      priority: 90 - index,
      confidence: 0.78 - index * 0.04,
      evidence_boundary: "这是样例数据，用于展示管家提醒和依据说明；不会读取你的真实本机数据。",
      evidence_refs: [{source: "demo", evidence_level: "demo_reference"}],
    }))
    : insights;

  const topSuggestions = sourceInsights
    .slice()
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(b.priority ?? 0) - Number(a.priority ?? 0))
    .slice(0, 3)
    .map((item: Record<string, any>, index: number) => ({
      id: String(item.id),
      title: demoMode
        ? (demoSuggestions[index]?.title ?? userFacingDemoText(item.title ?? insightTypeLabel(item.type), insightTypeLabel(item.type)))
        : userFacingDemoText(item.title ?? insightTypeLabel(item.type), insightTypeLabel(item.type)),
      summary: demoMode
        ? (demoSuggestions[index]?.summary ?? userFacingDemoText(item.summary ?? "这是一条管家提醒。"))
        : userFacingDemoText(item.summary ?? "这是一条管家提醒。"),
      status: statusLabel(item.status),
      type: insightTypeLabel(item.type),
      priority: Number(item.priority ?? 0),
      confidence: Number(item.confidence ?? 0),
      evidenceBoundary: String(item.evidence_boundary ?? "依据来自本地时间线，远程系统状态需要回源确认。"),
      raw: item,
    }));

  const commandCenter: TodayCommandCenter = {
    headline: mode === "new_user" ? "今天从哪儿开始？" : "今天先看这几件事",
    oneLineStatus: mode === "new_user"
      ? "先看样例，或了解本地模式。授权后会有今日概览、时间线和依据。"
      : demoMode
        ? "有 3 条样例记录值得回看，1 条建议适合先处理。"
        : insightCount > 0
          ? `有 ${insightCount} 条提醒值得回看，约 ${Math.round(focusMinutes)} 分钟稳定专注时段。`
          : `${sourceCount} 条本地信号已经整理好，暂时没有需要打扰你的提醒。`,
    primaryAction: mode === "new_user" ? "先看样例" : topSuggestions.length ? "看今天建议" : "查看时间线",
    topSuggestion: topSuggestions[0] ?? null,
    keyNumbers: mode === "new_user"
      ? [
        {label: "样例", value: "可查看", description: "不读真实数据"},
        {label: "授权", value: "需确认", description: "你确认后才读取"},
        {label: "依据", value: "会保留", description: "每条提醒可复核"},
      ]
      : demoMode
        ? [
          {label: "信号", value: "4 条", description: "样例线索"},
          {label: "提醒", value: "3 条", description: "适合先看"},
          {label: "专注", value: "42 分钟", description: "样例片段"},
        ]
        : [
          {label: "信号", value: numberText(sourceCount, " 条"), description: "已整理"},
          {label: "提醒", value: numberText(insightCount, " 条"), description: "可回看"},
          {label: "专注", value: numberText(focusMinutes, " 分钟"), description: "估算片段"},
        ],
    privacyHint: demoMode
      ? "样例体验，未读取你的真实数据。"
      : mode === "new_user"
        ? "真实模式需要你主动授权。"
        : "只在本机整理。",
    dataMode: demoMode ? "sample" : mode === "new_user" ? "not_connected" : "local",
  };

  return {
    mode,
    headline,
    subheadline,
    primaryAction: mode === "new_user" ? "开始整理今天" : "看今天建议",
    summaryLine: mode === "new_user"
      ? "了解本地模式后再决定是否授权。"
      : demoMode
        ? "3 件事 · 2 条提醒 · 1 个建议"
        : `${sourceCount} 条信号 · ${insightCount} 条提醒 · ${Math.round(focusMinutes)} 分钟专注`,
    demoMode,
    statusCards: [
      {
        title: "值得回看",
        value: demoMode ? "3 件" : numberText(metrics.source_event_count, " 条"),
        description: demoMode ? "管家替你整理出的今日事项" : "已纳入今日概览的本地信号",
        tone: "blue",
      },
      {
        title: "管家提醒",
        value: demoMode ? "2 条" : numberText(insights.length, " 条"),
        description: "需要你决定或回看的建议",
        tone: "red",
      },
      {
        title: "节律建议",
        value: demoMode ? "1 个" : numberText(metrics.focus_minutes, " 分钟"),
        description: demoMode ? "久坐后适合短暂活动" : "从本地时间线估算的稳定工作片段",
        tone: "green",
      },
      {
        title: "数据质量",
        value: mode === "new_user" ? "待授权" : "可用",
        description: mode === "new_user" ? "授权后才开始整理" : "当前结论带有边界说明",
        tone: "amber",
      },
    ],
    topSuggestions,
    sceneCards: [
      {
        title: "物品回溯",
        value: demoMode ? "钥匙" : numberText(metrics.context_switch_count, " 次"),
        description: demoMode ? "演示如何说明物品位置" : "今日上下文切换量",
        tone: "amber",
      },
      {
        title: "生活记录",
        value: numberText(timelineItems.length, " 条"),
        description: "已经整理进时间线的片段",
        tone: "blue",
      },
      {
        title: "待办提醒",
        value: demoMode ? "1 项" : numberText(metrics.workflow_candidate_count ?? 0, " 个"),
        description: demoMode ? "会议后事项适合收尾" : "可能值得沉淀的重复流程",
        tone: "green",
      },
      {
        title: "授权状态",
        value: mode === "new_user" ? "未就绪" : "可控",
        description: demoMode ? "当前只展示样例内容" : "优先使用本地观察和只在本机整理模式",
        tone: "red",
      },
    ],
    timelinePreview: (demoMode && !timelineItems.length ? demoTimelineItems : timelineItems).slice(0, 5).map(toTimelineMoment),
    dataQualityText: mode === "new_user"
      ? "当前还没有足够数据，OpenButler 不会编造今日结论。"
      : "所有提醒都保留依据和边界说明。",
    commandCenter,
  };
}
