import {useEffect, useMemo, useRef, useState} from "react";
import {PublicWindowCaptureSetup} from "./components/PublicWindowCaptureSetup";
import {CaptureObservationFeed} from "./components/CaptureObservationFeed";
import {CaptureObservationProvenance} from "./components/CaptureObservationProvenance";
import {CaptureObservationAnalysis, observationCurrentContent, observationStateLabel} from "./components/CaptureObservationAnalysis";
import {CaptureSessionSummary, capturePauseMessage} from "./components/CaptureSessionSummary";
import type {CaptureCapabilities} from "./lib/captureTypes";
import {MaskEditor} from "./components/MaskEditor";
import type {MaskedEditingCanvas} from "./components/MaskEditor";
import {clampMask, sameMask, validImageBounds} from "./lib/maskGeometry";
import type {ImageBounds} from "./lib/maskGeometry";
import {createPrivacyPreviewGate} from "./lib/privacyPreviewGate";
import type {PreviewTicket} from "./lib/privacyPreviewGate";
import {currentAppPath, replaceAppPath} from "./lib/navigation";
import {PreviewDailyReview} from "./components/PreviewDailyReview";
import {AgentLoopPanel} from "./components/AgentLoopPanel";
import {ModelCatalog} from "./components/ModelCatalog";
import type {ModelRole} from "./lib/modelCatalog";
import {
  Bot,
  Boxes,
  BrainCircuit,
  CalendarDays,
  Camera,
  CheckCircle2,
  ClipboardCheck,
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
  getButlerInsightNoiseEvaluation,
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
  getDesktopStatus,
  getContextEngineStatus,
  getContextObservations,
  deleteContextObservation,
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
  pauseBuiltinCaptureApi,
  revokeBuiltinCaptureApi,
  retryContextObservation,
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
  simulateEvents,
  type CaptureConfig,
  type ContextEngineStatus,
  type ContextObservation,
  type CaptureCoverageEvent
} from "./lib/api";
import {buildTodayHomeViewModel, type ActivationMode} from "./lib/butlerUiAdapter";
import {buildAchievementViewModel, type AchievementCard} from "./lib/achievementUiAdapter";
import {
  inboxCountByState,
  inboxStateLabels,
  sortInboxCards,
  toInboxDecisionCard,
  type InboxDecisionCard,
  type InboxDecisionState
} from "./lib/inboxUiAdapter";
import {
  groupTimelineByDate,
  timelineCategoryLabel,
  timelineImportanceLabel,
  toTimelineMoment,
  type TimelineMoment
} from "./lib/timelineUiAdapter";
import {insightTypeLabel, privacyModeLabel, sourceLabel, statusLabel, userFacingDemoText} from "./lib/userFacingLabels";
import type {EventItem, PluginManifest, PrivacyMode} from "./types";
import {DesignConceptPage, DesignLabPage, FormalButlerHome} from "./pages/DesignVariants";

type PageKey =
  | "acceptance"
  | "butler"
  | "dashboard"
  | "ingest"
  | "plugins"
  | "timeline"
  | "achievements"
  | "chat"
  | "models"
  | "workstation"
  | "pcActivity"
  | "butlerInbox"
  | "metrics"
  | "goals"
  | "privacy"
  | "designLab"
  | "designMijia"
  | "designIos"
  | "designDeck";

const primaryNavItems: Array<{key: PageKey; label: string; icon: typeof Home}> = [
  {key: "butler", label: "今日", icon: Inbox},
  {key: "timeline", label: "时间线", icon: CalendarDays},
  {key: "achievements", label: "成就", icon: Trophy},
  {key: "chat", label: "问管家", icon: MessageSquareText},
  {key: "models", label: "模型", icon: Boxes},
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
  {key: "ingest", label: "数据接入", icon: PlugZap},
  {key: "designLab", label: "设计实验室", icon: Boxes}
];

const navItems = [...primaryNavItems, ...advancedNavItems];
const FIRST_RUN_ACTIVATION_STORAGE_KEY = "openbutler:first_run_activation:v1";
const PREVIEW_ACTIVATION_STORAGE_KEY = "openbutler:preview_activation:v1";
const isPreviewDesktop = () => window.openbutlerDesktop?.channel === "preview";

type ActivationStatus = "unseen" | "demo_selected" | "real_setup_started" | "dismissed" | "completed";
type ModelProviderConfig = {
  modelPlatform: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  useSeparateEmbedding: boolean;
  embeddingModelPlatform: string;
  embeddingModelId: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
};

const DEFAULT_MODEL_PROVIDER_CONFIG: ModelProviderConfig = {
  modelPlatform: "doubao",
  modelId: "ark-code-latest",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  apiKey: "",
  useSeparateEmbedding: false,
  embeddingModelPlatform: "doubao",
  embeddingModelId: "doubao-embedding-vision",
  embeddingBaseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  embeddingApiKey: "",
};

function readActivationStatus(): ActivationStatus {
  try {
    const value = window.localStorage.getItem(isPreviewDesktop() ? PREVIEW_ACTIVATION_STORAGE_KEY : FIRST_RUN_ACTIVATION_STORAGE_KEY);
    return value === "demo_selected" ||
      value === "real_setup_started" ||
      value === "dismissed" ||
      value === "completed"
      ? value
      : "unseen";
  } catch {
    return "unseen";
  }
}

function activationModeFor(status: ActivationStatus): ActivationMode {
  if (status === "demo_selected") return "demo";
  if (status === "real_setup_started" || status === "completed") return "real_local";
  return "not_started";
}

function activationStatusLabel(status: ActivationStatus) {
  return {
    unseen: "尚未开始",
    demo_selected: "样例体验",
    real_setup_started: "本地模式待授权",
    dismissed: "稍后配置",
    completed: "已完成设置"
  }[status];
}

function routeForPage(key: PageKey) {
  return {
    acceptance: "/acceptance",
    butler: "/butler",
    timeline: "/timeline",
    achievements: "/achievements",
    chat: "/assistant",
    models: "/models",
    privacy: "/me",
    dashboard: "/dashboard",
    pcActivity: "/pc-activity-context",
    workstation: "/vision",
    plugins: "/plugins",
    metrics: "/metrics",
    goals: "/goals",
    butlerInbox: "/butler/inbox",
    ingest: "/ingest",
    designLab: "/design-lab",
    designMijia: "/design/mijia",
    designIos: "/design/ios",
    designDeck: "/design/deck"
  }[key];
}

