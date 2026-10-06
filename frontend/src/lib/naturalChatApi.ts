import {agentRuntimeApi, type AgentRuntimeApi, type RuntimePlannerStatus, type RuntimeSnapshot, type PlannerConfiguration} from "./agentRuntimeApi";

/** This transport is separate from both legacy notes and the selected goal planner. */
export type ConversationSummary = {
  id: string; version: number; status: "active" | "revoked" | "withdrawn";
  route_revision: number; source_version: number; boundary: "synthetic_loopback_only";
};
export type ChatProposal = {
  id: string; version: number; status: "proposed_unverified" | "adopted";
  title: string; target_id: string; success_event_type: string; success_value: unknown;
  deadline_at: string | null; evidence_ids: string[]; adopted_goal_id: string | null;
  plan: {summary: string; steps: string[]};
};
export type InputGoalContext = {id: string; title: string; target_id: string; success_event_type: string; success_value: unknown; status: string; version: number; plan_version: number; deadline_at: string | null; source_ids: string[]; evidence_ids: string[]};
export type NaturalTurn = {
  id: string; request_id: string; conversation_id: string;
  status: "completed" | "failed" | "outcome_unknown" | "withdrawn";
  user_content: string | null; answer: string | null;
  disposition: "answer" | "question" | "proposal" | null; reply_kind: "model" | "clarification" | null; proposal: ChatProposal | null;
  error_code: string | null; goal_id: string | null; expected_goal_version: number | null; retry_after: string | null; retry_of: string | null; created_at: string;
  request_evidence_ids: string[]; evidence_ids: string[]; input_evidence_ids: string[];
  route_revision: number; source_version: number; conversation_version: number; input_goal_contexts: InputGoalContext[];
  citations: {id: string; target_id: string; event_type: string; observed_at: string; trust: "untrusted"}[];
};
export type NaturalConversation = ConversationSummary & {turns: NaturalTurn[]; source_expires_at: string | null; route_configuration: PlannerConfiguration};
export type NaturalChatSnapshot = {planner: RuntimePlannerStatus; runtime: RuntimeSnapshot; conversations: ConversationSummary[]; conversation: NaturalConversation | null};
export type ConversationConsent = {confirmed: true; expected_route_revision: number; expected_source_version: number; expected_version: number | null};
export type NewNaturalTurn = {request_id: string; content: string; goal_id: string | null; expected_goal_version: number | null; expected_version: number; evidence_ids: string[]; retry_of: string | null};
export type AdoptionReceipt = {receipt: {adoption_id: string; proposal_id: string; goal_id: string; state: "completed"}; goal: {id: string}; replayed: boolean};

