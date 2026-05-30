import {eventTypeLabel, sourceLabel} from "./userFacingLabels";

export type TimelineMoment = {
  id: string;
  icon: string;
  title: string;
  date: string;
  time: string;
  category: string;
  summary: string;
  valueTag: string;
  sourceLabel: string;
  confidenceLabel: string;
  evidenceAvailable: boolean;
  evidenceBoundary: string;
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

export function toTimelineMoment(event: Record<string, any>): TimelineMoment {
  const durationSeconds = Number(event.duration_seconds ?? event.metrics?.duration_seconds ?? 0);
  const valueTag = durationSeconds > 0 ? `${Math.round(durationSeconds / 60)} 分钟` : eventTypeLabel(event.event_type);
  const confidence = Math.round(Number(event.confidence ?? 0) * 100);
  const refs = Array.isArray(event.evidence_refs) ? event.evidence_refs : [];
  const category = categoryFor(event);
  return {
    id: String(event.id ?? `${event.started_at}-${event.title}`),
    icon: iconFor(category),
    title: friendlyTitle(event),
    date: formatDate(event.started_at),
    time: formatTime(event.started_at),
    category,
    summary: String(event.summary ?? "这条记录来自 OpenButler 已授权的本地时间线。"),
    valueTag,
    sourceLabel: sourceLabel(event.source),
    confidenceLabel: confidence > 0 ? `可信度 ${confidence}%` : "可信度待确认",
    evidenceAvailable: refs.length > 0 || Boolean(event.evidence_boundary),
    evidenceBoundary: String(event.evidence_boundary ?? "这条记录只代表本地线索，远程系统状态需要回源确认。"),
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
