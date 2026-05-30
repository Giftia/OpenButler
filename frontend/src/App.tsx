import {useEffect, useMemo, useState} from "react";
import {
  Bot,
  Boxes,
  BrainCircuit,
  CalendarDays,
  Camera,
  CheckCircle2,
  ClipboardList,
  CloudOff,
  Database,
  Eye,
  FileAudio,
  FileText,
  Home,
  Inbox,
  KeyRound,
  Lightbulb,
  Loader2,
  Lock,
  MapPin,
  MessageSquareText,
  PlugZap,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Target,
  Trophy,
  Video,
  Watch
} from "lucide-react";
import {
  askButler,
  createButlerGoal,
  deleteButlerData,
  deleteWorkstationData,
  dismissInsight,
  generateButlerBriefing,
  generateButlerInsights,
  getButlerBriefingsToday,
  getButlerDataInsufficientDrill,
  getButlerGoals,
  getButlerHome,
  getButlerInsights,
  getButlerLatestHarnessRuns,
  getButlerMetricsRange,
  getButlerMetricsToday,
  getButlerMVPReport,
  getButlerProductizationDemoPack,
  getButlerReadiness,
  getButlerSettings,
  getButlerTimeline,
  getButlerProductizationObjectiveStatus,
  getEvents,
  getPlugins,
  getPrivacyMode,
  getWorkstationCameras,
  getWorkstationEvents,
  getWorkstationSettings,
  getWorkstationStatus,
  getWorkstationSummaryToday,
  getPCActivityEvents,
  getPCActivitySettings,
  getPCActivityStatus,
  getPCActivitySummaryToday,
  getPCActivityWorkflowCandidates,
  importPCActivities,
  queryPCActivityAtTime,
  rebuildButlerTimeline,
  resetButlerDemo,
  runButlerDemoPath,
  searchPCActivity,
  snoozeInsight,
  submitInsightFeedback,
  setPrivacyMode,
  startWorkstationSession,
  stopWorkstationSession,
  updateButlerGoal,
  updatePCActivitySettings,
  deletePCActivityEvents,
  updateWorkstationSettings,
  simulateEvents
} from "./lib/api";
import {buildTodayHomeViewModel} from "./lib/butlerUiAdapter";
import {
  groupTimelineByDate,
  timelineCategoryLabel,
  timelineImportanceLabel,
  toTimelineMoment,
  type TimelineMoment
} from "./lib/timelineUiAdapter";
import {insightTypeLabel, privacyModeLabel, sourceLabel, statusLabel, userFacingDemoText} from "./lib/userFacingLabels";
import type {EventItem, PluginManifest, PrivacyMode} from "./types";

type PageKey =
  | "butler"
  | "dashboard"
  | "ingest"
  | "plugins"
  | "timeline"
  | "chat"
  | "workstation"
  | "pcActivity"
  | "butlerInbox"
  | "metrics"
  | "goals"
  | "privacy";

const primaryNavItems: Array<{key: PageKey; label: string; icon: typeof Home}> = [
  {key: "butler", label: "今日", icon: Inbox},
  {key: "timeline", label: "时间线", icon: CalendarDays},
  {key: "chat", label: "问管家", icon: MessageSquareText},
  {key: "privacy", label: "我的", icon: ShieldCheck}
];

const advancedNavItems: Array<{key: PageKey; label: string; icon: typeof Home}> = [
  {key: "dashboard", label: "原型看板", icon: Home},
  {key: "pcActivity", label: "电脑活动", icon: Database},
  {key: "workstation", label: "视觉感知", icon: Camera},
  {key: "plugins", label: "技能插件", icon: BrainCircuit},
  {key: "metrics", label: "今日量化", icon: BrainCircuit},
  {key: "goals", label: "目标设置", icon: Target},
  {key: "butlerInbox", label: "提醒收件箱", icon: ClipboardList},
  {key: "ingest", label: "数据接入", icon: PlugZap}
];

const navItems = [...primaryNavItems, ...advancedNavItems];

function routeForPage(key: PageKey) {
  return {
    butler: "/butler",
    timeline: "/timeline",
    chat: "/assistant",
    privacy: "/me",
    dashboard: "/dashboard",
    pcActivity: "/pc-activity-context",
    workstation: "/vision",
    plugins: "/plugins",
    metrics: "/metrics",
    goals: "/goals",
    butlerInbox: "/butler/inbox",
    ingest: "/ingest"
  }[key];
}

const sourceCatalog = [
  {name: "手机相册", icon: Smartphone, mode: "strict", description: "照片 EXIF、场景、物品、人物主体索引"},
  {name: "视频流", icon: Video, mode: "strict", description: "定时抽帧、轨迹、区域变化"},
  {name: "智能眼镜", icon: Eye, mode: "strict", description: "第一视角片段、光照、手边物品"},
  {name: "备忘录", icon: FileText, mode: "strict", description: "任务、习惯、承诺、家庭约定"},
  {name: "电话录音/语音备忘录", icon: FileAudio, mode: "strict", description: "本地转写、说话人、行动项"},
  {name: "定位轨迹", icon: MapPin, mode: "basic", description: "外部地图服务可选，strict 下只保留本地轨迹"},
  {name: "交易记录", icon: ReceiptText, mode: "basic", description: "账单分类、异常支出、订阅提醒"},
  {name: "智能家居", icon: Lightbulb, mode: "strict", description: "传感器、灯光、门锁、能耗事件"},
  {name: "OpenClaw 技能", icon: Bot, mode: "strict", description: "SKILL.md + HTTP 工具接口"}
];

