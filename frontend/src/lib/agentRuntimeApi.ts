/** Preview-only local control plane. Never falls back to the stable /api/chat. */
export type GoalStatus = "candidate" | "active" | "waiting_external" | "paused" | "completed" | "cancelled";
export type RuntimeSource = {
  id: string; scope: string; version: number; status: "active" | "revoked" | "deleted" | "expired";
  consented_at: string | null; expires_at: string | null;
};
export type RuntimeEvidence = {
  id: string; source_id: string; source_version?: number; source_event_id: string; target_id: string;
  event_type: string; value: unknown; observed_at: string; expires_at: string | null;
  valid: boolean; provenance: unknown; trust: "untrusted";
};
export type RuntimeGoal = {
  id: string; title: string; target_id: string; success_event_type: string; success_value: unknown;
  version: number; status: GoalStatus; source_ids: string[]; evidence_ids: string[];
  deadline_at: string | null; activated_at: string | null;
  wait_target: {target_id?: string; event_type?: string; value?: unknown} | null;
  checkpoint: unknown; plan: unknown; approval: unknown;
  content_withheld?: boolean;
  verification_status?: "verified" | "withdrawn" | "unverified";
  completion_evidence_ids: string[]; blocked_reason: string | null;
  next_wake_at?: string | null;
};
export type RuntimeNotice = {
  id: string; goal_id: string; action_id: string; kind: string; message: string;
  created_at: string; read_at: string | null;
};
export type RuntimeMessage = {
  id: string; conversation_id: string; role: string; content: string;
  created_at: string; client_message_id: string;
};
export type RuntimeStatus = {
  enabled: boolean; planner: string; next_wake_at?: string | null; counts: Record<string, number>; settings: Record<string, unknown>;
};
export type RuntimeSnapshot = {
  status: RuntimeStatus; goals: RuntimeGoal[]; sources: RuntimeSource[];
  evidence: RuntimeEvidence[]; inbox: RuntimeNotice[]; messages: RuntimeMessage[];
};
export type RuntimeNoticeSettings = {quiet_until: string | null; daily_notice_budget: number; cooldown_seconds: number};
export type NewRuntimeGoal = {
  title: string; target_id: string; success_event_type: string; success_value: unknown;
  evidence_ids: string[]; source_ids: string[]; deadline_at: string | null;
};
export type PlannerMode = "deterministic" | "local_model";
export type PlannerConfiguration = {
  protocol: "openai_compatible" | "ollama_native"; endpoint: string; model: string; scope: "synthetic_only";
};
export type RuntimePlannerStatus = {
  selected_mode: PlannerMode; name: string; ready: boolean; configured: boolean; model_ready: boolean;
  needs_validation: boolean; configuration_revision: number; configuration: PlannerConfiguration | null;
  confirmed: boolean; last_attempt: "never" | "passed" | "failed";
  last_failure: null | "local_text_probe_failed" | "model_planner_unavailable" | "planner_configuration_invalid";
  model_allowed_sources: ["synthetic"]; boundary: "synthetic_loopback_only";
  daily_budget?: {limit: number; used: number; remaining: number; resets_at: string};
};
export type RuntimePlanProposal = {
  summary: string; steps: string[]; evidence_ids: string[];
  status: "proposed_unverified"; authored_by: "planner"; executable: false;
};
/** Model-authored text is a non-executable draft, never task completion. */
export function runtimePlanProposal(goal: RuntimeGoal): RuntimePlanProposal | null {
  if (goal.content_withheld || goal.source_ids.length !== 1 || goal.source_ids[0] !== "synthetic" || !goal.plan || typeof goal.plan !== "object") return null;
  const value = (goal.plan as Record<string, unknown>).proposal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proposal = value as Record<string, unknown>;
  if (proposal.status !== "proposed_unverified" || proposal.authored_by !== "planner" || proposal.executable !== false ||
      typeof proposal.summary !== "string" || !proposal.summary.trim() || proposal.summary.length > 500 ||
      !Array.isArray(proposal.steps) || proposal.steps.length < 1 || proposal.steps.length > 4 ||
      proposal.steps.some((step) => typeof step !== "string" || !step.trim() || step.length > 160) ||
      !Array.isArray(proposal.evidence_ids) || proposal.evidence_ids.length > 8 ||
      proposal.evidence_ids.some((id) => typeof id !== "string" || !id) || new Set(proposal.evidence_ids).size !== proposal.evidence_ids.length) return null;
  return proposal as RuntimePlanProposal;
}
function versionMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const versions = (value as Record<string, unknown>).source_versions;
  return versions && typeof versions === "object" && !Array.isArray(versions) ? versions as Record<string, unknown> : {};
}
/** Fail closed for a snapshot whose independently read consent/evidence changed. */
export function readableRuntimeSnapshot(value: RuntimeSnapshot, withheldSource?: string): RuntimeSnapshot {
  const now = Date.now();
  const allowed = new Map(value.sources.filter((source) => source.id !== withheldSource && source.status === "active" && (!source.expires_at || new Date(source.expires_at).getTime() > now)).map((source) => [source.id, source]));
  const evidence = value.evidence.filter((item) => item.valid && allowed.has(item.source_id) && (item.source_version === undefined || allowed.get(item.source_id)?.version === item.source_version) && (!item.expires_at || new Date(item.expires_at).getTime() > now));
  return {...value, evidence,
    goals: value.goals.map((goal) => goal.content_withheld || goal.source_ids.some((id) => !allowed.has(id) ||
      ![versionMap(goal.plan), versionMap(goal.approval)].some((versions) => typeof versions[id] === "number") ||
      [versionMap(goal.plan), versionMap(goal.approval)].some((versions) => id in versions && versions[id] !== allowed.get(id)?.version)) ? {
      ...goal, title: "来源内容暂不可用", target_id: "unavailable", success_event_type: "unavailable", success_value: null,
      evidence_ids: [], completion_evidence_ids: [], wait_target: null, checkpoint: {stage: "evidence_withdrawn"},
      plan: null, approval: null,
      content_withheld: !!withheldSource || !!goal.content_withheld,
      verification_status: withheldSource || goal.content_withheld ? goal.verification_status : goal.status === "completed" ? "withdrawn" : "unverified",
      blocked_reason: withheldSource || goal.content_withheld ? "来源操作待核对，暂不显示派生内容" : goal.blocked_reason || "来源授权当前不可用"
    } : (() => {
      const proposal = runtimePlanProposal(goal);
      // A proposal's own plan generation and referenced evidence must match the
      // same readable snapshot, even if an older approval remains readable.
      if (proposal && (goal.source_ids.some((id) => versionMap(goal.plan)[id] !== allowed.get(id)?.version) ||
          proposal.evidence_ids.some((id) => !evidence.some((item) => item.id === id && item.target_id === goal.target_id &&
            goal.source_ids.includes(item.source_id) && item.source_version === allowed.get(item.source_id)?.version)))) {
        return {...goal, plan: {...goal.plan as Record<string, unknown>, proposal: null}};
      }
      return goal;
    })())
  };
}
const PREFIX = "/api/agent-runtime";
export const CONVERSATION_ID = "local-preview";

