export const sourceLabels: Record<string, string> = {
  minecontext: "电脑活动",
  godview: "本机回溯",
  pc_activity: "电脑使用",
  butler_core: "管家整理",
  workstation_vision: "工位观察",
  manual: "手动记录",
  seed: "演示数据",
  rule_engine: "管家整理",
  timeline_event: "时间线依据",
  pc_activity_event: "电脑活动（演示）",
};

export const eventTypeLabels: Record<string, string> = {
  pc_activity: "电脑使用",
  focus_block: "专注时段",
  context_switch: "切换较多",
  app_usage: "应用使用",
  domain_usage: "网站使用",
  workflow_candidate: "可自动化流程",
  task_candidate: "待跟进事项",
  break_candidate: "休息提示",
  briefing: "管家简报",
  manual_note: "手动记录",
  data_quality_notice: "数据质量",
  daily_overview: "今日概览",
  achievement: "小成就",
};

export const insightTypeLabels: Record<string, string> = {
  daily_overview: "今日概览",
  focus_summary: "专注总结",
  context_switch_warning: "节奏提醒",
  workflow_candidate: "可自动化流程",
  task_followup: "待跟进事项",
  break_suggestion: "休息建议",
  privacy_notice: "隐私提示",
  data_quality_notice: "数据质量提示",
  achievement: "小成就",
};

export const statusLabels: Record<string, string> = {
  new: "新提醒",
  seen: "已查看",
  accepted: "已采纳",
  dismissed: "已忽略",
  snoozed: "稍后提醒",
  resolved: "已处理",
  marked_inaccurate: "已标记不准确",
};

export function sourceLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  return sourceLabels[key] ?? (key ? "本地记录" : "未知来源");
}

export function eventTypeLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  return eventTypeLabels[key] ?? "时间线事件";
}

export function insightTypeLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  return insightTypeLabels[key] ?? "管家提醒";
}

export function statusLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  return statusLabels[key] ?? "待查看";
}

export function privacyModeLabel(value: unknown): string {
  return value === "strict" ? "完全本地" : "基础隐私";
}

export function isDemoLike(value: unknown): boolean {
  const text = JSON.stringify(value ?? "").toLowerCase();
  return text.includes("demo")
    || text.includes("vercel")
    || text.includes("seed")
    || text.includes("mock")
    || text.includes("fixture")
    || text.includes("vercel-demo");
}

export function userFacingDemoText(value: unknown, fallback = "这是一条演示记录，用来展示 OpenButler 如何整理本地线索。"): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized.includes("check openbutler inbox")) return "查看了管家提醒，并保留了可复核依据。";
  if (normalized.includes("run local verification")) return "完成了一次本地验证，确认演示不会读取真实活动数据。";
  if (normalized.includes("review productization docs")) return "回看了产品化说明，用来整理下一步体验优化。";
  if (normalized.includes("openbutler coding block")) return "有一段较稳定的工作时间，被整理为专注片段。";
  if (normalized.includes("demo-only pc activity") || normalized.includes("not real minecontext")) {
    return fallback;
  }
  return raw
    .replace(/MineContext/g, "电脑活动")
    .replace(/PC 活动/g, "电脑活动")
    .replace(/PC Activity/g, "电脑使用")
    .replace(/evidence_refs/g, "依据")
    .replace(/evidence_boundary/g, "边界说明");
}
