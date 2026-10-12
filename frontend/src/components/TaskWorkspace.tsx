import {createContext, useContext, useEffect, useRef, useState} from "react";
import {
  taskActivityApi, nativeTaskWorkspaceAvailable, newTaskCommandId, TaskRequestError, taskDiscoveryFailures, taskSyncLifecycleReasons, parseTaskSyncIdentity, parseTaskSyncResult,
  type TaskActivityApi, type TaskSyncResult, type TaskSyncIdentity, type TaskSyncOperation, type TaskSnapshot, type TaskDetail, type NativeTask, type NewTask,
  type TaskPriority, type DiscoveryProvider, type TaskActivitySettings, type TaskActivity, type ResourceRef, type ActivityLink, type NewActivity, type NewResource
} from "../lib/taskActivityApi";
import "./TaskWorkspace.css";

const statusLabels = {todo: "待办", doing: "进行中", done: "已完成"};
const priorityLabels = {low: "低", normal: "普通", high: "高", urgent: "紧急"};
const relationLabels = {work: "实际工作", preparation: "准备", reference: "参考", possible: "可能相关"};
const resourceLabels = {url: "网址", file: "文件", document: "文档", window: "窗口", evidence: "证据编号"};
function time(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "未设置";
}
function duration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function localInput(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function iso(value: string) { return value ? new Date(value).toISOString() : null; }
function isAbort(error: unknown) { return error instanceof Error && error.name === "AbortError"; }
function providerLabel(provider: DiscoveryProvider | null | undefined) {
  return provider === "evidence_rules_v1" ? "规则发现" : provider === "local_model_v1" ? "模型提取" : "自动发现 · 来源未记录";
}
function origin(task: NativeTask) {
  return task.created_by === "user" ? "手动" : `${providerLabel(task.discovery_provider)} · ${task.confirmed ? "已确认" : "待核对"}`;
}
// Evidence withdrawal outranks unfinished editors. Missing evidence is also a
// withdrawal: the server may remove an expired resource/checkpoint projection.
function evidenceWithdrawn(previous: TaskDetail, next: TaskDetail) {
  const withdrawn = <T extends {id: string; evidence_available: boolean}>(before: T[], after: T[]) =>
    before.some((item) => item.evidence_available && !after.find((value) => value.id === item.id)?.evidence_available);
  return (!previous.task.evidence_unavailable && next.task.evidence_unavailable)
    || withdrawn(previous.activities, next.activities)
    || withdrawn(previous.resources, next.resources)
    || previous.activities.some((item) => withdrawn(item.resources, next.activities.find((value) => value.id === item.id)?.resources || []))
    || previous.merged_tasks.some((item) => !item.evidence_unavailable && next.merged_tasks.find((value) => value.id === item.id)?.evidence_unavailable)
    || !!(previous.checkpoint?.evidence_available && !next.checkpoint?.evidence_available);
}
function snapshotWithdrawsEvidence(detail: TaskDetail, snapshot: TaskSnapshot) {
  return [detail.task, ...detail.merged_tasks].some((item) => !item.evidence_unavailable && snapshot.tasks.find((value) => value.id === item.id)?.evidence_unavailable)
    || detail.activities.some((item) => {
      const next = snapshot.activities.find((value) => value.id === item.id);
      return item.evidence_available && next?.evidence_available === false
        || item.resources.some((resource) => resource.evidence_available && next?.resources.find((value) => value.id === resource.id)?.evidence_available === false);
    });
}
function ResourceList({items}: {items: ResourceRef[]}) {
  return items.length ? <ul className="task-resources">{items.map((item) => <li key={item.id}>
    <span className="task-tag">{resourceLabels[item.kind]} · {item.source === "user" ? "手动填写" : "活动线索"}</span>
    <strong>{item.evidence_available ? item.label : "来源已不可用"}</strong>
    {item.evidence_available ? <p className="task-reference">{item.reference}</p> : <p>引用内容已隐藏，请重新核对来源。</p>}
  </li>)}</ul> : <p className="task-empty">还没有相关资源。</p>;
}
function ActivityCard({item, children}: {item: TaskActivity; children?: React.ReactNode}) {
  return <article className="task-activity-card" data-activity-id={item.id}>
    <div className="task-row"><strong>{item.evidence_available ? item.title : "活动来源已不可用"}</strong>
      <span className="task-tag">{item.time_kind === "manual" ? "手动确认时段" : item.time_kind === "estimated" ? "估算时段" : "采样点 · 不计工时"}</span></div>
    <p className="task-muted">{time(item.start_at)}{item.end_at !== item.start_at ? ` 至 ${time(item.end_at)}` : ""}</p>
    {item.evidence_available && <p className="task-prewrap">{item.summary}</p>}
    {item.link && <p className="task-muted">{relationLabels[item.link.relation]} · {item.link.decision === "accepted" ? "已关联" : "已排除"} · {item.link.origin === "user" ? "手动确认" : "自动建议"}{item.link.primary && item.link.decision === "accepted" ? " · 主要归属" : ""}</p>}
    <details><summary>查看证据与资源</summary>
      <p className="task-muted">{item.boundary}</p>
      <p className="task-reference">{item.source === "manual" ? "手动记录" : "本机活动观察"} · 活动编号 {item.id}{item.evidence_available && item.source_record_id ? ` · 来源编号 ${item.source_record_id}` : ""}</p>
      <ResourceList items={item.resources} />
    </details>
    {children}
  </article>;
}
function TaskForm({task, busy, onCancel, onSave}: {
  task?: NativeTask; busy: boolean; onCancel: () => void; onSave: (input: NewTask, commandId: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(task?.title || ""), [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority || "normal"), [due, setDue] = useState(localInput(task?.due_at || null));
  const [error, setError] = useState("");
  const command = useRef<{body: string; id: string} | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!title.trim()) { setError("请填写任务标题。"); return; }
    try {
      const input = {title: title.trim(), description: description.trim(), priority, due_at: iso(due)};
      const body = JSON.stringify(input);
      if (!command.current || command.current.body !== body) command.current = {body, id: newTaskCommandId()};
      setError(""); await onSave(input, command.current.id);
    } catch { setError("日期或请求编号无效，请检查后再保存。"); }
  }
  return <form className="task-form" onSubmit={submit} aria-label={task ? "编辑任务" : "新建任务"}>
    <h2>{task ? "编辑任务" : "新建任务"}</h2>
    <label htmlFor="task-title">任务标题<input id="task-title" autoFocus maxLength={200} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} required /></label>
    <label htmlFor="task-description">补充说明<textarea id="task-description" maxLength={2000} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} /></label>
    <div className="task-form-row">
      <label htmlFor="task-priority">优先级<select id="task-priority" value={priority} disabled={busy} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label htmlFor="task-due">截止时间（手动填写，本机时区）<input id="task-due" type="datetime-local" value={due} disabled={busy} onChange={(e) => setDue(e.target.value)} /></label>
    </div>
    <p className="task-muted">可以留空。截止时间和完成状态均由你确认。</p>
    {error && <p role="alert">{error}</p>}
    <div className="task-actions"><button className="task-primary" type="submit" disabled={busy}>{busy ? "正在保存…" : "保存任务"}</button><button type="button" onClick={onCancel}>取消编辑</button></div>
  </form>;
}
function ActivityForm({busy, onCancel, onSave}: {busy: boolean; onCancel: () => void; onSave: (input: NewActivity, commandId: string) => Promise<boolean>}) {
  const [title, setTitle] = useState(""), [summary, setSummary] = useState(""), [start, setStart] = useState(""), [end, setEnd] = useState(""), [error, setError] = useState("");
  const command = useRef<{body: string; id: string} | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!title.trim() || !start || !end || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 86400000) { setError("请填写标题，以及结束晚于开始且不超过 24 小时的实际时段。"); return; }
    try {
      const input = {title: title.trim(), summary: summary.trim(), start_at: iso(start)!, end_at: iso(end)!};
      const body = JSON.stringify(input); if (!command.current || command.current.body !== body) command.current = {body, id: newTaskCommandId()};
      setError(""); await onSave(input, command.current.id);
    } catch { setError("日期或请求编号无效，请检查后再保存。"); }
  }
  return <form className="task-form" aria-label="补记活动" onSubmit={submit}>
    <h2>补记实际活动</h2>
    <label htmlFor="activity-title">活动标题<input id="activity-title" maxLength={200} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} required /></label>
    <label htmlFor="activity-summary">记录说明<textarea id="activity-summary" maxLength={1000} value={summary} disabled={busy} onChange={(e) => setSummary(e.target.value)} /></label>
    <div className="task-form-row"><label htmlFor="activity-start">开始（本机时区）<input id="activity-start" type="datetime-local" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} required /></label>
      <label htmlFor="activity-end">结束（本机时区）<input id="activity-end" type="datetime-local" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} required /></label></div>
    <p className="task-muted">保存表示你确认这段实际活动时间；稍后可关联到任务。</p>
    {error && <p role="alert">{error}</p>}
    <div className="task-actions"><button type="submit" className="task-primary" disabled={busy}>保存实际活动</button><button type="button" onClick={onCancel}>取消补记</button></div>
  </form>;
}
const syncIdentityKey = "openbutler.task-sync.request.v1";
function persistSyncIdentity(identity: TaskSyncIdentity | null) {
  if (identity) {
    const encoded = JSON.stringify(identity);
    window.sessionStorage.setItem(syncIdentityKey, encoded);
    if (window.sessionStorage.getItem(syncIdentityKey) !== encoded) throw new Error("Sync identity unavailable");
  } else window.sessionStorage.removeItem(syncIdentityKey);
}
/** Only a bounded command UUID/settings version survives navigation or reload.
 * Status reads never dispatch work, and absence cannot disprove a delayed POST. */
