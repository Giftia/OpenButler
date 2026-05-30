import {eventTypeLabel, isDemoLike, sourceLabel, userFacingDemoText} from "./userFacingLabels";

export type TimelineThumbnail = {
  kind: "image" | "placeholder" | "source-icon";
  url?: string;
  alt: string;
  privacyLabel?: string;
  tone: string;
};

export type TimelineMoment = {
  id: string;
  icon: string;
  title: string;
  date: string;
  time: string;
  startedAt: string;
  category: string;
  summary: string;
  valueTag: string;
  sourceLabel: string;
  sourceKey: string;
  eventKey: string;
  eventLabel: string;
  confidenceLabel: string;
  evidenceAvailable: boolean;
  evidenceBoundary: string;
  thumbnail: TimelineThumbnail;
  details: Record<string, unknown>;
};

function formatDate(value: unknown): string {
  const date = new Date(String(value ?? Date.now()));
  if (Number.isNaN(date.getTime())) return "今天";
  return new Intl.DateTimeFormat("zh-CN", {year: "numeric", month: "long", day: "numeric"}).format(date);
}

function formatTime(value: unknown): string {
  const date = new Date(String(value ?? Date.now()));
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit"}).format(date);
}

function friendlyTitle(event: Record<string, any>): string {
  const type = String(event.event_type ?? "");
  if (isDemoLike(event)) {
    const title = String(event.title ?? "").toLowerCase();
    if (title.includes("inbox")) return "一个提醒被整理出来";
    if (title.includes("verification") || title.includes("terminal")) return "一次本地验证被记录了";
    if (title.includes("coding") || title.includes("vscode")) return "一段专注被记住了";
    if (title.includes("docs") || title.includes("chrome")) return "一次产品回看被记录了";
  }
  if (type === "focus_block") return "一段专注被记住了";
  if (type === "context_switch") return "有一段切换值得注意";
  if (type === "workflow_candidate") return "一个流程可能值得自动化";
  if (type === "daily_overview") return "今天被整理成了概览";
  if (type === "data_quality_notice") return "有些数据还不完整";
  if (type === "achievement") return "一个小成就被记录了";
  return String(event.title ?? eventTypeLabel(type));
}

function categoryFor(event: Record<string, any>): string {
  const type = String(event.event_type ?? "");
  const source = String(event.source ?? "");
  if (type.includes("workflow")) return "自动化";
  if (type.includes("achievement")) return "成就";
  if (type.includes("notice") || type.includes("warning")) return "提醒";
  if (source.includes("workstation")) return "生活节律";
  if (source.includes("pc") || source.includes("minecontext")) return "工作";
  return "生活";
}

function iconFor(category: string): string {
  return {
    工作: "focus",
    生活: "life",
    家庭: "home",
    资产: "asset",
    自动化: "auto",
    提醒: "notice",
    成就: "win",
    生活节律: "rhythm",
  }[category] ?? "note";
}

function sourceKeyFor(event: Record<string, any>): string {
  const source = String(event.source ?? event.source_type ?? "").toLowerCase();
  const refs = JSON.stringify(event.evidence_refs ?? "").toLowerCase();
  if (source.includes("godview")) return "godview";
  if (source.includes("minecontext") || source.includes("pc_activity")) return "pc_activity";
  if (source.includes("phone") || source.includes("album") || refs.includes("phone_album")) return "phone_album";
  if (source.includes("workstation") || source.includes("vision")) return "workstation_vision";
  if (source.includes("manual")) return "manual";
  if (source.includes("butler") || source.includes("rule") || source.includes("timeline")) return "butler_core";
  if (source.includes("system")) return "system";
  return "butler_core";
}

function eventKeyFor(event: Record<string, any>): string {
  const type = String(event.event_type ?? "").toLowerCase();
  const title = String(event.title ?? "").toLowerCase();
  const summary = String(event.summary ?? "").toLowerCase();
  const text = `${type} ${title} ${summary}`;
  if (type === "focus_block" || title.includes("coding") || title.includes("专注")) return "focus_block";
  if (type === "context_switch" || text.includes("switch") || text.includes("切换")) return "context_switch";
  if (type === "workflow_candidate" || text.includes("workflow") || text.includes("自动化")) return "workflow_candidate";
  if (type === "object_location" || text.includes("key") || text.includes("钥匙")) return "object_location";
  if (type === "lighting_context" || text.includes("lighting") || text.includes("光照")) return "lighting_context";
  if (type === "security_event" || type === "motion_detected" || type === "presence_detected") return "security_event";
  if (type === "achievement" || text.includes("成就")) return "achievement";
  if (type === "data_quality_notice" || text.includes("数据")) return "data_quality_notice";
  if (type === "daily_overview" || type.includes("insight") || text.includes("提醒")) return "insight";
  if (type === "pc_activity") return "pc_activity";
  return type || "pc_activity";
}

export function timelineSourceLabel(key: string): string {
  return {
    all: "全部来源",
    pc_activity: "电脑活动",
    godview: "本机回溯",
    phone_album: "相册线索",
    workstation_vision: "工位观察",
    butler_core: "管家整理",
    manual: "手动记录",
    system: "系统",
  }[key] ?? "本地记录";
}