function aborted() { return new DOMException("Request interrupted", "AbortError"); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw aborted(); }

/** Desktop IPC cannot cancel a committed write; the UI reconciles with a fresh read. */
async function localRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  const method = body === undefined ? "GET" : "POST";
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const bridge = window.openbutlerDesktop;
  if (bridge?.requestApi) {
    const result = await bridge.requestApi(`${PREFIX}${path}`, {method, body: serialized});
    checkAbort(signal);
    if (!result.ok) throw new Error(`本机服务未确认请求（${result.status}）`);
    return result.data as T;
  }
  const base = bridge?.apiBase || import.meta.env.VITE_API_BASE_URL || window.location.origin;
  const url = new URL(`${PREFIX}${path}`, base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("本地目标循环只能连接本机服务");
  }
  const response = await fetch(url.toString(), {method, body: serialized, signal,
    headers: {"Content-Type": "application/json"}, redirect: "error", credentials: "same-origin"});
  checkAbort(signal);
  if (!response.ok) throw new Error(`本机服务未确认请求（${response.status}）`);
  return response.json() as Promise<T>;
}

export async function loadRuntimeSnapshot(signal?: AbortSignal): Promise<RuntimeSnapshot> {
  const [status, goals, sources, evidence, inbox, messages] = await Promise.all([
    localRequest<RuntimeStatus>("/status", undefined, signal),
    localRequest<{items: RuntimeGoal[]}>("/goals", undefined, signal),
    localRequest<{items: RuntimeSource[]}>("/sources", undefined, signal),
    localRequest<{items: RuntimeEvidence[]}>("/evidence", undefined, signal),
    localRequest<{items: RuntimeNotice[]}>("/inbox", undefined, signal),
    localRequest<{items: RuntimeMessage[]}>(`/chat?conversation_id=${encodeURIComponent(CONVERSATION_ID)}`, undefined, signal)
  ]);
  // Invalid or incompatible snapshots must never enable controls with guessed state.
  if (!status || typeof status.enabled !== "boolean" || ![goals, sources, evidence, inbox, messages].every((part) => Array.isArray(part?.items))) {
    throw new Error("本机状态格式不兼容，请更新服务后重试");
  }
  return {status, goals: goals.items, sources: sources.items, evidence: evidence.items, inbox: inbox.items, messages: messages.items};
}