const PREFIX = "/api/agent-runtime";
const compatible = () => new Error("本机合成对话状态格式不兼容；内容已隐藏，请更新服务后重新读取。");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:\-]{1,100}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(identity) && new Set(value).size === value.length;
const nullableText = (value: unknown, max?: number) => value === null || text(value, max);
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Request interrupted", "AbortError"); }
export class NaturalChatRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null = null) { super(`本机对话服务未确认请求（${status}）`); }
}
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal);
  const method = body === undefined ? "GET" : "POST", serialized = body === undefined ? undefined : JSON.stringify(body);
  const receiptRead = method === "GET" && /^\/conversations\/[^/]+\/(turns|adoptions)\/[^/]+$/.test(path);
  const bridge = window.openbutlerDesktop;
  if (bridge?.requestApi) {
    const result = await bridge.requestApi(`${PREFIX}${path}`, {method, body: serialized});
    checkAbort(signal);
    if (!result.ok) throw new NaturalChatRequestError(result.status, receiptRead && result.status === 404 && result.code === "runtime_item_not_found" ? result.code : null);
    return result.data;
  }
  const base = bridge?.apiBase || import.meta.env.VITE_API_BASE_URL || window.location.origin;
  const url = new URL(`${PREFIX}${path}`, base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("合成对话只能连接本机服务");
  const response = await fetch(url.toString(), {method, body: serialized, signal, headers: {"Content-Type": "application/json"}, redirect: "error", credentials: "same-origin"});
  checkAbort(signal);
  if (!response.ok) {
    let code: string | null = null;
    if (receiptRead && response.status === 404) {
      try {
        const body: unknown = await response.json();
        if (isObject(body) && Object.keys(body).length === 1 && body.detail === "runtime_item_not_found") code = "runtime_item_not_found";
      } catch { /* Unstructured errors cannot prove an absent runtime receipt. */ }
    }
    throw new NaturalChatRequestError(response.status, code);
  }
  return response.json();
}
export function parseConversationSummary(value: unknown): ConversationSummary {
  if (!isObject(value) || !identity(value.id) || !version(value.version) || !["active", "revoked", "withdrawn"].includes(String(value.status)) || !version(value.route_revision) || !version(value.source_version) || value.boundary !== "synthetic_loopback_only") throw compatible();
  return value as ConversationSummary;
}
export function parseNaturalTurn(value: unknown, conversationId: string, requestId?: string): NaturalTurn {
  if (!isObject(value) || !identity(value.id) || !identity(value.request_id) || value.conversation_id !== conversationId || requestId && value.request_id !== requestId ||
      !["completed", "failed", "outcome_unknown", "withdrawn"].includes(String(value.status)) || !nullableText(value.user_content, 2000) || !nullableText(value.answer) ||
      ![null, "answer", "question", "proposal"].includes(value.disposition as null) || ![null, "model", "clarification"].includes(value.reply_kind as null) || !nullableText(value.error_code, 160) ||
      !(value.goal_id === null || identity(value.goal_id)) || !(value.retry_of === null || identity(value.retry_of)) || !nullableText(value.retry_after, 80) || !(value.expected_goal_version === null || version(value.expected_goal_version)) || !ids(value.request_evidence_ids) || value.request_evidence_ids.length > 8 || !text(value.created_at, 80) ||
      !ids(value.evidence_ids) || value.evidence_ids.length > 8 || !ids(value.input_evidence_ids) || !version(value.route_revision) || !version(value.source_version) || !version(value.conversation_version) || !Array.isArray(value.citations) || value.citations.length > 8 || value.citations.some((citation) => !isObject(citation) || !identity(citation.id) || !text(citation.target_id, 200) || !text(citation.event_type, 200) || !text(citation.observed_at, 80) || citation.trust !== "untrusted")) throw compatible();
  if (!Array.isArray(value.input_goal_contexts) || value.input_goal_contexts.length > 100 || value.input_goal_contexts.some((goal) => !isObject(goal) || !identity(goal.id) || !text(goal.title, 300) || !text(goal.target_id, 200) || !text(goal.success_event_type, 200) || !Object.prototype.hasOwnProperty.call(goal, "success_value") || !["candidate", "active", "waiting_external", "paused", "completed", "cancelled"].includes(String(goal.status)) || !version(goal.version) || !version(goal.plan_version) || !nullableText(goal.deadline_at, 80) || !ids(goal.source_ids) || !ids(goal.evidence_ids))) throw compatible();
  if (value.status === "completed" && (value.reply_kind === null || !value.answer || value.reply_kind === "clarification" && (value.disposition !== "question" || value.proposal !== null))) throw compatible();
  if (value.status !== "completed" && (value.answer !== null || value.proposal !== null || value.reply_kind !== null)) throw compatible();
  if (value.status === "withdrawn" && value.user_content !== null) throw compatible();
  if (value.proposal !== null) {
    const proposal = value.proposal;
    if (!isObject(proposal) || !identity(proposal.id) || !version(proposal.version) || !["proposed_unverified", "adopted"].includes(String(proposal.status)) ||
        !text(proposal.title, 300) || !proposal.title.trim() || !text(proposal.target_id, 200) || !text(proposal.success_event_type, 200) ||
        !Object.prototype.hasOwnProperty.call(proposal, "success_value") || !nullableText(proposal.deadline_at, 80) || !ids(proposal.evidence_ids) ||
        !isObject(proposal.plan) || !text(proposal.plan.summary, 500) || !Array.isArray(proposal.plan.steps) || proposal.plan.steps.length < 1 || proposal.plan.steps.length > 4 || proposal.plan.steps.some((step) => !text(step, 160) || !step.trim()) || !(proposal.adopted_goal_id === null || identity(proposal.adopted_goal_id)) || (proposal.status === "adopted") !== (proposal.adopted_goal_id !== null)) throw compatible();
  }
  const citedIds = value.evidence_ids as string[], inputIds = value.input_evidence_ids as string[];
  if (new Set(value.citations.map((citation) => citation.id)).size !== value.citations.length || value.citations.some((citation) => !citedIds.includes(citation.id)) || value.evidence_ids.length !== value.citations.length || value.evidence_ids.some((id) => !inputIds.includes(id))) throw compatible();
  return value as NaturalTurn;
}
export function parseConversation(value: unknown, id: string): NaturalConversation {
  const summary = parseConversationSummary(value);
  if (summary.id !== id || !isObject(value) || !nullableText(value.source_expires_at, 80) || !isObject(value.route_configuration) || !["openai_compatible", "ollama_native"].includes(String(value.route_configuration.protocol)) || !text(value.route_configuration.endpoint, 500) || !text(value.route_configuration.model, 200) || value.route_configuration.scope !== "synthetic_only" || !Array.isArray(value.turns) || value.turns.length > 100) throw compatible();
  const turns = value.turns.map((turn) => parseNaturalTurn(turn, id));
  if (new Set(turns.map((turn) => turn.request_id)).size !== turns.length) throw compatible();
  return {...summary, turns, source_expires_at: value.source_expires_at as string | null, route_configuration: value.route_configuration as PlannerConfiguration};
}
const segment = (id: string) => { if (!identity(id)) throw compatible(); return encodeURIComponent(id); };
export const naturalChatApi = {
  list: async (signal?: AbortSignal): Promise<ConversationSummary[]> => {
    const value = await request("/conversations", undefined, signal);
    if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 100) throw compatible();
    const items = value.items.map(parseConversationSummary);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw compatible();
    return items;
  },
  read: async (id: string, signal?: AbortSignal) => parseConversation(await request(`/conversations/${segment(id)}`, undefined, signal), id),
  consent: async (id: string, consent: ConversationConsent, command_id: string) => parseConversation(await request(`/conversations/${segment(id)}/consent`, {...consent, command_id}), id),
  revoke: async (id: string, expected_version: number, command_id: string) => parseConversation(await request(`/conversations/${segment(id)}/revoke`, {expected_version, command_id}), id),
  send: async (id: string, turn: NewNaturalTurn) => parseNaturalTurn(await request(`/conversations/${segment(id)}/turns`, turn), id, turn.request_id),
  turn: async (id: string, requestId: string, signal?: AbortSignal) => parseNaturalTurn(await request(`/conversations/${segment(id)}/turns/${segment(requestId)}`, undefined, signal), id, requestId),
  adoption: async (id: string, adoptionId: string, signal?: AbortSignal): Promise<AdoptionReceipt> => {
    const value = await request(`/conversations/${segment(id)}/adoptions/${segment(adoptionId)}`, undefined, signal);
    if (!isObject(value) || !isObject(value.receipt) || value.receipt.state !== "completed" || value.receipt.adoption_id !== adoptionId || !identity(value.receipt.proposal_id) || !identity(value.receipt.goal_id) || !isObject(value.goal) || value.goal.id !== value.receipt.goal_id || value.replayed !== true) throw compatible();
    return value as AdoptionReceipt;
  },
  adopt: async (id: string, proposalId: string, expected_version: number, adoption_id: string): Promise<AdoptionReceipt> => {
    const value = await request(`/conversations/${segment(id)}/proposals/${segment(proposalId)}/adopt`, {adoption_id, expected_version, confirmed: true});
    if (!isObject(value) || !isObject(value.receipt) || value.receipt.state !== "completed" || value.receipt.adoption_id !== adoption_id || value.receipt.proposal_id !== proposalId || !identity(value.receipt.goal_id) || !isObject(value.goal) || value.goal.id !== value.receipt.goal_id || typeof value.replayed !== "boolean") throw compatible();
    return value as AdoptionReceipt;
  }
};
export type NaturalChatApi = typeof naturalChatApi;
export async function loadNaturalChatSnapshot(api: NaturalChatApi, runtimeApi: AgentRuntimeApi = agentRuntimeApi, id: string | null, signal?: AbortSignal): Promise<NaturalChatSnapshot> {
  const [planner, runtime, conversations, conversation] = await Promise.all([runtimeApi.plannerStatus(signal), runtimeApi.load(signal), api.list(signal), id ? api.read(id, signal) : Promise.resolve(null)]);
  checkAbort(signal);
  return {planner, runtime, conversations, conversation};
}