export function timelineEventLabel(key: string): string {
  return {
    all: "全部事件",
    pc_activity: "电脑活动",
    focus_block: "专注时段",
    context_switch: "切换较多",
    insight: "管家提醒",
    daily_overview: "管家提醒",
    workflow_candidate: "可自动化流程",
    object_location: "物品位置",
    lighting_context: "光照状态",
    security_event: "安防事件",
    achievement: "成就记录",
    data_quality_notice: "数据状态",
  }[key] ?? eventTypeLabel(key);
}

function isSafeImageUrl(value: unknown): value is string {
  const url = String(value ?? "").trim();
  if (!url) return false;
  if (/^[a-zA-Z]:\\/.test(url) || url.includes("\\screenshots\\") || url.includes("/screenshots/")) return false;
  return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("/assets/");
}

function findImageUrl(input: unknown): string | undefined {
  if (!input) return undefined;
  if (isSafeImageUrl(input)) return String(input);
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findImageUrl(item);
      if (found) return found;
    }
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    return findImageUrl(record.thumbnail_url)
      ?? findImageUrl(record.thumbnailUrl)
      ?? findImageUrl(record.url)
      ?? findImageUrl(record.src);
  }
  return undefined;
}

function hasLocalScreenshotReference(event: Record<string, any>): boolean {
  const text = JSON.stringify({
    evidence_refs: event.evidence_refs,
    screenshot_paths: event.screenshot_paths,
    raw_frame_ref: event.raw_frame_ref,
    raw_ref: event.raw_ref,
  }).toLowerCase();
  return text.includes("screenshot") || text.includes("\\") || text.includes(".png") || text.includes(".jpg");
}

function thumbnailFor(event: Record<string, any>, sourceKey: string, eventKey: string, title: string): TimelineThumbnail {
  const safeUrl = findImageUrl(event.thumbnail_url)
    ?? findImageUrl(event.thumbnailUrl)
    ?? findImageUrl(event.media_refs)
    ?? findImageUrl(event.evidence_refs);
  const tone = {
    pc_activity: "blue",
    phone_album: "amber",
    workstation_vision: "green",
    butler_core: "teal",
    godview: "violet",
    manual: "slate",
    system: "slate",
  }[sourceKey] ?? "teal";
  if (safeUrl) {
    return {kind: "image", url: safeUrl, alt: `${title} 的依据缩略图`, tone, privacyLabel: "可展示图片"};
  }
  if (hasLocalScreenshotReference(event)) {
    return {kind: "placeholder", alt: "本地截图依据占位", tone, privacyLabel: "有本地截图依据"};
  }
  const demo = isDemoLike(event);
  if (demo || ["object_location", "security_event", "lighting_context"].includes(eventKey)) {
    return {kind: "placeholder", alt: `${title} 的演示缩略图`, tone, privacyLabel: demo ? "演示数据" : "来源占位"};
  }
  return {kind: "source-icon", alt: `${timelineSourceLabel(sourceKey)}来源占位`, tone, privacyLabel: timelineSourceLabel(sourceKey)};
}

export function toTimelineMoment(event: Record<string, any>): TimelineMoment {
  const durationSeconds = Number(event.duration_seconds ?? event.metrics?.duration_seconds ?? 0);
  const valueTag = durationSeconds > 0 ? `${Math.round(durationSeconds / 60)} 分钟` : eventTypeLabel(event.event_type);
  const confidence = Math.round(Number(event.confidence ?? 0) * 100);
  const refs = Array.isArray(event.evidence_refs) ? event.evidence_refs : [];
  const category = categoryFor(event);
  const demo = isDemoLike(event);
  const title = friendlyTitle(event);
  const sourceKey = sourceKeyFor(event);
  const eventKey = eventKeyFor(event);
  return {
    id: String(event.id ?? `${event.started_at}-${event.title}`),
    icon: iconFor(category),
    title,
    date: formatDate(event.started_at),
    time: formatTime(event.started_at),
    startedAt: String(event.started_at ?? new Date().toISOString()),
    category,
    summary: demo
      ? userFacingDemoText(event.title ?? event.summary)
      : userFacingDemoText(event.summary ?? "这条记录来自 OpenButler 已授权的本地时间线。"),
    valueTag,
    sourceLabel: demo ? `${sourceLabel(event.source)} · 演示数据` : sourceLabel(event.source),
    sourceKey,
    eventKey,
    eventLabel: timelineEventLabel(eventKey),
    confidenceLabel: confidence > 0 ? `可信度 ${confidence}%` : "可信度待确认",
    evidenceAvailable: refs.length > 0 || Boolean(event.evidence_boundary),
    evidenceBoundary: userFacingDemoText(event.evidence_boundary ?? "这条记录只代表本地线索，远程系统状态需要回源确认。"),
    thumbnail: thumbnailFor(event, sourceKey, eventKey, title),
    details: event,
  };
}

export function groupTimelineByDate(items: TimelineMoment[]) {
  return items.reduce<Array<{date: string; items: TimelineMoment[]}>>((groups, item) => {
    const last = groups[groups.length - 1];
    if (last?.date === item.date) {
      last.items.push(item);
    } else {
      groups.push({date: item.date, items: [item]});
    }
    return groups;
  }, []);
}