/** A stale or incompatible status cannot enable model dispatch controls. */
export async function loadPlannerStatus(signal?: AbortSignal): Promise<RuntimePlannerStatus> {
  const value = await localRequest<RuntimePlannerStatus>("/planner", undefined, signal);
  const configuration = value?.configuration;
  if (!value || !["deterministic", "local_model"].includes(value.selected_mode) || typeof value.name !== "string" ||
      ![value.ready, value.configured, value.model_ready, value.needs_validation, value.confirmed].every((flag) => typeof flag === "boolean") ||
      !Number.isSafeInteger(value.configuration_revision) || value.configuration_revision < 0 ||
      !["never", "passed", "failed"].includes(value.last_attempt) ||
      ![null, "local_text_probe_failed", "model_planner_unavailable", "planner_configuration_invalid"].includes(value.last_failure) ||
      value.boundary !== "synthetic_loopback_only" || !Array.isArray(value.model_allowed_sources) ||
      value.model_allowed_sources.length !== 1 || value.model_allowed_sources[0] !== "synthetic" ||
      (configuration !== null && (!configuration || !["openai_compatible", "ollama_native"].includes(configuration.protocol) ||
        typeof configuration.endpoint !== "string" || typeof configuration.model !== "string" || configuration.scope !== "synthetic_only")) ||
      value.configured !== (configuration !== null)) throw new Error("本机规划器状态格式不兼容");
  return value;
}

export const agentRuntimeApi = {
  load: loadRuntimeSnapshot,
  plannerStatus: loadPlannerStatus,
  configurePlanner: (configuration: PlannerConfiguration, command_id: string) => localRequest("/planner/configure", {...configuration, confirmed: true, command_id}),
  selectPlanner: (mode: PlannerMode, command_id: string) => localRequest("/planner/select", {mode, command_id}),
  configure: (settings: RuntimeNoticeSettings, command_id: string) => localRequest("/settings", {...settings, command_id}),
  commandStatus: (id: string) => localRequest<{state: "completed" | "outcome_unknown"}>(`/commands/${encodeURIComponent(id)}`),
  setEnabled: (enabled: boolean, command_id: string) => localRequest("/enabled", {enabled, command_id}),
  message: (content: string, client_message_id: string) => localRequest("/chat", {conversation_id: CONVERSATION_ID, content, client_message_id}),
  createGoal: (goal: NewRuntimeGoal, command_id: string) => localRequest("/goals", {...goal, command_id}),
  activateGoal: (id: string, expected_version: number, command_id: string) => localRequest(`/goals/${encodeURIComponent(id)}/activate`, {expected_version, command_id}),
  controlGoal: (id: string, operation: "pause" | "resume" | "cancel", expected_version: number, command_id: string) => localRequest(`/goals/${encodeURIComponent(id)}/control`, {operation, expected_version, command_id}),
  readNotice: (id: string, command_id: string) => localRequest(`/inbox/${encodeURIComponent(id)}/read`, {command_id}),
  source: (id: string, operation: "grant" | "revoke" | "delete", command_id: string) => localRequest(`/sources/${encodeURIComponent(id)}/${operation}`, operation === "grant" ? {scope: "goal_tracking", confirmed: true, command_id} : {command_id})
};
export type AgentRuntimeApi = typeof agentRuntimeApi;