// Recovery metadata contains identifiers and definite rejection markers only.
// Drafts, model text and consent are
// never put in browser storage. Reading this journal never replays a write.
export type PendingNaturalOperation = {kind: "turn" | "adoption" | "consent" | "revoke"; conversationId: string; id: string; proposalId?: string; newConversation?: true; rejectedStatus?: number};
const pending = new Map<string, PendingNaturalOperation>();
const JOURNAL = "openbutler:natural-chat-pending:v1:";
export function pendingNaturalOperations(): PendingNaturalOperation[] {
  try {
    for (let index = 0; index < window.sessionStorage.length; index++) {
      const key = window.sessionStorage.key(index);
      if (!key?.startsWith(JOURNAL)) continue;
      try {
        const value = JSON.parse(window.sessionStorage.getItem(key) || "null");
        if (isObject(value) && ["turn", "adoption", "consent", "revoke"].includes(String(value.kind)) && identity(value.conversationId) && identity(value.id) && (value.proposalId === undefined || identity(value.proposalId)) && (value.newConversation === undefined || value.kind === "consent" && value.newConversation === true) && (value.rejectedStatus === undefined || [400, 403, 404, 409, 422].includes(Number(value.rejectedStatus)) && typeof value.rejectedStatus === "number")) {
          // A failed storage update must not replace a newer in-memory rejection
          // with the older persisted identifier-only record.
          if (!pending.has(value.id)) pending.set(value.id, value as PendingNaturalOperation);
        }
      } catch { /* Never infer or execute an operation from corrupt storage. */ }
    }
  } catch { /* Memory-only recovery if optional storage is unavailable. */ }
  return [...pending.values()];
}
export function rememberNaturalOperation(value: PendingNaturalOperation) {
  if (pendingNaturalOperations().length >= 100 && !pending.has(value.id)) throw new Error("待核对请求过多，请先核对已有请求。");
  pending.set(value.id, value);
  try { window.sessionStorage.setItem(`${JOURNAL}${value.id}`, JSON.stringify(value)); } catch { /* Memory-only fallback. */ }
}
export function forgetNaturalOperation(id: string) {
  pending.delete(id);
  try { window.sessionStorage.removeItem(`${JOURNAL}${id}`); } catch { /* Optional storage. */ }
}