function navigateClient(path: string) {
  replaceAppPath(path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function pageForPath(path: string): PageKey {
  return path === "/models" ? "models" : path.includes("acceptance")
    ? "acceptance"
    : path.includes("design/mijia")
    ? "designMijia"
    : path.includes("design/ios")
      ? "designIos"
      : path.includes("design/deck")
        ? "designDeck"
        : path.includes("design-lab")
          ? "designLab"
          : path.includes("butler/inbox")
    ? "butlerInbox"
    : path.includes("metrics")
      ? "metrics"
      : path.includes("goals")
        ? "goals"
        : path.includes("achievements")
          ? "achievements"
        : path.includes("pc-activity-context")
          ? "pcActivity"
          : path.includes("vision")
            ? "workstation"
            : path.includes("timeline")
              ? "timeline"
              : path.includes("assistant") || path.includes("butler/chat") || path.includes("chat")
                ? "chat"
                : path.includes("me") || path.includes("settings") || path.includes("privacy")
                  ? "privacy"
                  : path.includes("plugins")
                    ? "plugins"
                    : path.includes("ingest")
                      ? "ingest"
                      : path.includes("dashboard")
                        ? "dashboard"
                        : "butler";
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
  const currentPath = currentAppPath();
  const [page, setPage] = useState<PageKey>(() => pageForPath(currentPath));
  const [events, setEvents] = useState<EventItem[]>([]);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [privacyMode, setMode] = useState<PrivacyMode>("basic");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activationStatus, setActivationStatus] = useState<ActivationStatus>(() => readActivationStatus());
  const [showFirstRunGuide, setShowFirstRunGuide] = useState(false);

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

  useEffect(() => {
    function syncPageFromLocation() {
      setPage(pageForPath(currentAppPath()));
    }

    window.addEventListener("popstate", syncPageFromLocation);
    return () => window.removeEventListener("popstate", syncPageFromLocation);
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

  function updateActivation(status: ActivationStatus) {
    try {
      window.localStorage.setItem(isPreviewDesktop() ? PREVIEW_ACTIVATION_STORAGE_KEY : FIRST_RUN_ACTIVATION_STORAGE_KEY, status);
    } catch {
      // Local storage can be unavailable in restricted browser modes.
    }
    setActivationStatus(status);
  }

  function closeActivation(status: ActivationStatus) {
    updateActivation(status);
    setShowFirstRunGuide(false);
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

  const isDesignPage = page === "designLab" || page === "designMijia" || page === "designIos" || page === "designDeck";

  const CurrentPage = {
    acceptance: <AcceptanceCenter />,
    butler: isPreviewDesktop() && activationStatus !== "demo_selected"
      ? <PreviewToday onOpenGuide={() => setShowFirstRunGuide(true)} />
      : <FormalButlerHome activationStatus={activationStatus} />,
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
    achievements: <AchievementsPage />,
    chat: isPreviewDesktop() ? <AgentLoopPanel /> : <Chat activationStatus={activationStatus} />,
    models: <PreviewModelSettings onSaved={async () => {}} />,
    workstation: <WorkstationVision privacyMode={privacyMode} />,
    pcActivity: <PCActivityContext privacyMode={privacyMode} />,
    butlerInbox: <ButlerInbox />,
    metrics: <MetricsPage />,
    goals: <GoalsPage />,
    designLab: <DesignLabPage />,
    designMijia: <DesignConceptPage variant="mijia" activationStatus={activationStatus} />,
    designIos: <DesignConceptPage variant="ios" activationStatus={activationStatus} />,
    designDeck: <DesignConceptPage variant="deck" activationStatus={activationStatus} />,
    privacy: isPreviewDesktop() && activationStatus !== "demo_selected"
      ? <PreviewPrivacy mode={privacyMode} onChange={handlePrivacy} onOpenGuide={() => setShowFirstRunGuide(true)} />
      : <Privacy
          mode={privacyMode}
          onChange={handlePrivacy}
          plugins={plugins}
          activationStatus={activationStatus}
          onOpenGuide={() => setShowFirstRunGuide(true)}
        />
  }[page];

  const activationGateOpen = !(isPreviewDesktop() && (page === "chat" || page === "models") && activationStatus === "dismissed") && page !== "acceptance" && !isDesignPage && activationStatus !== "demo_selected" && activationStatus !== "completed";

  if (activationGateOpen) {
    return (
      <FirstRunGuide
        status={activationStatus}
        onChooseLocalChat={() => {
          closeActivation("dismissed");
          setPage("chat");
          replaceAppPath(routeForPage("chat"));
        }}
        mandatory
        onChooseDemo={() => {
          closeActivation("demo_selected");
          setPage("butler");
          replaceAppPath(routeForPage("butler"));
        }}
        onChooseReal={() => {
          updateActivation("real_setup_started");
        }}
        onDismiss={() => updateActivation("dismissed")}
        onComplete={() => {
          closeActivation("completed");
          setPage("butler");
          replaceAppPath(routeForPage("butler"));
        }}
      />
    );
  }

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark"><Bot size={22} /></div>
            <div>
              <strong>OpenButler</strong>
              <span>你的私人管家</span>
            </div>
          </div>
          <nav aria-label="OpenButler 主导航">
            {primaryNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  data-nav-key={item.key}
                  className={page === item.key ? "active" : ""}
                  onClick={() => {
                    setPage(item.key);
                    replaceAppPath(routeForPage(item.key));
                  }}
                  title={item.label}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="mode-chip">
            {privacyMode === "strict" ? <CloudOff size={16} /> : <ShieldCheck size={16} />}
            <span>{privacyModeLabel(privacyMode)}</span>
          </div>
        </aside>

        <main>
          {!isDesignPage && !primaryNavItems.some((item) => item.key === page) && <header className="topbar">
            <div>
              <p className="eyebrow">个人/家庭多模态事件湖原型</p>
              <h1>{page === "acceptance" ? "今日验收" : navItems.find((item) => item.key === page)?.label}</h1>
            </div>
            <button className="primary" onClick={handleSimulate} disabled={loading}>
              {loading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              <span>生成演示记录</span>
            </button>
          </header>}
          {error && <div className="mode-notice">当前为样例模式，未读取你的真实数据。安装桌面版后可以启用真实本地模式。</div>}
          {CurrentPage}
        </main>
      </div>
      {showFirstRunGuide && (
        <FirstRunGuide
          status={activationStatus}
          onChooseLocalChat={() => {
            closeActivation("dismissed");
            setPage("chat");
            replaceAppPath(routeForPage("chat"));
          }}
          onChooseDemo={() => {
            closeActivation("demo_selected");
            setPage("butler");
            replaceAppPath(routeForPage("butler"));
          }}
          onChooseReal={() => {
            updateActivation("real_setup_started");
          }}
          onDismiss={() => setShowFirstRunGuide(false)}
          onComplete={() => closeActivation("completed")}
        />
      )}
    </>
  );
}

type AcceptanceFeedback = {
  status: "passed" | "failed" | "conditional";
  comment: string;
};

function AcceptanceCenter() {
  const [pack, setPack] = useState<Record<string, any> | null>(null);
  const [feedback, setFeedback] = useState<Record<string, AcceptanceFeedback>>({});
  const [message, setMessage] = useState("正在读取昨夜验收包…");

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const value = await window.openbutlerDesktop?.getAcceptancePack();
      if (!mounted) return;
      setPack(value ?? null);
      setMessage(value ? "按场景体验后，留下你的判断。" : "还没有可用的夜间验收包。");
    })();
    return () => { mounted = false; };
  }, []);

  async function updateScenario(id: string, patch: Partial<AcceptanceFeedback>) {
    const next = {
      ...feedback,
      [id]: {...(feedback[id] ?? {status: "conditional", comment: ""}), ...patch}
    };
    setFeedback(next);
    const saved = await window.openbutlerDesktop?.saveAcceptanceFeedback({run_id: pack?.run_id, scenarios: next});
    setMessage(saved?.ok ? "已保存在本机。" : saved?.message ?? "没有保存成功，请再试一次。");
  }

  const approvedPrs = (pack?.pull_requests ?? [])
    .filter((pr: Record<string, any>) => feedback[`pr-${pr.number}`]?.status === "passed")
    .map((pr: Record<string, any>) => `#${pr.number}`);
  const approvalCommand = approvedPrs.length ? `批准合并 PR ${approvedPrs.join(" ")}` : "完成场景验收后生成批准命令";

  if (!pack) {
    return (
      <section className="acceptance-center friendly-empty">
        <ClipboardCheck size={30} />
        <h2>今天没有待测版本</h2>
        <p>{message}</p>
        <p className="evidence-boundary">系统不会用旧报告冒充昨夜运行结果。</p>
      </section>
    );
  }

  return (
    <div className="acceptance-center">
      <section className="acceptance-hero">
        <div>
          <p className="eyebrow">OpenButler Preview · {pack.mode === "dry-run" ? "只读演练" : "候选版本"}</p>
          <h2>早上好，昨夜结果已经整理好</h2>
          <p>{pack.summary}</p>
        </div>
        <div className="acceptance-version">
          <span>本次运行</span>
          <strong>{pack.candidate_version ?? "无安装候选"}</strong>
          <small>{pack.run_id}</small>
        </div>
      </section>

      <section className="acceptance-command">
        <div>
          <span>完成验收后发给 Codex</span>
          <strong>{approvalCommand}</strong>
        </div>
        <p>{message}</p>
      </section>

      <section className="acceptance-list" aria-label="待测场景">
        {(pack.scenarios ?? []).length === 0 && (
          <div className="friendly-empty">
            <h3>本轮没有可执行场景</h3>
            <p>这通常表示没有同时获得执行授权和完整规格的 Issue。</p>
          </div>
        )}
        {(pack.scenarios ?? []).map((scenario: Record<string, any>) => {
          const id = String(scenario.id);
          const current = feedback[id];
          return (
            <article className="acceptance-card" key={id}>
              <div className="acceptance-card-head">
                <div>
                  <span>{scenario.pr_number ? `PR #${scenario.pr_number}` : scenario.issue_number ? `Issue #${scenario.issue_number}` : "验收场景"}</span>
                  <h3>{scenario.title}</h3>
                </div>
                <span className={`acceptance-state ${current?.status ?? "pending"}`}>
                  {current?.status === "passed" ? "通过" : current?.status === "failed" ? "不通过" : current?.status === "conditional" ? "有条件通过" : "待验收"}
                </span>
              </div>
              <p>{scenario.purpose}</p>
              <ol>{(scenario.steps ?? []).map((step: string) => <li key={step}>{step}</li>)}</ol>
              <div className="acceptance-expected"><strong>预期</strong><span>{scenario.expected}</span></div>
              <div className="acceptance-actions">
                <button onClick={() => updateScenario(id, {status: "passed"})}>通过</button>
                <button onClick={() => updateScenario(id, {status: "conditional"})}>有条件通过</button>
                <button onClick={() => updateScenario(id, {status: "failed"})}>不通过</button>
              </div>
              <label className="acceptance-comment">
                <span>体验意见</span>
                <textarea
                  value={current?.comment ?? ""}
                  onChange={(event) => setFeedback((previous) => ({
                    ...previous,
                    [id]: {...(previous[id] ?? {status: "conditional"}), comment: event.target.value}
                  }))}
                  onBlur={(event) => updateScenario(id, {comment: event.target.value})}
                  placeholder="哪里不顺手、和预期有什么不同"
                />
              </label>
            </article>
          );
        })}
      </section>

      <section className="acceptance-privacy">
        <div><ShieldCheck size={20} /><strong>本轮隐私检查</strong></div>
        <ul>
          <li>真实活动读取：{pack.privacy?.real_activity_read ? "是" : "否"}</li>
          <li>数据库写入：{pack.privacy?.database_written ? "是" : "否"}</li>
          <li>截图复制：{pack.privacy?.screenshots_copied ? "是" : "否"}</li>
          <li>外部模型调用：{pack.privacy?.external_model_called ? "是" : "否"}</li>
        </ul>
      </section>
    </div>
  );
}


function AchievementsPage() {
  const [events, setEvents] = useState<Array<Record<string, any>>>([]);
  const [timelineItems, setTimelineItems] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [eventResult, timelineResult] = await Promise.all([
          getEvents(),
          getButlerTimeline()
        ]);
        if (!mounted) return;
        setEvents((eventResult as any).events ?? eventResult.items ?? []);
        setTimelineItems(timelineResult.items ?? []);
      } catch {
        if (!mounted) return;
        setEvents([]);
        setTimelineItems([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const view = buildAchievementViewModel(events, timelineItems);

  const navigateTo = (path: string) => {
    replaceAppPath(path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="achievements-page">
      <section className="achievement-hero today-panel">
        <div>
          <p className="eyebrow">{view.dataMode === "sample" ? "样例体验，未读取你的真实数据。" : "本地整理"}</p>
          <h1>{view.headline}</h1>
          <p>{view.subheadline}</p>
        </div>
        <div className="achievement-hero-number">
          <strong>{view.today.length}</strong>
          <span>条小成就</span>
        </div>
      </section>

      <section className="today-panel">
        <div className="section-title">
          <div>
            <h2>今天的小成就</h2>
            <p>这里记录进展，不评价你，也不制造压力。</p>
          </div>
        </div>
        <div className="achievement-card-grid">
          {view.today.map((item: AchievementCard) => (
            <article className="achievement-card-v2" key={item.id}>
              <div className="achievement-card-head">
                <Trophy size={20} />
                <span>{item.timeLabel}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              <div className="achievement-meta-row">
                <span>{item.source}</span>
                <span>可信度 {item.confidence}</span>
              </div>
              <details className="achievement-evidence">
                <summary>查看依据</summary>
                <div>
                  <span>来源：{item.source}</span>
                  <span>可信度：{item.confidence}</span>
                  <span>边界说明：{item.boundary}</span>
                  <span>隐私说明：{item.privacy}</span>
                </div>
              </details>
            </article>
          ))}
        </div>
      </section>

      <section className="achievement-columns">
        <div className="today-panel">
          <div className="section-title">
            <h2>连续记录</h2>
          </div>
          <div className="achievement-streak-list">
            {view.streaks.map((item) => (
              <div className="achievement-streak" key={item.id}>
                <strong>{item.value}</strong>
                <div>
                  <span>{item.title}</span>
                  <p>{item.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="today-panel">
          <div className="section-title">
            <h2>下一枚可解锁</h2>
          </div>
          <div className="achievement-next-list">
            {view.nextUnlock.map((item) => (
              <article className="achievement-next" key={item.id}>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                <button
                  className="secondary"
                  onClick={() => navigateTo(item.action.includes("时间线") ? "/timeline" : "/me")}
                >
                  {item.action}
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      {loading && <div className="friendly-empty"><strong>正在整理小成就</strong><span>如果暂时没有真实记录，会先展示样例体验。</span></div>}
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

function ButlerHome({
  activationStatus,
  onActivation,
  onOpenGuide
}: {
  activationStatus: ActivationStatus;
  onActivation: (status: ActivationStatus) => void;
  onOpenGuide: () => void;
}) {
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
  const [mvpActionBusy, setMvpActionBusy] = useState("");
  const [mvpActionMessage, setMvpActionMessage] = useState("");
  const [timelineItems, setTimelineItems] = useState<Array<Record<string, any>>>([]);
  const [attentionSuggestionId, setAttentionSuggestionId] = useState<string | null>(null);
  const [suggestionFocusMessage, setSuggestionFocusMessage] = useState("");

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
    replaceAppPath(path);
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
  const activationMode = activationModeFor(activationStatus);
  const view = buildTodayHomeViewModel(home, timelineItems, activationMode);
  const primarySuggestion = view.topSuggestions[0];
  const command = view.commandCenter;
  const sceneLead = view.sceneCards[0];
  const sceneRest = view.sceneCards.slice(1);

  function focusTopSuggestion() {
    if (!command.topSuggestion) return;
    setAttentionSuggestionId(command.topSuggestion.id);
    setSuggestionFocusMessage("已把这条建议展开在下面。你可以先看依据，再决定有用、不准确或稍后处理。");
    document.getElementById("today-suggestions")?.scrollIntoView({behavior: "smooth", block: "start"});
    window.setTimeout(() => {
      setAttentionSuggestionId(null);
      setSuggestionFocusMessage("");
    }, 3600);
  }

  function handleCommandPrimary() {
    if (view.mode === "new_user") {
      onActivation("demo_selected");
      return;
    }
    if (command.topSuggestion) {
      focusTopSuggestion();
      return;
    }
    navigateTo("/timeline");
  }

  function startFullSetup() {
    onActivation("real_setup_started");
    onOpenGuide();
  }

  function replayGuide() {
    onActivation("unseen");
    onOpenGuide();
  }

  return (
    <div className="today-page">
      <section className="today-hero mi-home-command" aria-label="OpenButler 今日中控">
        <div className="today-hero-copy">
          <div className="home-mode-row">
            <span className="privacy-chip">{command.dataMode === "sample" ? "样例体验" : command.dataMode === "local" ? "本地整理" : "还未授权"}</span>
            <span>{command.privacyHint}</span>
          </div>
          <div className="home-tab-row" aria-label="今日场景分类">
            <button className="active">今日</button>
            <button onClick={() => navigateTo("/timeline")}>记录</button>
            <button onClick={() => navigateTo("/achievements")}>成就</button>
            <button onClick={() => navigateTo("/me")}>设置</button>
          </div>
          <h1>{command.headline}</h1>
          <p className="hero-summary">{command.oneLineStatus}</p>
          <div className="home-status-strip">
            {command.keyNumbers.map((item) => (
              <article key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
                <small>{item.description}</small>
              </article>
            ))}
          </div>
          <div className="hero-actions primary-action-row">
            <button className="primary" onClick={handleCommandPrimary}>
              <CheckCircle2 size={17} />
              <span>{command.primaryAction}</span>
            </button>
            {(activationStatus === "demo_selected" || activationStatus === "completed") && (
              <button className="secondary setup-action" onClick={startFullSetup}>打开完整设置</button>
            )}
            {view.mode === "new_user" && (
              <button className="secondary" onClick={() => navigateTo("/me")}>了解本地模式</button>
            )}
          </div>
          {suggestionFocusMessage && <p className="action-feedback" role="status">{suggestionFocusMessage}</p>}
        </div>
        <div className="today-hero-status command-suggestion-card">
          <span className="privacy-chip">建议先看</span>
          <strong>{command.topSuggestion?.title ?? (view.mode === "new_user" ? "先看一个样例" : "今天没有紧急提醒")}</strong>
          <span>
            {command.topSuggestion?.summary
              ?? (view.mode === "new_user"
                ? "样例能让你先看到今日概览、时间线和依据是什么样。"
                : "你可以继续查看时间线，或者稍后再回来。")}
          </span>
          <button className="secondary" onClick={command.topSuggestion ? focusTopSuggestion : handleCommandPrimary}>
            {command.topSuggestion ? "看这条建议" : command.primaryAction}
          </button>
        </div>
      </section>

      {(activationStatus === "demo_selected" || activationStatus === "completed") && (
        <section className="setup-resume-panel" aria-label="本地完整功能设置">
          <div>
            <p className="eyebrow">当前可继续样例，也可以切到本地完全体</p>
            <h2>要使用自己的记录，先完成本地设置</h2>
            <p>
              现在没有读取你的真实数据。打开完整设置时，OpenButler 会先帮你准备智能整理能力，再查找本机记录组件。
              确认前不会导入活动，也不会复制截图。
            </p>
            <div className="setup-resume-checklist" aria-label="本地完全体开始步骤">
              <article>
                <strong>1. 打开桌面版</strong>
                <span>网页只能看样例。要使用自己的记录，请先获取并打开 OpenButler 桌面版。</span>
              </article>
              <article>
                <strong>2. 准备 API Key</strong>
                <span>推荐先用火山引擎 Ark 控制台创建 API Key。它相当于你给本机整理能力的一把钥匙。</span>
              </article>
              <article>
                <strong>3. 授权本机记录</strong>
                <span>OpenButler 只先确认本机记录来源是否可用；你确认前不会读取活动明细。</span>
              </article>
            </div>
          </div>
          <div className="setup-resume-actions">
            <button className="primary" onClick={startFullSetup}>打开完整设置</button>
            <button className="secondary" onClick={replayGuide}>重新打开引导</button>
          </div>
        </section>
      )}

      {view.mode === "new_user" && (
        <ProgressiveOnboarding
          activationStatus={activationStatus}
          onDemo={() => {
            onActivation("demo_selected");
            document.getElementById("today-suggestions")?.scrollIntoView({behavior: "smooth"});
          }}
          onOpenAdvanced={() => navigateTo("/me")}
        />
      )}

      <details className="today-panel today-more-status">
        <summary>更多今日信息</summary>
        <section className="today-status-grid compact-home-stats">
          {view.statusCards.map((card) => <TodayStatusTile card={card} key={card.title} />)}
        </section>
      </details>

      <section className="today-panel scene-dashboard-panel scene-dashboard-main" aria-label="今日场景信号">
        <div className="section-title">
          <div>
            <h2>场景信号</h2>
            <p>像米家状态卡一样，只放今天最有用的数字和线索。</p>
          </div>
          <button className="ghost" onClick={() => navigateTo("/timeline")}>查看全部记录</button>
        </div>
        <div className="scene-dashboard-grid">
          {sceneLead && (
            <article className={`scene-lead-card tone-${sceneLead.tone}`}>
              <span>{sceneLead.title}</span>
              <strong>{sceneLead.value}</strong>
              <small>{sceneLead.description}</small>
            </article>
          )}
          <div className="scene-card-grid scene-card-list">
            {sceneRest.map((card) => <SceneSignalCard card={card} key={card.title} />)}
          </div>
        </div>
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
                    attention={attentionSuggestionId === suggestion.id}
                    onChanged={refreshHome}
                  />
                ))}
              </div>
            ) : (
              <div className="friendly-empty">
                <strong>{dataInsufficient ? "还没有足够信号" : "暂时没有需要打扰你的事"}</strong>
                <span>{dataInsufficient ? "OpenButler 不会用空数据编造结论。你可以先了解本地模式，或查看高级入口。" : "你允许整理的记录已经处理完，目前没有高优先级提醒。"}</span>
              </div>
            )}
          </section>

          <section className="today-panel achievement-entry-panel">
            <div className="section-title">
              <div>
                <h2>今天的小成就</h2>
                <p>把值得留下的小进展单独收好，方便晚点回看。</p>
              </div>
              <button className="ghost" onClick={() => navigateTo("/achievements")}>查看成就</button>
            </div>
            <div className="achievement-entry-card">
              <Trophy size={22} />
              <div>
                <strong>有几件小事值得被记住</strong>
                <span>{view.demoMode ? "包括专注片段、待办收尾和节律恢复。样例体验未读取你的真实数据。" : "包括本地时间线里的推进、收尾和节律片段。"}</span>
              </div>
            </div>
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
            <div className="section-title"><h2>下一步</h2></div>
            <div className="next-action-card">
              <strong>{primarySuggestion?.title ?? (dataInsufficient ? "先了解本地模式" : "查看今天整理好的时间线")}</strong>
              <span>{primarySuggestion?.summary ?? (dataInsufficient ? "本地模式需要你在自己的电脑上运行，并主动授权要读取的线索。" : "当前没有紧急提醒，可以从完整时间线继续回看。")}</span>
              <button
                className="secondary"
                onClick={() => {
                  if (primarySuggestion) {
                    document.getElementById("today-suggestions")?.scrollIntoView({behavior: "smooth"});
                    return;
                  }
                  navigateTo(dataInsufficient ? "/me" : "/timeline");
                }}
              >
                {primarySuggestion ? "看建议" : dataInsufficient ? "了解本地模式" : "去查看"}
              </button>
            </div>
          </section>
        </aside>
      </section>

   </div>
  );
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
      <div className="scene-card-copy">
        <span>{card.title}</span>
        <small>{card.description}</small>
      </div>
      <strong>{card.value}</strong>
    </article>
  );
}

function ProgressiveOnboarding({
  activationStatus,
  onDemo,
  onOpenAdvanced
}: {
  activationStatus: ActivationStatus;
  onDemo: () => void;
  onOpenAdvanced: () => void;
}) {
  return (
    <section className="onboarding-panel">
      <div>
        <p className="eyebrow">开始设置 · {activationStatusLabel(activationStatus)}</p>
        <h2>选择一种方式开始今天</h2>
        <p>你可以先看样例，也可以了解本地模式。样例不会读取真实数据；本地模式需要你在自己的电脑上运行，并主动授权。</p>
      </div>
      <div className="onboarding-steps">
        <article><strong>1</strong><span>授权后生成今日概览</span></article>
        <article><strong>2</strong><span>把重要片段整理成时间线</span></article>
        <article><strong>3</strong><span>每条提醒都能查看依据</span></article>
      </div>
      <div className="hero-actions">
        <button className="primary" onClick={onDemo}>
          <CheckCircle2 size={17} />
          <span>先看样例</span>
        </button>
        <button className="secondary" onClick={onOpenAdvanced}>了解本地模式</button>
        <button className="ghost" onClick={() => document.getElementById("today-suggestions")?.scrollIntoView({behavior: "smooth"})}>稍后配置</button>
      </div>
      <small>线上样例只展示产品效果；本地模式只在本机运行，授权后才读取线索。</small>
    </section>
  );
}

function FriendlySuggestionCard({
  suggestion,
  attention = false,
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
  attention?: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (attention) setExpanded(true);
  }, [attention]);

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
    <article className={`friendly-insight-card${attention ? " attention" : ""}`}>
      {attention && <p className="inline-action-feedback" role="status">正在查看这条建议，依据已展开。</p>}
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
        <span>启动本地版并授权后，OpenButler 会把重要片段整理成可回看的生活记录。</span>
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
  const [noiseReport, setNoiseReport] = useState<Record<string, any> | null>(null);
  const [activeState, setActiveState] = useState<InboxDecisionState>("pending");
  const [message, setMessage] = useState("");

  async function refreshInbox() {
    const [result, noise] = await Promise.all([
      getButlerInsights(),
      getButlerInsightNoiseEvaluation().catch(() => null),
    ]);
    setInsights(result.items);
    setNoiseReport(noise);
  }

  useEffect(() => {
    refreshInbox().catch(() => undefined);
  }, []);

  const cards = sortInboxCards(insights.map(toInboxDecisionCard));
  const counts = inboxCountByState(cards);
  const visibleCards = cards.filter((card) => card.state === activeState);
  const noisyTypes = new Set<string>((noiseReport?.items ?? [])
    .filter((item: Record<string, any>) => Number(item.cooldown_minutes ?? 0) > 0 || Number(item.priority_delta ?? 0) < 0)
    .map((item: Record<string, any>) => String(item.insight_type)));

  return (
    <section className="wide-panel decision-inbox">
      <div className="section-title decision-inbox-head">
        <div>
          <p className="eyebrow">决策队列</p>
          <h2>待确认的提醒</h2>
          <p>先处理需要你决定的事。处理过的、稍后再看的、不准确的提醒都会分开放。</p>
        </div>
        <button className="secondary" onClick={refreshInbox}>刷新</button>
      </div>
      <div className="inbox-tabs" role="tablist" aria-label="提醒状态">
        {(Object.keys(inboxStateLabels) as InboxDecisionState[]).map((state) => (
          <button
            key={state}
            className={activeState === state ? "active" : ""}
            onClick={() => setActiveState(state)}
            role="tab"
            aria-selected={activeState === state}
          >
            <span>{inboxStateLabels[state]}</span>
            <strong>{counts[state]}</strong>
          </button>
        ))}
      </div>
      {message && <div className="inbox-feedback-message">{message}</div>}
      <InsightList
        insights={visibleCards}
        onChanged={refreshInbox}
        onMessage={setMessage}
        onStateChange={setActiveState}
        noisyTypes={noisyTypes}
        activeState={activeState}
      />
    </section>
  );
}

function InsightList({
  insights,
  onChanged,
  onMessage,
  onStateChange,
  noisyTypes,
  activeState = "pending",
}: {
  insights: Array<Record<string, any> | InboxDecisionCard>;
  onChanged: () => void;
  onMessage?: (message: string) => void;
  onStateChange?: (state: InboxDecisionState) => void;
  noisyTypes?: Set<string>;
  activeState?: InboxDecisionState;
}) {
  const [expandedInsightId, setExpandedInsightId] = useState<string | null>(null);
  const [busyInsightId, setBusyInsightId] = useState<string | null>(null);

  const cards = sortInboxCards(insights.map((item) => "stateLabel" in item ? item as InboxDecisionCard : toInboxDecisionCard(item as Record<string, any>)));

  function moveToState(type: string): InboxDecisionState {
    if (type === "remind_later") return "later";
    if (type === "inaccurate") return "inaccurate";
    if (["accepted_action", "dismissed", "too_frequent"].includes(type)) return "done";
    return activeState;
  }

  async function feedback(card: InboxDecisionCard, type: string) {
    setBusyInsightId(card.id);
    onMessage?.("");
    try {
      if (type === "dismissed") {
        await dismissInsight(card.id);
      } else if (type === "remind_later") {
        await snoozeInsight(card.id, 60);
      } else {
        await submitInsightFeedback(card.id, type);
      }
      const nextState = moveToState(type);
      await onChanged();
      onStateChange?.(nextState);
      if (type === "too_frequent") {
        onMessage?.("已记录。类似提醒后面会少出现。");
      } else if (type === "inaccurate") {
        onMessage?.("已标记为不准确。后面会少用这类判断。");
      } else if (type === "remind_later") {
        onMessage?.("已放到稍后。");
      } else if (type === "accepted_action") {
        onMessage?.("已处理。");
      } else if (type === "useful") {
        onMessage?.("已记录为有用。");
      }
    } catch {
      onMessage?.("没有保存成功，再试一次。");
    } finally {
      setBusyInsightId(null);
    }
  }

  if (!cards.length) {
    const emptyCopy: Record<InboxDecisionState, string> = {
      pending: "现在没有需要你处理的提醒。",
      later: "没有稍后再看的提醒。",
      done: "还没有处理过的提醒。",
      inaccurate: "还没有被标记为不准确的提醒。",
    };
    return (
      <div className="friendly-empty">
        <strong>{emptyCopy[activeState]}</strong>
        <span>数据不足时，OpenButler 不会编造结论。</span>
      </div>
    );
  }
  return (
    <div className="friendly-suggestion-list decision-card-list">
      {cards.map((card) => {
        const loweredByFeedback = card.noiseAdjusted || noisyTypes?.has(card.type);
        return (
        <article className="friendly-insight-card decision-card" key={card.id}>
          <div className="friendly-card-head">
            <div>
              <span>{card.typeLabel} · {card.stateLabel}</span>
              <strong>{card.title}</strong>
            </div>
            <small>{Math.round(card.confidence * 100)}%</small>
          </div>
          <p>{card.summary}</p>
          {loweredByFeedback && <div className="noise-hint">你标记过类似提醒，后面会少出现。</div>}
          {card.protectedNotice && <small className="protected-note">隐私和数据质量提醒不会被永久关闭。</small>}
          {expandedInsightId === card.id && card.raw.detail && <p>{userFacingDemoText(card.raw.detail)}</p>}
          <div className="friendly-actions">
            <button
              className="secondary evidence-toggle"
              aria-label="查看证据详情"
              onClick={() => setExpandedInsightId(expandedInsightId === card.id ? null : card.id)}
            >
              {expandedInsightId === card.id ? "收起依据" : "查看依据"}
            </button>
            <button className="primary compact-action" disabled={busyInsightId === card.id} onClick={() => feedback(card, "accepted_action")}>处理了</button>
            <button className="ghost" disabled={busyInsightId === card.id} onClick={() => feedback(card, "remind_later")}>稍后再看</button>
            <button className="ghost" disabled={busyInsightId === card.id} onClick={() => feedback(card, "inaccurate")}>不准确</button>
            <button className="ghost" disabled={busyInsightId === card.id} onClick={() => feedback(card, "too_frequent")}>少提醒类似内容</button>
            <button className="ghost" disabled={busyInsightId === card.id} onClick={() => feedback(card, "useful")}>有用</button>
          </div>
          {expandedInsightId === card.id && <InsightEvidenceDetails insight={card.raw} />}
          <div className="technical-card-fallback">
            <strong>{card.raw.title}</strong>
            <span>{card.raw.type} · {card.raw.status} · 置信度 {Math.round(card.confidence * 100)}%</span>
          </div>
        </article>
      )})}
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
        <span>本地图片不会上传；需要时只说明“有本地依据”，不展示真实路径。</span>
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

const timelineSampleEvents = [
  {
    id: "timeline-demo-key",
    source: "phone_album_demo",
    event_type: "object_location",
    title: "钥匙可能在玄关托盘附近",
    summary: "样例线索显示钥匙最后出现在玄关左侧托盘。",
    started_at: new Date().toISOString(),
    confidence: 0.78,
    evidence_boundary: "这是样例线索，只说明管家会如何解释依据；不代表你的真实生活记录。",
    evidence_refs: [{source: "phone_album_demo", evidence_level: "demo_reference"}],
  },
  {
    id: "timeline-demo-follow-up",
    source: "butler_demo",
    event_type: "insight",
    title: "会议后有一项待办适合收尾",
    summary: "一条会议后事项被整理出来，适合稍后确认。",
    started_at: new Date().toISOString(),
    confidence: 0.72,
    evidence_boundary: "这是样例提醒，用来展示 OpenButler 如何保留依据和边界。",
    evidence_refs: [{source: "butler_demo", evidence_level: "demo_reference"}],
  },
  {
    id: "timeline-demo-rest",
    source: "workstation_demo",
    event_type: "lighting_context",
    title: "该起身活动一下了",
    summary: "样例节律显示你已经连续坐了一段时间，适合短暂活动肩颈。",
    started_at: new Date().toISOString(),
    confidence: 0.7,
    evidence_boundary: "这是样例节律提醒，不代表医学或心理判断。",
    evidence_refs: [{source: "workstation_demo", evidence_level: "demo_reference"}],
  },
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
    objects: "钥匙",
    reminders: "待办",
    habits: "休息",
    home: "家庭",
    work: "记录",
    automation: "建议",
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
  const [previewItems, setPreviewItems] = useState<ContextObservation[]>([]);
  const [coverageEvents, setCoverageEvents] = useState<CaptureCoverageEvent[]>([]);
  const [previewError, setPreviewError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<TimelineTimeFilter>("today");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [importanceFilter, setImportanceFilter] = useState("all");

  async function refreshTimeline() {
    if (isPreviewDesktop() && readActivationStatus() !== "demo_selected") {
      try {
        const result = await getContextObservations();
        setPreviewItems(result.items);
        setCoverageEvents(result.coverage_events ?? []);
        setPreviewError("");
      } catch {
        setPreviewError("本机记录暂时无法读取。请确认本机服务正在运行。");
      }
      return;
    }
    try {
      const result = await getButlerTimeline();
      setItems(result.items);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    refreshTimeline().catch(() => undefined);
  }, []);

  const sampleMode = readActivationStatus() === "demo_selected";
  if (isPreviewDesktop() && !sampleMode) {
    return <section className="life-timeline-page preview-timeline-page">
      <div className="timeline-feed-hero"><div><p className="eyebrow">本机记录</p><h2>时间线</h2><p>查看截图记录和整理状态</p></div><button className="secondary" onClick={() => void refreshTimeline()}>刷新</button></div>
      {previewError && <p className="policy-note" role="alert">{previewError}</p>}
      <CaptureObservationFeed observations={previewItems} coverageEvents={coverageEvents} renderObservation={(item) => <PreviewObservationRow item={item} onChanged={() => void refreshTimeline()} />} />
    </section>;
  }
  const displayItems = items.length ? items : sampleMode ? timelineSampleEvents : [];
  const moments = displayItems.map(toTimelineMoment);
  const filteredMoments = filterTimelineMoments(moments, timeFilter, categoryFilter, importanceFilter);
  const groups = groupTimelineByDate(filteredMoments);
  const activeFilterSummary = `${timelineTimeFilters.find((item) => item.value === timeFilter)?.label ?? "今天"} · ${timelineCategoryLabel(categoryFilter)} · ${timelineImportanceLabel(importanceFilter)}`;

  return (
    <section className="life-timeline-page">
      <div className="timeline-feed-hero">
        <div>
          <p className="eyebrow">生活事件流</p>
          <h2>时间线</h2>
          <p>先看发生了什么。时间、来源和可信度放轻一点，需要时再展开依据。</p>
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
        已显示 {filteredMoments.length} 条事件 · {activeFilterSummary}{sampleMode && !items.length ? " · 样例体验" : ""}
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
                    <div className="moment-title-row">
                      <strong>{moment.title}</strong>
                      <span className={`moment-state ${moment.stateTone}`}>{moment.stateLabel}</span>
                    </div>
                    <p>{moment.summary}</p>
                    <div className="moment-tags">
                      <small>{moment.valueTag}</small>
                      <small>来源：{moment.sourceLabel}</small>
                      <small>{moment.eventLabel}</small>
                      <small>{moment.thumbnail.privacyLabel ?? "未展示原始路径"}</small>
                    </div>
                    <button
                      className="ghost timeline-evidence-button"
                      onClick={() => setExpandedId(expandedId === moment.id ? null : moment.id)}
                    >
                      {expandedId === moment.id ? "收起依据" : moment.evidenceAvailable ? "查看依据" : "说明来源"}
                    </button>
                    {expandedId === moment.id && (
                      <div className="moment-evidence evidence-drawer">
                        <div className="evidence-drawer-head">
                          <strong>这条记录的依据</strong>
                          <span>{moment.stateLabel}</span>
                        </div>
                        <p>{moment.evidenceBoundary}</p>
                        <div className="evidence">
                          <small>来源：{moment.sourceLabel}</small>
                          <small>{moment.confidenceLabel}</small>
                          <small>{moment.thumbnail.privacyLabel ?? "没有可展示图片"}</small>
                          <small>不会显示本地截图路径。</small>
                          <small>外部系统状态需要回到原处确认。</small>
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
          <strong>{displayItems.length ? "这个筛选下暂时没有事件" : "时间线还没有记录"}</strong>
          <span>{displayItems.length ? "可以放宽时间、分类或重要性条件，再看看。" : "启动本地版并授权后，这里会按时间整理工作、生活、提醒和可自动化流程。"}</span>
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
          <StatusItem label="工作区配置" value={minecontext.workspace_dir === "configured" ? "已配置" : "未配置"} />
          <StatusItem label="数据目录配置" value={minecontext.data_dir === "configured" ? "已配置" : "未配置"} />
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

function Chat({activationStatus}: {activationStatus: ActivationStatus}) {
  const [messages, setMessages] = useState<Array<{role: "user" | "butler"; text: string}>>([
    {role: "butler", text: "结论：我可以先帮你回看今天。\n关键数字：回答里会尽量给出少量数字，比如提醒数量、专注时长或时间线记录数。\n依据：我只使用 OpenButler 已授权的本地整理结果。\n边界说明：我不会凭聊天记忆补事实，也不能确认远程系统状态。\n下一步：你可以先问“今天有什么值得注意？”。"}
  ]);
  const [text, setText] = useState("今天有什么值得注意？");
  const [pending, setPending] = useState(false);
  const capabilityCards = [
    {title: "回看今天", text: "把今天的记录整理成几件能处理的事。", prompt: "今天有什么值得注意？"},
    {title: "查时间线", text: "从今天的记录里找最近发生了什么。", prompt: "查看今日记录"},
    {title: "解释依据", text: "说明一条提醒从哪里来、能信到什么程度。", prompt: "解释这条提醒的依据"},
    {title: "调整提醒", text: "记录“不准确”或“以后少提醒”的反馈。", prompt: "以后少提醒类似内容"},
  ];
  const promptGroups = [
    "今天有什么值得注意？",
    "我现在该先做什么？",
    "查看今日记录",
    "解释这条提醒的依据",
    "帮我生成晚间复盘",
    "这个建议不准确",
    "我的钥匙在哪？",
  ];

  function sanitizeAnswer(answer: string) {
    return answer
      .replace(/phone_album/g, "相册线索（演示）")
      .replace(/模拟事件\s*seed/g, "演示线索")
      .replace(/模拟事件\s*演示线索/g, "演示线索")
      .replace(/演示线索/g, "样例线索")
      .replace(/seed/g, "演示线索")
      .replace(/证据来自 相册线索（演示）：/g, "依据：相册线索（样例）。")
      .replace(/模拟事件/g, "样例线索")
      .replace(/演示线索/g, "样例线索")
      .replace(/raw source/g, "原始依据")
      .replace(/source_event_id/g, "依据编号")
      .replace(/raw_ref/g, "原始依据")
      .replace(/evidence_refs/g, "依据")
      .replace(/MineContext/g, "电脑活动")
      .replace(/godview/g, "本机回溯")
      .replace(/PCActivity/g, "电脑使用")
      .replace(/PC Activity/g, "电脑使用")
      .replace(/butler_core/g, "管家整理")
      .replace(/mock/g, "演示")
      .replace(/fixture/g, "演示");
  }

  function fallbackAnswer(message: string) {
    const sampleLine = activationModeFor(activationStatus) === "demo" || activationStatus === "demo_selected"
      ? "关键数字：当前可以先查看 4 条样例信号、3 条样例提醒和 42 分钟样例专注片段。"
      : "关键数字：本机服务这次没有返回最新结果，暂时不能给出真实统计。";
    return `结论：我现在没有拿到本机服务的回答，但不会编造结果。
${sampleLine}
依据：页面里已有的样例内容和你当前选择的问题“${message}”。
边界说明：这不是实时整理结果；如果要使用真实记录，需要先完成本地设置并确认授权。
下一步：你可以先点“今日”看样例，或到“我的”重新打开产品引导。`;
  }

  async function send(message = text) {
    if (!message.trim()) return;
    setPending(true);
    setMessages((items) => [...items, {role: "user", text: message}]);
    setText("");
    try {
      const result = await askButler(message);
      setMessages((items) => [...items, {role: "butler", text: sanitizeAnswer(result.answer)}]);
    } catch {
      setMessages((items) => [...items, {role: "butler", text: fallbackAnswer(message)}]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="chat-layout">
      <div className="butler-brief">
        <span className="privacy-chip">{activationModeFor(activationStatus) === "real_local" ? "本地整理" : "样例体验"}</span>
        <strong>你可以直接问我今天该看什么。</strong>
        <p>我会先给结论，再给关键数字、依据和边界。涉及外部系统状态时，我只会提示你回到原处确认。</p>
        <div className="hero-actions">
          <button className="primary" onClick={() => send("今天有什么值得注意？")}>回看今天</button>
          <button className="secondary" onClick={() => send("我现在该先做什么？")}>提醒下一步</button>
        </div>
      </div>
      <div className="assistant-capabilities" aria-label="问管家可以做什么">
        {capabilityCards.map((item) => (
          <button className="assistant-capability" key={item.title} onClick={() => send(item.prompt)}>
            <strong>{item.title}</strong>
            <span>{item.text}</span>
          </button>
        ))}
      </div>
      <div className="suggestions">
        {promptGroups.map((item) => (
          <button className="secondary" key={item} onClick={() => send(item)}>{item}</button>
        ))}
      </div>
      <div className="messages">
        {messages.map((message, index) => (
          <div className={`bubble ${message.role}`} key={`${message.role}-${index}`}>
            {message.text}
          </div>
        ))}
        {pending && <div className="bubble butler pending-answer">正在整理回答。如果本机服务没连上，我会先给你一条样例说明。</div>}
      </div>
      <div className="composer">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
          placeholder="问 OpenButler：今天有什么值得注意？"
        />
        <button className="primary" onClick={() => send()} disabled={pending}>
          {pending ? <Loader2 className="spin" size={17} /> : <MessageSquareText size={17} />}
          <span>发送</span>
        </button>
      </div>
    </section>
  );
}

type PreviewMask = CaptureConfig["masks"][number];

function observationProcessingReason(reason?: string | null): string {
  const labels: Record<string, string> = {
    queued: "已排队，等待整理", running: "整理中，截图已保存",
    queue_full: "队列已满，截图已保存。请手动重试，不会自动补跑。",
    process_restarted: "重启中断了整理，截图已保存。请重试",
    capture_paused: "采集已暂停，待处理截图保留；不会自动补跑。",
    authorization_revoked: "授权已撤销，整理已停止",
    source_reconfigured: "采集来源已重新配置，这条截图未继续整理。",
    session_expired: "本次采集授权已到期，未继续整理；不会自动续期。",
    model_unavailable: "模型不可用，截图已保存",
    invalid_source_grounding: "OCR 摘录未匹配原始文字，未采用模型结论；截图依据仍保留。",
    invalid_model_result: "输出格式不符，结果未采用",
    invalid_temporal_comparison: "跨记录比较未通过依据检查，未采用变化结论。",
    evidence_changed: "截图依据已改变，原整理结果不能继续采用。",
    temporal_context_changed: "历史上下文已改变，原比较结果不能继续采用。",
    record_or_evidence_unavailable: "记录或截图依据已过期、删除或暂不可用。",
    observation_not_pending: "这条记录当前不处于可排队状态，请刷新后检查。",
    prompt_limit_exceeded: "输入超过本次处理上限，未生成结论。",
    description_limit_exceeded: "图像描述超过处理上限，未生成结论。",
    provider_connection_failed: "无法连接模型服务，截图仍保留。",
    provider_http_error: "模型服务返回错误，未生成可用结论。",
    route_not_ready: "当前模型配置尚未就绪，请先手动验证。",
    strict_mode_forbidden: "当前隐私方式不允许此模型调用，整理已停止。",
    privacy_audit_unavailable: "隐私审计暂不可用，整理已安全停止。",
  };
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(labels, reason) ? labels[reason]
    : reason ? "处理原因暂不可确认；请查看本机服务状态，不能视为已整理。" : "";
}

function PreviewObservationRow({item, onChanged}: {item: ContextObservation; onChanged?: () => void}) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [evidenceMessage, setEvidenceMessage] = useState("");
  const [retryMessage, setRetryMessage] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const retryActive = useRef(false);

  async function retry() {
    if (retryActive.current) return;
    retryActive.current = true;
    setRetryBusy(true);
    setRetryMessage("");
    try {
      const result = await retryContextObservation(item.id);
      setRetryMessage(result.ok ? result.queued ? "已加入整理队列，尚未生成结论。" : "请求已接收，请刷新查看处理状态。" : observationProcessingReason(result.reason) || "本次未排入整理队列，请检查模型与截图依据。");
      onChanged?.();
    } catch {
      setRetryMessage("重新整理失败，请检查本机服务后重试。");
    } finally {
      retryActive.current = false;
      setRetryBusy(false);
    }
  }

  async function removeRecord() {
    if (!window.confirm("删除此记录及截图？删除后无法恢复。")) return;
    try {
      const result = await deleteContextObservation(item.id);
      setRetryMessage(result.deleted ? "记录已删除。" : "这条记录已经不存在。");
      onChanged?.();
    } catch {
      setRetryMessage("删除失败，请检查本机服务后重试。");
    }
  }

  async function toggleEvidence() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!item.evidence_available || !item.evidence_id) {
      setEvidenceMessage("这张遮挡后图片已过期或不可用。");
      return;
    }
    if (!window.openbutlerDesktop?.getMaskedEvidence) {
      setEvidenceMessage("当前桌面版暂不能展示图片依据。");
      return;
    }
    setEvidenceMessage("正在读取遮挡后图片…");
    try {
      const result = await window.openbutlerDesktop.getMaskedEvidence(item.evidence_id);
      if (result.ok && result.dataUrl.startsWith("data:image/png;base64,")) {
        setEvidence(result.dataUrl);
        setEvidenceMessage("");
      } else {
        setEvidenceMessage("图片依据已过期或暂不可用。");
      }
    } catch {
      setEvidenceMessage("图片依据暂时无法读取。");
    }
  }

  const date = new Date(item.captured_at);
  return <article className="preview-observation-row">
    <time dateTime={item.captured_at}>{Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN")}</time>
    <div className="preview-observation-body">
      <div className="moment-title-row"><strong>{observationCurrentContent(item)?.title || "本机画面记录"}</strong><span className="moment-state">{observationStateLabel(item.state)}</span></div>
      <CaptureObservationAnalysis item={item} />
      <CaptureObservationProvenance item={item} />
      {item.processing_reason && <small role="status">{observationProcessingReason(item.processing_reason)}</small>}
      <button className="ghost timeline-evidence-button" onClick={() => void toggleEvidence()}>{open ? "收起依据" : "查看依据"}</button>
      {(item.state === "model_unavailable" || (item.state === "recorded_pending" && item.processing_reason && !["queued", "running"].includes(item.processing_reason))) && <button className="secondary" disabled={retryBusy || !item.evidence_available} onClick={() => void retry()}>重新整理</button>}
      {retryMessage && <small role="status">{retryMessage}</small>}
      {open && <div className="moment-evidence evidence-drawer">
        <strong>依据与边界</strong><p>{item.boundary}</p>
        {evidence && <img className="preview-evidence-image" src={evidence} alt="实际采集且经隐私遮挡的窗口或屏幕截图依据" />}
        {evidenceMessage && <small role="status">{evidenceMessage}</small>}
        <small>已保存的遮挡后截图</small>
        <button className="ghost" onClick={() => void removeRecord()}>删除这条记录</button>
      </div>}
    </div>
  </article>;
}

function PreviewToday({onOpenGuide}: {onOpenGuide: () => void}) {
  const [status, setStatus] = useState<ContextEngineStatus | null>(null);
  const [observations, setObservations] = useState<ContextObservation[]>([]);
  const [coverageEvents, setCoverageEvents] = useState<CaptureCoverageEvent[]>([]);
  const [desktopCapture, setDesktopCapture] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshRevision = useRef(0);
  const controlBusy = useRef(false);
  const [stateMismatch, setStateMismatch] = useState(false);

  async function refreshPreviewToday() {
    const request = ++refreshRevision.current;
    try {
      const [nextStatus, nextObservations, captureState] = await Promise.all([
        getContextEngineStatus(), getContextObservations(),
        window.openbutlerDesktop?.getCaptureState?.().catch(() => null) ?? Promise.resolve(null)
      ]);
      if (request !== refreshRevision.current) return;
      setDesktopCapture(captureState ? {...captureState, source_kind: nextStatus.recording.source_kind} : null);
      const desktopActive = typeof captureState?.active === "boolean" ? captureState.active : null;
      setStatus(desktopActive === null ? nextStatus : {...nextStatus, recording: {...nextStatus.recording, active: nextStatus.recording.active || desktopActive}});
      setStateMismatch(desktopActive !== null && desktopActive !== nextStatus.recording.active);
      setObservations(nextObservations.items);
      setCoverageEvents(nextObservations.coverage_events ?? []);
      setError(capturePauseMessage(typeof captureState?.lastResult === "string" ? captureState.lastResult : null) || (desktopActive !== null && desktopActive !== nextStatus.recording.active
          ? "桌面采集与本机服务状态不一致，请检查隐私预览后重新启动。" : ""));
    } catch {
      if (request !== refreshRevision.current) return;
      setError("本机记录暂时无法读取，请确认本机服务正在运行。");
    }
  }

  useEffect(() => {
    void refreshPreviewToday();
    const timer = window.setInterval(() => { if (!controlBusy.current) void refreshPreviewToday(); }, 5_000);
    return () => { refreshRevision.current++; window.clearInterval(timer); };
  }, []);

  async function stopRecording(revoke: boolean) {
    if (controlBusy.current) return;
    controlBusy.current = true; refreshRevision.current++;
    setBusy(true);
    try {
      const bridge = await window.openbutlerDesktop?.pauseBuiltinCapture?.();
      if (bridge && !bridge.ok) throw new Error("capture_pause_failed");
      if (revoke) await revokeBuiltinCaptureApi();
      else await pauseBuiltinCaptureApi();
      await refreshPreviewToday();
    } catch {
      setError("操作未完成，请检查本机记录状态后重试。");
    } finally {
      controlBusy.current = false;
      setBusy(false);
    }
  }

  async function openRecordingSetup() {
    if (controlBusy.current) return;
    controlBusy.current = true; refreshRevision.current++;
    if (status?.recording.active) {
      setBusy(true);
      try {
        const bridge = await window.openbutlerDesktop?.pauseBuiltinCapture?.();
        if (bridge && !bridge.ok) throw new Error("capture_pause_failed");
        await pauseBuiltinCaptureApi();
        await refreshPreviewToday();
      } catch {
        setError("未能暂停当前录制，请先确认录制状态。");
        setBusy(false); controlBusy.current = false;
        return;
      }
      setBusy(false);
    }
    controlBusy.current = false;
    onOpenGuide();
  }

  const pending = observations.filter((item) => item.state === "recorded_pending" || item.state === "processing").length;
  const failed = observations.filter((item) => item.state === "model_unavailable").length;
  return <div className="today-page preview-today">
    <section className="today-hero mi-home-command" aria-label="本机记录今日概览">
      <div className="today-hero-copy">
        <span className="privacy-chip">0.2.0 Preview · 本机记录</span>
        <h1>今日</h1>
        <p className="hero-summary">{stateMismatch ? "录制状态不一致，请先暂停" : status?.recording.active ? "正在记录已授权范围" : "本机记录已暂停。"} {pending ? `${pending} 条记录等待整理。` : "暂无待整理记录。"}</p>
        <div className="home-status-strip">
          <article><strong>{status?.recording.record_count ?? 0}</strong><span>本机记录</span><small>含未整理记录</small></article>
          <article><strong>{pending}</strong><span>待整理</span><small>尚未生成结论</small></article>
          <article><strong>{failed}</strong><span>整理失败</span><small>记录仍可查看</small></article>
        </div>
        <div className="hero-actions primary-action-row">
          {status?.recording.active ? <button className="secondary" disabled={busy} onClick={() => void stopRecording(false)}>暂停录制</button> : <button className="primary" disabled={busy} onClick={() => void openRecordingSetup()}>设置截图记录</button>}
          {status?.recording.active && <button className="secondary" disabled={busy} onClick={() => void stopRecording(true)}>停止并撤销授权</button>}
          <button className="secondary" onClick={() => navigateClient("/timeline")}>查看时间线</button>
          <a className="secondary preview-model-shortcut" href="#preview-model-settings" onClick={(event) => { event.preventDefault(); document.getElementById("preview-model-settings")?.scrollIntoView({behavior: "smooth", block: "start"}); document.getElementById("preview-model-settings")?.focus(); }}>配置模型</a>
          <button className="ghost" disabled={busy} onClick={() => void refreshPreviewToday()}>刷新</button>
        </div>
      </div>
      <div className="today-hero-status command-suggestion-card"><span className="privacy-chip">记录状态</span><strong>{stateMismatch ? "状态待核对" : status?.recording.active ? "记录中" : "未录制"}</strong><span>截图可先保存，配置模型后再整理</span><details><summary>整理说明</summary><small>录制与整理独立运行；待整理、失败和已整理会分别标记。未完成的记录需手动重试。</small></details></div>
    </section>
    <section className="today-panel"><CaptureSessionSummary state={desktopCapture} />
      {status?.recording.processing_queue && <div aria-label="本机整理队列" role="status">
        <strong>整理队列</strong><p>处理中 {status.recording.processing_queue.running} · 排队 {status.recording.processing_queue.queued}/{status.recording.processing_queue.capacity} · 未入队 {status.recording.processing_queue.backpressured}</p>
        <small>{status.recording.processing_queue.accepting ? "当前接受新的整理任务。" : "当前暂停接收整理任务。"}未完成的截图仍保留，请手动重试，不会自动补跑。</small><details><summary>队列说明</summary><small>队列数量不代表模型已成功；未入队或中断的记录需手动重试。</small></details>
      </div>}
    </section>
    {error && <p className="policy-note" role="alert">{error}</p>}
    <PreviewDailyReview authorized={status?.recording.authorized === true} recordRevision={observations.map((item) => `${item.id}:${item.state}:${item.evidence_available}`).join("|")} />
    <section className="today-panel preview-records-panel">
      <div className="section-title"><div><p className="eyebrow">本机记录</p><h2>最近记录</h2></div><button className="secondary" onClick={() => navigateClient("/timeline")}>全部记录</button></div>
      <CaptureObservationFeed observations={observations} coverageEvents={coverageEvents} limit={6} renderObservation={(item) => <PreviewObservationRow item={item} onChanged={() => void refreshPreviewToday()} />} />
    </section>
    <section className="today-panel preview-recording-controls"><div className="section-title"><div><h2>录制授权</h2><p>重新开始前需要再次检查隐私预览。</p></div></div>
      <div className="desktop-action-row"><button className="secondary" disabled={busy || !status?.recording.active} onClick={() => void stopRecording(false)}>暂停</button><button className="secondary" disabled={busy || !status?.recording.authorized} onClick={() => void stopRecording(true)}>停止并撤销授权</button><button className="secondary" disabled={busy} onClick={() => void openRecordingSetup()}>更改录制范围</button></div>
    </section>
    <PreviewModelSettings onSaved={refreshPreviewToday} />
  </div>;
}

function PreviewPrivacy({mode, onChange, onOpenGuide}: {mode: PrivacyMode; onChange: (mode: PrivacyMode) => void; onOpenGuide: () => void}) {
  const [status, setStatus] = useState<ContextEngineStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getContextEngineStatus().then(setStatus).catch(() => setMessage("本机录制状态暂不可用。")); }, []);

  async function stop(revoke: boolean) {
    setBusy(true);
    try {
      const bridge = await window.openbutlerDesktop?.pauseBuiltinCapture?.();
      if (bridge && !bridge.ok) throw new Error("capture_pause_failed");
      if (revoke) await revokeBuiltinCaptureApi();
      else await pauseBuiltinCaptureApi();
      setStatus(await getContextEngineStatus());
      setMessage(revoke ? "录制授权已撤销；已有记录仍按保留规则处理。" : "录制已暂停。");
    } catch {
      setMessage("操作未完成，请检查本机服务后重试。");
    } finally {
      setBusy(false);
    }
  }

  return <div className="me-page preview-me-page">
    <section className="today-panel"><div className="section-title"><div><p className="eyebrow">我的 OpenButler</p><h2>本机记录授权</h2><p>只记录已授权范围；重新开始前需预览</p></div><span className="privacy-chip">0.2.0 Preview</span></div>
      <div className="activation-status-grid"><StatusItem label="录制" value={status?.recording.active ? "运行中" : "已暂停"} /><StatusItem label="授权" value={status?.recording.authorized ? "已授权" : "未授权"} /><StatusItem label="本机记录" value={`${status?.recording.record_count ?? 0} 条`} /></div>
      <div className="desktop-action-row"><button className="secondary" disabled={busy || !status?.recording.active} onClick={() => void stop(false)}>暂停</button><button className="secondary" disabled={busy || !status?.recording.authorized} onClick={() => void stop(true)}>撤销授权</button><button className="secondary" onClick={onOpenGuide}>查看录制范围</button></div>
      {message && <p className="policy-note" role="status">{message}</p>}
    </section>
    <section className="today-panel"><div className="section-title"><div><h2>隐私方式</h2><p>外部模型需单独授权</p></div></div>
      <div className="mode-toggle"><button className={mode === "strict" ? "selected" : ""} onClick={() => onChange("strict")}><CloudOff size={20} /><strong>只在本机整理</strong><span>不允许外部模型调用。</span></button><button className={mode === "basic" ? "selected" : ""} onClick={() => onChange("basic")}><ShieldCheck size={20} /><strong>基础隐私</strong><span>仅在单独授权后使用外部能力。</span></button></div>
    </section>
  </div>;
}

type PreviewModelRoute = {protocol: "openai_compatible" | "ollama_native"; mode: "local" | "custom"; endpoint: string; model: string; api_key: string; apiKeyConfigured: boolean};
type LocalModelDiscovery = {status: "idle" | "loading" | "ready" | "empty" | "unavailable"; models: string[]; endpoint: string; selected: string | null; message: string};
const emptyLocalModelDiscovery = (): LocalModelDiscovery => ({status: "idle", models: [], endpoint: "", selected: null, message: ""});
function validLocalModelDiscoveryEndpoint(endpoint: string): boolean {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/.test(endpoint)) return false;
  try { const url = new URL(endpoint); return !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function readLocalModelDiscovery(result: unknown, endpoint: string): string[] | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (value.ok !== true || value.endpoint !== endpoint || !Array.isArray(value.models) || value.models.length > 128
    || value.models.some((model) => typeof model !== "string" || !model.length || model.length > 200 || model.trim() !== model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) || model.includes("//") || model.split("/").some((part) => part === "." || part === ".."))) return null;
  return [...new Set(value.models as string[])];
}
function localModelDiscoveryFailure(code: unknown): string {
  const messages: Record<string, string> = {
    invalid_local_endpoint: "请填写不含路径或末尾斜线的本机 HTTP 地址，例如 http://127.0.0.1:11434。",
    unsupported_discovery_protocol: "仅支持读取本机 Ollama 的已安装模型列表。",
    local_discovery_busy: "本机模型列表正在读取，请稍后再试。",
    local_discovery_timeout: "读取本机模型列表超时，请检查此地址的 Ollama 服务。",
    local_discovery_unavailable: "此地址的本机模型列表暂不可用，请确认 Ollama 正在运行。",
    local_discovery_http_error: "本机服务未返回可用的模型列表，请检查服务地址。",
    local_discovery_response_too_large: "本机模型列表超出安全读取上限，未采用返回内容。",
    invalid_local_model_response: "本机模型列表格式无法验证，未采用返回内容。",
    local_discovery_cancelled: "本次列表读取已取消，请重新读取。",
  };
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(messages, code) ? messages[code]
    : "读取本机模型列表未完成，请检查服务地址后重试。已有模型配置未改变。";
}
type PreviewModelConfiguration = {image: PreviewModelRoute; text: PreviewModelRoute; external_consent: boolean; masked_data_consent: boolean};
type PreviewModelConfigurationState = "unconfigured" | "saved-needs-validation" | "ready" | "unavailable";
const emptyPreviewRoute = (): PreviewModelRoute => ({protocol: "ollama_native", mode: "local", endpoint: "http://127.0.0.1:11434", model: "", api_key: "", apiKeyConfigured: false});
const samePreviewModelDestination = (a: PreviewModelRoute, b?: PreviewModelRoute) => Boolean(b && a.mode === b.mode && a.protocol === b.protocol && a.endpoint === b.endpoint);

function readPreviewModelConfiguration(result: Record<string, unknown>): PreviewModelConfiguration | null {
  const routes = result.routes && typeof result.routes === "object" ? result.routes as Record<string, unknown> : result;
  const route = (value: unknown): PreviewModelRoute => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {...emptyPreviewRoute(),
      ...(item.protocol === "ollama_native" || item.protocol === "openai_compatible" ? {protocol: item.protocol} : {}),
      ...(item.mode === "local" || item.mode === "custom" ? {mode: item.mode} : {}),
      ...(typeof item.endpoint === "string" ? {endpoint: item.endpoint} : {}),
      ...(typeof item.model === "string" ? {model: item.model} : {}),
      apiKeyConfigured: item.apiKeyConfigured === true,
    };
  };
  const image = route(routes.image), text = route(routes.text);
  return image.model && text.model ? {image, text, external_consent: result.external_consent === true, masked_data_consent: result.masked_data_consent === true} : null;
}

function readSessionModelConfiguration(result: Record<string, unknown>): PreviewModelConfiguration | null {
  if (result.persistence !== "session_only" || result.savedConfigurationAvailable !== false) return null;
  const configuration = readPreviewModelConfiguration(result);
  if (!configuration || configuration.external_consent || configuration.masked_data_consent) return null;
  const routes = result.routes && typeof result.routes === "object" ? result.routes as Record<string, unknown> : {};
  for (const target of ["image", "text"] as const) {
    const raw = routes[target] && typeof routes[target] === "object" ? routes[target] as Record<string, unknown> : {};
    if (raw.mode !== "local" || raw.protocol !== "ollama_native" || raw.apiKeyConfigured === true || (raw.api_key != null && raw.api_key !== "")
      || !validLocalModelDiscoveryEndpoint(configuration[target].endpoint) || !configuration[target].model.trim() || configuration[target].model.length > 200) return null;
  }
  return configuration;
}
function sessionModelFailure(code: unknown): string {
  const labels: Record<string, string> = {
    session_models_invalid_configuration: "仅本次使用只支持无密钥的本机 Ollama；请检查两个服务地址和模型名称。",
    session_models_validation_failed: "本次会话模型未通过验证，不能作为可用配置。",
    session_models_cancelled: "本次会话验证已取消，没有启用新的内存配置。",
    session_models_stop_unconfirmed: "本机模型服务是否已停止尚未确认。当前配置不可视为已撤销或可用，请重新检查服务状态。",
    local_service_unavailable: "本机服务暂不可用，本次会话配置未确认。",
    model_routes_save_in_progress: "另一次模型配置仍在处理，请等待后重新检查状态。",
  };
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(labels, code) ? labels[code]
    : "本次会话配置未确认，请重新检查本机服务。没有确认写入磁盘或模型可用。";
}
function previewModelFailure(result: unknown): string {
  const item = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const messages: Record<string, string> = {
    provider_connection_failed: "无法连接模型服务，请检查服务是否启动及网络连接。",
    endpoint_resolution_failed: "无法解析服务地址，请检查地址与网络连接。",
    provider_http_error: "模型服务拒绝了请求，请检查 API Key、模型名称和服务权限。",
    image_probe_failed: "图像模型未通过测试，请确认所选模型支持图像识别。",
    text_probe_failed: "文字模型未通过测试，请检查模型名称及响应能力。",
    invalid_provider_response: "模型返回格式不兼容，请检查接口类型。",
    invalid_endpoint: "服务地址格式不正确。OpenAI 兼容接口需含路径（如 /v1），Ollama 只填主机与端口；不要添加末尾斜杠、查询参数或账号密码。",
    local_requires_loopback_http: "本机模型需使用指向 localhost 或回环地址的 HTTP 服务地址。",
    custom_requires_public_https: "自定义服务需使用公开的 HTTPS 地址。",
    unsafe_endpoint: "服务地址不符合安全要求，请使用公开的 HTTPS 模型服务地址。",
    external_consent_required: "请分别确认外部模型联网调用和遮挡后数据发送范围。",
    privacy_audit_unavailable: "本机隐私审计暂不可用，请检查本机服务后重试。",
    strict_mode_forbidden: "当前隐私方式不允许外部调用，请检查隐私设置和授权。",
    local_service_unavailable: "本机服务暂不可用，请在桌面版检查服务后重试。",
  };
  if (typeof item.error_code === "string" && Object.prototype.hasOwnProperty.call(messages, item.error_code)) return messages[item.error_code];
  // Only known desktop messages are displayed; arbitrary provider errors may contain secrets.
  const desktopMessages: Record<string, string> = {
    "本机密钥存储不可用，配置未保存。": "本机加密密钥存储不可用，配置未保存。请检查桌面系统的密钥存储。",
    "录制尚未安全暂停，模型配置未更改。": "录制尚未安全暂停，请先暂停录制后重试。模型配置未更改。",
    "已取消外部模型授权。": "已取消外部模型授权，本次配置未保存。",
  };
  return typeof item.error === "string" && Object.prototype.hasOwnProperty.call(desktopMessages, item.error) ? desktopMessages[item.error] : "模型验证或保存未完成，请检查地址、模型名称、授权和本机服务后重试。";
}

function previewModelFailurePreservesConfiguration(result: unknown): boolean {
  const item = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return new Set([
    "本机密钥存储不可用，配置未保存。", "模型配置不完整。", "录制尚未安全暂停，模型配置未更改。",
    "外部模型需要明确同意联网调用和发送遮挡后数据。", "已取消外部模型授权。",
    "模型验证未通过，请检查连接和授权。",
  ]).has(typeof item.error === "string" ? item.error : "");
}

function PreviewModelSettings({onSaved, sectionId = "preview-model-settings"}: {onSaved: () => Promise<void>; sectionId?: string}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [imageRoute, setImageRoute] = useState<PreviewModelRoute>(emptyPreviewRoute);
  const [localDiscoveries, setLocalDiscoveries] = useState<{image: LocalModelDiscovery; text: LocalModelDiscovery}>(() => ({image: emptyLocalModelDiscovery(), text: emptyLocalModelDiscovery()}));
  const [discoveringTarget, setDiscoveringTarget] = useState<"image" | "text" | null>(null);
  const [textRoute, setTextRoute] = useState<PreviewModelRoute>(emptyPreviewRoute);
  const [externalConsent, setExternalConsent] = useState(false);
  const [maskedDataConsent, setMaskedDataConsent] = useState(false);
  const [savedConfiguration, setSavedConfiguration] = useState<PreviewModelConfiguration | null>(null);
  const [configurationState, setConfigurationState] = useState<PreviewModelConfigurationState>("unconfigured");
  const [sessionOnly, setSessionOnly] = useState(false);
  const [localTimeoutSeconds, setLocalTimeoutSeconds] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [request] = useState(() => ({active: false, reading: false, pending: false, readVersion: 0, editVersion: 0, persistenceUncertain: false, sessionPending: false, sessionRevoking: false, sessionVersion: 0, discoveryBusy: false, discoveryVersion: {image: 0, text: 0}, discoverySelection: {image: null as {model: string; endpoint: string} | null, text: null as {model: string; endpoint: string} | null}}));
  const bridgeAvailable = Boolean(window.openbutlerDesktop?.getBuiltinModelRoutes && window.openbutlerDesktop?.saveBuiltinModelRoutes);
  const hasExternalRoute = imageRoute.mode === "custom" || textRoute.mode === "custom";
  const sessionEligible = [imageRoute, textRoute].every((route) => route.mode === "local" && route.protocol === "ollama_native" && !route.api_key);
  const sessionBridgeAvailable = Boolean(window.openbutlerDesktop?.useBuiltinLocalModelsForSession && window.openbutlerDesktop?.revokeBuiltinSessionModels);
  function readModelBudget(result: Record<string, unknown>) {
    const nested = result.status && typeof result.status === "object" ? result.status as Record<string, unknown> : {};
    const seconds = result.local_total_timeout_seconds ?? nested.local_total_timeout_seconds;
    setLocalTimeoutSeconds(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? seconds : null);
  }

  function invalidateLocalModels(target: "image" | "text") {
    request.discoveryVersion[target]++;
    request.discoverySelection[target] = null;
    setLocalDiscoveries((current) => ({...current, [target]: emptyLocalModelDiscovery()}));
  }

  function restoreFields(configuration: PreviewModelConfiguration) {
    invalidateLocalModels("image"); invalidateLocalModels("text");
    setImageRoute({...configuration.image, api_key: ""});
    setTextRoute({...configuration.text, api_key: ""});
    setExternalConsent(configuration.external_consent);
    setMaskedDataConsent(configuration.masked_data_consent);
    setDirty(false);
  }

  async function loadRoutes() {
    if (request.pending || request.reading) return;
    const readVersion = ++request.readVersion, editVersion = request.editVersion;
    request.reading = true;
    setLoading(true);
    try {
      const getRoutes = window.openbutlerDesktop?.getBuiltinModelRoutes;
      if (!getRoutes || !window.openbutlerDesktop?.saveBuiltinModelRoutes) throw new Error("desktop_bridge_unavailable");
      const result = await getRoutes();
      if (!request.active || readVersion !== request.readVersion) return;
      if (result.persistenceUncertain === true) request.persistenceUncertain = true;
      if (result.error_code === "local_service_unavailable") throw new Error("local_service_unavailable");
      const isSession = result.persistence === "session_only";
      setSessionOnly(isSession); readModelBudget(result);
      const configuration = isSession ? readSessionModelConfiguration(result) : readPreviewModelConfiguration(result);
      if (isSession && !configuration && result.ready === true) throw new Error("invalid_session_status");
      const activeConfiguration = readPreviewModelConfiguration({...result, routes: null});
      if (result.ready === true && configuration && activeConfiguration && (["image", "text"] as const).some((target) => !samePreviewModelDestination(configuration[target], activeConfiguration[target]) || configuration[target].model !== activeConfiguration[target].model)) {
        request.persistenceUncertain = true;
      }
      setSavedConfiguration(configuration);
      setConfigurationState(request.persistenceUncertain ? "unavailable" : result.ready === true ? "ready" : result.last_attempt === "failed" ? "unavailable" : configuration ? "saved-needs-validation" : "unconfigured");
      // A late read must never overwrite a draft or restore old destination consent over new edits.
      if (configuration && !dirty && editVersion === request.editVersion) restoreFields(configuration);
      setMessage(request.persistenceUncertain ? "本机存档已重新读取，但运行配置与存档是否一致尚未确认。请重新验证并保存；录制不会自动恢复。" : result.last_attempt === "failed" ? previewModelFailure(result) : "");
    } catch {
      if (!request.active || readVersion !== request.readVersion) return;
      setConfigurationState("unavailable");
      setMessage("无法读取模型配置。请在桌面版检查本机服务后重试；当前填写的内容会保留。");
    } finally {
      if (request.active && readVersion === request.readVersion) {
        request.reading = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    request.active = true;
    request.reading = false;
    void loadRoutes();
    return () => {
      request.active = false; request.readVersion += 1; request.discoveryVersion.image++; request.discoveryVersion.text++; request.sessionVersion++;
      if (request.sessionPending) {
        request.sessionPending = false;
        void window.openbutlerDesktop?.revokeBuiltinSessionModels?.().catch(() => undefined);
      }
    };
  }, []);

  function markEdited() {
    request.editVersion += 1;
    setDirty(true);
    setMessage("");
  }

  async function discoverLocalModels(target: "image" | "text", route: PreviewModelRoute) {
    if (request.pending || request.discoveryBusy || route.mode !== "local" || route.protocol !== "ollama_native") return;
    const endpoint = route.endpoint.trim();
    const version = ++request.discoveryVersion[target];
    const fail = (code: unknown) => setLocalDiscoveries((current) => ({...current, [target]: {...emptyLocalModelDiscovery(), status: "unavailable", endpoint, message: localModelDiscoveryFailure(code)}}));
    if (!validLocalModelDiscoveryEndpoint(endpoint)) { fail("invalid_local_endpoint"); return; }
    const read = window.openbutlerDesktop?.listBuiltinLocalModels;
    if (!read) { fail("local_discovery_unavailable"); return; }
    request.discoveryBusy = true; setDiscoveringTarget(target);
    setLocalDiscoveries((current) => ({...current, [target]: {...emptyLocalModelDiscovery(), status: "loading", endpoint}}));
    try {
      const result = await read({endpoint, protocol: "ollama_native"});
      if (!request.active || version !== request.discoveryVersion[target]) return;
      if (!result.ok) { fail(result.error_code); return; }
      const models = readLocalModelDiscovery(result, endpoint);
      if (!models) { fail("invalid_local_model_response"); return; }
      setLocalDiscoveries((current) => ({...current, [target]: {status: models.length ? "ready" : "empty", models, endpoint, selected: null,
        message: models.length ? "已读取此地址的已安装模型；选择后仍需手动验证并保存。" : "此地址没有已安装模型。没有下载模型，也未更改已保存配置。"}}));
    } catch {
      if (request.active && version === request.discoveryVersion[target]) fail(null);
    } finally {
      request.discoveryBusy = false;
      if (request.active) setDiscoveringTarget(null);
    }
  }

  function routeFields(label: string, target: "image" | "text", value: PreviewModelRoute) {
    const savedKeyAvailable = samePreviewModelDestination(value, savedConfiguration?.[target]) && savedConfiguration?.[target].apiKeyConfigured;
    const change = (next: PreviewModelRoute) => {
      if (request.pending) return;
      if (!samePreviewModelDestination(next, value)) {
        setExternalConsent(false);
        setMaskedDataConsent(false);
        const pickedModel = request.discoverySelection[target]?.model;
        invalidateLocalModels(target);
        next = {...next, api_key: "", model: pickedModel && value.model === pickedModel ? "" : next.model};
      }
      if (next.model !== value.model) {
        request.discoverySelection[target] = null;
        setLocalDiscoveries((current) => ({...current, [target]: {...current[target], selected: null}}));
      }
      markEdited();
      (target === "image" ? setImageRoute : setTextRoute)(next);
    };
    return <fieldset className="preview-model-route" disabled={busy}><legend>{label}</legend>
      <label><span>运行位置</span><select name={`${target}-mode`} value={value.mode} onChange={(event) => change({...value, mode: event.target.value as PreviewModelRoute["mode"], protocol: event.target.value === "local" ? "ollama_native" : "openai_compatible", endpoint: event.target.value === "local" ? "http://127.0.0.1:11434" : ""})}><option value="local">本机模型</option><option value="custom">自定义服务</option></select></label>
      <label><span>接口类型</span><select name={`${target}-protocol`} value={value.protocol} onChange={(event) => change({...value, protocol: event.target.value as PreviewModelRoute["protocol"]})}><option value="ollama_native">Ollama</option><option value="openai_compatible">OpenAI 兼容接口</option></select></label>
      <label><span>服务地址</span><input name={`${target}-endpoint`} value={value.endpoint} onChange={(event) => change({...value, endpoint: event.target.value})} placeholder={value.mode === "local" ? "http://127.0.0.1:11434" : "https://example.com/v1"} autoComplete="off" spellCheck={false} /></label>
      <label><span>模型名称</span><input name={`${target}-model`} value={value.model} onChange={(event) => change({...value, model: event.target.value})} placeholder="填写模型名称" autoComplete="off" /></label>
      {value.mode === "local" && value.protocol === "ollama_native" && <div className="preview-local-model-discovery" style={{display: "grid", gap: 8}} aria-label={label + "本机已安装模型"}>
        <button className="secondary" type="button" disabled={busy || loading || discoveringTarget !== null || !window.openbutlerDesktop?.listBuiltinLocalModels}
          onClick={() => void discoverLocalModels(target, value)}>{discoveringTarget === target ? "正在读取本机模型…" : "读取已安装模型"}</button>
        <small>仅列出当前服务的已安装模型</small><details><summary>读取说明</summary><small>点击后读取，不扫描其他地址，不下载、推理或保存配置。</small></details>
        {!window.openbutlerDesktop?.listBuiltinLocalModels && <small>当前桌面版暂不支持读取模型列表，仍可手动填写名称。</small>}
        {localDiscoveries[target].status === "ready" && <label><span>此地址已安装的模型</span><select name={`${target}-installed-model`} value={localDiscoveries[target].selected ?? ""} disabled={busy || discoveringTarget !== null}
          onChange={(event) => {
            const model = event.target.value, discovery = localDiscoveries[target];
            if (request.pending || discovery.endpoint !== value.endpoint.trim() || !discovery.models.includes(model)) return;
            request.discoverySelection[target] = {model, endpoint: discovery.endpoint};
            markEdited(); (target === "image" ? setImageRoute : setTextRoute)({...value, model});
            setLocalDiscoveries((current) => ({...current, [target]: {...current[target], selected: model}}));
          }}><option value="" disabled>请选择已安装模型</option>{localDiscoveries[target].models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}
        {localDiscoveries[target].message && <small role="status">{localDiscoveries[target].message}</small>}
      </div>}
      {value.mode === "custom" && <label><span>API Key（本机加密保存）</span><input name={`${target}-api-key`} type="password" autoComplete="off" value={value.api_key} onChange={(event) => change({...value, api_key: event.target.value})} placeholder={savedKeyAvailable ? "已保存，留空可复用" : "服务需要时填写"} /><small>{savedKeyAvailable ? "同一地址、接口类型和运行位置可复用已保存密钥；密钥不会回显。" : "更换地址、接口类型或运行位置后，不会沿用旧密钥。"}</small></label>}
    </fieldset>;
  }

  async function reconcileUncertainSave() {
    request.persistenceUncertain = true;
    setConfigurationState("unavailable");
    let reread = false;
    try {
      const result = await window.openbutlerDesktop?.getBuiltinModelRoutes?.();
      if (!request.active) return;
      if (result && result.error_code !== "local_service_unavailable") {
        // The bridge may return old disk routes alongside the new backend's ready state.
        // Preserve the draft and never infer that the old saved configuration is active.
        setSavedConfiguration(result.savedConfigurationAvailable === false ? null : readPreviewModelConfiguration(result));
        reread = true;
      }
    } catch { /* The uncertain state remains visible; never display raw IPC errors. */ }
    if (request.active) setMessage(reread
      ? "保存结果未确认，已重新读取本机存档。当前运行配置可能与存档不同，请重新验证并保存，确认后再继续录制；录制不会自动恢复。"
      : "保存结果未确认，且无法读取本机存档。当前运行配置可能已改变，请检查本机服务后重新读取并验证；录制不会自动恢复。");
  }

  async function revokeSessionModels() {
    if (request.sessionRevoking || (request.pending && !request.sessionPending)) return;
    const revoke = window.openbutlerDesktop?.revokeBuiltinSessionModels;
    if (!revoke) return;
    request.sessionVersion++; request.sessionPending = false; request.sessionRevoking = true; request.pending = true;
    setBusy(true); setMessage("正在撤销本次内存配置并取消待完成验证…");
    try {
      const result = await revoke();
      if (!request.active) return;
      if (!result.ok || result.sessionRevoked !== true) throw new Error("session_revocation_unconfirmed");
      request.persistenceUncertain = false; setSessionOnly(false); setSavedConfiguration(null); setConfigurationState("unconfigured"); setDirty(true);
      setMessage("本次内存配置已撤销，录制保持暂停。再次使用需手动验证；没有自动恢复模型配置。");
      try { await onSaved(); } catch { /* The explicit native revocation receipt remains authoritative. */ }
    } catch {
      if (request.active) { request.persistenceUncertain = true; setSessionOnly(true); setConfigurationState("unavailable"); setMessage("本次配置的撤销尚未确认，请重新读取状态或重试撤销；不要视为仍可用。"); }
    } finally { request.sessionRevoking = false; request.pending = false; if (request.active) setBusy(false); }
  }

  async function useSessionModels() {
    if (request.pending || request.reading || !sessionEligible || !sessionBridgeAvailable) return;
    if (![imageRoute, textRoute].every((route) => validLocalModelDiscoveryEndpoint(route.endpoint.trim()) && route.model.trim() && route.model.trim().length <= 200)) {
      setMessage("请填写两个无密钥本机 Ollama 的有效回环地址和模型名称。"); return;
    }
    const clean = (route: PreviewModelRoute) => ({mode: "local" as const, protocol: "ollama_native", endpoint: route.endpoint.trim(), model: route.model.trim()});
    const payload = {image: clean(imageRoute), text: clean(textRoute), external_consent: false, masked_data_consent: false};
    const version = ++request.sessionVersion;
    request.pending = true; request.sessionPending = true; setBusy(true); setMessage("正在验证仅本次使用的本机模型；尚未确认可用，也不会开始录制。");
    try {
      const result = await window.openbutlerDesktop!.useBuiltinLocalModelsForSession!(payload);
      if (!request.active || version !== request.sessionVersion) return;
      const configuration = readSessionModelConfiguration(result);
      const exact = configuration && (["image", "text"] as const).every((target) => configuration[target].endpoint === payload[target].endpoint && configuration[target].model === payload[target].model);
      if (!result.ok || result.ready !== true || result.status?.ready !== true || !exact) {
        if (result.ok) await window.openbutlerDesktop?.revokeBuiltinSessionModels?.().catch(() => undefined);
        if (!request.active || version !== request.sessionVersion) return;
        setSessionOnly(true); setSavedConfiguration(null); setConfigurationState("unavailable");
        setMessage(sessionModelFailure(result.error_code)); return;
      }
      request.persistenceUncertain = false; setSessionOnly(true); setSavedConfiguration(configuration); restoreFields(configuration);
      readModelBudget(result); setConfigurationState("ready");
      setMessage("测试通过，仅本次有效。录制不会自动恢复。");
    } catch {
      if (request.active && version === request.sessionVersion) {
        await window.openbutlerDesktop?.revokeBuiltinSessionModels?.().catch(() => undefined);
        if (request.active && version === request.sessionVersion) { setSessionOnly(true); setSavedConfiguration(null); setConfigurationState("unavailable"); setMessage("本次验证结果未确认，已请求撤销可能的内存配置。请重新读取状态；未确认模型可用。"); }
      }
    } finally {
      if (version === request.sessionVersion) {
        request.sessionPending = false; request.pending = false;
        if (request.active) { setBusy(false); try { await onSaved(); } catch { /* No automatic validation or capture follows. */ } }
      }
    }
  }

  async function saveRoutes() {
    if (request.pending || request.reading || !bridgeAvailable) return;
    const validatingSaved = Boolean(savedConfiguration && !dirty);
    const configuration = validatingSaved ? savedConfiguration! : {image: imageRoute, text: textRoute, external_consent: externalConsent, masked_data_consent: maskedDataConsent};
    if (![configuration.image, configuration.text].every((route) => route.model.trim() && route.endpoint.trim())) {
      setMessage("请填写图像和文字模型的服务地址及模型名称。");
      return;
    }
    if ([configuration.image, configuration.text].some((route) => route.mode === "custom") && (!configuration.external_consent || !configuration.masked_data_consent)) {
      setMessage("使用自定义外部服务前，请分别确认联网调用和遮挡后数据发送范围。");
      return;
    }
    request.pending = true;
    setBusy(true);
    setMessage("");
    const sanitize = (route: PreviewModelRoute) => ({protocol: route.protocol, mode: route.mode, endpoint: route.endpoint.trim(), model: route.model.trim(), ...(route.api_key.trim() ? {api_key: route.api_key} : {})});
    const payload = {...configuration, image: sanitize(configuration.image), text: sanitize(configuration.text)};
    let updated = false;
    try {
      const result = await window.openbutlerDesktop!.saveBuiltinModelRoutes!(payload);
      if (!request.active) return;
      if (!result.ok) {
        if (result.error === "模型配置正在验证或保存，请等待完成后重试。") {
          setConfigurationState("unavailable");
          setMessage("另一次模型配置仍在验证或保存。请等待完成后重新读取状态，再决定是否重试；录制不会自动恢复。");
          return;
        }
        if (previewModelFailurePreservesConfiguration(result)) {
          // Explicit validation/preflight rejections precede publishing either proposed route.
          if (configurationState !== "ready") setConfigurationState("unavailable");
          setMessage(`${previewModelFailure(result)}${savedConfiguration ? sessionOnly ? " 之前的本次会话配置须以服务状态为准。" : " 上次保存的配置仍保留。" : " 本次配置未保存。"}录制不会自动恢复。`);
        } else {
          // A disk write can fail after the backend switched routes; !ok alone is not rollback proof.
          await reconcileUncertainSave();
        }
        return;
      }
      const savedRoute = (target: "image" | "text"): PreviewModelRoute => ({...payload[target], api_key: "", apiKeyConfigured: Boolean(payload[target].api_key || (samePreviewModelDestination(configuration[target], savedConfiguration?.[target]) && savedConfiguration?.[target].apiKeyConfigured))});
      const next = {...configuration, image: savedRoute("image"), text: savedRoute("text")};
      setSessionOnly(false); readModelBudget(result);
      request.persistenceUncertain = false;
      setSavedConfiguration(next);
      restoreFields(next);
      setConfigurationState(result.status?.ready === true ? "ready" : "saved-needs-validation");
      setMessage(result.status?.ready === true ? "测试通过，已加密保存。继续录制前请检查预览。" : "配置已保存，但当前可用状态尚未确认。请重新验证；录制不会自动恢复。");
      updated = true;
    } catch {
      if (request.active) await reconcileUncertainSave();
    } finally {
      // Refresh recording status even after a rejected proposal: the desktop may have paused it.
      if (request.active) {
        try { await onSaved(); } catch {
          if (request.active && updated) setMessage("模型配置已保存，但录制状态刷新失败。请刷新页面查看；录制不会自动恢复。");
        }
      }
      request.pending = false;
      if (request.active) setBusy(false);
    }
  }

  function openAdvancedSettings() {
    setAdvancedOpen(true);
    window.requestAnimationFrame?.(() => {
      document.getElementById(`${sectionId}-advanced`)?.scrollIntoView({behavior: "smooth", block: "start"});
      document.getElementById(`${sectionId}-title`)?.focus();
    });
  }

  function pickCatalogModel(target: ModelRole, endpoint: string, model: string) {
    if (request.pending || request.reading) return;
    invalidateLocalModels(target); markEdited();
    setExternalConsent(false); setMaskedDataConsent(false);
    const route: PreviewModelRoute = {protocol: "ollama_native", mode: "local", endpoint, model, api_key: "", apiKeyConfigured: false};
    (target === "image" ? setImageRoute : setTextRoute)(route);
    openAdvancedSettings();
  }

  const stateLabels: Record<PreviewModelConfigurationState, string> = {unconfigured: "未配置", "saved-needs-validation": "已保存，待验证", ready: "可用", unavailable: "暂不可用"};
  const stateDescriptions: Record<PreviewModelConfigurationState, string> = {
    unconfigured: "选择图像和文字模型，测试后使用",
    "saved-needs-validation": "配置已载入，请重新测试",
    ready: "上次测试通过；修改后需重新测试",
    unavailable: "模型状态未确认，请检查服务后重试",
  };
  return <section id={sectionId} className="today-panel preview-model-settings catalog-settings" tabIndex={-1} aria-labelledby={`${sectionId}-title`} aria-busy={busy || loading}>
    <ModelCatalog disabled={busy || loading} onPick={pickCatalogModel} onOpenAdvanced={openAdvancedSettings} assignments={{image: savedConfiguration?.image.model || "", text: savedConfiguration?.text.model || "", status: sessionOnly ? "仅本次会话" : configurationState === "ready" ? "上次测试通过" : "待测试"}} />
    <details id={`${sectionId}-advanced`} className="model-advanced-settings" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
    <summary>手动配置与测试</summary><div className="model-advanced-body">
    <div className="section-title preview-model-heading"><div><p className="eyebrow"><KeyRound size={16} /> 智能整理</p><h2 id={`${sectionId}-title`} tabIndex={-1}>模型配置</h2></div><span className={`preview-model-state ${configurationState}`} role="status">{loading ? "读取中" : sessionOnly ? (dirty ? "草稿待验证" : configurationState === "ready" ? "本次会话可用" : "本次会话未确认") : `${dirty && configurationState === "ready" ? "上次配置" : ""}${stateLabels[configurationState]}`}</span></div>
    <p>{sessionOnly ? (dirty ? "修改未生效，请先测试" : "已载入临时配置，打开页面不会调用模型。") : stateDescriptions[configurationState]}</p>
    {sessionOnly && <p className="preview-model-notice" role="status">仅本次有效，退出后需重新配置</p>}
    {localTimeoutSeconds !== null && <small>单次超时上限：{localTimeoutSeconds} 秒</small>}
    {!bridgeAvailable && <p className="preview-model-notice">请在桌面版配置模型</p>}
    {dirty && <p className="preview-model-notice" role="status">修改未保存，请先测试。{savedConfiguration ? sessionOnly ? "本次配置状态待核对。" : "上次保存的配置仍保留。" : ""}</p>}
    <div className="preview-model-grid">{routeFields("图像理解", "image", imageRoute)}{routeFields("文字整理", "text", textRoute)}</div>
    {hasExternalRoute && <div className="preview-model-consent"><p>外部服务需单独授权；更改地址、接口或运行位置后需重新确认。</p><label className="preview-confirm"><input name="external-model-consent" type="checkbox" disabled={busy} checked={externalConsent} onChange={(event) => {markEdited(); setExternalConsent(event.target.checked);}} /> 允许调用所选外部模型服务</label><label className="preview-confirm"><input name="masked-model-consent" type="checkbox" disabled={busy} checked={maskedDataConsent} onChange={(event) => {markEdited(); setMaskedDataConsent(event.target.checked);}} /> 允许向所选外部服务发送遮挡后的数据</label></div>}
    <p className="preview-model-validation-note">测试只发送合成图和文字，不发送本机记录。测试可能暂停录制，不会自动开始或恢复。{hasExternalRoute && <span> 使用外部服务可能产生费用。</span>}</p>
    <div className="desktop-action-row"><button className="primary" disabled={busy || loading || !bridgeAvailable} onClick={() => void saveRoutes()}>{busy ? "测试中" : savedConfiguration && !dirty && !sessionOnly ? "重新测试" : "测试并保存"}</button>{dirty && savedConfiguration && <button className="secondary" disabled={busy || loading} onClick={() => {request.editVersion += 1; restoreFields(savedConfiguration); setMessage(sessionOnly ? "已恢复上次本次会话的非密钥字段；尚未发起模型调用。" : "已恢复上次保存的非密钥字段；尚未发起模型调用。");}}>{sessionOnly ? "恢复本次配置" : "恢复已保存配置"}</button>}<button className="secondary" disabled={busy || loading || !bridgeAvailable} onClick={() => void loadRoutes()}>刷新状态</button></div>
    {sessionEligible && <div className="preview-model-session-controls" style={{display: "grid", gap: 8}}>
      <button className="secondary" disabled={busy || loading || !sessionBridgeAvailable} onClick={() => void useSessionModels()}>测试并临时使用</button>
      <small>仅本机无密钥模型可用；退出后失效</small>
    </div>}
    {(sessionOnly || request.sessionPending) && <button className="secondary" disabled={loading || request.sessionRevoking || !sessionBridgeAvailable || (busy && !request.sessionPending)} onClick={() => void revokeSessionModels()}>{request.sessionPending ? "取消本次验证" : "撤销本次模型配置"}</button>}
    <details className="model-config-help"><summary>配置说明</summary>
      <p>截图记录无需模型。打开页面只读取状态，不会自动调用模型；测试失败不会删除已保存配置。</p>
      <p>表单修改不会立即替换运行配置，需测试并保存后生效。</p>
      <p>临时配置仅适用于无密钥的本机 Ollama，配置只留在内存，未写入磁盘。退出后需重新配置；关闭面板会取消未完成的临时测试。</p>
      {localTimeoutSeconds !== null && <p>图像与文字分两次独立调用，总耗时可能更长；超时上限不是预计速度。</p>}
    </details>
    {message && <p className="policy-note" role="status">{message}</p>}
    </div></details>
  </section>;
}

function PreviewActivation({status, mandatory, onChooseDemo, onChooseReal, onDismiss, onComplete, onChooseLocalChat}: {
  status: ActivationStatus;
  mandatory: boolean;
  onChooseLocalChat?: () => void;
  onChooseDemo: () => void;
  onChooseReal: () => void;
  onDismiss: () => void;
  onComplete: () => void;
}) {
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const [localSetup, setLocalSetup] = useState(status === "real_setup_started" || status === "completed");
  // Full-desktop privacy checks are not verified. This gate is intentionally
  // independent of capability reports, including missing or stale supported:true.
  const fullDesktopAvailable = false;
  const [captureScope, setCaptureScope] = useState<"screen" | "public_window" | null>(() => window.openbutlerDesktop?.getCaptureWindows ? "public_window" : null);
  const [capabilities, setCapabilities] = useState<CaptureCapabilities | null>(null);
  const [displays, setDisplays] = useState<Array<{id: string; label: string}>>([]);
  const [displayId, setDisplayId] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [masks, setMasks] = useState<PreviewMask[]>([]);
  const [preview, setPreview] = useState<(MaskedEditingCanvas & {ticket: PreviewTicket; configKey: string; privacyMode: PrivacyMode}) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [privacyMode, setLocalPrivacyMode] = useState<PrivacyMode>("strict");
  const [statusData, setStatusData] = useState<ContextEngineStatus | null>(null);
  const [busy, setBusy] = useState<"preview" | "privacy" | "start" | null>(null);
  const [message, setMessage] = useState("");
  const previewGate = useRef(createPrivacyPreviewGate());
  const operation = useRef<"preview" | "privacy" | "start" | null>(null);

  useEffect(() => {
    previewGate.current.open();
    return () => previewGate.current.close();
  }, []);

  useEffect(() => {
    if (!localSetup) return;
    let cancelled = false;
    void Promise.all([getContextEngineStatus(), window.openbutlerDesktop?.getCaptureCapabilities?.() ?? Promise.resolve(null)])
      .then(([current, capability]) => {
        if (cancelled) return;
        setStatusData(current);
        setCapabilities(capability);
        setLocalPrivacyMode(current.privacy_mode);
      })
      .catch(() => { if (!cancelled) setMessage("本机录制服务暂不可用，请稍后重试。"); });
    return () => { cancelled = true; };
  }, [localSetup, captureScope]);

  function invalidatePreview() {
    previewGate.current.invalidate();
    setConfirmed(false);
    setPreview((previous) => previous ? {...previous, fresh: false} : null);
  }

  function changeConfig(action: () => void, clearCanvas = false) {
    if (operation.current === "start" || operation.current === "privacy" || statusData?.recording.active) return;
    invalidatePreview();
    action();
    if (clearCanvas) setPreview(null);
    setMessage("");
  }

  function captureConfig(): CaptureConfig | null {
    const excluded_apps = exclusions.split(/[\n,，]/).map((name) => name.trim()).filter(Boolean);
    if (!displayId || !excluded_apps.length) {
      setMessage("请先选择屏幕，并填写至少一个不记录的应用。");
      return null;
    }
    if (masks.some((mask) => !Number.isSafeInteger(mask.x) || !Number.isSafeInteger(mask.y) || !Number.isSafeInteger(mask.width) || !Number.isSafeInteger(mask.height) || mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0
        || (preview?.bounds && !sameMask(mask, clampMask(mask, preview.bounds))))) {
      setMessage("遮挡区域需要填写图像范围内的非负整数坐标和大于 0 的宽高。");
      return null;
    }
    return {display_id: displayId, excluded_apps, masks: masks.map((mask) => ({...mask})), confirmed: true};
  }

  const configKey = JSON.stringify({display_id: displayId, excluded_apps: exclusions.split(/[\n,，]/).map((name) => name.trim()).filter(Boolean), masks, confirmed: true});
  const previewCurrent = !!preview && preview.fresh && !!preview.bounds && preview.configKey === configKey
    && preview.privacyMode === privacyMode && previewGate.current.isCurrent(preview.ticket);
  const editDisabled = !statusData || busy === "start" || busy === "privacy" || !!statusData.recording.active;

  async function checkPreview() {
    if (operation.current || editing || statusData?.recording.active || !fullDesktopAvailable) return;
    const config = captureConfig();
    if (!config || !window.openbutlerDesktop?.getMaskedCapturePreview) return;
    invalidatePreview();
    const ticket = previewGate.current.request();
    operation.current = "preview";
    setBusy("preview");
    setMessage("正在生成新的已遮挡预览；尚未开始录制。");
    try {
      const result = await window.openbutlerDesktop.getMaskedCapturePreview(config);
      if (!previewGate.current.isCurrent(ticket)) return;
      if (!result.ok || !result.previewDataUrl.startsWith("data:image/png;base64,")) {
        setMessage("隐私预览未完成，录制尚未开始。请检查遮挡配置后重试。");
        return;
      }
      setPreview({url: result.previewDataUrl, maskedRegions: result.masked_regions ?? result.maskedRegions ?? 0,
        configKey: JSON.stringify(config), privacyMode, ticket, bounds: null, fresh: true});
      setMessage("请检查预览图中是否仍有不希望记录的内容。修改设置后需要重新预览。");
    } catch {
      if (previewGate.current.isCurrent(ticket)) setMessage("隐私预览失败，录制尚未开始。");
    } finally {
      operation.current = null;
      setBusy(null);
      if (!previewGate.current.isCurrent(ticket)) setMessage("设置已改变，旧的预览结果已忽略。请重新检查隐私预览。");
    }
  }

  function loadedPreview(ticket: PreviewTicket, bounds: ImageBounds) {
    if (!preview || preview.ticket !== ticket) return;
    if (!validImageBounds(bounds)) {
      invalidatePreview();
      setPreview(null);
      setMessage("隐私预览图片不可用，请重新预览；录制尚未开始。");
      return;
    }
    const fresh = preview.fresh && previewGate.current.isCurrent(ticket);
    const boundedMasks = masks.map((mask) => clampMask(mask, bounds));
    const changed = boundedMasks.some((mask, index) => !sameMask(mask, masks[index]));
    if (changed) {
      previewGate.current.invalidate();
      setMasks(boundedMasks);
      setConfirmed(false);
      setMessage("遮挡区域已按原图边界调整，请重新检查隐私预览。");
    }
    setPreview((previous) => previous?.ticket === ticket ? {...previous, bounds, fresh: fresh && !changed} : previous);
  }

  async function pauseFailedStart() {
    await Promise.all([
      pauseBuiltinCaptureApi().catch(() => undefined),
      window.openbutlerDesktop?.pauseBuiltinCapture?.().catch(() => undefined),
    ]);
  }

  async function beginRecording() {
    if (operation.current || editing || statusData?.recording.active || !fullDesktopAvailable) return;
    const config = captureConfig();
    if (!config || !previewCurrent || !preview || !previewGate.current.isCurrent(preview.ticket) || !confirmed || !window.openbutlerDesktop?.startBuiltinCapture) return;
    // Consume this approval before awaiting the bridge so a double-click cannot reuse it.
    invalidatePreview();
    const ticket = previewGate.current.request();
    operation.current = "start";
    setBusy("start");
    try {
      const result = await window.openbutlerDesktop.startBuiltinCapture(config);
      if (!result.ok) throw new Error("capture_bridge_failed");
      if (!previewGate.current.isCurrent(ticket)) {
        await pauseFailedStart();
        return;
      }
      onComplete();
    } catch {
      await pauseFailedStart();
      if (previewGate.current.isCurrent(ticket)) setMessage("录制未能启动，已尝试暂停。请检查本机服务后重新预览并确认。");
    } finally {
      operation.current = null;
      setBusy(null);
    }
  }

  async function choosePrivacy(mode: PrivacyMode) {
    if (operation.current || editing || statusData?.recording.active || mode === privacyMode) return;
    invalidatePreview();
    const ticket = previewGate.current.request();
    operation.current = "privacy";
    setBusy("privacy");
    try {
      await setPrivacyMode(mode);
      if (previewGate.current.isCurrent(ticket)) {
        setLocalPrivacyMode(mode);
        setMessage("隐私方式已更新，请重新检查隐私预览。");
      }
    } catch {
      if (previewGate.current.isCurrent(ticket)) setMessage("隐私设置未保存，请重试；原预览已失效。");
    } finally {
      operation.current = null;
      setBusy(null);
    }
  }

  function leaveSetup(action: () => void) {
    if (operation.current === "start") return;
    previewGate.current.close();
    setPreview(null);
    setConfirmed(false);
    action();
  }

  return (
    <div className="first-run-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-activation-title">
      <section className="first-run-guide preview-activation-guide">
        <div className="first-run-copy">
          <p className="eyebrow">0.2.0 Preview · 首次激活</p>
          <h2 id="preview-activation-title">开始使用</h2>
          <p>选择专用公开窗口，单独授权并检查遮挡后再开始。模型可稍后配置。</p>
          <div className="activation-choice-grid">
            {onChooseLocalChat && <button className="activation-choice" disabled={busy === "start"} onClick={() => leaveSetup(onChooseLocalChat)}>
              <MessageSquareText size={17} /><strong>先聊天</strong><span>文字保存在本机，不录屏</span>
            </button>}
            <button className="activation-choice primary-choice" disabled={!!busy} onClick={() => { onChooseReal(); setLocalSetup(true); }}>
              <Video size={17} /><strong>设置截图记录</strong><span>无需额外安装</span>
            </button>
            <button className="activation-choice" disabled={busy === "start"} onClick={() => leaveSetup(onChooseDemo)}>
              <Eye size={17} /><strong>先看样例</strong><span>不读取真实数据。</span>
            </button>
          </div>
          <button className="secondary first-run-model-entry" aria-expanded={modelSetupOpen} aria-controls="activation-model-settings" disabled={busy === "start"}
            onClick={() => setModelSetupOpen((open) => !open)}>{modelSetupOpen ? "收起模型设置" : "配置模型"}</button>
          <small>配置模型不会开始录制</small><details><summary>使用说明</summary><small>完整桌面隐私检查尚未验证，当前不可用。专用公开窗口需单独授权。打开模型设置只读取已保存状态，点击测试才调用模型。</small></details>
          {modelSetupOpen && <PreviewModelSettings sectionId="activation-model-settings" onSaved={async () => {
            const current = await getContextEngineStatus(); setStatusData(current);
          }} />}
          {!localSetup && <p className="policy-note">网页仅供体验，截图记录需桌面版</p>}
        </div>
        {localSetup && <div className="first-run-local-setup preview-capture-setup">
          <div className="local-setup-head"><strong>录制范围</strong><p>更改设置后，请重新预览</p></div>
          <div className="capture-source-choice" role="group" aria-label="选择自动记录来源">
            <button className="secondary" aria-pressed={captureScope === "public_window"} disabled={!!busy || editing || !!statusData?.recording.active || !window.openbutlerDesktop?.getCaptureWindows} onClick={() => { invalidatePreview(); setPreview(null); setCaptureScope("public_window"); }}>专用公开窗口</button>
            <button className="secondary" aria-pressed={false} disabled aria-describedby="full-desktop-unavailable">整个屏幕（当前不可用）</button>
          </div>
          <p id="full-desktop-unavailable" className="capture-capability-warning">完整桌面采集当前不可用：隐私检查尚未验证。专用公开窗口需单独授权。</p>
          {captureScope === "public_window" && window.openbutlerDesktop?.getCaptureWindows && <PublicWindowCaptureSetup active={!!statusData?.recording.active} capabilities={capabilities} onComplete={onComplete} onStartingChange={(starting) => setBusy(starting ? "start" : null)} />}
          {!window.openbutlerDesktop?.getCaptureWindows && <p role="status">当前版本未提供专用公开窗口采集。不会改录整个屏幕；已有记录保持不变。</p>}
          {fullDesktopAvailable && captureScope === "screen" && <>
          <div className="local-setup-status">
            <StatusItem label="录制能力" value={statusData?.capture_available ? "可用" : "待连接"} />
            <StatusItem label="当前状态" value={statusData?.recording.active ? "记录中" : "未录制"} />
            <StatusItem label="已有记录" value={`${statusData?.recording.record_count ?? 0} 条`} />
          </div>
          <label><span>选择屏幕</span><select value={displayId} disabled={editDisabled || editing} onChange={(event) => changeConfig(() => setDisplayId(event.target.value), true)}>
            {!displays.length && <option value="">尚未检测到屏幕</option>}
            {displays.map((display) => <option key={display.id} value={display.id}>{display.label}</option>)}
          </select></label>
          <label><span>不记录的应用（每行一个）</span><textarea value={exclusions} disabled={editDisabled || editing} onChange={(event) => changeConfig(() => setExclusions(event.target.value))} placeholder="例如：密码管理器" rows={3} /></label>
          <fieldset className="preview-privacy-choice" disabled={!!busy || editing || editDisabled}><legend>隐私方式</legend>
            <label><input type="radio" checked={privacyMode === "strict"} onChange={() => void choosePrivacy("strict")} /> 只在本机整理</label>
            <label><input type="radio" checked={privacyMode === "basic"} onChange={() => void choosePrivacy("basic")} /> 允许之后单独授权外部能力</label>
          </fieldset>
          <p className="policy-note">当前只启用本机记录。选择基础隐私也不会自动调用外部模型。</p>
          {statusData?.recording.active && <p className="policy-note">录制正在运行。请先返回今日暂停，再更改范围。</p>}
          <button className="secondary" onClick={() => void checkPreview()} disabled={!!busy || editing || statusData?.recording.active || !fullDesktopAvailable || !window.openbutlerDesktop?.getMaskedCapturePreview}>检查隐私预览</button>
          <MaskEditor key={preview?.ticket.requestId ?? "no-preview"} masks={masks} canvas={preview} disabled={editDisabled} editing={editing}
            onChange={(next) => changeConfig(() => setMasks(next))} onEditStart={invalidatePreview} onEditingChange={setEditing}
            onImageLoad={(bounds) => { if (preview) loadedPreview(preview.ticket, bounds); }}
            onImageError={() => { invalidatePreview(); setPreview(null); setMessage("隐私预览图片无法显示，请重新预览；录制尚未开始。"); }} />
          <label className="preview-confirm"><input type="checkbox" checked={confirmed} disabled={!previewCurrent || !!busy || editing || !!statusData?.recording.active}
            onChange={(event) => { if (previewCurrent && preview && previewGate.current.isCurrent(preview.ticket) && !busy && !editing) setConfirmed(event.target.checked); }} /> 我已检查最新预览，同意按上述范围录制</label>
          <button className="primary" onClick={() => void beginRecording()} disabled={!!busy || editing || statusData?.recording.active || !previewCurrent || !confirmed || !fullDesktopAvailable || !window.openbutlerDesktop?.startBuiltinCapture}>开始记录</button>
          {statusData?.recording.active && <button className="secondary" onClick={() => leaveSetup(onComplete)}>返回今日</button>}
          {message && <p className="policy-note" role="status">{message}</p>}
          </>}
        </div>}
        {!mandatory && <button className="first-run-close" disabled={busy === "start"} onClick={() => leaveSetup(onDismiss)}>关闭</button>}
      </section>
    </div>
  );
}

function FirstRunGuide({
  status,
  mandatory = false,
  onChooseDemo,
  onChooseReal,
  onDismiss,
  onComplete,
  onChooseLocalChat
}: {
  status: ActivationStatus;
  mandatory?: boolean;
  onChooseLocalChat?: () => void;
  onChooseDemo: () => void;
  onChooseReal: () => void;
  onDismiss: () => void;
  onComplete: () => void;
}) {
  if (isPreviewDesktop()) {
    return <PreviewActivation status={status} mandatory={mandatory} onChooseDemo={onChooseDemo} onChooseReal={onChooseReal} onDismiss={onDismiss} onComplete={onComplete} onChooseLocalChat={onChooseLocalChat} />;
  }
  const isDesktopRuntime = typeof window !== "undefined" && !!window.openbutlerDesktop;
  const [setupPane, setSetupPane] = useState<"intro" | "local">(status === "real_setup_started" ? "local" : "intro");
  const [mineContextStatus, setMineContextStatus] = useState<Record<string, any> | null>(null);
  const [mineContextScan, setMineContextScan] = useState<Record<string, any> | null>(null);
  const [setupMessage, setSetupMessage] = useState("");
  const [checkingMineContext, setCheckingMineContext] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelProviderConfig>(DEFAULT_MODEL_PROVIDER_CONFIG);

  const activationSteps = [
    {step: "1", title: "先看懂它能做什么", text: "OpenButler 会把你允许整理的本机记录，变成今日概览、提醒和依据。"},
    {step: "2", title: "选择样例或完整使用", text: "样例只展示效果；完整使用会在你的电脑上整理你允许读取的记录。"},
    {step: "3", title: "确认隐私承诺", text: "默认完全本地、只读、不开外部模型、不复制截图。"},
    {step: "4", title: "连接智能整理能力", text: "填写模型服务信息，让本机记录可以被整理成摘要和提醒。"},
    {step: "5", title: "查找本机记录组件", text: "找到后连接已有服务；找不到时，再由你确认是否安装。"},
    {step: "6", title: "预览后再开始", text: "真实整理前先看会读取什么，确认后才继续。"},
  ];
  const resultCards = [
    {
      title: "今日概览",
      text: "把你允许整理的记录，压缩成一句能看懂的今日状态。",
      icon: CalendarDays,
    },
    {
      title: "管家提醒",
      text: "只把值得你决定、回看或稍后处理的事放到前面。",
      icon: Lightbulb,
    },
    {
      title: "可复核依据",
      text: "每条提醒都能展开查看来源、可信度和边界说明。",
      icon: ShieldCheck,
    },
  ];

  const previewItems = [
    {time: "09:22", title: "钥匙可能在玄关托盘附近", source: "相册线索 · 样例"},
    {time: "14:10", title: "有一项会议后待办适合收尾", source: "今日记录 · 样例"},
    {time: "18:40", title: "可以安排 5 分钟活动一下", source: "生活节律 · 样例"},
  ];

  async function refreshMineContextStatus() {
    if (!window.openbutlerDesktop) {
      setMineContextStatus({reachable: false, running: false, configured: false, status: "web_demo"});
      return;
    }
    setCheckingMineContext(true);
    try {
      const payload = await window.openbutlerDesktop.getMineContextStatus();
      setMineContextStatus(payload);
      setSetupMessage(payload.reachable ? "已检测到本机记录组件正在运行。" : "还没有检测到本机记录组件。你可以先查找、启动，或选择安装程序。");
    } catch {
      setSetupMessage("检测失败。请确认 OpenButler 本机服务仍在运行。");
    } finally {
      setCheckingMineContext(false);
    }
  }

  useEffect(() => {
    if (setupPane === "local") {
      void refreshMineContextStatus();
    }
  }, [setupPane]);

  function updateModelConfig<K extends keyof ModelProviderConfig>(key: K, value: ModelProviderConfig[K]) {
    setModelConfig((current) => ({...current, [key]: value}));
    setModelReady(false);
  }

  function missingModelFields(config: ModelProviderConfig) {
    const labels: Record<keyof ModelProviderConfig, string> = {
      modelPlatform: "服务商",
      modelId: "模型名称 / ID",
      baseUrl: "服务地址",
      apiKey: "API Key",
      useSeparateEmbedding: "独立高级向量配置",
      embeddingModelPlatform: "高级向量服务商",
      embeddingModelId: "高级向量模型 / ID",
      embeddingBaseUrl: "高级向量服务地址",
      embeddingApiKey: "高级向量 API Key",
    };
    const missing: string[] = [];
    (["modelPlatform", "modelId", "baseUrl", "apiKey"] as Array<keyof ModelProviderConfig>).forEach((key) => {
      if (!String(config[key] || "").trim()) missing.push(labels[key]);
    });
    if (config.useSeparateEmbedding) {
      (["embeddingModelPlatform", "embeddingModelId", "embeddingBaseUrl", "embeddingApiKey"] as Array<keyof ModelProviderConfig>).forEach((key) => {
        if (!String(config[key] || "").trim()) missing.push(labels[key]);
      });
    }
    return missing;
  }

  function saveModelConfigForScan() {
    const missing = missingModelFields(modelConfig);
    if (missing.length) {
      setModelReady(false);
      setSetupMessage(`请先补全：${missing.join("、")}。配置完成后才能启用本地完全体。`);
      return false;
    }
    setModelReady(true);
    setSetupMessage("智能整理已补齐。下一步可以查找本机记录组件；这一步不会读取活动明细。");
    return true;
  }

  async function scanMineContext() {
    if (!modelReady && !saveModelConfigForScan()) return;
    if (!window.openbutlerDesktop) {
      setSetupMessage("当前是网页样例。请在 OpenButler 桌面版中查找本机记录组件。");
      return;
    }
    setCheckingMineContext(true);
    try {
      const scan = await window.openbutlerDesktop.scanMineContextInstallations();
      setMineContextScan(scan);
      await refreshMineContextStatus();
      setSetupMessage(scan?.found
        ? `已找到 ${scan.candidates?.length ?? 0} 个本机记录组件线索。可以启动并连接。`
        : "没有找到本机记录组件。你可以选择自动安装，或打开下载页手动安装。");
    } catch {
      setSetupMessage("扫描失败。请确认桌面应用仍在运行，或稍后重试。");
    } finally {
      setCheckingMineContext(false);
    }
  }

  async function chooseInstaller() {
    const result = await window.openbutlerDesktop?.chooseMineContextInstaller();
    if (result?.selected) setSetupMessage("已选择安装程序。点击“安装或启动”后会交给 Windows 安装器处理。");
  }

  async function startMineContext() {
    if (!modelReady && !saveModelConfigForScan()) return;
    const result = await window.openbutlerDesktop?.startMineContext();
    setSetupMessage(result?.message ?? "未能启动本机记录组件。");
    window.setTimeout(() => void refreshMineContextStatus(), 1200);
  }

  async function downloadAndInstallMineContext() {
    if (!modelReady && !saveModelConfigForScan()) return;
    if (!window.openbutlerDesktop) {
      setSetupMessage("自动安装只在桌面版可用。网页样例不会安装任何本机工具。");
      return;
    }
    setCheckingMineContext(true);
    try {
      const download = await window.openbutlerDesktop.downloadMineContextInstaller();
      if (!download?.ok) {
        setSetupMessage(download?.message ?? "没有准备好安装包。你可以选择手动安装。");
        return;
      }
      const install = await window.openbutlerDesktop.installMineContextWithApproval();
      setSetupMessage(install?.message ?? "安装流程已结束。请重新查找本机记录组件。");
      await scanMineContext();
    } finally {
      setCheckingMineContext(false);
    }
  }

  async function openMineContextDownloadPage() {
    await window.openbutlerDesktop?.openMineContextDownloadPage();
    setSetupMessage("已打开本机记录组件下载页面。安装完成后，请回到这里重新扫描。");
  }

  async function testModelConfig() {
    setSavingModel(true);
    try {
      const missing = missingModelFields(modelConfig);
      if (missing.length) {
        setModelReady(false);
        setSetupMessage(`请先补全：${missing.join("、")}。`);
      } else {
        setModelReady(true);
        const result = await window.openbutlerDesktop?.testMineContextModelConfig(modelConfig);
        setSetupMessage(result?.message ?? "智能整理信息已补齐；连接本机记录组件后即可保存。");
      }
    } finally {
      setSavingModel(false);
    }
  }

  async function applyModelConfig() {
    if (!modelReady && !saveModelConfigForScan()) return;
    setSavingModel(true);
    try {
      const result = await window.openbutlerDesktop?.applyMineContextModelConfig(modelConfig);
      setSetupMessage(result?.message ?? "智能整理配置已保存。");
      if (result?.ok) {
        await refreshMineContextStatus();
        onComplete();
      }
    } finally {
      setSavingModel(false);
    }
  }

  return (
    <div className="first-run-backdrop" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <section className="first-run-guide">
        <div className="first-run-copy">
          <p className="eyebrow">首次激活 · {activationStatusLabel(status)}</p>
          <h2 id="first-run-title">像安装一个私人管家一样开始</h2>
          <p>
            你不用理解后端、端口或数据表。先看样例，或者让 OpenButler 在本机整理你主动授权的记录。
            授权前只会检测和预览，不会导入真实活动。
          </p>
          {status === "dismissed" && (
            <p className="policy-note">你可以稍后回来继续设置。完成样例体验或本地完全体设置前，不会进入空控制台。</p>
          )}
          <div className="first-run-signal-strip" aria-label="首次使用会得到什么">
            <article>
              <strong>今天重点</strong>
              <span>先看到最值得处理的 1-3 件事。</span>
            </article>
            <article>
              <strong>完整记录</strong>
              <span>把重要片段整理进可回看的时间线。</span>
            </article>
            <article>
              <strong>依据说明</strong>
              <span>每条建议都能展开看来源和边界。</span>
            </article>
          </div>
          <details className="activation-step-details">
            <summary>完整使用会怎么开始</summary>
            <div className="activation-step-list" aria-label="首次激活步骤">
              {activationSteps.map((item) => (
                <article key={item.step}>
                  <span>{item.step}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.text}</small>
                  </div>
                </article>
              ))}
            </div>
          </details>
          <div className="activation-choice-grid" aria-label="选择开始方式">
            <button className="activation-choice primary-choice" onClick={onChooseDemo}>
              <CheckCircle2 size={17} />
              <strong>先看样例</strong>
              <span>立即理解产品效果，不读取你的真实数据。</span>
            </button>
            <button className="activation-choice" onClick={() => {
              onChooseReal();
              setSetupPane("local");
            }}>
              <Database size={17} />
              <strong>让 OpenButler 整理我的本机记录</strong>
              <span>先检测本机记录组件和智能整理，再由你确认。</span>
            </button>
            <button className="activation-choice quiet-choice" onClick={onDismiss}>
              <CalendarDays size={17} />
              <strong>稍后配置</strong>
              <span>停在引导页，之后再选择样例或完整使用。</span>
            </button>
          </div>
        </div>

        {setupPane === "intro" ? (
          <div className="first-run-cards">
            {resultCards.map((step) => {
              const Icon = step.icon;
              return (
                <article className="first-run-card" key={step.title}>
                  <Icon size={20} />
                  <strong>{step.title}</strong>
                  <span>{step.text}</span>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="first-run-local-setup" aria-label="本地完全体设置">
            <div className="local-setup-head">
              <span className="privacy-chip">{isDesktopRuntime ? "本地完全体" : "网页样例"}</span>
              <strong>先完成本地模式激活</strong>
              <p>先填写智能整理钥匙，再查找本机记录组件。连接成功后先看授权前预览，确认后才会开始整理你的本机记录。</p>
            </div>
            <div className="local-setup-status">
              <StatusItem label="桌面环境" value={isDesktopRuntime ? "已连接" : "仅样例"} />
              <StatusItem label="智能整理" value={modelReady ? "已补齐" : "待补齐"} />
              <StatusItem label="本机记录组件" value={mineContextStatus?.reachable ? "运行中" : checkingMineContext ? "检测中" : "未检测到"} />
            </div>

            {!isDesktopRuntime ? (
              <div className="local-mode-preview-panel">
                <div className="section-title compact-title">
                  <div>
                      <p className="eyebrow">完整使用需要桌面版</p>
                      <h3>桌面版会带你完成本机设置</h3>
                  </div>
                </div>
                <p>公开网页只提供样例体验，不会扫描你的电脑。桌面版会在本机一步步带你完成下面三件事。</p>
                <div className="local-mode-step-grid">
                  <article>
                    <strong>连接智能整理能力</strong>
                    <span>API Key 是服务商给你的访问凭证。桌面版会把它交给本机整理能力，用来把记录整理成摘要和提醒。</span>
                  </article>
                  <article>
                    <strong>查找本机记录组件</strong>
                    <span>只检查安装位置和运行状态，不读取活动标题、URL 或截图。</span>
                  </article>
                  <article>
                    <strong>预览后再开始</strong>
                    <span>确认前不会导入真实活动；找不到服务时才会询问自动安装或手动安装。</span>
                  </article>
                </div>
                <div className="setup-link-grid" aria-label="真实模式准备说明">
                  <article>
                    <strong>桌面版从哪里获取？</strong>
                    <span>你可以从桌面版发布页获取安装包。内测阶段如果发布页暂未开放，请使用收到的内测安装包。</span>
                    <a className="inline-help-link" href="https://github.com/Giftia/OpenButler/releases" target="_blank" rel="noreferrer">查看桌面版发布页</a>
                  </article>
                  <article>
                    <strong>API Key 去哪里拿？</strong>
                    <span>推荐从火山引擎 Ark 控制台创建 Key。桌面版会带默认配置，你通常只需要粘贴这一项。</span>
                    <a className="inline-help-link" href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer">打开 Ark 控制台</a>
                  </article>
                </div>
                <div className="web-only-setup-note">
                  <strong>你现在可以先看样例。</strong>
                  <p>现在可以继续看样例。要接入真实记录，请先获取桌面版；打开后选择“打开完整设置”，粘贴 API Key，再按提示授权本机记录。</p>
                  <div className="desktop-action-row compact-actions">
                    <button className="primary" onClick={onChooseDemo}>先继续看样例</button>
                    <button className="secondary" onClick={() => setSetupMessage("请先打开桌面版发布页获取安装包。安装并打开后点“打开完整设置”，粘贴 API Key，再授权本机记录。网页样例不能扫描你的电脑。")}>我还没有桌面版</button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="model-config-panel">
                  <div className="section-title compact-title">
                    <div>
                      <p className="eyebrow">智能整理能力</p>
                      <h3>先连接智能整理钥匙</h3>
                    </div>
                  </div>
                  <div className="api-key-help-card">
                    <KeyRound size={19} />
                    <div>
                      <strong>我该从哪里获得 API Key？</strong>
                      <p>API Key 是服务商给你的访问凭证。OpenButler 不内置云模型，所以需要你提供自己的 Key；你可以先打开 Ark 控制台创建，再回到这里粘贴。</p>
                      <small>如果你还没有服务商账号，先用样例体验即可。API Key 只会保存在本机记录来源里，不会显示在状态页、日志或摘要里。</small>
                      <a className="inline-help-link" href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer">打开火山引擎 Ark 控制台</a>
                    </div>
                  </div>
                  <label>
                    <span>服务商</span>
                    <input value={modelConfig.modelPlatform} onChange={(event) => updateModelConfig("modelPlatform", event.target.value)} placeholder="火山引擎 Ark" />
                  </label>
                  <label>
                    <span>API Key</span>
                    <input type="password" value={modelConfig.apiKey} onChange={(event) => updateModelConfig("apiKey", event.target.value)} placeholder="只保存在本机" />
                  </label>
                  <details className="advanced-model-settings">
                    <summary>高级连接信息</summary>
                    <p>大多数用户不用改这里。只有服务商要求你改模型名称、服务地址或高级向量模型时，再展开填写。</p>
                    <label>
                      <span>模型名称</span>
                      <input value={modelConfig.modelId} onChange={(event) => updateModelConfig("modelId", event.target.value)} placeholder="可保持默认" />
                    </label>
                    <label>
                      <span>服务地址</span>
                      <input value={modelConfig.baseUrl} onChange={(event) => updateModelConfig("baseUrl", event.target.value)} placeholder="可保持默认" />
                    </label>
                    <label className="checkbox-line">
                      <input type="checkbox" checked={modelConfig.useSeparateEmbedding} onChange={(event) => updateModelConfig("useSeparateEmbedding", event.target.checked)} />
                      <span>我需要单独填写高级向量模型</span>
                    </label>
                    {modelConfig.useSeparateEmbedding && (
                      <div className="embedding-config-grid">
                        <label>
                          <span>高级向量服务商</span>
                          <input value={modelConfig.embeddingModelPlatform} onChange={(event) => updateModelConfig("embeddingModelPlatform", event.target.value)} placeholder="火山引擎 Ark" />
                        </label>
                        <label>
                          <span>高级向量模型 / ID</span>
                          <input value={modelConfig.embeddingModelId} onChange={(event) => updateModelConfig("embeddingModelId", event.target.value)} placeholder="doubao-embedding-vision" />
                        </label>
                        <label>
                          <span>高级向量服务地址</span>
                          <input value={modelConfig.embeddingBaseUrl} onChange={(event) => updateModelConfig("embeddingBaseUrl", event.target.value)} placeholder="https://..." />
                        </label>
                        <label>
                          <span>高级向量 API Key</span>
                          <input type="password" value={modelConfig.embeddingApiKey} onChange={(event) => updateModelConfig("embeddingApiKey", event.target.value)} placeholder="只保存在本机" />
                        </label>
                      </div>
                    )}
                  </details>
                  <div className="desktop-action-row">
                    <button className="secondary" onClick={testModelConfig} disabled={!isDesktopRuntime || savingModel}>
                      {savingModel ? "检查中" : "检查配置"}
                    </button>
                    <button className="primary" onClick={saveModelConfigForScan} disabled={!isDesktopRuntime || savingModel}>
                      保存配置，继续查找
                    </button>
                  </div>
                  <small>这里不会发起模型调用，只准备把配置保存到本机记录来源。</small>
                  <details className="technical-note">
                    <summary>高级说明</summary>
                    <small>高级说明：本机记录组件的底层项目名是 MineContext。普通使用时不需要理解这个名字。</small>
                  </details>
                </div>

                <div className="model-config-panel">
                  <div className="section-title compact-title">
                    <div>
                      <p className="eyebrow">本机记录组件</p>
                      <h3>查找本机记录组件</h3>
                    </div>
                  </div>
                  <p className="policy-note">查找只检查安装位置和运行状态，不读取活动标题、URL、截图或原始记录。</p>
                  <div className="local-setup-status">
                    <StatusItem label="查找结果" value={mineContextScan?.found ? `找到 ${mineContextScan?.candidates?.length ?? 0} 个线索` : "待扫描"} />
                    <StatusItem label="连接状态" value={mineContextStatus?.reachable ? "可连接" : "未连接"} />
                    <StatusItem label="保存配置" value={mineContextStatus?.configured ? "已完成" : "待确认"} />
                  </div>
                  <div className="desktop-action-row">
                    <button className="secondary" onClick={scanMineContext} disabled={checkingMineContext || !modelReady} title={!modelReady ? "请先保存智能整理" : undefined}>
                      {checkingMineContext ? "查找中" : "查找本机记录组件"}
                    </button>
                    <button className="secondary" onClick={startMineContext} disabled={checkingMineContext || !modelReady} title={!modelReady ? "请先保存智能整理" : undefined}>
                      启动并连接
                    </button>
                    <button className="secondary" onClick={downloadAndInstallMineContext} disabled={checkingMineContext || !modelReady} title={!modelReady ? "请先保存智能整理" : undefined}>
                      自动安装
                    </button>
                    <button className="secondary" onClick={openMineContextDownloadPage}>
                      手动安装
                    </button>
                    <button className="secondary" onClick={chooseInstaller}>
                      选择安装包
                    </button>
                    <button className="primary" onClick={applyModelConfig} disabled={savingModel || !modelReady || !mineContextStatus?.reachable} title={!modelReady ? "请先保存智能整理" : !mineContextStatus?.reachable ? "请先连接本机记录组件" : undefined}>
                      {savingModel ? "写入中" : "保存到本机记录组件并完成"}
                    </button>
                  </div>
                  <small>如果没有找到本机记录组件，自动安装会先请求确认，再从官方 Releases 下载最新安装包。无法识别安装包时会转为手动安装。</small>
                </div>

                <div className="model-config-panel local-preview-panel">
                  <div className="section-title compact-title">
                    <div>
                      <p className="eyebrow">授权前预览</p>
                      <h3>先看将读取什么，再决定是否开始</h3>
                    </div>
                  </div>
                  <p className="policy-note">这一步只显示聚合信息。确认前不会导入真实活动，不显示窗口标题、URL、截图路径或原始内容。</p>
                  <div className="local-setup-status preview-status-grid">
                    <StatusItem label="时间范围" value="今天 / 最近 24 小时" />
                    <StatusItem label="记录数量" value={mineContextStatus?.reachable ? "连接后计算" : "连接后显示"} />
                    <StatusItem label="数据类型" value="时间片段 / 应用使用 / 摘要线索" />
                    <StatusItem label="写入状态" value="确认前不写入" />
                  </div>
                  <div className="first-use-result-card">
                    <span className="privacy-chip">第一份今日整理预览</span>
                    <strong>完成连接后，OpenButler 会先给你一张今日整理主卡。</strong>
                    <p>它会说明今天整理了什么、哪条最值得先看、依据来自哪里，以及哪些结论还不能确认。记录不足时，会告诉你下一步怎么补齐，而不是显示空控制台。</p>
                  </div>
                </div>
              </>
            )}
            {setupMessage && <p className="policy-note">{setupMessage}</p>}
          </div>
        )}

        <div className="first-run-preview" aria-label="OpenButler 整理结果示例">
          <span className="privacy-chip">样例体验</span>
          <strong>授权后，你会得到什么</strong>
          <p>本地模式只在你的电脑上运行。默认只读、不开外部模型、不复制本地截图。</p>
          <div>
            {previewItems.map((item) => (
              <article key={`${item.time}-${item.title}`}>
                <time>{item.time}</time>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.source}</span>
                </div>
              </article>
            ))}
          </div>
          <small>样例只用于说明产品效果，不代表你的真实生活记录。</small>
          <button className="secondary light-on-dark" onClick={onChooseDemo}>先看样例</button>
        </div>

        {!mandatory && <button className="first-run-close" onClick={onDismiss}>关闭</button>}
      </section>
    </div>
  );
}

function Privacy({
  mode,
  onChange,
  plugins,
  activationStatus,
  onOpenGuide
}: {
  mode: PrivacyMode;
  onChange: (mode: PrivacyMode) => void;
  plugins: PluginManifest[];
  activationStatus: ActivationStatus;
  onOpenGuide: () => void;
}) {
  const blocked = plugins.filter((plugin) => !plugin.runtime.available).length;
  const [desktopStatus, setDesktopStatus] = useState<Record<string, any> | null>(null);
  const [mineContextStatus, setMineContextStatus] = useState<Record<string, any> | null>(null);
  const [desktopStatusError, setDesktopStatusError] = useState<string | null>(null);
  const isDesktopRuntime = typeof window !== "undefined" && !!window.openbutlerDesktop;

  async function refreshDesktopStatus() {
    const payload = await getDesktopStatus();
    setDesktopStatus(payload);
    if (window.openbutlerDesktop) {
      setMineContextStatus(await window.openbutlerDesktop.getMineContextStatus());
    }
    setDesktopStatusError(null);
  }

  useEffect(() => {
    let mounted = true;
    void refreshDesktopStatus()
      .then(() => {
        if (mounted) {
          setDesktopStatusError(null);
        }
      })
      .catch(() => {
        if (mounted) {
          setDesktopStatus(null);
          setDesktopStatusError("当前页面还没有连接本机桌面服务。");
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function restartDesktopBackend() {
    if (!window.openbutlerDesktop) return;
    await window.openbutlerDesktop.restartBackend();
    await refreshDesktopStatus();
  }

  async function chooseMineContextHome() {
    if (!window.openbutlerDesktop) return;
    await window.openbutlerDesktop.chooseMineContextHome();
    await refreshDesktopStatus();
  }

  async function openDesktopDataFolder() {
    await window.openbutlerDesktop?.openDataFolder();
  }


  function openPageFromSettings(key: PageKey) {
    replaceAppPath(routeForPage(key));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const localModeChecks = [
    {
      label: "本机服务",
      value: desktopStatus?.service?.running ? "运行中" : isDesktopRuntime ? "启动中" : "网页样例",
    },
    {
      label: "严格隐私",
      value: desktopStatus?.privacy?.strict ? "已开启" : mode === "strict" ? "已开启" : "未开启",
    },
    {
      label: "样例数据",
      value: desktopStatus?.privacy?.seed_events_disabled ? "已关闭" : isDesktopRuntime ? "待确认" : "样例可用",
    },
    {
      label: "截图复制",
      value: desktopStatus?.privacy?.copy_screenshots ? "已开启" : "未开启",
    },
    {
      label: "外部模型",
      value: desktopStatus?.privacy?.external_model_allowed ? "已允许" : "未允许",
    },
    {
      label: "本地线索",
      value: desktopStatus?.data_sources?.minecontext?.configured ? "已选择" : "未选择",
    },
    {
      label: "本机记录组件",
      value: mineContextStatus?.reachable ? "运行中" : isDesktopRuntime ? "未检测到" : "网页样例",
    },
    {
      label: "智能整理",
      value: mineContextStatus?.configured || desktopStatus?.data_sources?.minecontext?.model_configured ? "已完成" : "待配置",
    },
  ];

  return (
    <div className="me-page">
      <section className="today-panel local-service-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">我的 OpenButler</p>
            <h2>{isDesktopRuntime ? "本地完全体检查" : "当前可继续样例，也可以切到本地完全体"}</h2>
            <p>
              {isDesktopRuntime
                ? "本地版会在你的电脑上运行。你确认前不会导入真实活动。"
                : "网页版本只展示产品效果。要整理真实本机记录，需要安装并启动本地版。"}
            </p>
          </div>
          <span className="privacy-chip">{isDesktopRuntime ? "本地模式" : "样例体验"}</span>
        </div>
        <div className="activation-status-grid">
          {localModeChecks.map((item) => (
            <StatusItem key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
        {desktopStatusError && <p className="policy-note">{desktopStatusError}</p>}
        {isDesktopRuntime && (
          <div className="desktop-action-row">
            <button className="secondary" onClick={chooseMineContextHome}>选择本机记录目录</button>
            <button className="secondary" onClick={restartDesktopBackend}>重新启动本机服务</button>
            <button className="secondary" onClick={refreshDesktopStatus}>重新检测</button>
            <button className="secondary" onClick={openDesktopDataFolder}>打开本地数据文件夹</button>
          </div>
        )}
      </section>

      <section className="today-panel activation-settings-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">开始设置</p>
            <h2>当前状态：{activationStatusLabel(activationStatus)}</h2>
            <p>
              样例体验只展示产品效果；真实本地模式需要你在本机运行，并主动授权要读取的线索。
              你可以随时重新打开引导，确认授权后会得到什么。
            </p>
          </div>
          <button className="secondary" onClick={onOpenGuide}>重新选择开始方式</button>
        </div>
        <div className="activation-status-grid">
          <StatusItem label="样例体验" value={activationStatus === "demo_selected" ? "已选择" : "可查看"} />
          <StatusItem label="真实本地模式" value={activationStatus === "real_setup_started" || activationStatus === "completed" ? "待授权" : "未开始"} />
          <StatusItem label="授权后得到" value="概览/提醒/依据" />
          <StatusItem label="真实数据读取" value="需授权" />
        </div>
        <p className="policy-note">线上版本不会读取你的真实本机活动。真实模式需要在你的电脑上启动本地版，并由你确认授权范围。</p>
      </section>

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
            <span>只在你明确同意时使用联网能力。</span>
          </button>
          <button className={mode === "strict" ? "selected" : ""} onClick={() => onChange("strict")}>
            <CloudOff size={20} />
            <strong>只在本机整理</strong>
            <span>不会把你的数据发给外部服务。</span>
          </button>
        </div>
        <p className="policy-note">当前有 {blocked} 项联网能力已暂停，避免未经确认的数据外发。</p>
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

      <section className="today-panel">
        <div className="section-title">
          <div>
            <h2>产品引导</h2>
            <p>重新看一遍 OpenButler 会如何整理线索、提醒重点并保留依据。</p>
          </div>
          <button className="secondary" onClick={onOpenGuide}>重新查看产品引导</button>
        </div>
      </section>

      <details className="advanced-lab-panel" id="advanced-lab-entry">
        <summary>高级与实验室</summary>
        <div className="advanced-lab-grid">
          {advancedNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className="secondary"
                key={item.key}
                onClick={() => openPageFromSettings(item.key)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
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