// Retain an unconfirmed write ID across navigation/retry. Only IDs, never message
// contents, are persisted. A digest avoids duplicating private text in storage keys.
const pendingCommands = new Map<string, Promise<string>>();
function randomId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前环境无法创建安全请求编号");
  return globalThis.crypto.randomUUID();
}
async function storageKey(operation: string) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(operation));
  return `openbutler:loop-command:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function commandIdFor(operation: string): Promise<string> {
  const pending = pendingCommands.get(operation);
  if (pending) return pending;
  const prepared = (async () => {
    const key = await storageKey(operation);
    let id: string | null = null;
    try { id = key ? window.sessionStorage.getItem(key) : null; } catch { /* Memory fallback. */ }
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) id = randomId();
    try { if (key) window.sessionStorage.setItem(key, id); } catch { /* Memory fallback. */ }
    return id;
  })();
  pendingCommands.set(operation, prepared);
  void prepared.catch(() => { if (pendingCommands.get(operation) === prepared) pendingCommands.delete(operation); });
  return prepared;
}
export async function confirmCommand(operation: string) {
  const pending = pendingCommands.get(operation);
  const key = await storageKey(operation);
  try { if (key) window.sessionStorage.removeItem(key); } catch { /* Optional cache. */ }
  if (pendingCommands.get(operation) === pending) pendingCommands.delete(operation);
}

async function retainedCommands() {
  const retained = new Map<string, {operation?: string; storage?: string}>();
  for (const [operation, pending] of pendingCommands) {
    try { retained.set(await pending, {operation, storage: await storageKey(operation) ?? undefined}); } catch { /* No ID created. */ }
  }
  try {
    for (let index = 0; index < window.sessionStorage.length; index++) {
      const key = window.sessionStorage.key(index);
      if (!key?.startsWith("openbutler:loop-command:v1:")) continue;
      const id = window.sessionStorage.getItem(key);
      if (id && /^[0-9a-f-]{36}$/i.test(id) && !retained.has(id)) retained.set(id, {storage: key});
    }
  } catch { /* Storage may be disabled. */ }
  return retained;
}
async function retireRetained(item: {operation?: string; storage?: string}) {
  if (item.operation) await confirmCommand(item.operation);
  else { try { if (item.storage) window.sessionStorage.removeItem(item.storage); } catch { /* Optional. */ } }
}
/** Read only, before state capture: settle known receipts without replaying writes. */
export async function reconcileCommandReceipts(api: AgentRuntimeApi, signal?: AbortSignal) {
  const retained = await retainedCommands();
  for (const [id, item] of [...retained].slice(0, 100)) {
    checkAbort(signal);
    if (item.operation?.startsWith("message:")) continue;
    try {
      const receipt = await api.commandStatus(id);
      checkAbort(signal);
      if (receipt.state === "completed") await retireRetained(item);
    } catch { checkAbort(signal); /* Unknown/not found retains the same ID. */ }
  }
}
export async function reconcileMessageReceipts(messages: RuntimeMessage[]) {
  const received = new Set(messages.map((message) => message.client_message_id));
  for (const [id, item] of await retainedCommands()) if (received.has(id)) await retireRetained(item);
}
