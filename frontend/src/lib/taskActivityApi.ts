/** Native task records are separate from executable agent-runtime goals. */
export type TaskStatus = "todo" | "doing" | "done";
export type DiscoveryProvider = "evidence_rules_v1" | "local_model_v1" | "unknown";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type NativeTask = {
  id: string; version: number; title: string; description: string; status: TaskStatus;
  priority: TaskPriority; due_at: string | null; completed_at: string | null;
  archived: boolean; merged_into: string | null; created_by: "user" | "assistant";
  confirmed: boolean; evidence_unavailable: boolean; created_at: string; updated_at: string;
  discovery_provider: DiscoveryProvider | null;
};
export type ResourceRef = {
  id: string; kind: "url" | "file" | "document" | "window" | "evidence";
  label: string; reference: string; source: "user" | "activity"; evidence_available: boolean;
};
export type ActivityLink = {
  relation: "work" | "preparation" | "reference" | "possible";
  decision: "accepted" | "rejected"; origin: "user" | "assistant"; confidence: number; primary: boolean;
};
export type TaskActivity = {
  id: string; source: "manual" | "observation"; source_record_id: string | null;
  title: string; summary: string; start_at: string; end_at: string;
  time_kind: "manual" | "estimated" | "sample"; evidence_available: boolean;
  boundary: string; resources: ResourceRef[]; link?: ActivityLink;
};
export type TaskDetail = {
  task: NativeTask; activities: TaskActivity[]; resources: ResourceRef[];
  time: {observed_span_seconds: number; estimated_seconds: number; manual_seconds: number; total_seconds: number; boundary: string};
  checkpoint: null | {next_step: string; resource_ref: string | null; source: "user" | "activity"; observed_at: string; evidence_available: boolean};
  merged_tasks: NativeTask[];
};
export type TaskDiscovery = {
  id: string; activity_id: string; title: string; quote: string;
  state: "pending" | "accepted" | "dismissed" | "invalidated"; confidence: number; version: number; provider: DiscoveryProvider;
};
/** Fixed diagnostic codes only. Never display provider responses or exception text. */
export const taskDiscoveryFailures = {
  task_context_incomplete: "这条观察的完整原文未通过输入检查（来源验证或输入预算），本次没有发送给模型。有效活动仍保留；这不表示没有任务。",
  invalid_discovery_result: "模型返回的线索格式未通过校验，本次未保存新的任务线索。有效活动仍保留；这不表示没有任务。",
  discovery_source_mismatch: "模型返回的标题或引用与原文不一致，本次未保存新的任务线索。有效活动仍保留；这不表示没有任务。",
  discovery_authorization_changed: "来源、授权或模型设置已变化，或本次处理已停止，这条记录的线索未保存。请核对当前可用的记录；没有自动重试。",
  local_model_unavailable: "本地模型当前不可用或未通过本地来源检查，本次未保存新的任务线索。有效活动仍保留。",
  local_provider_failed: "本地模型请求失败，本次未保存新的任务线索。有效活动仍保留；没有自动重试。",
  local_provider_timeout: "本地模型请求超时，本次未保存新的任务线索。有效活动仍保留；没有自动重试。",
  invalid_provider_response: "本地模型响应未通过协议校验，本次未保存新的任务线索。有效活动仍保留；没有自动重试。",
  local_discovery_failed: "本地线索处理失败，本次未保存新的任务线索。有效活动仍保留；没有自动切换发现方式或重试。",
} as const;
export type TaskDiscoveryFailure = keyof typeof taskDiscoveryFailures;
function discoveryFailure(value: unknown): value is TaskDiscoveryFailure {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(taskDiscoveryFailures, value);
}
export type TaskActivitySettings = {
  auto_discovery: boolean; version: number; provider: "evidence_rules_v1" | "local_model_v1";
  model_discovery_available: boolean; last_error: null | TaskDiscoveryFailure; boundary: string;
};
export const taskSyncLifecycleReasons = {
  disabled: "线索发现已关闭，本次未处理活动。",
  no_authorized_observations: "没有可处理的已授权本机观察。",
  source_outside_scope: "来源已不在当前授权范围内。",
  interrupted: "同步已中断，已提交的活动和线索仍保留。",
  worker_start_failed: "本机同步未能启动，请核对后再手动同步。",
  sync_failed: "本机同步失败，请核对已保存的记录；没有自动重试。",
} as const;
export type TaskSyncOperation = {
  command_id: string; version: number; state: "pending" | "stopping" | "complete" | "error" | "interrupted";
  settled: boolean; provider: TaskActivitySettings["provider"]; settings_version: number; bounded_to: 1 | 200;
  selected: number; attempted: number; processed: number; activities_created: number; skipped_invalid: number;
  has_more: boolean | null; reason: TaskDiscoveryFailure | keyof typeof taskSyncLifecycleReasons | null;
  created_at: string; updated_at: string;
};
export type TaskSyncResult = {operation: TaskSyncOperation | null; reason: "extraction_in_progress" | null};
export type TaskSyncIdentity = {command_id: string; expected_version: number};
export type TaskRequestCode = TaskDiscoveryFailure | "task_sync_not_found" | "version_conflict" | "command_conflict";
export type TaskSnapshot = {tasks: NativeTask[]; activities: TaskActivity[]; discoveries: TaskDiscovery[]; pendingDiscoveryCount: number; hasMorePendingDiscoveries: boolean; settings: TaskActivitySettings};
export type NewTask = {title: string; description: string; priority: TaskPriority; due_at: string | null};
export type TaskPatch = Partial<NewTask & {status: TaskStatus; archived: boolean; confirmed: boolean}> & {expected_version: number};
export type NewActivity = {title: string; summary: string; start_at: string; end_at: string};
export type NewResource = Pick<ResourceRef, "label" | "reference"> & {kind: Exclude<ResourceRef["kind"], "evidence">};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const version = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
const flag = (value: unknown) => typeof value === "boolean";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const oneOf = (value: unknown, values: string[]) => string(value) && values.includes(value);
const incompatible = () => new Error("本机任务数据格式不兼容，已停止操作。请更新服务后重新读取。");
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10000) throw incompatible();
  return value.map(parse);
}
export function parseNativeTask(value: unknown): NativeTask {
  if (!object(value) || !identity(value.id) || !version(value.version) || !string(value.title) || !string(value.description) ||
      !oneOf(value.status, ["todo", "doing", "done"]) || !oneOf(value.priority, ["low", "normal", "high", "urgent"]) ||
      !nullableDate(value.due_at) || !nullableDate(value.completed_at) || !flag(value.archived) ||
      !(value.merged_into === null || identity(value.merged_into)) || !oneOf(value.created_by, ["user", "assistant"]) ||
      !flag(value.confirmed) || !flag(value.evidence_unavailable) || !date(value.created_at) || !date(value.updated_at)) throw incompatible();
  if (value.discovery_provider !== undefined && value.discovery_provider !== null && !oneOf(value.discovery_provider, ["evidence_rules_v1", "local_model_v1", "unknown"])) throw incompatible();
  // Historical rows have no reliable provider attribution. Current settings are
  // never evidence of which provider created an older task.
  return {...value, discovery_provider: value.created_by === "user" ? null : value.discovery_provider ?? "unknown"} as NativeTask;
}
export function parseResource(value: unknown): ResourceRef {
  if (!object(value) || !identity(value.id) || !oneOf(value.kind, ["url", "file", "document", "window", "evidence"]) ||
      !string(value.label) || !string(value.reference) || !oneOf(value.source, ["user", "activity"]) || !flag(value.evidence_available)) throw incompatible();
  return value as ResourceRef;
}
export function parseActivity(value: unknown): TaskActivity {
  if (!object(value) || !identity(value.id) || !oneOf(value.source, ["manual", "observation"]) ||
      !(value.source_record_id === null || identity(value.source_record_id)) || !string(value.title) || !string(value.summary) ||
      !date(value.start_at) || !date(value.end_at) || Date.parse(value.end_at) < Date.parse(value.start_at) ||
      !oneOf(value.time_kind, ["manual", "estimated", "sample"]) || !flag(value.evidence_available) || !string(value.boundary)) throw incompatible();
  list(value.resources, parseResource);
  if (value.link !== undefined && value.link !== null) {
    const link = value.link;
    if (!object(link) || !oneOf(link.relation, ["work", "preparation", "reference", "possible"]) ||
        !oneOf(link.decision, ["accepted", "rejected"]) || !oneOf(link.origin, ["user", "assistant"]) ||
        !finite(link.confidence) || link.confidence > 1 || !flag(link.primary)) throw incompatible();
  }
  return value as TaskActivity;
}
export function parseTaskDetail(value: unknown): TaskDetail {
  if (!object(value)) throw incompatible();
  const task = parseNativeTask(value.task), merged_tasks = list(value.merged_tasks, parseNativeTask);
  list(value.activities, parseActivity); list(value.resources, parseResource);
  if (!object(value.time) || ![value.time.observed_span_seconds, value.time.estimated_seconds, value.time.manual_seconds, value.time.total_seconds].every(finite) || !string(value.time.boundary)) throw incompatible();
  if (value.checkpoint !== null) {
    const checkpoint = value.checkpoint;
    if (!object(checkpoint) || !string(checkpoint.next_step) || !(checkpoint.resource_ref === null || string(checkpoint.resource_ref)) ||
        !oneOf(checkpoint.source, ["user", "activity"]) || !date(checkpoint.observed_at) || !flag(checkpoint.evidence_available)) throw incompatible();
  }
  return {...value, task, merged_tasks} as TaskDetail;
}
export function parseDiscovery(value: unknown): TaskDiscovery {
  if (!object(value) || !identity(value.id) || !identity(value.activity_id) || !string(value.title) || !string(value.quote) ||
      !oneOf(value.state, ["pending", "accepted", "dismissed", "invalidated"]) || !finite(value.confidence) || value.confidence > 1 || !version(value.version)) throw incompatible();
  if (value.provider !== undefined && !oneOf(value.provider, ["evidence_rules_v1", "local_model_v1", "unknown"])) throw incompatible();
  return {...value, provider: value.provider ?? "unknown"} as TaskDiscovery;
}
/** Pending-first page metadata prevents a bounded result from looking complete. */
export function parseDiscoveryPage(value: unknown) {
  if (!object(value)) throw incompatible();
  const discoveries = list(value.items, parseDiscovery);
  const shown = discoveries.filter((item) => item.state === "pending").length;
  if (!Number.isSafeInteger(value.pending_count) || Number(value.pending_count) < shown || !flag(value.has_more_pending) ||
      value.has_more_pending !== (Number(value.pending_count) > shown) || (Number(value.pending_count) > 0 && shown === 0)) throw incompatible();
  return {discoveries, pendingDiscoveryCount: Number(value.pending_count), hasMorePendingDiscoveries: value.has_more_pending as boolean};
}
const uuid = (value: unknown): value is string => string(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function parseTaskSyncIdentity(value: unknown): TaskSyncIdentity {
  if (!object(value) || Object.keys(value).length !== 2 || !uuid(value.command_id) || !version(value.expected_version)) throw incompatible();
  return {command_id: value.command_id, expected_version: Number(value.expected_version)};
}
export function parseTaskSyncResult(value: unknown): TaskSyncResult {
  if (!object(value) || Object.keys(value).length !== 2 || !(value.reason === null || value.reason === "extraction_in_progress")) throw incompatible();
  if (value.operation === null) return {operation: null, reason: value.reason};
  const op = value.operation;
  const fields = ["command_id", "version", "state", "settled", "provider", "settings_version", "bounded_to", "selected", "attempted", "processed", "activities_created", "skipped_invalid", "has_more", "reason", "created_at", "updated_at"];
  const timestamp = (v: unknown) => date(v) && /(?:Z|[+-]\d{2}:\d{2})$/.test(v);
  if (value.reason !== null || !object(op) || Object.keys(op).length !== fields.length || fields.some((key) => !(key in op)) ||
      !uuid(op.command_id) || !version(op.version) || !version(op.settings_version) || !flag(op.settled) ||
      !oneOf(op.state, ["pending", "stopping", "complete", "error", "interrupted"]) ||
      op.settled !== ["complete", "error", "interrupted"].includes(String(op.state)) ||
      !oneOf(op.provider, ["evidence_rules_v1", "local_model_v1"]) || op.bounded_to !== (op.provider === "local_model_v1" ? 1 : 200) ||
      ![op.selected, op.attempted, op.processed, op.activities_created, op.skipped_invalid].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) ||
      Number(op.attempted) > Number(op.selected) || Number(op.processed) > Number(op.attempted) ||
      Number(op.selected) > Number(op.bounded_to) || Number(op.activities_created) > Number(op.attempted) || Number(op.skipped_invalid) > 201 ||
      !(op.has_more === null || flag(op.has_more)) ||
      !(op.reason === null || discoveryFailure(op.reason) || string(op.reason) && Object.prototype.hasOwnProperty.call(taskSyncLifecycleReasons, op.reason)) ||
      op.state === "pending" && op.reason !== null ||
      ["stopping", "interrupted"].includes(String(op.state)) && op.reason !== "interrupted" ||
      op.state === "complete" && !(op.reason === null || oneOf(op.reason, ["disabled", "no_authorized_observations"])) ||
      op.state === "error" && !(discoveryFailure(op.reason) || oneOf(op.reason, ["source_outside_scope", "worker_start_failed", "sync_failed"])) ||
      !timestamp(op.created_at) || !timestamp(op.updated_at) || Date.parse(String(op.updated_at)) < Date.parse(String(op.created_at))) throw incompatible();
  return {operation: op as TaskSyncOperation, reason: null};
}
export function parseTaskSettings(value: unknown): TaskActivitySettings {
  if (!object(value) || !flag(value.auto_discovery) || !version(value.version) || !oneOf(value.provider, ["evidence_rules_v1", "local_model_v1"]) ||
      !flag(value.model_discovery_available) || !(value.last_error === null || discoveryFailure(value.last_error)) || !string(value.boundary)) throw incompatible();
  return value as TaskActivitySettings;
}
export function nativeTaskWorkspaceAvailable() {
  return window.openbutlerDesktop?.channel === "preview" && typeof window.openbutlerDesktop.requestApi === "function";
}
export class TaskRequestError extends Error {
  constructor(readonly status: number, readonly code?: TaskRequestCode) {
    super(code && discoveryFailure(code) ? taskDiscoveryFailures[code] : status === 409 ? "记录已变化，请重新读取后检查再保存。" : status === 401 || status === 403
      ? "本机身份验证未通过。请重新打开桌面应用后再试。" : status === 400 || status === 422 ? "输入未通过本机校验，请检查标题、时间与引用格式。" : status === 404 ? "这条记录已不可用，请重新读取。" : `本机服务未确认请求（${status}）。`);
  }
}
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Request interrupted", "AbortError"); }
/** No fetch fallback: only trusted desktop IPC injects the local session credential. */
async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal);
  if (!nativeTaskWorkspaceAvailable()) throw new Error("任务工作区仅在本机 Preview 桌面应用中可用。");
  const bridge = window.openbutlerDesktop!;
  const result = await bridge.requestApi!(path, {method, body: body === undefined ? undefined : JSON.stringify(body)});
  checkAbort(signal);
  if (!nativeTaskWorkspaceAvailable() || window.openbutlerDesktop !== bridge) throw new Error("本机连接已变化，请重新读取。");
  if (!result.ok) {
    const exactSyncLookup = /^\/api\/task-activity\/sync\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path);
    const code = method === "GET" && exactSyncLookup && result.status === 404 && result.code === "task_sync_not_found" ? result.code
      : method === "POST" && path === "/api/task-activity/sync" && result.status === 409 && ["version_conflict", "command_conflict"].includes(result.code || "") ? result.code as TaskRequestCode
      : method === "POST" && path === "/api/task-activity/sync" && [409, 422].includes(result.status) && discoveryFailure(result.code) ? result.code : undefined;
    throw new TaskRequestError(result.status, code);
  }
  return result.data;
}
function items<T>(value: unknown, parse: (value: unknown) => T) {
  if (!object(value)) throw incompatible();
  return list(value.items, parse);
}
const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
export function newTaskCommandId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前环境无法生成安全请求编号。");
  return globalThis.crypto.randomUUID();
}
export const taskActivityApi = {
  async load(signal?: AbortSignal): Promise<TaskSnapshot> {
    const [tasks, activities, discoveries, settings] = await Promise.all([
      request("/api/tasks?include_archived=true", "GET", undefined, signal),
      request("/api/task-activity/activities", "GET", undefined, signal),
      request("/api/task-activity/discoveries", "GET", undefined, signal),
      request("/api/task-activity/settings", "GET", undefined, signal)
    ]);
    return {tasks: items(tasks, parseNativeTask), activities: items(activities, parseActivity), ...parseDiscoveryPage(discoveries), settings: parseTaskSettings(settings)};
  },
  async detail(id: string, signal?: AbortSignal) {
    const detail = parseTaskDetail(await request(taskPath(id), "GET", undefined, signal));
    if (detail.task.id !== id) throw incompatible();
    return detail;
  },
  async create(input: NewTask, command_id: string) { return parseNativeTask(await request("/api/tasks", "POST", {...input, command_id})); },
  async update(id: string, input: TaskPatch) { return parseNativeTask(await request(taskPath(id), "PATCH", input)); },
  async createActivity(input: NewActivity, command_id: string) { return parseActivity(await request("/api/task-activity/activities", "POST", {...input, command_id})); },
  async link(taskId: string, activityId: string, input: {expected_version: number; relation: ActivityLink["relation"]; decision: ActivityLink["decision"]; primary: boolean}) {
    return parseNativeTask(await request(`${taskPath(taskId)}/activities/${encodeURIComponent(activityId)}`, "PUT", input));
  },
  async checkpoint(id: string, expected_version: number, next_step: string, resource_ref: string | null) {
    return parseNativeTask(await request(`${taskPath(id)}/checkpoint`, "PUT", {expected_version, next_step, resource_ref: resource_ref || ""}));
  },
  async resource(id: string, expected_version: number, input: NewResource, command_id: string) {
    return parseNativeTask(await request(`${taskPath(id)}/resources`, "POST", {...input, expected_version, command_id}));
  },
  async merge(id: string, expected_version: number, target_id: string, target_version: number) {
    return parseNativeTask(await request(`${taskPath(id)}/merge`, "POST", {expected_version, target_id, target_version}));
  },
  async unmerge(id: string, expected_version: number) { return parseNativeTask(await request(`${taskPath(id)}/unmerge`, "POST", {expected_version})); },
  async settings(expected_version: number, auto_discovery: boolean, provider: TaskActivitySettings["provider"]) {
    return parseTaskSettings(await request("/api/task-activity/settings", "PUT", {expected_version, auto_discovery, provider, confirmed: true}));
  },
  async sync(identity: TaskSyncIdentity) { return parseTaskSyncResult(await request("/api/task-activity/sync", "POST", parseTaskSyncIdentity(identity))); },
  async syncStatus(command_id?: string, signal?: AbortSignal) {
    if (command_id !== undefined && !uuid(command_id)) throw incompatible();
    return parseTaskSyncResult(await request(`/api/task-activity/sync${command_id ? `/${command_id}` : ""}`, "GET", undefined, signal));
  },
  async stopSync(command_id: string) {
    if (!uuid(command_id)) throw incompatible();
    return parseTaskSyncResult(await request(`/api/task-activity/sync/${command_id}/stop`, "POST", {}));
  },
  async resolve(id: string, expected_version: number, decision: "accept" | "dismiss") {
    const result = await request(`/api/task-activity/discoveries/${encodeURIComponent(id)}/resolve`, "POST", {expected_version, decision});
    if (!object(result) || !(result.task === null || object(result.task))) throw incompatible();
    return {task: result.task === null ? null : parseNativeTask(result.task)};
  }
};
export type TaskActivityApi = typeof taskActivityApi;
