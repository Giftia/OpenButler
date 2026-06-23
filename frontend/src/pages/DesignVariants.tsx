import {useEffect, useState} from "react";
import {getButlerHome, getButlerTimeline} from "../lib/api";
import {buildTodayHomeViewModel, type ActivationMode} from "../lib/butlerUiAdapter";
import {toTimelineMoment, type TimelineMoment} from "../lib/timelineUiAdapter";

type ActivationStatus = "unseen" | "demo_selected" | "real_setup_started" | "dismissed" | "completed";
type DesignVariant = "mijia" | "ios" | "deck";

const designVariantMeta: Record<DesignVariant, {title: string; subtitle: string; route: string; badge: string}> = {
  mijia: {
    title: "米家式状态中控",
    subtitle: "用大卡片和场景信号回答：今天发生了什么，哪件事该先看。",
    route: "/design/mijia",
    badge: "状态优先",
  },
  ios: {
    title: "iOS Home 式私人管家",
    subtitle: "更克制的卡片、底部行动和自然语言，适合长期日常使用。",
    route: "/design/ios",
    badge: "日常使用",
  },
  deck: {
    title: "大屏 PPT 式汇报版",
    subtitle: "高信息密度、强数据叙事，适合产品演示和商业评估。",
    route: "/design/deck",
    badge: "演示汇报",
  },
};

const designSampleEvents = [
  {
    id: "design-demo-object-location",
    source: "phone_album_demo",
    event_type: "object_location",
    title: "钥匙可能在玄关托盘附近",
    summary: "样例线索显示钥匙最后出现在玄关左侧托盘。你可以查看依据，理解管家如何说明不确定性。",
    started_at: new Date().toISOString(),
    confidence: 0.78,
    evidence_boundary: "这是样例数据，只用于展示物品回溯体验；不代表你的真实相册或本机记录。",
    evidence_refs: [{source: "phone_album_demo", evidence_level: "demo_reference"}],
    evidence_notes: ["09:22 的样例相册线索", "画面里出现玄关左侧托盘", "因此只说“可能在附近”"],
  },
  {
    id: "design-demo-follow-up",
    source: "butler_demo",
    event_type: "insight",
    title: "会议后有一项待办适合收尾",
    summary: "样例提醒显示一条会议后事项适合回看确认。OpenButler 不会替你判断远程任务状态。",
    started_at: new Date().toISOString(),
    confidence: 0.72,
    evidence_boundary: "这是样例数据，用于展示提醒和依据说明；真实模式需要你在本机运行并主动授权。",
    evidence_refs: [{source: "butler_demo", evidence_level: "demo_reference"}],
    evidence_notes: ["14:10 的样例会议后记录", "同一事项今天没有收尾记录", "远程任务状态仍需回原系统确认"],
  },
  {
    id: "design-demo-rest-rhythm",
    source: "workstation_demo",
    event_type: "lighting_context",
    title: "可以安排 5 分钟活动一下",
    summary: "样例节律显示你已经连续坐了一段时间，适合短暂活动肩颈或补充光照。",
    started_at: new Date().toISOString(),
    confidence: 0.7,
    evidence_boundary: "这是样例数据，只说明 OpenButler 如何给出温和建议；不代表医学或心理判断。",
    evidence_refs: [{source: "workstation_demo", evidence_level: "demo_reference"}],
    evidence_notes: ["16:40 的样例节律片段", "连续坐着超过一段时间", "只给活动建议，不做健康判断"],
  },
];