const stageLabels: Record<string, string> = {
  preprocessor: "前处理",
  timeline_processor: "中处理",
  butler_tool: "后处理"
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function groupByStage(plugins: PluginManifest[]) {
  return plugins.reduce<Record<string, PluginManifest[]>>((acc, plugin) => {
    acc[plugin.stage] = [...(acc[plugin.stage] ?? []), plugin];
    return acc;
  }, {});
}

function App() {
  const currentPath = window.location.pathname;
  const [page, setPage] = useState<PageKey>(
    currentPath.includes("butler/inbox")
      ? "butlerInbox"
      : currentPath.includes("metrics")
        ? "metrics"
        : currentPath.includes("goals")
          ? "goals"
          : currentPath.includes("pc-activity-context")
      ? "pcActivity"
      : currentPath.includes("vision")
        ? "workstation"
        : currentPath.includes("timeline")
          ? "timeline"
          : currentPath.includes("assistant") || currentPath.includes("butler/chat")
            ? "chat"
            : currentPath.includes("me") || currentPath.includes("settings") || currentPath.includes("privacy")
              ? "privacy"
              : currentPath.includes("plugins")
                ? "plugins"
                : currentPath.includes("ingest")
                  ? "ingest"
                  : currentPath.includes("dashboard")
                    ? "dashboard"
                    : currentPath.includes("butler")
            ? "butler"
            : "butler"
  );
  const [events, setEvents] = useState<EventItem[]>([]);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [privacyMode, setMode] = useState<PrivacyMode>("basic");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh(q = search) {
    setError(null);
    const [eventResult, pluginResult, modeResult] = await Promise.all([
      getEvents(q),
      getPlugins(),
      getPrivacyMode()
    ]);
    setEvents(eventResult.items);
    setPlugins(pluginResult.items);
    setMode(modeResult.mode);
  }

  useEffect(() => {
    refresh()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleSimulate() {
    setLoading(true);
    try {
      await simulateEvents("manual_web_demo");
      await refresh("");
      setSearch("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePrivacy(mode: PrivacyMode) {
    await setPrivacyMode(mode);
    await refresh();
  }

  const stats = useMemo(() => {
    const objectCount = new Set(events.map((event) => event.object_label).filter(Boolean)).size;
    const lightScores = events
      .filter((event) => event.event_type === "light_score" && typeof event.score === "number")
      .map((event) => event.score as number);
    const avgLight = lightScores.length
      ? Math.round(lightScores.reduce((total, score) => total + score, 0) / lightScores.length)
      : 0;
    const achievements = events.filter((event) => event.event_type === "achievement").length;
    return {objectCount, avgLight, achievements, events: events.length};
  }, [events]);

  const CurrentPage = {
    butler: <ButlerHome />,
    dashboard: (
      <Dashboard
        events={events}
        stats={stats}
        loading={loading}
        onSimulate={handleSimulate}
      />
    ),
    ingest: <Ingest privacyMode={privacyMode} />,
    plugins: <Plugins plugins={plugins} privacyMode={privacyMode} />,
    timeline: (
      <UnifiedTimeline />
    ),
    chat: <Chat />,
    workstation: <WorkstationVision privacyMode={privacyMode} />,
    pcActivity: <PCActivityContext privacyMode={privacyMode} />,
    butlerInbox: <ButlerInbox />,
    metrics: <MetricsPage />,
    goals: <GoalsPage />,
    privacy: (
      <Privacy
        mode={privacyMode}
        onChange={handlePrivacy}
        plugins={plugins}
      />
    )
  }[page];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Bot size={22} /></div>
          <div>
            <strong>OpenButler</strong>
            <span>Local-first AI Butler</span>
          </div>
        </div>
        <nav>
          {primaryNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                data-nav-key={item.key}
                className={page === item.key ? "active" : ""}
                onClick={() => {
                  setPage(item.key);
                  window.history.replaceState(null, "", routeForPage(item.key));
                }}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <details className="advanced-nav">
            <summary>高级与实验室</summary>
            <div>
              {advancedNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    data-nav-key={item.key}
                    className={page === item.key ? "active" : ""}
                    onClick={() => {
                      setPage(item.key);
                      window.history.replaceState(null, "", routeForPage(item.key));
                    }}
                    title={item.label}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </details>
        </nav>
        <div className="mode-chip">
          {privacyMode === "strict" ? <CloudOff size={16} /> : <ShieldCheck size={16} />}
          <span>{privacyModeLabel(privacyMode)}</span>
        </div>
      </aside>

      <main>
        {!primaryNavItems.some((item) => item.key === page) && <header className="topbar">
          <div>
            <p className="eyebrow">个人/家庭多模态事件湖原型</p>
            <h1>{navItems.find((item) => item.key === page)?.label}</h1>
          </div>
          <button className="primary" onClick={handleSimulate} disabled={loading}>
            {loading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            <span>生成演示记录</span>
          </button>
        </header>}
        {error && <div className="error">API 连接失败：{error}</div>}
        {CurrentPage}
      </main>
    </div>
  );
}

function Dashboard({
  events,
  stats,
  loading,
  onSimulate
}: {
  events: EventItem[];
  stats: {objectCount: number; avgLight: number; achievements: number; events: number};
  loading: boolean;
  onSimulate: () => void;
}) {
  const objects = events.filter((event) => event.object_label).slice(0, 5);
  const achievements = events.filter((event) => event.event_type === "achievement").slice(0, 3);
  return (
    <div className="page-grid">
      <section className="metrics">
        <Metric icon={Database} label="今日上下文事件" value={stats.events} tone="blue" />
        <Metric icon={Boxes} label="已识别物品" value={stats.objectCount} tone="green" />
        <Metric icon={Lightbulb} label="光照评分" value={`${stats.avgLight || "--"}/100`} tone="amber" />
        <Metric icon={Trophy} label="小成就" value={stats.achievements} tone="red" />
      </section>

      <section className="wide-panel context-panel">
        <div className="section-title">
          <h2>今日上下文流</h2>
          <button className="ghost" onClick={onSimulate} disabled={loading}>
            <RefreshCw size={16} />
            <span>再生成一组</span>
          </button>
        </div>
        <div className="event-list compact">
          {events.slice(0, 5).map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>已识别物品</h2></div>
        <div className="object-grid">
          {objects.map((event) => (
            <div className="object-tile" key={event.id}>
              <KeyRound size={18} />
              <strong>{event.object_label}</strong>
              <span>{event.location}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>奖状栏</h2></div>
        <div className="achievement-list">
          {achievements.map((event) => (
            <div key={event.id} className="achievement">
              <Trophy size={18} />
              <div>
                <strong>{event.title}</strong>
                <span>{event.summary}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({icon: Icon, label, value, tone}: {icon: typeof Home; label: string; value: number | string; tone: string}) {
  return (
    <div className={`metric ${tone}`}>
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Ingest({privacyMode}: {privacyMode: PrivacyMode}) {
  return (
    <section className="wide-panel">
      <div className="section-title">
        <h2>Capture Gateway</h2>
        <p>上传、定时截图、抽帧、转写、位置与家庭事件统一进入本地事件湖。</p>
      </div>
      <div className="source-grid">
        {sourceCatalog.map((source) => {
          const Icon = source.icon;
          const disabled = privacyMode === "strict" && source.mode === "basic";
          return (
            <article className={disabled ? "source disabled" : "source"} key={source.name}>
              <Icon size={21} />
              <div>
                <strong>{source.name}</strong>
                <span>{source.description}</span>
              </div>
              <small>{disabled ? "strict 下需本地替代" : "可接入"}</small>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Plugins({plugins, privacyMode}: {plugins: PluginManifest[]; privacyMode: PrivacyMode}) {
  const grouped = groupByStage(plugins);
  return (
    <div className="pipeline">
      {["preprocessor", "timeline_processor", "butler_tool"].map((stage) => (
        <section className="panel" key={stage}>
          <div className="section-title">
            <h2>{stageLabels[stage]}</h2>
            <p>{stage}</p>
          </div>
          <div className="plugin-list">
            {(grouped[stage] ?? []).map((plugin) => (
              <article className="plugin" key={plugin.id}>
                <div>
                  <strong>{plugin.name}</strong>
                  <span>{plugin.id} · v{plugin.version}</span>
                </div>
                <div className="plugin-meta">
                  <small>{plugin.model_requirements.provider}</small>
                  <small>{plugin.privacy_level}</small>
                </div>
                <p>{plugin.prompt_template}</p>
                <div className={plugin.runtime.available ? "status ok" : "status blocked"}>
                  {plugin.runtime.available ? <CheckCircle2 size={15} /> : <Lock size={15} />}
                  <span>
                    {plugin.runtime.available
                      ? `${privacyMode} 模式可运行`
                      : plugin.runtime.blocked_reasons.join("；")}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Timeline({
  events,
  search,
  setSearch,
  onSearch
}: {
  events: EventItem[];
  search: string;
  setSearch: (value: string) => void;
  onSearch: () => void;
}) {
  return (
    <section className="wide-panel">
      <div className="searchbar">
        <Search size={18} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onSearch()}
          placeholder="搜索钥匙、光照、餐桌、玄关..."
        />
        <button className="secondary" onClick={onSearch}>搜索</button>
      </div>
      <div className="event-list">
        {events.map((event) => (
          <EventRow key={event.id} event={event} verbose />
        ))}
      </div>
    </section>
  );
}

function ButlerHome() {
  const [home, setHome] = useState<Record<string, any> | null>(null);
  const [readiness, setReadiness] = useState<Record<string, any> | null>(null);
  const [mvpReport, setMvpReport] = useState<Record<string, any> | null>(null);
  const [latestHarnessRuns, setLatestHarnessRuns] = useState<Array<Record<string, any>>>([]);
  const [objectiveStatus, setObjectiveStatus] = useState<Record<string, any> | null>(null);
  const [demoPack, setDemoPack] = useState<Record<string, any> | null>(null);
  const [briefings, setBriefings] = useState<Array<Record<string, any>>>([]);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoMessage, setDemoMessage] = useState("");
  const [drillReport, setDrillReport] = useState<Record<string, any> | null>(null);
  const [drillBusy, setDrillBusy] = useState(false);
  const [drillMessage, setDrillMessage] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [mvpActionBusy, setMvpActionBusy] = useState("");
  const [mvpActionMessage, setMvpActionMessage] = useState("");
  const [timelineItems, setTimelineItems] = useState<Array<Record<string, any>>>([]);

  async function refreshHome() {
    const [homeResult, readinessResult, reportResult, briefingResult, timelineResult] = await Promise.all([
      getButlerHome(),
      getButlerReadiness(),
      getButlerMVPReport(),
      getButlerBriefingsToday(),
      getButlerTimeline()
    ]);
    const harnessResult = await getButlerLatestHarnessRuns();
    const objectiveResult = await getButlerProductizationObjectiveStatus();
    const demoPackResult = await getButlerProductizationDemoPack();
    setHome(homeResult);
    setReadiness(readinessResult);
    setMvpReport(reportResult);
    setLatestHarnessRuns(harnessResult.items ?? []);
    setObjectiveStatus(objectiveResult);
    setDemoPack(demoPackResult);
    setBriefings(briefingResult.items);
    setTimelineItems(timelineResult.items ?? []);
  }

  useEffect(() => {
    refreshHome().catch(() => undefined);
  }, []);

  async function generate() {
    setBusy(true);
    try {
      await generateButlerInsights(true);
      await generateButlerBriefing("evening");
      await refreshHome();
    } finally {
      setBusy(false);
    }
  }

  async function importTodayForButler() {
    setImportBusy(true);
    setImportMessage("");
    try {
      const result = await importPCActivities({lookback_hours: 24, limit: 200});
      setImportMessage(`已导入 ${result.count ?? result.created?.length ?? 0} 条 PC 活动线索。`);
      await refreshHome();
    } catch (error) {
      setImportMessage("MineContext 暂不可用，无法导入今日 PC 活动。");
    } finally {
      setImportBusy(false);
    }
  }

  async function runDemoPath() {
    setDemoBusy(true);
    setDemoMessage("");
    try {
      const result = await runButlerDemoPath({lookback_hours: 24, limit: 200, briefing_type: "evening"});
      const steps = result.steps ?? {};
      const importStep = steps.pc_activity_import ?? {};
      const timelineStep = steps.timeline_rebuild ?? {};
      const insightStep = steps.insight_generation ?? {};
      const briefingStep = steps.briefing_generation ?? {};
      await refreshHome();
      const parts = [
        `导入今日 PC Activity ${importStep.count ?? 0} 条`,
        `重建 timeline ${timelineStep.count ?? 0} 条`,
        `生成 insights ${insightStep.count ?? 0} 条`,
        `生成${briefingStep.type === "evening" ? "晚间" : ""}简报 1 条`,
      ];
      setDemoMessage(`${parts.join("；")}。${importStep.message ? ` ${importStep.message}` : ""}`);
    } catch (error) {
      setDemoMessage("演示路径执行失败，请检查后端服务或 MineContext 接入状态。");
    } finally {
      setDemoBusy(false);
    }
  }

  async function resetDemoPath() {
    setResetBusy(true);
    setDemoMessage("");
    try {
      const result = await resetButlerDemo();
      const reset = result.reset ?? {};
      const preserved = result.preserved ?? {};
      await refreshHome();
      setDemoMessage(
        `已重置演示数据：timeline ${reset.timeline ?? 0}、metrics ${reset.metrics ?? 0}、insights ${reset.insights ?? 0}、briefings ${reset.briefings ?? 0}、harness summaries ${reset.harness_runs ?? 0}。` +
          `PC Activity 保留 ${preserved.pc_activity_events_after ?? 0} 条；MineContext 原始数据删除数为 ${preserved.minecontext_source_deleted ?? 0}。`
      );
    } catch (error) {
      setDemoMessage("演示重置失败，请检查后端服务状态。");
    } finally {
      setResetBusy(false);
    }
  }

  async function runDataInsufficientDrill() {
    setDrillBusy(true);
    setDrillMessage("");
    try {
      const result = await getButlerDataInsufficientDrill();
      setDrillReport(result);
      const harnessResult = await getButlerLatestHarnessRuns();
      setLatestHarnessRuns(harnessResult.items ?? []);
      const failedCount = (result.acceptance ?? []).filter((item: Record<string, any>) => item.status !== "passed").length;
      setDrillMessage(
        `只读演练完成：状态 ${result.status}，需要处理 ${failedCount} 项；dry_run=${String(result.dry_run)}，mutates_data=${String(result.mutates_data)}。`
      );
    } catch (error) {
      setDrillMessage("数据不足演练失败，请检查后端服务状态。");
    } finally {
      setDrillBusy(false);
    }
  }

  function navigateTo(path: string) {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  async function handleMvpNextAction(action: Record<string, any>) {
    const type = String(action?.type ?? "review_report");
    setMvpActionBusy(type);
    setMvpActionMessage("");
    try {
      if (type === "import_pc_activity") {
        const result = await importPCActivities({lookback_hours: 24, limit: 200});
        setMvpActionMessage(`已导入 ${result.count ?? result.created?.length ?? 0} 条 PC Activity。`);
      } else if (type === "rebuild_timeline") {
        const result = await rebuildButlerTimeline();
        setMvpActionMessage(`已重建统一时间线 ${result.count ?? 0} 条。`);
      } else if (type === "generate_metrics") {
        await getButlerMetricsToday();
        setMvpActionMessage("已刷新今日指标。");
      } else if (type === "generate_insights") {
        const result = await generateButlerInsights(true);
        setMvpActionMessage(`已生成主动洞察 ${result.count ?? result.items?.length ?? 0} 条。`);
      } else if (type === "generate_briefing") {
        await generateButlerBriefing("evening");
        setMvpActionMessage("已生成晚间简报。");
      } else if (type === "open_inbox") {
        navigateTo("/butler/inbox");
        setMvpActionMessage("已打开 Butler Inbox。");
      } else if (type === "review_privacy_settings") {
        navigateTo("/privacy");
        setMvpActionMessage("已打开隐私设置。");
      } else if (type === "review_openclaw_tools" || type === "review_evidence_boundaries" || type === "review_report") {
        setMvpActionMessage("这是复核类建议，请查看当前面板和仓库文档；不会自动写外部系统。");
      } else if (type === "stop_and_review") {
        setMvpActionMessage("该项需要人工复核，已停止自动处理。");
      } else {
        setMvpActionMessage("该建议不支持自动执行，请人工复核。");
      }
      await refreshHome();
    } catch (error) {
      setMvpActionMessage("建议动作执行失败，请检查后端服务、MineContext 状态或隐私设置。");
    } finally {
      setMvpActionBusy("");
    }
  }

  const metrics = home?.metrics ?? {};
  const insights = home?.insights ?? [];
  const dataInsufficient = Number(metrics.source_event_count ?? 0) === 0 || insights.some((item: Record<string, any>) => item.type === "data_quality_notice");
  const view = buildTodayHomeViewModel(home, timelineItems);
  const primarySuggestion = view.topSuggestions[0];
  return (
    <div className="today-page">
      <section className="today-hero">
        <div className="today-hero-copy">
          <p className="eyebrow">OpenButler 主动 AI 管家 · {view.demoMode ? "演示数据" : "本地数据"} · {privacyModeLabel("strict")}</p>
          <h1>{view.headline}</h1>
          <p className="hero-summary">{view.subheadline}</p>
          <p>{view.demoMode ? "这是演示体验，用来展示它如何照看物品、待办和生活节律。" : "OpenButler 会把授权的本地线索整理成今日概览、提醒和可复核依据。"}</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => document.getElementById("today-suggestions")?.scrollIntoView({behavior: "smooth"})}>
              <CheckCircle2 size={17} />
              <span>{view.primaryAction}</span>
            </button>
            <button className="secondary" onClick={() => navigateTo("/chat")}>问管家</button>
            <button className="ghost" onClick={() => navigateTo("/timeline")}>查看全部记录</button>
          </div>
          <div className="summary-chips">
            <span>{view.statusCards[0]?.value ?? "0 条"}信号</span>
            <span>{view.statusCards[1]?.value ?? "0 条"}提醒</span>
            <span>{view.statusCards[2]?.value ?? "0 分钟"}专注</span>
            <span>{view.demoMode ? "演示数据" : "完全本地"}</span>
          </div>
        </div>
        <div className="today-hero-status">
          <span className="privacy-chip">{view.demoMode ? "演示数据" : privacyModeLabel("strict")}</span>
          <strong>{view.summaryLine}</strong>
          <span>{view.demoMode ? "演示内容不会读取你的真实数据。" : "今日已整理信号"}</span>
          <small>{view.dataQualityText}</small>
        </div>
      </section>

      {view.mode === "new_user" && (
        <ProgressiveOnboarding
          onImport={importTodayForButler}
          importBusy={importBusy}
          importMessage={importMessage}
          onOpenAdvanced={() => navigateTo("/pc-activity-context")}
        />
      )}

      <section className="today-status-grid compact-home-stats">
        {view.statusCards.map((card) => <TodayStatusTile card={card} key={card.title} />)}
      </section>

      <section className="today-focus-layout">
        <div className="today-main-column">
          <section className="today-panel" id="today-suggestions">
            <div className="section-title">
              <div>
                <h2>管家建议</h2>
                <p>我先把最值得你处理的事放在这里，依据需要时再展开。</p>
              </div>
              <button className="ghost" onClick={() => navigateTo("/butler/inbox")}>查看全部</button>
            </div>
            {view.topSuggestions.length ? (
              <div className="friendly-suggestion-list">
                {view.topSuggestions.map((suggestion) => (
                  <FriendlySuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    onChanged={refreshHome}
                  />
                ))}
              </div>
            ) : (
              <div className="friendly-empty">
                <strong>{dataInsufficient ? "还没有足够信号" : "暂时没有需要打扰你的事"}</strong>
                <span>{dataInsufficient ? "OpenButler 不会用空数据编造结论。你可以先连接本机观察或查看高级入口。" : "已连接数据源，但目前没有高优先级提醒。"}</span>
              </div>
            )}
          </section>

          <section className="today-panel">
            <div className="section-title">
              <div>
                <h2>今日时间线预览</h2>
                <p>像生活记录一样保存重要片段，而不是展示技术日志。</p>
              </div>
              <button className="ghost" onClick={() => navigateTo("/timeline")}>完整时间线</button>
            </div>
            <LifeTimelinePreview items={view.timelinePreview} />
          </section>
        </div>

        <aside className="today-side-column">
          <section className="today-panel">
            <div className="section-title"><h2>场景信号</h2></div>
            <div className="scene-card-grid">
              {view.sceneCards.map((card) => <SceneSignalCard card={card} key={card.title} />)}
            </div>
          </section>

          <section className="today-panel">
            <div className="section-title"><h2>下一步</h2></div>
            <div className="next-action-card">
              <strong>{primarySuggestion?.title ?? (dataInsufficient ? "先连接一个本地数据源" : "查看今天整理好的时间线")}</strong>
              <span>{primarySuggestion?.summary ?? (dataInsufficient ? "连接电脑活动后，OpenButler 会开始整理今日概览和依据。" : "当前没有紧急提醒，可以从完整时间线继续回看。")}</span>
              <button className="secondary" onClick={() => navigateTo(dataInsufficient ? "/pc-activity-context" : "/timeline")}>
                {dataInsufficient ? "去连接" : "去查看"}
              </button>
            </div>
          </section>
        </aside>
      </section>

      <details className="advanced-lab-panel developer-only-panel">
        <summary>开发者设置</summary>
        <div className="advanced-lab-grid">
          <button className="secondary" onClick={runDemoPath} disabled={demoBusy}>
            {demoBusy ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
            <span>运行演示闭环</span>
          </button>
          <button className="secondary" onClick={resetDemoPath} disabled={resetBusy}>
            {resetBusy ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            <span>重置演示数据</span>
          </button>
          <button className="secondary" onClick={runDataInsufficientDrill} disabled={drillBusy}>
            {drillBusy ? <Loader2 className="spin" size={17} /> : <CloudOff size={17} />}
            <span>演练空数据路径</span>
          </button>
          <button className="secondary" onClick={() => navigateTo("/metrics")}>查看今日量化</button>
          <button className="secondary" onClick={() => navigateTo("/goals")}>目标设置</button>
          <button className="secondary" onClick={() => navigateTo("/plugins")}>技能插件</button>
        </div>
        {(demoMessage || drillMessage || mvpActionMessage) && (
          <div className="suggestion-box">
            <strong>实验室运行结果</strong>
            {demoMessage && <span>{demoMessage}</span>}
            {drillMessage && <span>{drillMessage}</span>}
            {mvpActionMessage && <span>{mvpActionMessage}</span>}
          </div>
        )}
        <div className="evidence">
          <small>readiness {String(readiness?.status ?? "not_loaded")}</small>
          <small>mvp {String(mvpReport?.status ?? "not_loaded")}</small>
          <small>briefings {String(briefings.length)}</small>
          <small>harness_runs {String(latestHarnessRuns.length)}</small>
          <small>objectives {String((objectiveStatus?.objectives ?? []).length)}</small>
          <small>demo_pack {String(demoPack?.status ?? "not_loaded")}</small>
        </div>
        <p className="policy-note">{home?.overview?.evidence_boundary ?? "今日概览只基于已授权的本地数据源，远程系统状态需要回源确认。"}</p>
      </details>
    </div>
  );
  /*
  return (
    <div className="workstation-page">
      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>今日主动概览</h2>
            <p>{home?.overview?.headline ?? "正在读取今日 OpenButler 时间线。"}</p>
          </div>
          <div className="inline-actions">
            <button className="primary" onClick={runDemoPath} disabled={demoBusy}>
              {demoBusy ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
              <span>运行演示闭环</span>
            </button>
            <button className="secondary" onClick={resetDemoPath} disabled={resetBusy}>
              {resetBusy ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              <span>重置演示数据</span>
            </button>
            <button className="secondary" onClick={runDataInsufficientDrill} disabled={drillBusy}>
              {drillBusy ? <Loader2 className="spin" size={17} /> : <CloudOff size={17} />}
              <span>演练空数据路径</span>
            </button>
            <button className="secondary" onClick={generate} disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              <span>生成今日洞察</span>
            </button>
          </div>
        </div>
        <div className="suggestion-box">
          <strong>一键演示路径</strong>
          <span>按顺序执行：导入今日 PC Activity、重建统一时间线、生成主动洞察、生成晚间简报，并刷新 MVP readiness 面板。</span>
          <span>重置演示数据只清理 OpenButler 派生的 timeline、metrics、insights、briefings 和 Harness summaries；不会删除 PC Activity、MineContext 数据库或 MineContext 截图文件。</span>
          {demoMessage && <small>{demoMessage}</small>}
        </div>
        <div className="suggestion-box">
          <strong>数据不足恢复演练</strong>
          <span>只读调用 `/api/butler/demo/data-insufficient-drill`，验证没有 PC Activity 时的 next_action、证据边界和 strict 隐私字段；不会导入、重建、复制截图或删除 MineContext 源数据。</span>
          {drillMessage && <small>{drillMessage}</small>}
          {drillReport && (
            <div className="status-grid readiness-grid">
              {(drillReport.acceptance ?? []).slice(0, 5).map((check: Record<string, any>) => (
                <article
                  className={check.status === "passed" ? "status-item readiness-ready" : "status-item readiness-data_insufficient"}
                  key={check.id}
                >
                  <span>{String(check.status)}</span>
                  <strong>{String(check.next_action?.label ?? check.title)}</strong>
                  <small>{String(check.next_action?.type ?? "none")}</small>
                </article>
              ))}
            </div>
          )}
          {drillReport && (
            <small>
              演练边界：{String(drillReport.evidence_boundary)} strict: external_model_used={String(drillReport.privacy?.external_model_used)} ·
              minecontext_source_deleted={String(drillReport.privacy?.minecontext_source_deleted)} · copied_screenshots={String(drillReport.privacy?.copied_screenshots)}
            </small>
          )}
        </div>
        <div className="suggestion-box">
          <strong>证据边界</strong>
          <span>{home?.overview?.evidence_boundary ?? "结论只基于已授权的本地数据源。"}</span>
        </div>
        {dataInsufficient && (
          <div className="suggestion-box">
            <strong>数据不足</strong>
            <span>当前没有足够的 MineContext PC 活动事件，OpenButler 不会编造今日结论。可以先导入今日活动，再重新生成洞察。</span>
            <div className="inline-actions">
              <button className="primary" onClick={importTodayForButler} disabled={importBusy}>
                {importBusy ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
                <span>导入今日 PC 活动</span>
              </button>
              <button
                className="secondary"
                onClick={() => {
                  window.history.replaceState(null, "", "/pc-activity-context");
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              >
                打开 PC 操作感知
              </button>
            </div>
            {importMessage && <small>{importMessage}</small>}
          </div>
        )}
      </section>

      <section className="wide-panel readiness-panel">
        <div className="section-title">
          <div>
            <h2>MVP 可演示状态</h2>
            <p>状态：{readiness?.status ?? "checking"} · 只读取 OpenButler 派生数据，不触碰 MineContext 原始数据。</p>
          </div>
          <div className={readiness?.status === "ready" ? "live-indicator on" : "live-indicator"}>
            <ShieldCheck size={16} />
            <span>{readiness?.status ?? "checking"}</span>
          </div>
        </div>
        <div className="status-grid readiness-grid">
          {(readiness?.checks ?? []).map((check: Record<string, any>) => (
            <article className={`status-item readiness-${String(check.status)}`} key={check.id}>
              <span>{String(check.status)}</span>
              <strong>{String(check.title)}</strong>
              <small>{Object.entries(check.details ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</small>
            </article>
          ))}
        </div>
        {readiness?.status === "data_insufficient" && (
          <div className="suggestion-box">
            <strong>自检显示数据不足</strong>
            <span>主动管家核心可运行，但缺少今日 PC Activity 事件。先导入今日活动后，再重新生成洞察和简报。</span>
          </div>
        )}
        <p className="policy-note">{readiness?.evidence_boundary ?? "自检结果会保留证据边界。"}</p>
      </section>

      <section className="wide-panel mvp-report-panel">
        <div className="section-title">
          <div>
            <h2>Productization Harness</h2>
            <p>状态：{mvpReport?.status ?? "checking"} · 北极星：{mvpReport?.north_star ?? "60 秒内理解今天发生了什么、什么值得注意、下一步应该做什么。"}</p>
          </div>
          <div className={mvpReport?.status === "ready" ? "live-indicator on" : "live-indicator"}>
            <ShieldCheck size={16} />
            <span>{mvpReport?.status ?? "checking"}</span>
          </div>
        </div>
        <div className="mvp-chain">
          {(mvpReport?.mvp_chain ?? []).map((stage: Record<string, any>) => (
            <article key={String(stage.stage)}>
              <span>{String(stage.stage)}</span>
              <strong>{String(stage.count ?? 0)}</strong>
              <small>{String(stage.status ?? "unknown")}</small>
            </article>
          ))}
        </div>
        <div className="suggestion-box">
          <strong>最近 Harness 结果</strong>
          <span>这些是本地 Productization Harness 摘要，只保存状态、失败项、隐私计数和证据边界；不保存 MineContext 原始记录或截图内容。</span>
          <div className="status-grid readiness-grid">
            {latestHarnessRuns.map((run: Record<string, any>) => (
              <article
                className={run.status === "ready" ? "status-item readiness-ready" : "status-item readiness-data_insufficient"}
                key={run.id}
              >
                <span>{String(run.kind)}</span>
                <strong>{String(run.status)}</strong>
                <small>{String(run.created_at)}</small>
                <small>dry_run={String(run.dry_run)} · mutates_data={String(run.mutates_data)}</small>
                <small>failed_checks={(run.failed_checks ?? []).length}</small>
              </article>
            ))}
            {latestHarnessRuns.length === 0 && (
              <article className="status-item readiness-data_insufficient">
                <span>empty</span>
                <strong>暂无 Harness 运行记录</strong>
                <small>运行 MVP 报告或空数据演练后会在这里显示最近结果。</small>
              </article>
            )}
          </div>
        </div>
        <div className="suggestion-box">
          <strong>目标完成度自检</strong>
          <span>把 `.openbutler/goals.yaml` 的 active objectives 映射到当前本地 API、UI 文件和文档证据；不验证远程仓库、CI、云效或部署状态。</span>
          <div className="status-grid readiness-grid">
            {(objectiveStatus?.objectives ?? []).map((objective: Record<string, any>) => (
              <article
                className={objective.status === "proven" ? "status-item readiness-ready" : "status-item readiness-attention_needed"}
                key={objective.id}
              >
                <span>{String(objective.status)}</span>
                <strong>{String(objective.id)}</strong>
                <small>{String(objective.title)}</small>
                <small>priority={String(objective.priority ?? "unknown")} · source={String(objective.source_ref?.path ?? "unknown")}</small>
                <small>{String(objective.proven_count ?? 0)}/{String(objective.criteria_count ?? 0)} criteria proven</small>
                {(objective.success_criteria ?? []).slice(0, 2).map((item: string, index: number) => (
                  <small key={`${objective.id}-success-${index}`}>目标：{String(item)}</small>
                ))}
                {(objective.criteria ?? [])
                  .filter((criterion: Record<string, any>) => criterion.status !== "proven")
                  .slice(0, 2)
                  .map((criterion: Record<string, any>) => (
                    <small key={`${objective.id}-${criterion.id}`}>
                      {criterion.id === "evidence_mapper_missing" ? "缺少 evidence mapper" : "待处理"}：{String(criterion.title)}
                    </small>
                  ))}
              </article>
            ))}
            {!objectiveStatus && (
              <article className="status-item readiness-data_insufficient">
                <span>checking</span>
                <strong>正在读取目标自检</strong>
                <small>刷新 Productization Harness 后显示。</small>
              </article>
            )}
          </div>
          {objectiveStatus?.evidence_boundary && <small>目标边界：{String(objectiveStatus.evidence_boundary)}</small>}
        </div>
        <div className="suggestion-box">
          <strong>一页演示包</strong>
          <span>
            汇总 readiness、MVP report、active objectives 和最近 Harness 摘要，供本地验收时一次性查看；不调用外部模型、不复制截图、不删除 MineContext 源数据。
          </span>
          <div className="status-grid readiness-grid">
            <article className={demoPack?.status === "ready" ? "status-item readiness-ready" : "status-item readiness-attention_needed"}>
              <span>{String(demoPack?.status ?? "checking")}</span>
              <strong>demo pack</strong>
              <small>{String(demoPack?.schema_version ?? "productization_demo_pack_v1")}</small>
            </article>
            <article className={demoPack?.readiness?.status === "ready" ? "status-item readiness-ready" : "status-item readiness-data_insufficient"}>
              <span>{String(demoPack?.readiness?.status ?? "checking")}</span>
              <strong>readiness</strong>
              <small>timeline={String(demoPack?.readiness?.summary?.timeline_events ?? 0)} · insights={String(demoPack?.readiness?.summary?.insights ?? 0)}</small>
            </article>
            <article className={demoPack?.mvp_report?.status === "ready" ? "status-item readiness-ready" : "status-item readiness-data_insufficient"}>
              <span>{String(demoPack?.mvp_report?.status ?? "checking")}</span>
              <strong>MVP report</strong>
              <small>acceptance={(demoPack?.mvp_report?.acceptance ?? []).length}</small>
            </article>
            <article className={demoPack?.objective_status?.status === "proven" ? "status-item readiness-ready" : "status-item readiness-attention_needed"}>
              <span>{String(demoPack?.objective_status?.status ?? "checking")}</span>
              <strong>active objectives</strong>
              <small>harness_runs={String(demoPack?.latest_harness_runs?.count ?? 0)}</small>
            </article>
          </div>
          <small>
            strict: external_model_used={String(demoPack?.privacy?.external_model_used ?? false)} ·
            external_model_allowed={String(demoPack?.privacy?.external_model_allowed ?? false)} ·
            minecontext_source_deleted={String(demoPack?.privacy?.minecontext_source_deleted ?? 0)} ·
            copied_screenshots={String(demoPack?.privacy?.copied_screenshots ?? 0)}
          </small>
          {demoPack?.evidence_boundary && <small>演示包边界：{String(demoPack.evidence_boundary)}</small>}
        </div>
        <div className="status-grid readiness-grid">
          {(mvpReport?.acceptance ?? []).slice(0, 6).map((check: Record<string, any>) => (
            <article
              className={check.status === "passed" ? "status-item readiness-ready" : "status-item readiness-attention_needed"}
              key={check.id}
            >
              <span>{String(check.status)}</span>
              <strong>{String(check.title)}</strong>
              <small>{Object.entries(check.details ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</small>
              <small>下一步：{String(check.next_action?.label ?? "查看验收报告")}</small>
            </article>
          ))}
        </div>
        {mvpReport?.status !== "ready" && (
          <div className="suggestion-box">
            <strong>可执行修复建议</strong>
            {(mvpReport?.acceptance ?? [])
              .filter((check: Record<string, any>) => check.status !== "passed")
              .slice(0, 3)
              .map((check: Record<string, any>) => (
                <div className="action-suggestion" key={check.id}>
                  <span>
                    {String(check.next_action?.label ?? check.title)}：{String(check.next_action?.description ?? "检查该验收项详情。")}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => handleMvpNextAction(check.next_action ?? {})}
                    disabled={Boolean(mvpActionBusy)}
                  >
                    {mvpActionBusy === check.next_action?.type ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                    <span>执行建议</span>
                  </button>
                </div>
              ))}
            {mvpActionMessage && <small>{mvpActionMessage}</small>}
          </div>
        )}
        <div className="suggestion-box">
          <strong>验收边界</strong>
          <span>{mvpReport?.evidence_boundary ?? "MVP 验收报告会保留证据边界。"}</span>
          <span>
            strict: external_model_used={String(mvpReport?.privacy?.external_model_used ?? false)} ·
            external_model_allowed={String(mvpReport?.privacy?.external_model_allowed ?? false)} ·
            minecontext_source_deleted={String(mvpReport?.privacy?.minecontext_source_deleted ?? 0)} ·
            copied_screenshots={String(mvpReport?.privacy?.copied_screenshots ?? 0)}
          </span>
        </div>
      </section>

      <section className="metrics">
        <Metric icon={Database} label="PC 活跃" value={`${metrics.pc_active_minutes ?? 0} 分钟`} tone="blue" />
        <Metric icon={BrainCircuit} label="深度工作" value={`${metrics.focus_minutes ?? 0} 分钟`} tone="green" />
        <Metric icon={RefreshCw} label="上下文切换" value={metrics.context_switch_count ?? 0} tone="amber" />
        <Metric icon={Inbox} label="主动洞察" value={insights.length} tone="red" />
      </section>

      <section className="wide-panel">
        <div className="section-title"><h2>主动洞察</h2></div>
        <InsightList insights={insights} onChanged={refreshHome} />
      </section>

      <section className="panel">
        <div className="section-title"><h2>建议下一步</h2></div>
        <div className="plugin-list">
          {(home?.suggested_next_actions ?? []).map((action: Record<string, any>, index: number) => (
            <article className="plugin" key={`${action.type}-${index}`}>
              <strong>{String(action.label)}</strong>
              <span>{String(action.type)}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>今日简报</h2></div>
        <div className="plugin-list">
          {briefings.slice(0, 2).map((briefing) => (
            <article className="plugin" key={briefing.id}>
              <strong>{briefing.title}</strong>
              <span>{briefing.evidence_boundary}</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
  */
}

function TodayStatusTile({card}: {card: {title: string; value: string; description: string; tone: string}}) {
  return (
    <article className={`today-status-card tone-${card.tone}`}>
      <span>{card.title}</span>
      <strong>{card.value}</strong>
      <small>{card.description}</small>
    </article>
  );
}

function SceneSignalCard({card}: {card: {title: string; value: string; description: string; tone: string}}) {
  return (
    <article className={`scene-card tone-${card.tone}`}>
      <span>{card.title}</span>
      <strong>{card.value}</strong>
      <small>{card.description}</small>
    </article>
  );
}

function ProgressiveOnboarding({
  onImport,
  importBusy,
  importMessage,
  onOpenAdvanced
}: {
  onImport: () => void;
  importBusy: boolean;
  importMessage: string;
  onOpenAdvanced: () => void;
}) {
  return (
    <section className="onboarding-panel">
      <div>
        <p className="eyebrow">3 步开始</p>
        <h2>先建立今天的第一条本地线索</h2>
        <p>OpenButler 默认不会编造结论。连接本机观察后，它会整理时间线、生成今日概览，并把依据留给你复核。</p>
      </div>
      <div className="onboarding-steps">
        <article><strong>1</strong><span>连接本机观察</span></article>
        <article><strong>2</strong><span>生成今日概览</span></article>
        <article><strong>3</strong><span>查看时间线与依据</span></article>
      </div>
      <div className="hero-actions">
        <button className="primary" onClick={onImport} disabled={importBusy}>
          {importBusy ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
          <span>连接电脑活动</span>
        </button>
        <button className="secondary" onClick={onOpenAdvanced}>稍后配置</button>
      </div>
      {importMessage && <small>{importMessage}</small>}
    </section>
  );
}

function FriendlySuggestionCard({
  suggestion,
  onChanged
}: {
  suggestion: {
    id: string;
    title: string;
    summary: string;
    status: string;
    type: string;
    confidence: number;
    evidenceBoundary: string;
    raw: Record<string, any>;
  };
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  async function feedback(type: string) {
    if (type === "dismissed") {
      await dismissInsight(suggestion.id);
    } else if (type === "remind_later") {
      await snoozeInsight(suggestion.id, 60);
    } else {
      await submitInsightFeedback(suggestion.id, type);
    }
    await onChanged();
  }

  return (
    <article className="friendly-insight-card">
      <div className="friendly-card-head">
        <div>
          <span>{suggestion.type} · {suggestion.status}</span>
          <strong>{suggestion.title}</strong>
        </div>
        <small>{Math.round(suggestion.confidence * 100)}%</small>
      </div>
      <p>{suggestion.summary}</p>
      <div className="friendly-actions">
        <button className="secondary" aria-label="查看证据详情" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起依据" : "查看依据"}
        </button>
        <button className="ghost" onClick={() => feedback("useful")}>有用</button>
        <button className="ghost" onClick={() => feedback("remind_later")}>稍后再说</button>
        <button className="ghost" onClick={() => feedback("inaccurate")}>不准确</button>
      </div>
      {expanded && <InsightEvidenceDetails insight={suggestion.raw} />}
    </article>
  );
}

function LifeTimelinePreview({items}: {items: TimelineMoment[]}) {
  if (!items.length) {
    return (
      <div className="friendly-empty">
        <strong>时间线还在等待第一条记录</strong>
        <span>接入本地数据后，OpenButler 会把重要片段整理成可回看的生活记录。</span>
      </div>
    );
  }
  return (
    <div className="life-timeline preview">
      {items.slice(0, 5).map((item) => (
        <article className="life-moment" key={item.id}>
          <div className={`moment-icon ${item.icon}`}>{item.category.slice(0, 1)}</div>
          <div className="moment-body">
            <div className="moment-meta">
              <span>{item.date} · {item.time}</span>
              <span>{item.category}</span>
            </div>
            <strong>{item.title}</strong>
            <p>{item.summary}</p>
            <div className="moment-tags">
              <small>{item.valueTag}</small>
              <small>依据：{item.sourceLabel}</small>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function ButlerInbox() {
  const [insights, setInsights] = useState<Array<Record<string, any>>>([]);

  async function refreshInbox() {
    const result = await getButlerInsights();
    setInsights(result.items);
  }

  useEffect(() => {
    refreshInbox().catch(() => undefined);
  }, []);

  return (
    <section className="wide-panel">
      <div className="section-title">
        <div>
          <h2>管家提醒</h2>
          <p>这里收纳 OpenButler 主动整理出的提醒、建议和复盘卡片。你可以反馈它是否有用。</p>
        </div>
        <button className="secondary" onClick={refreshInbox}>刷新</button>
      </div>
      <InsightList insights={insights} onChanged={refreshInbox} />
    </section>
  );
}

function InsightList({insights, onChanged}: {insights: Array<Record<string, any>>; onChanged: () => void}) {
  const [expandedInsightId, setExpandedInsightId] = useState<string | null>(null);

  async function feedback(id: string, type: string) {
    if (type === "dismissed") {
      await dismissInsight(id);
    } else if (type === "remind_later") {
      await snoozeInsight(id, 60);
    } else {
      await submitInsightFeedback(id, type);
    }
    await onChanged();
  }

  if (!insights.length) {
    return <div className="friendly-empty"><strong>暂无管家提醒</strong><span>数据不足时 OpenButler 不会编造结论。连接本地数据后会逐步出现提醒和依据。</span></div>;
  }
  return (
    <div className="friendly-suggestion-list">
      {insights.map((insight) => (
        <article className="friendly-insight-card" key={insight.id}>
          <div className="friendly-card-head">
            <div>
              <span>{insightTypeLabel(insight.type)} · {statusLabel(insight.status)}</span>
              <strong>{userFacingDemoText(insight.title ?? insightTypeLabel(insight.type), insightTypeLabel(insight.type))}</strong>
            </div>
            <small>{Math.round(Number(insight.confidence ?? 0) * 100)}%</small>
          </div>
          <p>{userFacingDemoText(insight.summary ?? "这是一条管家提醒。")}</p>
          {expandedInsightId === String(insight.id) && insight.detail && <p>{userFacingDemoText(insight.detail)}</p>}
          <div className="friendly-actions">
            <button
              className="secondary evidence-toggle"
              aria-label="查看证据详情"
              onClick={() => setExpandedInsightId(expandedInsightId === String(insight.id) ? null : String(insight.id))}
            >
              {expandedInsightId === String(insight.id) ? "收起依据" : "查看依据"}
            </button>
            <button className="ghost" onClick={() => feedback(String(insight.id), "useful")}>有用</button>
            <button className="ghost" onClick={() => feedback(String(insight.id), "inaccurate")}>不准确</button>
            <button className="ghost" onClick={() => feedback(String(insight.id), "remind_later")}>稍后再说</button>
            <button className="ghost" onClick={() => feedback(String(insight.id), "too_frequent")}>不再提醒类似内容</button>
          </div>
          {expandedInsightId === String(insight.id) && <InsightEvidenceDetails insight={insight} />}
          <div className="technical-card-fallback">
            <strong>{insight.title}</strong>
            <span>{insight.type} · {insight.status} · 置信度 {Math.round(Number(insight.confidence ?? 0) * 100)}%</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function InsightEvidenceDetails({insight}: {insight: Record<string, any>}) {
  const refs = Array.isArray(insight.evidence_refs) ? insight.evidence_refs : [];
  return (
    <div className="evidence-detail-panel">
      <div className="section-title">
        <h2>依据详情</h2>
        <p>只展示本地引用和边界说明；截图证据仅显示路径引用，不复制或读取内容。</p>
      </div>
      <div className="evidence">
        <small>来源 {sourceLabel(insight.generated_by ?? "butler_core")}</small>
        <small>类型 {insightTypeLabel(insight.type)}</small>
        <small>状态 {statusLabel(insight.status)}</small>
        <small>可信度 {Math.round(Number(insight.confidence ?? 0) * 100)}%</small>
      </div>
      <div className="suggestion-box">
        <strong>边界说明</strong>
        <span>{userFacingDemoText(insight.evidence_boundary ?? "数据不足，无法判断。")}</span>
      </div>
      <div className="suggestion-box">
        <strong>隐私说明</strong>
        <span>未复制截图文件 · 未上传截图文件 · 未调用外部模型 · 截图只显示为本地路径引用</span>
      </div>
      {refs.length ? (
        <div className="evidence-ref-list">
          {refs.map((ref: Record<string, any>, index: number) => (
            <div className="evidence-ref-row" key={`${String(ref.kind ?? "ref")}-${index}`}>
              <strong>{sourceLabel(ref.source ?? ref.kind ?? "本地依据")}</strong>
              <span>{String(ref.path ?? `本地依据 ${index + 1}`)}</span>
              {String(ref.kind ?? "").includes("screenshot") && <small>仅显示路径 · 未复制截图</small>}
            </div>
          ))}
        </div>
      ) : (
        <div className="suggestion-box">
          <strong>暂无可展开依据</strong>
          <span>数据不足或该提醒没有可展开依据引用；OpenButler 不会用缺失依据包装成确定结论。</span>
        </div>
      )}
    </div>
  );
}

function MetricsPage() {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [range, setRange] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    Promise.all([getButlerMetricsToday(), getButlerMetricsRange(7)])
      .then(([todayResult, rangeResult]) => {
        setData(todayResult);
        setRange(rangeResult);
      })
      .catch(() => undefined);
  }, []);

  const metrics = data?.metrics ?? {};
  const trend = range?.trend ?? [];
  const trendSummary = range?.summary ?? {};
  const dataInsufficient = trendSummary.status === "data_insufficient" || Number(trendSummary.total_source_event_count ?? 0) === 0;
  return (
    <div className="page-grid">
      <section className="metrics">
        <Metric icon={Database} label="PC 活跃时长" value={`${metrics.pc_active_minutes ?? 0} 分钟`} tone="blue" />
        <Metric icon={BrainCircuit} label="深度工作时长" value={`${metrics.focus_minutes ?? 0} 分钟`} tone="green" />
        <Metric icon={RefreshCw} label="上下文切换次数" value={metrics.context_switch_count ?? 0} tone="amber" />
        <Metric icon={CheckCircle2} label="来源事件数" value={metrics.source_event_count ?? 0} tone="red" />
      </section>
      <UsagePanel title="主要应用" items={metrics.top_apps ?? []} />
      <UsagePanel title="主要网站" items={metrics.top_domains ?? []} />
      <section className="wide-panel">
        <div className="section-title">
          <h2>最近 7 天趋势</h2>
          <p>基于本地 OpenButler 指标快照；数据不足时不推断趋势。</p>
        </div>
        {dataInsufficient ? (
          <div className="suggestion-box">
            <strong>最近 7 天数据不足</strong>
            <span>{String(trendSummary.data_insufficient_message ?? "请先导入 PC Activity、重建统一时间线并生成今日指标。")}</span>
            <span>strict 隐私模式下仍只读取本地派生指标，不调用外部模型。</span>
          </div>
        ) : (
          <div className="trend-grid">
            <TrendPanel title="PC 活跃" metricKey="pc_active_minutes" unit="m" items={trend} />
            <TrendPanel title="深度工作" metricKey="focus_minutes" unit="m" items={trend} />
            <TrendPanel title="上下文切换" metricKey="context_switch_count" unit="次" items={trend} />
          </div>
        )}
        <div className="evidence">
          <small>days_with_data {String(trendSummary.days_with_data ?? 0)}</small>
          <small>external_model_used {String(range?.privacy?.external_model_used ?? false)}</small>
          <small>copied_screenshots {String(range?.privacy?.copied_screenshots ?? 0)}</small>
          <small>minecontext_source_deleted {String(range?.privacy?.minecontext_source_deleted ?? 0)}</small>
        </div>
      </section>
      <section className="wide-panel">
        <div className="section-title"><h2>证据边界</h2></div>
        <p className="policy-note">{range?.evidence_boundary ?? data?.evidence_boundary}</p>
      </section>
    </div>
  );
}

function TrendPanel({title, metricKey, unit, items}: {title: string; metricKey: string; unit: string; items: Array<Record<string, any>>}) {
  const max = Math.max(1, ...items.map((item) => Number(item[metricKey] ?? 0)));
  return (
    <section className="panel trend-panel">
      <div className="section-title"><h2>{title}</h2></div>
      <div className="bar-list">
        {items.map((item) => {
          const value = Number(item[metricKey] ?? 0);
          const dateLabel = String(item.date ?? "").slice(5);
          return (
            <div className="bar-row" key={`${metricKey}-${item.date}`}>
              <span>{dateLabel}</span>
              <div><i style={{width: `${Math.round((value / max) * 100)}%`}} /></div>
              <strong>{value}{unit}</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function UsagePanel({title, items}: {title: string; items: Array<Record<string, any>>}) {
  return (
    <section className="panel">
      <div className="section-title"><h2>{title}</h2></div>
      <div className="bar-list">
        {items.length ? items.map((item) => (
          <div className="bar-row" key={String(item.name)}>
            <span>{String(item.name)}</span>
            <div><i style={{width: `${Math.min(100, Number(item.minutes ?? 0))}%`}} /></div>
            <strong>{Number(item.minutes ?? 0)}m</strong>
          </div>
        )) : <p className="policy-note">暂无可量化数据。</p>}
      </div>
    </section>
  );
}

type TimelineTimeFilter = "today" | "yesterday" | "7d" | "all";

const timelineTimeFilters: Array<{value: TimelineTimeFilter; label: string}> = [
  {value: "today", label: "今天"},
  {value: "yesterday", label: "昨天"},
  {value: "7d", label: "近 7 天"},
  {value: "all", label: "全部"},
];

const timelineCategoryFilters = [
  "all",
  "work",
  "objects",
  "reminders",
  "home",
  "habits",
  "automation",
];

const timelineImportanceFilters = [
  "all",
  "actionable",
  "record_only",
  "has_evidence",
];

function isInTimeFilter(moment: TimelineMoment, filter: TimelineTimeFilter): boolean {
  if (filter === "all") return true;
  const started = new Date(moment.startedAt);
  if (Number.isNaN(started.getTime())) return true;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfSevenDays = new Date(startOfToday);
  startOfSevenDays.setDate(startOfSevenDays.getDate() - 6);
  if (filter === "today") return started >= startOfToday && started < startOfTomorrow;
  if (filter === "yesterday") return started >= startOfYesterday && started < startOfToday;
  return started >= startOfSevenDays && started < startOfTomorrow;
}

function filterTimelineMoments(
  moments: TimelineMoment[],
  timeFilter: TimelineTimeFilter,
  categoryFilter: string,
  importanceFilter: string
) {
  return moments.filter((moment) => (
    isInTimeFilter(moment, timeFilter)
    && (categoryFilter === "all" || moment.categoryKey === categoryFilter)
    && (importanceFilter === "all" || moment.importanceKey === importanceFilter || (importanceFilter === "has_evidence" && moment.evidenceAvailable))
  ));
}

function TimelineThumbnail({moment}: {moment: TimelineMoment}) {
  const thumb = moment.thumbnail;
  const mark = {
    objects: "钥",
    reminders: "待",
    habits: "休",
    home: "家",
    work: "事",
    automation: "技",
  }[moment.categoryKey] ?? moment.category.slice(0, 1);
  if (thumb.kind === "image" && thumb.url) {
    return (
      <figure className="event-thumb image-thumb">
        <img src={thumb.url} alt={thumb.alt} onError={(event) => { event.currentTarget.style.display = "none"; }} />
        {thumb.privacyLabel && <figcaption>{thumb.privacyLabel}</figcaption>}
      </figure>
    );
  }
  return (
    <figure className={`event-thumb ${thumb.tone}`}>
      <span>{mark}</span>
      <figcaption>{thumb.privacyLabel ?? "来源占位"}</figcaption>
    </figure>
  );
}

function UnifiedTimeline() {
  const [items, setItems] = useState<Array<Record<string, any>>>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<TimelineTimeFilter>("today");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [importanceFilter, setImportanceFilter] = useState("all");

  async function refreshTimeline() {
    const result = await getButlerTimeline();
    setItems(result.items);
  }

  useEffect(() => {
    refreshTimeline().catch(() => undefined);
  }, []);

  const moments = items.map(toTimelineMoment);
  const filteredMoments = filterTimelineMoments(moments, timeFilter, categoryFilter, importanceFilter);
  const groups = groupTimelineByDate(filteredMoments);
  const activeFilterSummary = `${timelineTimeFilters.find((item) => item.value === timeFilter)?.label ?? "今天"} · ${timelineCategoryLabel(categoryFilter)} · ${timelineImportanceLabel(importanceFilter)}`;

  return (
    <section className="life-timeline-page">
      <div className="timeline-feed-hero">
        <div>
          <p className="eyebrow">全场景事件流</p>
          <h2>时间线</h2>
          <p>这里按生活场景整理发生过的事。技术来源只在你展开依据时说明。</p>
        </div>
        <button className="secondary" onClick={refreshTimeline}>刷新</button>
      </div>
      <div className="timeline-filter-bar" aria-label="时间线筛选">
        <label>
          <span>时间</span>
          <select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as TimelineTimeFilter)}>
            {timelineTimeFilters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>分类</span>
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            {timelineCategoryFilters.map((item) => <option key={item} value={item}>{timelineCategoryLabel(item)}</option>)}
          </select>
        </label>
        <label>
          <span>重要性</span>
          <select value={importanceFilter} onChange={(event) => setImportanceFilter(event.target.value)}>
            {timelineImportanceFilters.map((item) => <option key={item} value={item}>{timelineImportanceLabel(item)}</option>)}
          </select>
        </label>
      </div>
      <p className="timeline-result-note">
        已显示 {filteredMoments.length} 条事件 · {activeFilterSummary}
      </p>
      {groups.length ? (
        <div className="life-timeline event-feed">
          {groups.map((group) => (
            <section className="life-day-group" key={group.date}>
              <h3>{group.date}</h3>
              {group.items.map((moment) => (
                <article className="life-moment event-feed-card" key={moment.id}>
                  <time dateTime={moment.startedAt}>{moment.time}</time>
                  <div className="moment-body">
                    <strong>{moment.title}</strong>
                    <p>{moment.summary}</p>
                    <div className="moment-tags">
                      <small>{moment.valueTag}</small>
                      <small>{moment.sourceLabel}</small>
                      <small>{moment.eventLabel}</small>
                      <small>{moment.evidenceAvailable ? "可查看依据" : "依据不足"}</small>
                    </div>
                    <button
                      className="ghost"
                      onClick={() => setExpandedId(expandedId === moment.id ? null : moment.id)}
                    >
                      {expandedId === moment.id ? "收起" : "查看依据"}
                    </button>
                    {expandedId === moment.id && (
                      <div className="moment-evidence">
                        <strong>依据与边界</strong>
                        <span>{moment.evidenceBoundary}</span>
                        <div className="evidence">
                          <small>依据来源：{moment.sourceLabel}</small>
                          <small>{moment.confidenceLabel}</small>
                          <small>{moment.thumbnail.privacyLabel ?? "未展示原始路径"}</small>
                          <small>这是本地线索整理，不代表远程网站或服务的实时状态。</small>
                        </div>
                      </div>
                    )}
                  </div>
                  <TimelineThumbnail moment={moment} />
                </article>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="friendly-empty">
          <strong>{items.length ? "这个筛选下暂时没有事件" : "时间线还没有记录"}</strong>
          <span>{items.length ? "可以放宽时间、分类或重要性条件，查看更完整的生活记录。" : "连接本地数据源后，这里会按时间整理工作、生活、提醒和自动化候选。"}</span>
        </div>
      )}
    </section>
  );
}

function GoalsPage() {
  const [goals, setGoals] = useState<Array<Record<string, any>>>([]);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [metricsRange, setMetricsRange] = useState<Record<string, any> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");

  async function refreshGoals() {
    const [goalResult, settingsResult, metricsResult] = await Promise.all([
      getButlerGoals(),
      getButlerSettings(),
      getButlerMetricsRange(7)
    ]);
    setGoals(goalResult.items);
    setSettings(settingsResult);
    setMetricsRange(metricsResult);
  }

  useEffect(() => {
    refreshGoals().catch(() => undefined);
  }, []);

  async function toggleGoal(goal: Record<string, any>) {
    await updateButlerGoal(String(goal.id), {enabled: !goal.enabled});
    await refreshGoals();
  }

  async function addGoal() {
    await createButlerGoal({
      title: "发现重复流程时提醒我",
      goal_type: "workflow_candidate",
      target: {enabled: true},
      schedule: {frequency: "low"},
      enabled: true
    });
    await refreshGoals();
  }

  async function clearButlerDerivedData() {
    if (deleteConfirm !== "DELETE BUTLER") {
      setDeleteMessage("请输入 DELETE BUTLER 才能删除 Butler 派生数据。");
      return;
    }
    setDeleteBusy(true);
    setDeleteMessage("");
    try {
      const result = await deleteButlerData();
      setDeleteMessage(`已删除 Butler 派生数据：时间线 ${result.timeline ?? 0}、指标 ${result.metrics ?? 0}、洞察 ${result.insights ?? 0}、简报 ${result.briefings ?? 0}、Harness 摘要 ${result.harness_runs ?? 0}。MineContext 原始数据删除数为 ${result.minecontext_source_deleted ?? result.minecontext_deleted ?? 0}。`);
      setDeleteConfirm("");
    } catch (error) {
      setDeleteMessage("删除失败，请检查后端服务状态后重试。");
    } finally {
      setDeleteBusy(false);
    }
  }

  const trendSummary = metricsRange?.summary ?? {};
  const daysWithData = Number(trendSummary.days_with_data ?? 0);
  const totalFocus = Number(trendSummary.total_focus_minutes ?? 0);
  const totalPcActive = Number(trendSummary.total_pc_active_minutes ?? 0);
  const totalSwitches = Number(trendSummary.total_context_switch_count ?? 0);

  function progressText(goal: Record<string, any>) {
    const target = goal.target ?? {};
    if (Number(target.focus_minutes ?? 0) > 0) {
      return `最近 7 天深度工作 ${totalFocus} / ${Number(target.focus_minutes) * Math.max(daysWithData, 1)} 分钟`;
    }
    if (Number(target.threshold ?? 0) > 0) {
      return `最近 7 天上下文切换 ${totalSwitches} 次；提醒阈值 ${Number(target.threshold)} 次 / ${goal.schedule?.window_minutes ?? 30} 分钟`;
    }
    if (goal.goal_type === "briefing") {
      return `最近 7 天有 ${daysWithData} 天可生成复盘依据`;
    }
    return `最近 7 天 PC 活跃 ${totalPcActive} 分钟；数据天数 ${daysWithData}`;
  }

  return (
    <div className="workstation-page">
      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>Goals</h2>
            <p>目标用于约束主动管家，默认保守，不发送系统通知。</p>
          </div>
          <button className="primary" onClick={addGoal}>新增目标</button>
        </div>
        <div className="plugin-list">
          {goals.map((goal) => (
            <article className="plugin" key={goal.id}>
              <strong>{goal.title}</strong>
              <span>{goal.goal_type} · {goal.enabled ? "启用" : "关闭"}</span>
              <p>目标：{JSON.stringify(goal.target)} · 计划：{JSON.stringify(goal.schedule)}</p>
              <button className="secondary" onClick={() => toggleGoal(goal)}>{goal.enabled ? "关闭" : "启用"}</button>
            </article>
          ))}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>目标达成趋势</h2>
            <p>基于最近 7 天 Butler 指标摘要，只使用本地 OpenButler 时间线和指标。</p>
          </div>
          <span className={`status-pill ${daysWithData ? "ready" : "attention_needed"}`}>{daysWithData ? "ready" : "data_insufficient"}</span>
        </div>
        <div className="status-grid compact-status">
          <StatusItem label="数据天数" value={`${daysWithData} / 7`} />
          <StatusItem label="PC 活跃" value={`${totalPcActive} 分钟`} />
          <StatusItem label="深度工作" value={`${totalFocus} 分钟`} />
          <StatusItem label="上下文切换" value={`${totalSwitches} 次`} />
        </div>
        <div className="plugin-list">
          {goals.map((goal) => (
            <article className="plugin" key={`trend-${goal.id}`}>
              <strong>{goal.title}</strong>
              <span>{progressText(goal)}</span>
              <p>{metricsRange?.evidence_boundary ?? "趋势来自本地 OpenButler 指标摘要；不代表远程系统实时状态。"}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>数据保留与删除</h2>
            <p>这里只管理 OpenButler 主动管家派生数据，不会删除 MineContext 原始数据、数据库或截图文件。</p>
          </div>
        </div>
        <div className="status-grid compact-status">
          <StatusItem label="派生数据保留" value={`${settings?.retention?.derived_data_retention_days ?? 365} 天`} />
          <StatusItem label="反馈保留" value={`${settings?.retention?.feedback_retention_days ?? 365} 天`} />
          <StatusItem label="审计日志保留" value={`${settings?.retention?.audit_log_retention_days ?? 90} 天`} />
          <StatusItem label="MineContext 原始数据" value="不由此页面删除" />
        </div>
        <div className="suggestion-box">
          <strong>删除范围确认</strong>
          <span>删除按钮只清理统一时间线、今日指标、主动洞察、简报和 Productization Harness 摘要。PC Activity 事件、MineContext 源数据库、截图路径指向的文件都不会被删除。</span>
          <span>如需继续，请输入 <strong>DELETE BUTLER</strong> 后执行删除。</span>
          <div className="inline-actions">
            <input
              className="confirm-input"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              placeholder="DELETE BUTLER"
            />
            <button className="secondary danger-button" onClick={clearButlerDerivedData} disabled={deleteBusy}>
              删除 Butler 派生数据
            </button>
          </div>
          {deleteMessage && <small>{deleteMessage}</small>}
        </div>
      </section>
    </div>
  );
}

function minutes(value: number) {
  return Math.round((value || 0) / 60);
}

function WorkstationVision({privacyMode}: {privacyMode: PrivacyMode}) {
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [summary, setSummary] = useState<Record<string, any> | null>(null);
  const [events, setEvents] = useState<Array<Record<string, any>>>([]);
  const [cameras, setCameras] = useState<Array<Record<string, any>>>([]);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshWorkstation() {
    const [cameraResult, statusResult, summaryResult, eventResult, settingsResult] = await Promise.all([
      getWorkstationCameras(),
      getWorkstationStatus(),
      getWorkstationSummaryToday(),
      getWorkstationEvents(),
      getWorkstationSettings()
    ]);
    setCameras(cameraResult.items);
    setStatus(statusResult);
    setSummary(summaryResult);
    setEvents(eventResult.items);
    setSettings(settingsResult);
  }

  useEffect(() => {
    refreshWorkstation().catch(() => undefined);
  }, []);

  async function start() {
    setBusy(true);
    try {
      await startWorkstationSession({
        camera_id: String(cameras[0]?.id ?? settings?.default_camera_id ?? "usb-camera-0"),
        fps: 1,
        privacy_mode: privacyMode === "strict" ? "strict" : "basic",
        save_raw_frames: false,
        enabled_detectors: ["presence", "posture", "attention", "fatigue", "work_state"],
        user_confirmed: true
      });
      await refreshWorkstation();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await stopWorkstationSession(status?.session?.id);
      await refreshWorkstation();
    } finally {
      setBusy(false);
    }
  }

  async function updateSetting(key: string, value: unknown) {
    if (!settings) return;
    await updateWorkstationSettings({...settings, [key]: value});
    await refreshWorkstation();
  }

  async function clearData(todayOnly: boolean) {
    await deleteWorkstationData(todayOnly);
    await refreshWorkstation();
  }

  const session = status?.session;
  const current = status?.current ?? {};
  const metrics = summary?.metrics ?? {};
  const attention = summary?.attention_metrics ?? {};
  const localEyes = status?.local_eyes ?? {};
  const latestFatigue = events.find((event) => event.type === "fatigue_signal");
  const latestPosture = events.find((event) => event.type === "posture_state");

  return (
    <div className="workstation-page">
      <section className="wide-panel camera-status">
        <div className="section-title">
          <div>
            <h2>OpenButler Vision</h2>
            <p>复用全局 camera-eye 本地眼睛技能；默认不保存原始画面；只输出基于可观察线索的视觉状态估计。</p>
          </div>
          <div className={session ? "live-indicator on" : "live-indicator"}>
            <Camera size={16} />
            <span>{session ? "视觉感知运行中" : "视觉感知已关闭"}</span>
          </div>
        </div>
        <div className="status-grid">
          <StatusItem label="当前摄像头" value={String(session?.camera_id ?? cameras[0]?.id ?? "未选择")} />
          <StatusItem label="运行状态" value={String(session?.status ?? "stopped")} />
          <StatusItem label="当前隐私模式" value={String(session?.privacy_mode ?? settings?.privacy_mode ?? privacyMode)} />
          <StatusItem label="当前 FPS" value={String(session?.fps ?? settings?.fps?.presence ?? 1)} />
          <StatusItem label="原始画面保存" value={session?.save_raw_frames || settings?.save_raw_frames ? "开启" : "关闭"} />
          <StatusItem label="本地眼睛技能" value={localEyes.available ? String(localEyes.mode ?? "connected") : "不可用/降级"} />
        </div>
        <div className="actions-row">
          <button className="primary" onClick={start} disabled={busy || !!session}>
            <Camera size={17} />
            <span>启动分析</span>
          </button>
          <button className="secondary" onClick={stop} disabled={busy || !session}>停止分析</button>
          <button className="secondary" onClick={refreshWorkstation}>刷新状态</button>
          <select className="camera-select" defaultValue={String(cameras[0]?.id ?? "usb-camera-0")}>
            {(cameras.length ? cameras : [{id: "usb-camera-0", name: "Mock USB Camera 0"}]).map((camera) => (
              <option key={String(camera.id)} value={String(camera.id)}>{String(camera.name ?? camera.id)}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="metrics">
        <Metric icon={Eye} label="当前在座状态" value={String(current.presence ?? "unknown")} tone="blue" />
        <Metric icon={Watch} label="当前姿态" value={String(current.posture ?? "unknown")} tone="green" />
        <Metric icon={BrainCircuit} label="专注状态" value={String(current.work_state ?? "unknown")} tone="amber" />
        <Metric icon={Trophy} label="今日在场时长" value={`${metrics.total_present_minutes ?? 0} 分钟`} tone="red" />
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <h2>注意力热区</h2>
          <p>基于头部朝向和物品上下文的粗略估计，不代表眼动仪精度。</p>
        </div>
        <div className="bar-list">
          {[
            ["屏幕", attention.screen_focus_ratio],
            ["键盘/桌面", attention.desk_focus_ratio],
            ["手机", attention.phone_focus_ratio],
            ["离屏", attention.off_screen_ratio],
            ["未知", attention.unknown_ratio]
          ].map(([label, value]) => (
            <div className="bar-row" key={String(label)}>
              <span>{label}</span>
              <div><i style={{width: `${Math.round(Number(value ?? 0) * 100)}%`}} /></div>
              <strong>{Math.round(Number(value ?? 0) * 100)}%</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>疲劳与休息建议</h2></div>
        <div className="suggestion-box">
          <strong>{latestFatigue?.state === "medium" || latestFatigue?.state === "high" ? "可能有疲劳迹象" : "暂无强提醒"}</strong>
          <span>连续在座 {metrics.longest_presence_minutes ?? 0} 分钟，疲劳信号 {metrics.fatigue_signal_count ?? 0} 次。建议每 50 分钟短暂活动肩颈并补充光照。</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>姿态统计</h2></div>
        <div className="status-grid compact-status">
          <StatusItem label="坐姿时间" value={`${minutes(Number(summary?.total_sitting_seconds ?? 0))} 分钟`} />
          <StatusItem label="站姿时间" value={`${minutes(Number(summary?.total_standing_seconds ?? 0))} 分钟`} />
          <StatusItem label="当前姿态" value={String(latestPosture?.state ?? "unknown")} />
          <StatusItem label="姿态提醒" value={`${metrics.posture_warning_count ?? 0} 次`} />
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title"><h2>今日时间线</h2></div>
        <div className="event-list">
          {events.slice(0, 8).map((event) => (
            <article className="event-row" key={event.id}>
              <div className="event-time">{formatTime(event.started_at)}</div>
              <div className="event-body">
                <strong>{event.type} · {event.state ?? "metric"}</strong>
                <span>置信度 {Math.round(Number(event.confidence ?? 0) * 100)}% · {event.reason_codes?.join("、") || "结构化事件"}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="wide-panel privacy-controls">
        <div className="section-title">
          <h2>隐私控制</h2>
          <p>摄像头分析必须主动开启；strict 模式禁止外部模型、外部 API 和外部 webhook。</p>
        </div>
        <label><input type="checkbox" checked={!!settings?.enabled} onChange={(event) => updateSetting("enabled", event.target.checked)} /> 视觉感知开关</label>
        <label><input type="checkbox" checked={!!settings?.save_raw_frames} onChange={(event) => updateSetting("save_raw_frames", event.target.checked)} /> 保存原始画面</label>
        <label><input type="checkbox" checked readOnly /> 仅本地处理</label>
        <label>数据保留天数 <input value={settings?.derived_event_retention_days ?? 365} readOnly /></label>
        <button className="secondary" onClick={() => clearData(true)}>删除今日数据</button>
        <button className="secondary" onClick={() => clearData(false)}>删除全部视觉感知数据</button>
      </section>
    </div>
  );
}

function PCActivityContext({privacyMode}: {privacyMode: PrivacyMode}) {
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [summary, setSummary] = useState<Record<string, any> | null>(null);
  const [events, setEvents] = useState<Array<Record<string, any>>>([]);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [workflows, setWorkflows] = useState<Array<Record<string, any>>>([]);
  const [timeQuery, setTimeQuery] = useState("今天9点10分");
  const [keywordQuery, setKeywordQuery] = useState("小红书网站");
  const [queryResult, setQueryResult] = useState<Record<string, any> | null>(null);
  const [searchResult, setSearchResult] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshPCActivity() {
    const [statusResult, summaryResult, eventResult, settingsResult, workflowResult] = await Promise.all([
      getPCActivityStatus(),
      getPCActivitySummaryToday(),
      getPCActivityEvents(),
      getPCActivitySettings(),
      getPCActivityWorkflowCandidates()
    ]);
    setStatus(statusResult);
    setSummary(summaryResult);
    setEvents(eventResult.items);
    setSettings(settingsResult);
    setWorkflows(workflowResult.items);
  }

  useEffect(() => {
    refreshPCActivity().catch(() => undefined);
  }, []);

  async function runTimeQuery() {
    setBusy(true);
    try {
      const result = await queryPCActivityAtTime({
        when: timeQuery,
        window_minutes: settings?.minecontext?.default_window_minutes ?? 10,
        include_screenshot_paths: true,
        include_raw_output: false
      });
      setQueryResult(result);
      await refreshPCActivity();
    } finally {
      setBusy(false);
    }
  }

  async function runKeywordSearch() {
    setBusy(true);
    try {
      const result = await searchPCActivity({query: keywordQuery, limit: 8, include_screenshot_paths: true});
      setSearchResult(result);
      await refreshPCActivity();
    } finally {
      setBusy(false);
    }
  }

  async function importToday() {
    setBusy(true);
    try {
      await importPCActivities({lookback_hours: 24, limit: 200});
      await refreshPCActivity();
    } finally {
      setBusy(false);
    }
  }

  async function updatePCSetting(path: "enabled" | "store_screenshot_paths" | "copy_screenshot_evidence", value: boolean) {
    if (!settings) return;
    const next: Record<string, any> = {...settings, minecontext: {...settings.minecontext}};
    if (path === "enabled") {
      next.enabled = value;
      next.minecontext.enabled = value;
    } else {
      next.minecontext[path] = value;
    }
    await updatePCActivitySettings(next);
    await refreshPCActivity();
  }

  async function clearPCEvents() {
    await deletePCActivityEvents();
    await refreshPCActivity();
  }

  const minecontext = status?.minecontext ?? {};
  const metrics = summary?.metrics ?? {};
  const apps = Object.entries(summary?.app_usage ?? {}).slice(0, 5);
  const domains = Object.entries(summary?.domain_usage ?? {}).slice(0, 5);

  return (
    <div className="workstation-page">
      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>MineContext 连接状态</h2>
            <p>OpenButler 只读接入本机 MineContext / godview 技能，默认只保存结构化事件和截图路径。</p>
          </div>
          <div className={minecontext.available ? "live-indicator on" : "live-indicator"}>
            <Database size={16} />
            <span>{minecontext.available ? "已连接" : "未连接"}</span>
          </div>
        </div>
        <div className="status-grid">
          <StatusItem label="访问方式" value={String(minecontext.mode ?? "unavailable")} />
          <StatusItem label="启用状态" value={status?.enabled ? "已启用" : "默认关闭"} />
          <StatusItem label="只读模式" value={status?.read_only ? "开启" : "关闭"} />
          <StatusItem label="工作区目录" value={String(minecontext.workspace_dir ?? "--")} />
          <StatusItem label="数据目录" value={String(minecontext.data_dir ?? "--")} />
          <StatusItem label="可用能力" value={(minecontext.capabilities ?? []).join("、") || "--"} />
        </div>
        <div className="actions-row">
          <button className="secondary" onClick={refreshPCActivity}>检测连接</button>
          <button className="primary" onClick={importToday} disabled={busy}>导入今日活动</button>
          <button className="secondary" onClick={clearPCEvents}>删除导入事件</button>
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <h2>上帝视角查询</h2>
          <p>查询结果必须显示证据边界；MineContext 生成文本不会被当作最终事实。</p>
        </div>
        <div className="pc-query-grid">
          <div className="query-card">
            <label>按时间查询</label>
            <div className="searchbar">
              <Search size={18} />
              <input value={timeQuery} onChange={(event) => setTimeQuery(event.target.value)} />
              <button className="secondary" onClick={runTimeQuery} disabled={busy}>查询</button>
            </div>
            {queryResult && <EvidenceResult result={queryResult} />}
          </div>
          <div className="query-card">
            <label>按关键词搜索</label>
            <div className="searchbar">
              <Search size={18} />
              <input value={keywordQuery} onChange={(event) => setKeywordQuery(event.target.value)} />
              <button className="secondary" onClick={runKeywordSearch} disabled={busy}>搜索</button>
            </div>
            {searchResult && <SearchEvidenceResult result={searchResult} />}
          </div>
        </div>
      </section>

      <section className="metrics">
        <Metric icon={Database} label="PC 活跃时长" value={`${metrics.total_pc_active_minutes ?? 0} 分钟`} tone="blue" />
        <Metric icon={BrainCircuit} label="深度工作" value={`${metrics.estimated_focus_minutes ?? 0} 分钟`} tone="green" />
        <Metric icon={RefreshCw} label="上下文切换" value={metrics.estimated_context_switch_count ?? 0} tone="amber" />
        <Metric icon={Trophy} label="工作流候选" value={workflows.length} tone="red" />
      </section>

      <section className="panel">
        <div className="section-title"><h2>主要应用</h2></div>
        <div className="bar-list">
          {apps.length ? apps.map(([label, value]) => (
            <div className="bar-row" key={label}>
              <span>{label}</span>
              <div><i style={{width: `${Math.min(100, Math.round(Number(value) / 60))}%`}} /></div>
              <strong>{Math.round(Number(value) / 60)}m</strong>
            </div>
          )) : <p className="policy-note">导入今日活动后显示。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><h2>主要网站</h2></div>
        <div className="bar-list">
          {domains.length ? domains.map(([label, value]) => (
            <div className="bar-row" key={label}>
              <span>{label}</span>
              <div><i style={{width: `${Math.min(100, Math.round(Number(value) / 60))}%`}} /></div>
              <strong>{Math.round(Number(value) / 60)}m</strong>
            </div>
          )) : <p className="policy-note">没有可统计的域名线索。</p>}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title"><h2>PC 活动时间线</h2></div>
        <div className="event-list">
          {events.slice(0, 8).map((event) => (
            <article className="event-row" key={event.id}>
              <div className="event-time">{formatTime(event.started_at)}</div>
              <div className="event-body">
                <strong>{event.title || event.activity_type}</strong>
                <span>{event.summary}</span>
                <div className="evidence">
                  <small>minecontext</small>
                  <small>置信度 {Math.round(Number(event.confidence ?? 0) * 100)}%</small>
                  <small>{event.evidence_level}</small>
                  <small>{event.screenshot_paths?.length ? "有截图路径" : "无截图路径"}</small>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title"><h2>工作流候选</h2></div>
        <div className="plugin-list">
          {workflows.map((item, index) => (
            <article className="plugin" key={`${item.title}-${index}`}>
              <strong>{String(item.title)}</strong>
              <span>出现 {String(item.occurrences)} 次 · 建议封装为 {String(item.automation_fit)}</span>
              <p>{String(item.evidence_boundary)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="wide-panel privacy-controls">
        <div className="section-title">
          <h2>隐私控制</h2>
          <p>strict 模式禁止外部模型、外部 webhook；默认不复制截图，只保存路径用于本地复核。</p>
        </div>
        <label><input type="checkbox" checked={!!settings?.enabled} onChange={(event) => updatePCSetting("enabled", event.target.checked)} /> 启用 MineContext 接入</label>
        <label><input type="checkbox" checked readOnly /> 只读模式</label>
        <label><input type="checkbox" checked={!!settings?.minecontext?.store_screenshot_paths} onChange={(event) => updatePCSetting("store_screenshot_paths", event.target.checked)} /> 保存截图路径</label>
        <label><input type="checkbox" checked={!!settings?.minecontext?.copy_screenshot_evidence} onChange={(event) => updatePCSetting("copy_screenshot_evidence", event.target.checked)} /> 复制截图证据</label>
        <label>当前隐私模式 <input value={privacyMode} readOnly /></label>
      </section>
    </div>
  );
}

function EvidenceResult({result}: {result: Record<string, any>}) {
  return (
    <div className="suggestion-box">
      <strong>{result.can_confirm ? "可以作为较高置信度线索确认" : "无法客观确认"}</strong>
      <span>{String(result.summary ?? "")}</span>
      <span>activity id：{(result.activity_ids ?? []).join("、") || "无"} · context id：{(result.context_ids ?? []).join("、") || "无"}</span>
      <span>截图路径：{(result.screenshot_paths ?? []).slice(0, 2).join("；") || "无"}</span>
      <span>{String(result.evidence_boundary ?? "")}</span>
    </div>
  );
}

function SearchEvidenceResult({result}: {result: Record<string, any>}) {
  const first = result.items?.[0];
  if (!first) {
    return <div className="suggestion-box"><strong>没有可确认命中</strong><span>{String(result.evidence_boundary ?? result.error ?? "无结果")}</span></div>;
  }
  return (
    <div className="suggestion-box">
      <strong>{String(first.match_level)} · {first.can_confirm ? "可确认线索" : "不能确认"}</strong>
      <span>{String(first.started_at ?? "未知")} - {String(first.ended_at ?? "未知")}</span>
      <span>{String(first.summary ?? "")}</span>
      <span>source id：{String(first.source_id ?? "无")} · 截图路径：{(first.screenshot_paths ?? []).slice(0, 2).join("；") || "无"}</span>
      <span>{String(first.evidence_boundary ?? "")}</span>
    </div>
  );
}

function StatusItem({label, value}: {label: string; value: string}) {
  return (
    <div className="status-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Chat() {
  const [messages, setMessages] = useState<Array<{role: "user" | "butler"; text: string}>>([
    {role: "butler", text: "我已经为你整理好今天值得回看的 3 件事，其中 1 件可能需要你决定。你可以让我回看今天，也可以让我提醒下一步。"}
  ]);
  const [text, setText] = useState("我的钥匙在哪");
  const [pending, setPending] = useState(false);

  function sanitizeAnswer(answer: string) {
    return answer
      .replace(/phone_album/g, "相册线索（演示）")
      .replace(/seed/g, "演示线索")
      .replace(/raw source/g, "原始依据")
      .replace(/source_event_id/g, "依据编号")
      .replace(/MineContext/g, "电脑活动")
      .replace(/PC Activity/g, "电脑使用")
      .replace(/mock/g, "演示")
      .replace(/fixture/g, "演示");
  }

  async function send(message = text) {
    if (!message.trim()) return;
    setPending(true);
    setMessages((items) => [...items, {role: "user", text: message}]);
    setText("");
    try {
      const result = await askButler(message);
      setMessages((items) => [...items, {role: "butler", text: sanitizeAnswer(result.answer)}]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="chat-layout">
      <div className="butler-brief">
        <span className="privacy-chip">演示体验</span>
        <strong>我先帮你看过一遍今天。</strong>
        <p>现在可以回看今日重点、确认下一步，或查看物品和生活节律的演示线索。</p>
        <div className="hero-actions">
          <button className="primary" onClick={() => send("帮我回看今天")}>帮我回看今天</button>
          <button className="secondary" onClick={() => send("提醒我下一步")}>提醒我下一步</button>
        </div>
      </div>
      <div className="suggestions">
        {[
          "今天有什么值得注意？",
          "查看今日记录",
          "哪些事适合自动提醒？",
          "我的钥匙在哪？",
          "今天适合休息一下吗？",
          "帮我总结本周的小成就"
        ].map((item) => (
          <button className="secondary" key={item} onClick={() => send(item)}>{item}</button>
        ))}
      </div>
      <div className="messages">
        {messages.map((message, index) => (
          <div className={`bubble ${message.role}`} key={`${message.role}-${index}`}>
            {message.text}
          </div>
        ))}
      </div>
      <div className="composer">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
          placeholder="向 OpenButler 提问"
        />
        <button className="primary" onClick={() => send()} disabled={pending}>
          {pending ? <Loader2 className="spin" size={17} /> : <MessageSquareText size={17} />}
          <span>发送</span>
        </button>
      </div>
    </section>
  );
}

function Privacy({
  mode,
  onChange,
  plugins
}: {
  mode: PrivacyMode;
  onChange: (mode: PrivacyMode) => void;
  plugins: PluginManifest[];
}) {
  const blocked = plugins.filter((plugin) => !plugin.runtime.available).length;
  return (
    <div className="me-page">
      <section className="today-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">我的</p>
            <h2>我的授权</h2>
            <p>你可以随时查看 OpenButler 读取了什么、没有读取什么，以及如何关闭或删除。</p>
          </div>
        </div>
        <div className="mode-toggle">
          <button className={mode === "basic" ? "selected" : ""} onClick={() => onChange("basic")}>
            <ShieldCheck size={20} />
            <strong>基础隐私</strong>
            <span>适合你明确授权的联网服务。</span>
          </button>
          <button className={mode === "strict" ? "selected" : ""} onClick={() => onChange("strict")}>
            <CloudOff size={20} />
            <strong>完全本地</strong>
            <span>禁止外部模型、云端 API 和外部回调。</span>
          </button>
        </div>
        <p className="policy-note">完全本地模式下，有 {blocked} 项联网能力已暂停，避免未经确认的数据外发。</p>
      </section>

      <section className="today-panel">
        <div className="section-title"><h2>读取了什么</h2></div>
        <div className="status-grid compact-status">
          <StatusItem label="今日记录" value="演示" />
          <StatusItem label="管家提醒" value="演示" />
          <StatusItem label="相册线索" value="演示" />
          <StatusItem label="真实本机数据" value="未读取" />
        </div>
        <p className="policy-note">线上 Demo 只使用演示内容展示产品效果，不会读取你的真实相册、电脑活动或本地截图。</p>
      </section>

      <section className="today-panel">
        <div className="section-title"><h2>提醒偏好</h2></div>
        <div className="status-grid compact-status">
          <StatusItem label="每日概览" value="开启" />
          <StatusItem label="提醒频率" value="保守" />
          <StatusItem label="生活建议" value="开启" />
          <StatusItem label="依据说明" value="点击后展开" />
        </div>
      </section>

      <details className="advanced-lab-panel">
        <summary>开发者设置</summary>
        <div className="topology">
          <div className="topology-row"><ShieldCheck size={18} /><span>隐私策略详情：完全本地模式会拦截 Provider、Webhook 和外部模型。</span></div>
          <div className="topology-row"><Camera size={18} /><span>Capture Gateway（高级采集入口）</span></div>
          <div className="topology-row"><BrainCircuit size={18} /><span>Preprocessor Runtime（高级前处理）</span></div>
          <div className="topology-row"><Database size={18} /><span>SQLite + Local Files（本地数据层）</span></div>
          <div className="topology-row"><Bot size={18} /><span>OpenClaw 技能声明已配置，运行时调用未验证。</span></div>
          <div className="topology-row"><Database size={18} /><span>后续预留：PostgreSQL + pgvector、MinIO、DuckDB。</span></div>
        </div>
      </details>
    </div>
  );
}

function EventRow({event, verbose = false}: {event: EventItem; verbose?: boolean}) {
  return (
    <article className="event-row">
      <div className="event-time">{formatTime(event.timestamp)}</div>
      <div className="event-body">
        <strong>{event.title}</strong>
        <span>{event.summary}</span>
        {verbose && (
          <div className="evidence">
            <small>{event.source}</small>
            {event.location && <small>{event.location}</small>}
            {event.score !== null && event.score !== undefined && <small>score {event.score}</small>}
            <small>{event.evidence_chain.length} 条证据</small>
          </div>
        )}
      </div>
    </article>
  );
}

export default App;
