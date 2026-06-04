import {insightTypeLabel, userFacingDemoText} from "./userFacingLabels";

export type InboxDecisionState = "pending" | "later" | "done" | "inaccurate";

export type InboxDecisionCard = {
  id: string;
  title: string;
  summary: string;
  type: string;
  typeLabel: string;
  status: string;
  state: InboxDecisionState;
  stateLabel: string;
  confidence: number;
  priority: number;
  protectedNotice: boolean;
  noiseAdjusted: boolean;
  noiseHint: string | null;
  evidenceBoundary: string;
  raw: Record<string, any>;
};

export const inboxStateLabels: Record<InboxDecisionState, string> = {
  pending: "待确认",
  later: "稍后",
  done: "已处理",
  inaccurate: "不准确",
};

const protectedNoticeTypes = new Set(["data_quality_notice", "privacy_notice"]);

export function inboxStateFor(status: unknown): InboxDecisionState {
  const key = String(status ?? "").trim();
  if (key === "snoozed") return "later";
  if (key === "marked_inaccurate") return "inaccurate";
  if (["dismissed", "accepted", "resolved"].includes(key)) return "done";
  return "pending";
}

export function toInboxDecisionCard(insight: Record<string, any>): InboxDecisionCard {
  const status = String(insight.status ?? "new");
  const type = String(insight.type ?? "daily_overview");
  const state = inboxStateFor(status);
  const adjustment = insight.metrics?.feedback_adjustment ?? {};
  const tooFrequent = Number(adjustment.too_frequent_count ?? 0) > 0;
  const priorityReduction = Number(adjustment.priority_reduction ?? 0);
  const noiseAdjusted = tooFrequent || priorityReduction > 0;
  const protectedNotice = protectedNoticeTypes.has(type);
  return {
    id: String(insight.id),
    title: userFacingDemoText(insight.title ?? insightTypeLabel(type), insightTypeLabel(type)),
    summary: userFacingDemoText(insight.summary ?? "这条提醒需要你确认一下。"),
    type,
    typeLabel: insightTypeLabel(type),
    status,
    state,
    stateLabel: inboxStateLabels[state],
    confidence: Number(insight.confidence ?? 0),
    priority: Number(insight.priority ?? 0),
    protectedNotice,
    noiseAdjusted,
    noiseHint: noiseAdjusted ? "你标记过类似提醒，后面会少出现。" : null,
    evidenceBoundary: userFacingDemoText(insight.evidence_boundary ?? "这条提醒来自本地时间线整理，不能替代原始系统确认。"),
    raw: insight,
  };
}

export function sortInboxCards(cards: InboxDecisionCard[]): InboxDecisionCard[] {
  return [...cards].sort((left, right) => {
    const protectedWeight = Number(left.protectedNotice) - Number(right.protectedNotice);
    if (protectedWeight) return protectedWeight;
    const noiseWeight = Number(left.noiseAdjusted) - Number(right.noiseAdjusted);
    if (noiseWeight) return noiseWeight;
    return right.priority - left.priority;
  });
}

export function inboxCountByState(cards: InboxDecisionCard[]): Record<InboxDecisionState, number> {
  return cards.reduce<Record<InboxDecisionState, number>>(
    (counts, card) => {
      counts[card.state] += 1;
      return counts;
    },
    {pending: 0, later: 0, done: 0, inaccurate: 0}
  );
}