function useTaskSync(api: TaskActivityApi, available: boolean, onProgress: () => void, onAuthorizationLoss: () => void) {
  const [operation, setOperation] = useState<TaskSyncOperation | null>(null);
  const [message, setMessage] = useState(""), [reason, setReason] = useState<TaskSyncResult["reason"]>(null);
  const [ready, setReady] = useState(false), [requesting, setRequesting] = useState(false), [unresolved, setUnresolved] = useState(false);
  const [stopUnknown, setStopUnknown] = useState(false);
  const owner = useRef(0), live = useRef(false), identity = useRef<TaskSyncIdentity | null>(null), current = useRef<TaskSyncOperation | null>(null);
  const inFlight = useRef(false), read = useRef<AbortController | null>(null), storageBlocked = useRef(false);
  const progress = useRef(onProgress), authLoss = useRef(onAuthorizationLoss);
  progress.current = onProgress; authLoss.current = onAuthorizationLoss;
  function authorizationLost() {
    // Drop the old authenticated projection and fence every outstanding reply.
    // The content-free request identity is the only durable reconciliation key.
    owner.current++; read.current?.abort(); read.current = null; inFlight.current = false;
    current.current = null; setOperation(null); setReason(null); setRequesting(false); setReady(false);
    setUnresolved(!!identity.current);
    setMessage("本机身份验证未通过，已隐藏上次同步详情。原请求结果仍需通过同一编号查询；没有重发或确认取消。");
    authLoss.current();
  }
  function apply(raw: unknown, target: TaskSyncIdentity | null) {
    const result = parseTaskSyncResult(raw);
    if (target && identity.current?.command_id !== target.command_id) return;
    if (target && !result.operation && result.reason === null) throw new Error("Missing exact sync receipt");
    const op = result.operation, previous = current.current;
    if (target && previous && !op) throw new Error("Acknowledged receipt cannot become no-dispatch");
    if (op && previous && (target || !previous.settled || op.command_id === previous.command_id)) {
      if (op.command_id !== previous.command_id) throw new Error("Changed sync receipt identity");
      const same = Object.keys(op).every((key) => op[key as keyof TaskSyncOperation] === previous[key as keyof TaskSyncOperation]);
      // A settled receipt is immutable, including its counts, even if a stale
      // or incompatible peer advertises a larger revision.
      if (previous.settled) {if (same) setMessage(""); return;}
      if (op.version < previous.version) return;
      if (op.version === previous.version) {
        if (!same) throw new Error("Conflicting sync receipt version");
        setMessage(""); return;
      }
      if (["selected", "attempted", "processed", "activities_created", "skipped_invalid"].some((key) => Number(op[key as keyof TaskSyncOperation]) < Number(previous[key as keyof TaskSyncOperation])) ||
          ["provider", "settings_version", "bounded_to", "created_at"].some((key) => op[key as keyof TaskSyncOperation] !== previous[key as keyof TaskSyncOperation]) ||
          previous.has_more !== null && op.has_more !== previous.has_more || previous.state === "stopping" && op.state === "pending" ||
          Date.parse(op.updated_at) < Date.parse(previous.updated_at)) throw new Error("Regressed sync receipt");
    }
    if (op && !op.settled && !target) {
      const known = {command_id: op.command_id, expected_version: op.settings_version};
      persistSyncIdentity(known); identity.current = known;
    }
    if (!op || op.settled) { persistSyncIdentity(null); identity.current = null; }
    current.current = op; setOperation(op); setUnresolved(!!identity.current); setReason(result.reason); setMessage("");
    if (!op || op.state !== "pending") setStopUnknown(false);
    if (op && (!previous || op.version !== previous.version)) progress.current();
  }
  async function reconcile() {
    if (!live.current || storageBlocked.current || read.current && !read.current.signal.aborted) return;
    // Native IPC cancellation is local suppression only. Coalesce timer/focus
    // reads rather than abandoning a slow request every two seconds.
    const controller = new AbortController(); read.current = controller;
    const ticket = owner.current, target = identity.current;
    try {
      const value = await api.syncStatus(target?.command_id, controller.signal);
      if (!live.current || ticket !== owner.current || controller.signal.aborted) return;
      // A latest read begun before a new command cannot replace its exact receipt.
      if ((identity.current?.command_id || null) !== (target?.command_id || null)) return;
      apply(value, target); setReady(true);
    } catch (failure) {
      if (!live.current || ticket !== owner.current || controller.signal.aborted || isAbort(failure) ||
          (identity.current?.command_id || null) !== (target?.command_id || null)) return;
      if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) {authorizationLost(); return;}
      setMessage(failure instanceof TaskRequestError && failure.code === "task_sync_not_found"
        ? "暂未查到这次同步。原请求仍可能延迟到达，不能据此确认取消；请求编号已保留，没有自动重试。"
        : `同步状态尚未确认。${target ? "原请求编号已保留；" : ""}仅查询状态，不自动重试或宣称完成。请恢复本机连接后核对。`);
      // A failed initial latest lookup must not enable a new operation.
      setReady(!!target); setUnresolved(!!target);
    } finally {if (read.current === controller) read.current = null;}
  }
  const reconcileLatest = useRef(reconcile); reconcileLatest.current = reconcile;
  useEffect(() => {
    live.current = true; owner.current++; inFlight.current = false; storageBlocked.current = false;
    current.current = null; identity.current = null; setOperation(null); setMessage(""); setReason(null); setReady(false); setRequesting(false); setUnresolved(false); setStopUnknown(false);
    if (available) {
      try {
        const raw = window.sessionStorage.getItem(syncIdentityKey);
        if (raw !== null) {
          if (raw.length > 160) throw new Error("Invalid sync identity");
          identity.current = parseTaskSyncIdentity(JSON.parse(raw)); setUnresolved(true);
        }
        void reconcileLatest.current();
      } catch {
        storageBlocked.current = true;
        setMessage("无法安全保留或读取同步请求编号，已暂停新同步。请重新打开桌面应用后核对已有同步状态。");
      }
    }
    return () => {live.current = false; owner.current++; read.current?.abort();};
  }, [api, available]);
  useEffect(() => {
    if (!available) return;
    function visible() { if (document.visibilityState === "visible") void reconcileLatest.current(); }
    const timer = window.setInterval(() => {if (identity.current && document.visibilityState === "visible") void reconcileLatest.current();}, 2000);
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => {window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible);};
  }, [api, available]);
  async function start(expected_version: number, resubmit = false) {
    if (!live.current || !ready || inFlight.current || storageBlocked.current || current.current && !current.current.settled || identity.current && !resubmit) return;
    const ticket = owner.current;
    let target: TaskSyncIdentity;
    try {
      target = identity.current || {command_id: newTaskCommandId(), expected_version};
      persistSyncIdentity(target);
    } catch {
      setMessage("无法安全保存同步请求编号，本次没有发送同步请求。请恢复本机存储后再试。"); return;
    }
    read.current?.abort(); identity.current = target; current.current = null; setOperation(null); setReason(null); setUnresolved(true);
    inFlight.current = true; setRequesting(true); setMessage("");
    try {
      const value = await api.sync(target);
      if (live.current && ticket === owner.current) apply(value, target);
    } catch (failure) {
      if (!live.current || ticket !== owner.current || identity.current?.command_id !== target.command_id) return;
      if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) {authorizationLost(); return;}
      if (current.current) return; // An independent exact lookup already confirmed admission.
      if (failure instanceof TaskRequestError && failure.code === "version_conflict" && !current.current) {
        try {persistSyncIdentity(null);} catch {
          setMessage("本次同步未获接收，但请求编号暂时无法清除。请恢复本机存储后查询状态；没有重发请求。"); return;
        }
        identity.current = null; setUnresolved(false);
        setMessage("发现设置已变化，本次同步未获接收。请重新读取并核对当前设置后，再手动同步；没有自动重试。"); progress.current();
      } else setMessage("同步请求结果尚未确认。请求编号和原设置版本已保留；离开页面不会撤销请求，没有自动重试。请查询状态，或明确重发同一请求。");
    } finally {if (live.current && ticket === owner.current) {inFlight.current = false; setRequesting(false);}}
  }
  async function stop() {
    const target = identity.current;
    if (!live.current || !target || inFlight.current) return;
    const ticket = owner.current; inFlight.current = true; setRequesting(true); setStopUnknown(true); setMessage("");
    try {
      const value = await api.stopSync(target.command_id);
      if (live.current && ticket === owner.current) apply(value, target);
    } catch (failure) {
      if (!live.current || ticket !== owner.current || identity.current?.command_id !== target.command_id) return;
      if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) {authorizationLost(); return;}
      setMessage("停止请求结果尚未确认，不能确认已取消。原请求仍可能完成或延迟到达；继续查询同一请求，不会撤销已提交的记录。");
    } finally {if (live.current && ticket === owner.current) {inFlight.current = false; setRequesting(false);}}
  }
  return {operation, message, reason, ready, requesting, unresolved, stopUnknown, start, stop, reconcile, invalidateAuthorization: authorizationLost,
    canStart: ready && !requesting && !unresolved && !storageBlocked.current,
    canResubmit: ready && unresolved && !operation && !requesting && !stopUnknown && !storageBlocked.current};
}
function SyncStatus({sync, version}: {sync: ReturnType<typeof useTaskSync>; version?: number}) {
  const op = sync.operation;
  if (!op && !sync.message && !sync.unresolved && !sync.reason) return null;
  const label = op ? {pending: "同步进行中", stopping: "正在停止同步，等待本机处理退出", complete: "同步已完成", error: "同步失败", interrupted: "同步已中断"}[op.state] : sync.requesting ? "正在提交同步请求" : "同步结果尚未确认";
  return <section className="task-boundary" aria-label="本机同步状态">
    {op || sync.unresolved ? <p role="status">{label}。离开页面仍可稍后查询；不会阻止查看或编辑任务。</p> : null}
    {op && <><p>{providerLabel(op.provider)} · 已选择 {op.selected} 条，已开始 {op.attempted} 条，已完成提取 {op.processed} 条，新保存活动 {op.activities_created} 条，跳过无效来源 {op.skipped_invalid} 条。</p>
      <p className="task-muted">计数不代表模型调用次数、新任务数或任务提取质量。{op.has_more === null ? "尚未确定是否还有待处理活动。" : op.has_more ? "仍有待处理活动；本次结束后可再手动同步。" : "本次没有报告更多待处理活动。"}</p>
      {op.state === "error" && <p>此前已提交的活动或线索仍保留，错误不会回滚；请以上述计数核对。</p>}
      {op.reason && <p className={op.state === "error" ? "task-warning" : "task-muted"} role={op.state === "error" ? "alert" : undefined}>{op.reason in taskDiscoveryFailures ? taskDiscoveryFailures[op.reason as keyof typeof taskDiscoveryFailures].replace(/本次/g, "这条记录") : taskSyncLifecycleReasons[op.reason as keyof typeof taskSyncLifecycleReasons]}</p>}</>}
    {sync.reason && <p>已有线索整理正在进行，本次没有重复启动。稍后可刷新查看活动。</p>}
    {sync.message && <p className="task-warning" role="alert">{sync.message}</p>}
    {sync.stopUnknown && <p className="task-warning">停止请求正在确认，尚不能保证已停止。</p>}
    {sync.canResubmit && <p className="task-warning">重发表示你明确要求继续同步，即使此前尝试过停止；仍使用原请求编号和原设置版本。</p>}
    <div className="task-actions"><button onClick={() => void sync.reconcile()}>查询同步状态</button>
      {sync.unresolved && <button disabled={sync.requesting || op?.state === "stopping"} onClick={() => void sync.stop()}>停止本次同步</button>}
      {sync.canResubmit && version !== undefined && <button onClick={() => void sync.start(version, true)}>确认继续执行并重发原请求</button>}
    </div>
    {sync.unresolved && <p className="task-muted">停止只阻止后续提交，不会撤销已经保存的活动或线索。没有自动重试。</p>}
  </section>;
}
type Mutate = (message: string | ((result: unknown) => string), action: () => Promise<unknown>, after?: (result: unknown) => void) => Promise<boolean>;
function DetailPanel({detail, snapshot, busy, mutate, onClose, invalidateView, onDraftChange}: {detail: TaskDetail; snapshot: TaskSnapshot; busy: boolean; mutate: Mutate; onClose: () => void; invalidateView: () => void; onDraftChange: (editing: boolean) => void}) {
  const task = detail.task;
  const [editing, setEditing] = useState(false), [addingResource, setAddingResource] = useState(false), [editingCheckpoint, setEditingCheckpoint] = useState(false), [merging, setMerging] = useState(false);
  // Each editor keeps the version the user actually began editing. A separate
  // action may refresh displayed data, but cannot silently rebase that draft.
  const editVersion = useRef(task.version), checkpointVersion = useRef(task.version), resourceVersion = useRef(task.version), mergeVersion = useRef(task.version), mergeTargetVersion = useRef<number | null>(null), linkVersion = useRef<number | null>(null);
  const [target, setTarget] = useState(""), [activity, setActivity] = useState(""), [relation, setRelation] = useState<ActivityLink["relation"]>("work"), [primary, setPrimary] = useState(true);
  const [nextStep, setNextStep] = useState(detail.checkpoint?.evidence_available ? detail.checkpoint.next_step : ""), [checkpointRef, setCheckpointRef] = useState(detail.checkpoint?.evidence_available ? detail.checkpoint.resource_ref || "" : "");
  const [resourceKind, setResourceKind] = useState<NewResource["kind"]>("document"), [resourceLabel, setResourceLabel] = useState(""), [resourceReference, setResourceReference] = useState("");
  // Same-task refreshes retain component identity. Update authoritative values
  // only outside an unfinished editor; entering the editor uses the latest read.
  useEffect(() => {
    if (!editingCheckpoint) {
      setNextStep(detail.checkpoint?.evidence_available ? detail.checkpoint.next_step : "");
      setCheckpointRef(detail.checkpoint?.evidence_available ? detail.checkpoint.resource_ref || "" : "");
    }
  }, [detail.checkpoint?.next_step, detail.checkpoint?.resource_ref, detail.checkpoint?.evidence_available, editingCheckpoint]);
  const resourceCommand = useRef<{body: string; id: string} | null>(null);
  useEffect(() => {onDraftChange(editing || addingResource || editingCheckpoint || merging || !!activity); return () => onDraftChange(false);}, [editing, addingResource, editingCheckpoint, merging, activity]);
  const editable = !task.archived && !task.merged_into;
  const targets = snapshot.tasks.filter((item) => item.id !== task.id && !item.archived && !item.merged_into);
  function cancel(action: () => void) { invalidateView(); action(); }
  const api = useTaskApi();
  function patch(values: Omit<Parameters<TaskActivityApi["update"]>[1], "expected_version">, message: string) { return mutate(message, () => api.update(task.id, {...values, expected_version: task.version})); }
  if (editing) return <TaskForm task={task} busy={busy} onCancel={() => cancel(() => setEditing(false))} onSave={(input) => mutate("任务已保存。", () => api.update(task.id, {...input, expected_version: editVersion.current}), () => setEditing(false))} />;
  return <section className="task-detail" aria-label="任务详情">
    <div className="task-row"><span className="task-kicker">任务详情</span><button onClick={onClose}>关闭详情</button></div>
    <h2>{task.title}</h2>
    <div className="task-tags"><span className="task-tag">{origin(task)}</span><span className="task-tag">{statusLabels[task.status]}</span><span className="task-tag">{priorityLabels[task.priority]}优先级</span>{task.archived && <span className="task-tag">已归档</span>}{task.merged_into && <span className="task-tag">已合并</span>}</div>
    {task.evidence_unavailable && <p className="task-warning">部分来源已不可用。已确认的任务文字仍保留，相关证据需要重新核对。</p>}
    <p className="task-prewrap">{task.description || "还没有补充说明。"}</p>
    <dl className="task-facts"><div><dt>截止时间</dt><dd>{time(task.due_at)}{task.due_at ? " · 手动填写" : ""}</dd></div><div><dt>完成时间</dt><dd>{task.completed_at ? `${time(task.completed_at)} · 手动确认` : "尚未确认完成"}</dd></div></dl>
    <div className="task-actions">
      <button disabled={busy || !editable} onClick={() => {editVersion.current = task.version; setEditing(true);}}>编辑任务</button>
      {!task.confirmed && <button disabled={busy || !editable || task.evidence_unavailable} onClick={() => patch({confirmed: true}, "已确认任务线索。")}>确认这项任务</button>}
      {task.status === "todo" && <button disabled={busy || !editable} onClick={() => patch({status: "doing"}, "已标记进行中。")}>开始处理</button>}
      {task.status !== "done" ? <button disabled={busy || !editable} onClick={() => patch({status: "done"}, "已手动标记完成。")}>标记完成（手动）</button> : <button disabled={busy || !editable} onClick={() => patch({status: "todo"}, "任务已重新打开。")}>重新打开</button>}
      <button disabled={busy || !!task.merged_into} onClick={() => patch({archived: !task.archived}, task.archived ? "任务已恢复。" : "任务已归档，可随时恢复。")}>{task.archived ? "恢复任务" : "归档任务"}</button>
    </div>
    <section className="task-section"><div className="task-row"><h3>从这里继续</h3><button disabled={busy || !editable || editingCheckpoint} onClick={() => {checkpointVersion.current = task.version; setEditingCheckpoint(true);}}>编辑续接点</button></div>
      {editingCheckpoint ? <form className="task-form" onSubmit={(event) => {event.preventDefault(); if (nextStep.trim()) void mutate("续接点已保存。", () => api.checkpoint(task.id, checkpointVersion.current, nextStep.trim(), checkpointRef.trim() || null), () => setEditingCheckpoint(false));}}>
        <label htmlFor="task-next-step">下一步<textarea id="task-next-step" maxLength={1000} required disabled={busy} value={nextStep} onChange={(e) => setNextStep(e.target.value)} /></label>
        <label htmlFor="task-checkpoint-resource">续接资源引用（可选）<input id="task-checkpoint-resource" maxLength={500} disabled={busy} value={checkpointRef} onChange={(e) => setCheckpointRef(e.target.value)} /></label>
        <div className="task-actions"><button type="submit" disabled={busy}>保存续接点</button><button type="button" onClick={() => cancel(() => setEditingCheckpoint(false))}>取消续接点</button></div>
      </form> : detail.checkpoint?.evidence_available ? <><p className="task-prewrap">{detail.checkpoint.next_step}</p>{detail.checkpoint.resource_ref && <p className="task-reference">{detail.checkpoint.resource_ref}</p>}<p className="task-muted">{detail.checkpoint.source === "user" ? "手动记录" : "活动线索 · 待核对"} · {time(detail.checkpoint.observed_at)}</p></> : <p className="task-empty">{detail.checkpoint ? "续接点的来源已不可用，请重新填写。" : "记下下一步和要用的资源，回来时就能继续。"}</p>}
    </section>
    <section className="task-section"><h3>时间记录</h3><div className="task-time-grid"><div><span>手动确认</span><strong>{duration(detail.time.manual_seconds)}</strong></div><div><span>活动估算</span><strong>{duration(detail.time.estimated_seconds)}</strong></div><div><span>观察跨度</span><strong>{duration(detail.time.observed_span_seconds)}</strong></div></div>
      <p className="task-muted">采样点和观察跨度不等于实际工时。未观测间隔未知，不自动补齐。</p><p className="task-muted">{detail.time.boundary}</p></section>
    <section className="task-section"><div className="task-row"><h3>相关资源</h3><button disabled={busy || !editable || addingResource} onClick={() => {resourceVersion.current = task.version; setAddingResource(true);}}>添加资源引用</button></div>
      <p className="task-muted">仅显示文字引用。不会自动打开文件、网址或窗口。</p><ResourceList items={detail.resources} />
      {addingResource && <form className="task-form" onSubmit={(event) => {event.preventDefault(); if (!resourceLabel.trim() || !resourceReference.trim()) return; const input: NewResource = {kind: resourceKind, label: resourceLabel.trim(), reference: resourceReference.trim()}; const body = JSON.stringify(input); if (!resourceCommand.current || resourceCommand.current.body !== body) resourceCommand.current = {body, id: newTaskCommandId()}; const id = resourceCommand.current.id; void mutate("资源引用已保存。", () => api.resource(task.id, resourceVersion.current, input, id), () => {setAddingResource(false); setResourceLabel(""); setResourceReference(""); resourceCommand.current = null;});}}>
        <label htmlFor="task-resource-kind">引用类型<select id="task-resource-kind" value={resourceKind} disabled={busy} onChange={(e) => setResourceKind(e.target.value as NewResource["kind"])}>{Object.entries(resourceLabels).filter(([value]) => value !== "evidence").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label htmlFor="task-resource-label">名称<input id="task-resource-label" value={resourceLabel} maxLength={200} required disabled={busy} onChange={(e) => setResourceLabel(e.target.value)} /></label>
        <label htmlFor="task-resource-reference">引用文字<input id="task-resource-reference" value={resourceReference} maxLength={1000} required disabled={busy} onChange={(e) => setResourceReference(e.target.value)} /></label>
        <div className="task-actions"><button type="submit" disabled={busy}>保存资源引用</button><button type="button" onClick={() => cancel(() => setAddingResource(false))}>取消资源引用</button></div>
      </form>}
    </section>
    <section className="task-section"><h3>相关活动时间线</h3>
      {detail.activities.length ? <div className="task-activity-list">{detail.activities.map((item) => <ActivityCard key={item.id} item={item}>
        <div className="task-actions"><button disabled={busy || !editable} onClick={() => mutate("活动归属已更正。", () => api.link(task.id, item.id, {expected_version: task.version, relation: item.link?.relation || "possible", decision: item.link?.decision === "accepted" ? "rejected" : "accepted", primary: item.link?.decision !== "accepted" && item.link?.relation === "work"}))}>{item.link?.decision === "accepted" ? "排除此关联" : "重新关联"}</button></div>
      </ActivityCard>)}</div> : <p className="task-empty">暂无相关活动。可从已保存的本机活动中手动关联。</p>}
      <form className="task-form" onSubmit={(event) => {event.preventDefault(); if (activity && linkVersion.current !== null) void mutate("活动已手动关联。", () => api.link(task.id, activity, {expected_version: linkVersion.current!, relation, decision: "accepted", primary: (relation === "work" || relation === "preparation") && primary}), () => {setActivity(""); setRelation("work"); setPrimary(true); linkVersion.current = null;});}}>
        <label htmlFor="task-link-activity">选择活动<select id="task-link-activity" value={activity} disabled={busy || !editable} onChange={(e) => {setActivity(e.target.value); if (!e.target.value) linkVersion.current = null; else if (linkVersion.current === null) linkVersion.current = task.version;}}><option value="">请选择活动</option>{snapshot.activities.filter((item) => item.evidence_available).map((item) => <option key={item.id} value={item.id}>{item.title} · {time(item.start_at)}</option>)}</select></label>
        <label htmlFor="task-link-relation">关联类型<select id="task-link-relation" value={relation} disabled={busy || !editable} onChange={(e) => setRelation(e.target.value as ActivityLink["relation"])}>{Object.entries(relationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {(relation === "work" || relation === "preparation") && <label className="task-check"><input type="checkbox" checked={primary} disabled={busy || !editable} onChange={(e) => setPrimary(e.target.checked)} />设为主要归属（避免多任务重复计时）</label>}
        <button type="submit" disabled={busy || !editable || !activity}>确认关联或更正</button>
      </form>
    </section>
    <section className="task-section"><div className="task-row"><h3>重复任务整理</h3><button disabled={busy || !editable || merging || !targets.length} onClick={() => {mergeVersion.current = task.version; setTarget(""); mergeTargetVersion.current = null; setMerging(true);}}>合并到另一任务</button></div>
      <p className="task-muted">合并会保留原任务，可撤销；不会替你改变目标任务的截止时间或完成状态。</p>
      {merging && <form className="task-form" onSubmit={(event) => {event.preventDefault(); const selected = targets.find((item) => item.id === target); if (selected && mergeTargetVersion.current !== null) void mutate("任务已合并，可在目标任务中撤销。", () => api.merge(task.id, mergeVersion.current, selected.id, mergeTargetVersion.current!), () => setMerging(false));}}>
        <label htmlFor="task-merge-target">保留的目标任务<select id="task-merge-target" value={target} disabled={busy} onChange={(e) => {setTarget(e.target.value); mergeTargetVersion.current = targets.find((item) => item.id === e.target.value)?.version ?? null;}}><option value="">请选择目标任务</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <div className="task-actions"><button type="submit" disabled={busy || !target}>确认合并</button><button type="button" onClick={() => cancel(() => setMerging(false))}>取消合并</button></div>
      </form>}
      {task.merged_into && <button disabled={busy} onClick={() => mutate("合并已撤销，原任务已恢复。", () => api.unmerge(task.id, task.version))}>撤销此任务合并</button>}
      {detail.merged_tasks.map((item) => <div className="task-row" key={item.id}><span>{item.title}</span><button disabled={busy} onClick={() => mutate("合并已撤销，原任务已恢复。", () => api.unmerge(item.id, item.version))}>撤销合并：{item.title}</button></div>)}
    </section>
  </section>;
}

// A React context keeps test injection and all nested mutations on one transport.
const TaskApiContext = createContext(taskActivityApi);
const useTaskApi = () => useContext(TaskApiContext);

export function TaskWorkspace({api = taskActivityApi}: {api?: TaskActivityApi}) {
  const available = nativeTaskWorkspaceAvailable();
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [detailView, setDetailView] = useState<{value: TaskDetail | null; editorRevision: number}>({value: null, editorRevision: 0});
  const detail = detailView.value;
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"tasks" | "discoveries" | "activities">("tasks"), [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("open"), [query, setQuery] = useState(""), [creating, setCreating] = useState(false), [addingActivity, setAddingActivity] = useState(false), [confirmDiscovery, setConfirmDiscovery] = useState(false), [pending, setPending] = useState("");
  const [providerDraft, setProviderDraft] = useState<TaskActivitySettings["provider"] | null>(null);
  const mounted = useRef(false), epoch = useRef(0), selectedRef = useRef<string | null>(null), busyRef = useRef(false);
  const childDraft = useRef(false), ownDraft = useRef(false), refreshLatest = useRef<() => Promise<boolean>>(async () => false);
  ownDraft.current = creating || addingActivity || confirmDiscovery;
  const listRead = useRef<AbortController | null>(null), detailRead = useRef<AbortController | null>(null);
  function setDetail(next: TaskDetail | null | ((current: TaskDetail | null) => TaskDetail | null)) {
    setDetailView((current) => {
      const value = typeof next === "function" ? next(current.value) : next;
      // A clear can be batched with an immediately resolved replacement. Bump
      // the editor key too; a queued null does not guarantee a committed unmount.
      const resetEditor = childDraft.current && current.value && (!value || current.value.task.id === value.task.id && evidenceWithdrawn(current.value, value));
      return value === current.value ? current : {value, editorRevision: current.editorRevision + (resetEditor ? 1 : 0)};
    });
  }
  function invalidateView() { epoch.current++; }
  function closeDetail() { invalidateView(); selectedRef.current = null; setSelected(null); setDetail(null); detailRead.current?.abort(); setDetailLoading(false); }
  async function readDetail(id: string, preserveSameTask = false, forceApply = false) {
    detailRead.current?.abort(); const controller = new AbortController(); detailRead.current = controller;
    // Refreshing an open task must not detach scrolled action targets while the
    // read is in flight. New navigation still hides the previous task at once.
    setDetail((current) => preserveSameTask && current?.task.id === id ? current : null);
    setDetailLoading(true);
    try {
      const value = await api.detail(id, controller.signal);
      if (!mounted.current || controller.signal.aborted || selectedRef.current !== id) return false;
      // A user may begin editing while a same-task detail read is pending.
      // Privacy projections must still apply, including to confirmed/manual tasks.
      setDetail((current) => !preserveSameTask || forceApply || !current || evidenceWithdrawn(current, value) || (!childDraft.current && !ownDraft.current) ? value : current);
      return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !isAbort(failure) && selectedRef.current === id) {
        setDetail(null);
        setError(failure instanceof Error ? failure.message : "无法读取任务详情。");
        if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) sync.invalidateAuthorization();
      }
      return false;
    } finally { if (mounted.current && !controller.signal.aborted && selectedRef.current === id) setDetailLoading(false); }
  }
  async function refresh(forceDetail = false) {
    listRead.current?.abort(); const controller = new AbortController(); listRead.current = controller;
    setLoading(true);
    try {
      const value = await api.load(controller.signal);
      if (!mounted.current || controller.signal.aborted) return false;
      setSnapshot(value);
      const selectedTask = value.tasks.find((item) => item.id === selectedRef.current);
      const withdrawnEvidence = value.tasks.some((item) => item.evidence_unavailable) || value.activities.some((item) => !item.evidence_available || item.resources.some((resource) => !resource.evidence_available));
      if (selectedRef.current && (forceDetail || withdrawnEvidence || (!childDraft.current && !ownDraft.current))) {
        if (selectedTask) {
          // Hide newly withdrawn content immediately, without repeatedly tearing
          // down a task whose unavailable evidence is already redacted.
          setDetail((current) => current && snapshotWithdrawsEvidence(current, value) ? null : current);
          return await readDetail(selectedRef.current, true, forceDetail);
        } else closeDetail();
      }
      return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !isAbort(failure)) {
        setSnapshot(null); setDetail(null); detailRead.current?.abort();
        if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) sync.invalidateAuthorization();
        setError(failure instanceof Error ? failure.message : "无法读取本机任务。内容已隐藏，请重新读取。");
      }
      return false;
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }
  refreshLatest.current = refresh;
  const sync = useTaskSync(api, available, () => {if (!busyRef.current) void refreshLatest.current();}, () => {
    listRead.current?.abort(); detailRead.current?.abort(); setSnapshot(null); setDetail(null); setLoading(false); setDetailLoading(false);
  });
  useEffect(() => {
    mounted.current = true;
    if (available) void refresh();
    return () => { mounted.current = false; epoch.current++; listRead.current?.abort(); detailRead.current?.abort(); };
  }, [api, available]);
  useEffect(() => {
    if (!available) return;
    function refreshVisible() {
      if (document.visibilityState !== "visible" || busyRef.current || childDraft.current || ownDraft.current) return;
      void refreshLatest.current();
    }
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const interval = window.setInterval(refreshVisible, 30000);
    return () => {window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); window.clearInterval(interval);};
  }, [available]);
  function openTask(id: string) { invalidateView(); setCreating(false); setTab("tasks"); selectedRef.current = id; setSelected(id); setError(""); void readDetail(id); }
  function changeTab(value: typeof tab) { closeDetail(); setCreating(false); setAddingActivity(false); setConfirmDiscovery(false); setProviderDraft(null); setTab(value); setError(""); }
  const mutate: Mutate = async (message, action, after) => {
    if (busyRef.current || !snapshot) return false;
    busyRef.current = true;
    // A preserved action can be clicked during a read. That read must not later
    // overwrite the mutation's authoritative reconciliation with its old result.
    listRead.current?.abort(); detailRead.current?.abort(); setLoading(false); setDetailLoading(false);
    const ticket = epoch.current; setPending("正在保存到本机"); setError(""); setNotice("");
    try {
      const result = await action();
      if (!mounted.current) return true;
      setNotice(typeof message === "function" ? message(result) : message);
      await refresh(true);
      if (mounted.current && epoch.current === ticket) after?.(result);
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      if (failure instanceof TaskRequestError && failure.code && failure.code in taskDiscoveryFailures) {
        const refreshed = await refresh(!(childDraft.current || ownDraft.current));
        if (mounted.current) setError(taskDiscoveryFailures[failure.code as keyof typeof taskDiscoveryFailures]
          + (refreshed ? "" : " 当前记录重新读取未成功，请恢复本机连接后再核对。"));
      } else if (failure instanceof TaskRequestError && failure.status === 409) {
        const preserveDraft = childDraft.current || ownDraft.current;
        const refreshed = await refresh(!preserveDraft);
        if (mounted.current) setError(refreshed ? preserveDraft
          ? "记录已变化，当前草稿已保留。请先取消编辑，再重新打开任务核对，本次没有自动重试。"
          : "记录已变化，已重新读取。请核对当前内容后再操作，本次没有自动重试。"
          : "记录已变化，但重新读取未成功。内容已隐藏，请恢复本机连接后再核对。");
      } else {
        if (failure instanceof TaskRequestError && [401, 403].includes(failure.status)) sync.invalidateAuthorization();
        setError(failure instanceof TaskRequestError && [400, 401, 403, 404, 422].includes(failure.status) ? failure.message : "请求结果尚未确认。请刷新核对本机记录后再操作，避免重复新建。离开页面不会撤销已提交的请求。");
      }
      return false;
    } finally { busyRef.current = false; if (mounted.current) setPending(""); }
  };
  if (!available) return <section className="task-workspace"><header><p className="task-kicker">本机任务</p><h1>任务与活动</h1></header><p className="task-empty">请在本机 Preview 桌面应用中打开任务工作区。网页样例不读取或保存个人任务。</p></section>;
  const pendingDiscoveries = snapshot?.discoveries.filter((item) => item.state === "pending") || [];
  const tasks = snapshot?.tasks.filter((item) => {
    if (filter === "archived" ? !item.archived : item.archived || item.merged_into) return false;
    if (filter === "open" && item.status === "done" || filter === "done" && item.status !== "done") return false;
    return `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }) || [];
  const pendingDiscoveryCount = snapshot?.pendingDiscoveryCount || 0;
  const busy = !!pending;
  const discoveryProvider = providerDraft || snapshot?.settings.provider || "evidence_rules_v1";
  return <TaskApiContext.Provider value={api}><section className="task-workspace">
    <header className="task-header"><div><p className="task-kicker">本机任务 · 活动线索</p><h1>任务与活动</h1><p className="task-muted">把要做的事、相关证据和下一步放在一起。</p></div><div className="task-actions"><button disabled={busy || loading} onClick={() => {setError(""); void refresh();}}>{loading ? "正在读取…" : "刷新任务"}</button><button className="task-primary" disabled={busy || !snapshot} onClick={() => {closeDetail(); setTab("tasks"); setCreating(true);}}>新建任务</button></div></header>
    <p className="task-boundary">数据保存在本机。任务记录与“问管家”的执行目标独立；保存任务不会启动自动执行或提醒。</p>
    {error && <p className="task-warning" role="alert">{error}</p>}{notice && <p className="task-success" role="status">{notice}</p>}{busy && <p role="status" className="task-muted">正在保存到本机。切换或关闭页面不会撤销已提交的操作。</p>}
    <SyncStatus sync={sync} version={snapshot?.settings.version} />
    <div className="task-tabs" role="tablist" aria-label="任务工作区视图">{([['tasks', '任务'], ['discoveries', `待确认线索${pendingDiscoveryCount ? ` (${pendingDiscoveryCount})` : ''}`], ['activities', '活动记录']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} id={`task-tab-${key}`} aria-controls={`task-panel-${key}`} onClick={() => changeTab(key)}>{label}</button>)}</div>
    {!snapshot ? <p className="task-empty">{loading ? "正在读取本机任务与活动…" : "当前无法读取任务。请检查本机服务后刷新。"}</p> : <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`}>
      {tab === "tasks" && <div className="task-layout"><aside className="task-list-pane" aria-label="任务列表">
        <label htmlFor="task-search">搜索任务<input id="task-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="标题或说明" /></label>
        <label htmlFor="task-filter">显示<select id="task-filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">未完成</option><option value="done">已完成</option><option value="all">全部未归档</option><option value="archived">已归档</option></select></label>
        <div className="task-list">{tasks.length ? tasks.map((item) => <button className="task-choice" key={item.id} aria-pressed={selected === item.id} onClick={() => openTask(item.id)}><strong>{item.title}</strong><span>{statusLabels[item.status]} · {priorityLabels[item.priority]}优先级</span><span className="task-muted">{origin(item)}</span>{item.due_at && <span className="task-muted">截止 {time(item.due_at)}</span>}</button>) : <p className="task-empty">{query ? "没有匹配的任务。" : filter === "archived" ? "还没有归档任务。" : "这里还没有任务。手动创建一项，或核对待确认线索。"}</p>}</div>
      </aside><div className="task-detail-pane">{creating ? <TaskForm busy={busy} onCancel={() => {invalidateView(); setCreating(false);}} onSave={(input, commandId) => mutate("任务已保存。", () => api.create(input, commandId), (result) => openTask((result as NativeTask).id))} /> : detail && selected === detail.task.id ? <DetailPanel key={`${detail.task.id}:${detailView.editorRevision}`} detail={detail} snapshot={snapshot} busy={busy} mutate={mutate} onClose={closeDetail} invalidateView={invalidateView} onDraftChange={(value) => {childDraft.current = value;}} /> : <p className="task-empty">{detailLoading ? "正在读取任务详情…" : "选择一个任务，查看相关活动和续接点。"}</p>}</div></div>}
      {tab === "discoveries" && <div className="task-discovery-layout"><section className="task-card"><h2>发现设置</h2><p>当前：{snapshot.settings.auto_discovery ? "已启用本地线索发现" : "自动发现已关闭"}</p><p className="task-muted">模糊内容先进入待确认队列；截止时间和完成状态仍需手动确认。</p><p className="task-muted">{snapshot.settings.boundary}</p>
        <label htmlFor="task-discovery-provider">发现方式<select id="task-discovery-provider" value={discoveryProvider} disabled={busy || snapshot.settings.auto_discovery} onChange={(event) => {setProviderDraft(event.target.value as TaskActivitySettings["provider"]); setConfirmDiscovery(false);}}><option value="evidence_rules_v1">本地证据规则</option><option value="local_model_v1" disabled={!snapshot.settings.model_discovery_available}>已配置的本地模型（实验性 · 全部待确认）{snapshot.settings.model_discovery_available ? "" : "（当前不可用）"}</option></select></label>
        <p className="task-muted">{discoveryProvider === "local_model_v1" ? "经本机网关使用已配置的本地文字模型。该实验功能尚未通过任务提取质量验证；所有模型线索都需你确认，不自动新建任务或建立关联。" : "使用固定文字规则，不调用模型。"}{snapshot.settings.auto_discovery ? " 切换方式前请先关闭发现。" : ""}</p>
        {snapshot.settings.last_error && <p className="task-warning">{taskDiscoveryFailures[snapshot.settings.last_error]}</p>}
        {snapshot.settings.auto_discovery ? <button disabled={busy} onClick={() => mutate("已关闭新线索发现，已有任务保留。", () => api.settings(snapshot.settings.version, false, snapshot.settings.provider))}>关闭线索发现</button> : <button disabled={busy || (discoveryProvider === "local_model_v1" && !snapshot.settings.model_discovery_available)} onClick={() => setConfirmDiscovery(true)}>开启线索发现</button>}
        {confirmDiscovery && !snapshot.settings.auto_discovery && <div className="task-confirm"><p>只处理已有授权且保存在本机的观察文字。发现方式：{discoveryProvider === "local_model_v1" ? "实验性本地文字模型（所有线索待确认）" : "本地证据规则"}。不启用采集，不调用外部模型。要开启吗？</p><div className="task-actions"><button disabled={busy} onClick={() => mutate("已开启本机线索发现。", () => api.settings(snapshot.settings.version, true, discoveryProvider), () => setConfirmDiscovery(false))}>确认开启</button><button onClick={() => {invalidateView(); setConfirmDiscovery(false);}}>暂不开启</button></div></div>}
        <button disabled={!sync.canStart} onClick={() => void sync.start(snapshot.settings.version)}>同步已有本机活动</button><p className="task-muted">同步只整理已保存的授权观察，不开启采集。</p>
      </section><section className="task-card"><h2>待确认线索</h2>{snapshot.hasMorePendingDiscoveries && <p className="task-boundary" role="status">当前显示前 {pendingDiscoveries.length} 条待确认线索，还有 {snapshot.pendingDiscoveryCount - pendingDiscoveries.length} 条待确认；处理后会继续显示。</p>}{pendingDiscoveries.length ? pendingDiscoveries.map((item) => <article className="task-discovery" key={item.id}><span className="task-tag">{providerLabel(item.provider)} · 未核实 · 待确认</span><h3>{item.title}</h3><p className="task-prewrap">{item.quote}</p><p className="task-reference">活动编号 {item.activity_id} · 关联置信度 {Math.round(item.confidence * 100)}%（不是事实保证）</p><div className="task-actions"><button disabled={busy} onClick={() => mutate("线索已确认并保存为任务。", () => api.resolve(item.id, item.version, "accept"))}>确认成任务</button><button disabled={busy} onClick={() => mutate("已忽略这条线索。", () => api.resolve(item.id, item.version, "dismiss"))}>忽略线索</button></div></article>) : <p className="task-empty">没有等待确认的线索。缺少证据时不会自动补全任务。</p>}</section></div>}
      {tab === "activities" && <section className="task-card"><div className="task-row"><h2>活动记录</h2><button disabled={busy} onClick={() => {invalidateView(); setAddingActivity(true);}}>补记活动</button></div><p className="task-muted">采样记录仅说明某个时刻有观察。空白时段未知，不能据此证明持续工作或任务完成。</p>
        {addingActivity && <ActivityForm busy={busy} onCancel={() => {invalidateView(); setAddingActivity(false);}} onSave={(input, commandId) => mutate("实际活动已保存。", () => api.createActivity(input, commandId), () => setAddingActivity(false))} />}
        <div className="task-activity-list">{snapshot.activities.length ? snapshot.activities.map((item) => <ActivityCard key={item.id} item={item} />) : <p className="task-empty">还没有活动记录。可以手动补记，不需要开启采集。</p>}</div></section>}
    </div>}
  </section></TaskApiContext.Provider>;
}