function navigateClient(path: string) {
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function scrollToDesignSection(selector: string) {
  document.querySelector(selector)?.scrollIntoView({behavior: "smooth", block: "start"});
}

function activationModeForDesign(status: ActivationStatus): ActivationMode {
  if (status === "demo_selected") return "demo";
  if (status === "real_setup_started" || status === "completed") return "real_local";
  return "demo";
}

function useDesignConceptView(activationStatus: ActivationStatus) {
  const [home, setHome] = useState<Record<string, any> | null>(null);
  const [timelineItems, setTimelineItems] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [homeResult, timelineResult] = await Promise.all([getButlerHome(), getButlerTimeline()]);
        if (!mounted) return;
        setHome(homeResult);
        setTimelineItems(timelineResult.items ?? []);
      } catch {
        if (!mounted) return;
        setHome(null);
        setTimelineItems([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const view = buildTodayHomeViewModel(home, timelineItems, activationModeForDesign(activationStatus));
  const moments = designSampleEvents.slice(0, 6).map(toTimelineMoment);
  return {view, moments, loading};
}

function DesignSwitcher({active}: {active?: DesignVariant}) {
  return (
    <div className="design-switcher" aria-label="设计版本切换">
      {(Object.keys(designVariantMeta) as DesignVariant[]).map((key) => {
        const item = designVariantMeta[key];
        return (
          <button key={key} className={active === key ? "active" : ""} onClick={() => navigateClient(item.route)}>
            <span>{item.badge}</span>
            <strong>{item.title}</strong>
          </button>
        );
      })}
    </div>
  );
}

function DesignVariantFooter({active}: {active?: DesignVariant}) {
  return (
    <details className="design-variant-footer">
      <summary>切换设计版本</summary>
      <DesignSwitcher active={active} />
    </details>
  );
}

function SetupPathPanel({compact = false}: {compact?: boolean}) {
  return (
    <section className={compact ? "setup-path-panel compact" : "setup-path-panel"} aria-label="从样例到本地模式">
      <div>
        <span>怎么开始真实使用</span>
        <strong>先看样例，再用桌面版整理你的本机记录。</strong>
        <p>网页只展示样例。真实使用需要打开桌面版、创建智能整理钥匙，再选择你愿意授权的本机记录。</p>
        <div className="setup-path-actions">
          <a className="primary setup-download-link" href="https://github.com/Giftia/OpenButler/releases" target="_blank" rel="noreferrer">获取桌面版</a>
          <button className="secondary" onClick={() => scrollToDesignSection("[data-design-sample-records]")}>先看本页样例</button>
        </div>
      </div>
      <ol>
        <li><b>1</b><span>先看样例</span></li>
        <li><b>2</b><span>打开桌面版</span></li>
        <li><b>3</b><span>创建智能整理钥匙</span></li>
        <li><b>4</b><span>授权本机记录</span></li>
      </ol>
      <div className="setup-preview-mini" aria-label="桌面版配置预览">
        <strong>桌面版里会继续带你完成</strong>
        <span>填写智能整理钥匙</span>
        <span>扫描本机记录组件</span>
        <span>预览会读取什么</span>
        <span>确认后开始整理今天</span>
      </div>
      <details>
        <summary>本机记录和智能整理钥匙是什么？</summary>
        <p>本机记录包括你主动授权的电脑活动、时间线片段，以及以后单独开启的相册或工位线索；不会默认读取聊天、密码、文件内容或截图原图。智能整理钥匙也叫 API Key，通常在你选择的模型服务商控制台创建。它让桌面版能把授权记录整理成摘要和提醒；是否产生费用取决于服务商账户。真实模式会先预览会读取什么，确认前不会开始整理。</p>
      </details>
    </section>
  );
}
export function DesignLabPage() {
  return (
    <section className="design-lab-page">
      <div className="design-lab-hero">
        <p className="eyebrow">设计实验室</p>
        <h1>同一套能力，先试三种产品气质</h1>
        <p>这里不改后端，也不读取真实数据。三套界面都用现有今日、时间线和提醒数据，用来判断普通用户最容易看懂哪一种。</p>
      </div>
      <SetupPathPanel compact />
      <div className="design-lab-grid">
        {(Object.keys(designVariantMeta) as DesignVariant[]).map((key) => {
          const item = designVariantMeta[key];
          return (
            <article className={`design-lab-card ${key}`} key={key}>
              <span>{item.badge}</span>
              <h2>{item.title}</h2>
              <p>{item.subtitle}</p>
              <button className="primary" onClick={() => navigateClient(item.route)}>体验这个版本</button>
            </article>
          );
        })}
      </div>
      <div className="design-lab-note">
        <strong>评估标准</strong>
        <span>不看技术栈，只看新用户能否在 30 秒内明白：这是什么、对我有什么用、下一步该点哪里。</span>
      </div>
    </section>
  );
}

export function DesignConceptPage({variant, activationStatus}: {variant: DesignVariant; activationStatus: ActivationStatus}) {
  const {view, moments, loading} = useDesignConceptView(activationStatus);
  if (variant === "mijia") return <MijiaConcept view={view} moments={moments} loading={loading} />;
  if (variant === "ios") return <IosConcept view={view} moments={moments} loading={loading} />;
  return <DeckConcept view={view} moments={moments} loading={loading} />;
}

function MijiaConcept({view, moments, loading}: {view: ReturnType<typeof buildTodayHomeViewModel>; moments: TimelineMoment[]; loading: boolean}) {
  const command = view.commandCenter;
  return (
    <section className="concept-page concept-mijia">
      <div className="mijia-topbar">
        <div>
          <p>OpenButler</p>
          <h1>今天</h1>
        </div>
        <span>{command.privacyHint}</span>
      </div>
      <div className="mijia-product-note">
        <strong>这是一个私人管家中控。</strong>
        <span>它把你授权的本地线索整理成今日重点、生活记录和可查看的依据。样例体验不会读取真实数据。</span>
      </div>
      <SetupPathPanel />
      <div className="mijia-hero-card">
        <div>
          <span>{command.dataMode === "sample" ? "样例体验" : "本地整理"}</span>
          <h2>{command.headline}</h2>
          <p>{command.oneLineStatus}</p>
          <button className="primary" onClick={() => navigateClient("/butler")}>{command.primaryAction}</button>
        </div>
        <article>
          <small>建议先看</small>
          <strong>{command.topSuggestion?.title ?? "先看样例"}</strong>
          <p>{command.topSuggestion?.summary ?? "用一组样例先了解今日概览、时间线和依据。"}</p>
        </article>
      </div>
      <div className="mijia-action-strip" aria-label="快速开始">
        <button className="active" onClick={() => navigateClient("/butler")}>看今天重点</button>
        <button onClick={() => navigateClient("/timeline")}>查看生活记录</button>
        <button onClick={() => navigateClient("/me")}>了解本地模式</button>
      </div>
      <div className="mijia-room-tabs"><button className="active">全部</button><button>工作</button><button>生活</button><button>家庭</button></div>
      <div className="mijia-tile-grid">
        {view.sceneCards.map((card) => <article key={card.title} className={`mijia-tile tone-${card.tone}`}><span>{card.title}</span><strong>{card.value}</strong><small>{card.description}</small></article>)}
      </div>
      <div className="mijia-list-panel" data-design-sample-records>
        <div className="section-title"><h2>最近记录</h2><button className="ghost" onClick={() => navigateClient("/timeline")}>全部</button></div>
        {moments.slice(0, 4).map((moment) => <ConceptEventRow key={moment.id} moment={moment} />)}
      </div>
      <DesignVariantFooter active="mijia" />
      {loading && <p className="concept-loading">正在读取当前样例状态...</p>}
    </section>
  );
}

function IosConcept({view, moments, loading, formal = false}: {view: ReturnType<typeof buildTodayHomeViewModel>; moments: TimelineMoment[]; loading: boolean; formal?: boolean}) {
  const command = view.commandCenter;
  return (
    <section className={formal ? "concept-page concept-ios formal-butler-home" : "concept-page concept-ios"}>
      <div className="ios-header">
        <span>{command.privacyHint}</span>
        <h1>今天先看这几件事</h1>
        <p>{command.oneLineStatus}</p>
      </div>
      <div className="ios-card-stack">
        <article className="ios-main-card">
          <small>今日摘要</small>
          <strong>{command.headline}</strong>
          <button className="primary" onClick={() => scrollToDesignSection("[data-design-sample-records]")}>{formal ? "看今天记录" : command.primaryAction}</button>
        </article>
        <article className="ios-suggestion-card">
          <small>下一步</small>
          <strong>{command.topSuggestion?.title ?? "先浏览样例"}</strong>
          <p>{command.topSuggestion?.summary ?? "样例不会读取你的真实数据。"}</p>
        </article>
      </div>
      <div className="ios-number-row">
        {command.keyNumbers.map((item) => <article key={item.label}><strong>{item.value}</strong><span>{item.label}</span><small>{item.description}</small></article>)}
      </div>
      {formal && <SetupPathPanel compact />}
      <section className="ios-event-sheet" data-design-sample-records>
        <div className="section-title"><h2>今天留下的记录</h2><button className="ghost" onClick={() => navigateClient("/timeline")}>查看时间线</button></div>
        {moments.slice(0, 5).map((moment) => <ConceptEventRow key={moment.id} moment={moment} compact />)}
      </section>
      {!formal && <DesignVariantFooter active="ios" />}
      {loading && <p className="concept-loading">正在整理...</p>}
    </section>
  );
}


export function FormalButlerHome({activationStatus}: {activationStatus: ActivationStatus}) {
  const {view, moments, loading} = useDesignConceptView(activationStatus);
  return <IosConcept view={view} moments={moments} loading={loading} formal />;
}
function DeckConcept({view, moments, loading}: {view: ReturnType<typeof buildTodayHomeViewModel>; moments: TimelineMoment[]; loading: boolean}) {
  const command = view.commandCenter;
  return (
    <section className="concept-page concept-deck">
      <div className="deck-hero">
        <div>
          <p>OPENBUTLER / 概念汇报</p>
          <h1>{command.headline}</h1>
        </div>
        <strong>{command.keyNumbers[0]?.value ?? "4 条"}</strong>
      </div>
      <SetupPathPanel compact />
      <div className="deck-grid">
        <article className="deck-statement">
          <span>核心判断</span>
          <h2>{command.oneLineStatus}</h2>
          <button className="primary" onClick={() => navigateClient("/butler")}>{command.primaryAction}</button>
        </article>
        {command.keyNumbers.map((item) => <article className="deck-metric" key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.description}</small></article>)}
      </div>
      <div className="deck-evidence-wall" data-design-sample-records>
        <div>
          <span>事件流</span>
          <h2>这些片段构成今天的依据</h2>
        </div>
        <div>
          {moments.slice(0, 4).map((moment) => <ConceptEventRow key={moment.id} moment={moment} />)}
        </div>
      </div>
      <DesignVariantFooter active="deck" />
      {loading && <p className="concept-loading">正在载入样例内容...</p>}
    </section>
  );
}

function evidenceNotesFor(moment: TimelineMoment): string[] {
  const notes = moment.details?.evidence_notes;
  if (Array.isArray(notes) && notes.length) return notes.map((item) => String(item));
  if (moment.eventKey === "object_location") return ["样例相册线索", "出现玄关托盘", "只给可能位置"];
  if (moment.eventKey === "lighting_context") return ["样例节律片段", "连续坐着一段时间", "建议短暂活动"];
  if (moment.eventKey === "insight") return ["样例提醒", "有待确认事项", "需要你决定是否处理"];
  return ["本地时间线片段", "来源可查看", "结论保留边界"];
}

function ConceptEventRow({moment, compact = false}: {moment: TimelineMoment; compact?: boolean}) {
  return (
    <article className={compact ? "concept-event compact" : "concept-event"}>
      <time>{moment.time}</time>
      <div>
        <strong>{moment.title}</strong>
        <p>{moment.summary}</p>
        <span>{moment.sourceLabel} · {moment.stateLabel}</span>
      </div>
      <div className={`concept-thumb tone-${moment.thumbnail.tone}`} aria-label={moment.thumbnail.alt}>
        {moment.thumbnail.kind === "image" && moment.thumbnail.url ? <img src={moment.thumbnail.url} alt={moment.thumbnail.alt} /> : <span>{moment.eventLabel.slice(0, 2)}</span>}
      </div>
      <details className="concept-evidence">
        <summary>查看依据</summary>
        <div>
          <span>来源：{moment.sourceLabel}</span>
          <span>证据片段：{evidenceNotesFor(moment).join("；")}</span>
          <span>可信度：{moment.confidenceLabel}</span>
          <span>边界：{moment.evidenceBoundary}</span>
          <span>隐私：未上传数据，未显示本地路径。{moment.thumbnail.privacyLabel ? ` ${moment.thumbnail.privacyLabel}` : ""}</span>
        </div>
      </details>
    </article>
  );
}
