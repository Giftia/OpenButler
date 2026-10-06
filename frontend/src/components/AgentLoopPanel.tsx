import {useEffect, useRef, useState} from "react";
import {agentRuntimeApi, commandIdFor, confirmCommand, reconcileCommandReceipts, reconcileMessageReceipts, readableRuntimeSnapshot, runtimePlanProposal, type AgentRuntimeApi, type GoalStatus, type RuntimeEvidence, type RuntimeGoal, type RuntimeSnapshot, type RuntimeNoticeSettings} from "../lib/agentRuntimeApi";
import {NaturalChatPanel} from "./NaturalChatPanel";
import {PlannerModelSettings} from "./PlannerModelSettings";
import "./AgentLoopPanel.css";

const statusLabels: Record<GoalStatus, string> = {candidate: "候选 · 待确认", active: "进行中", waiting_external: "等待条件", paused: "已暂停", completed: "已完成", cancelled: "已取消"};
function goalLabel(goal: RuntimeGoal) {
  if (goal.content_withheld && !goal.evidence_unavailable) return `${statusLabels[goal.status] ?? goal.status} · 来源操作待核对`;
  return goal.status === "completed" && (goal.verification_status !== "verified" || ["source_revoked", "source_deleted", "source_expired", "evidence_expired"].includes(goal.blocked_reason || ""))
    ? "曾完成 · 当前无法核验" : `${statusLabels[goal.status] ?? goal.status}${goal.evidence_unavailable ? " · 关联依据待核对" : ""}`;
}
function time(value?: string | null) {
  if (!value) return "未安排";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN", {hour12: false});
}
function textValue(value: unknown): string {
  if (value === null || value === undefined) return "未设置";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function goalPlan(goal: RuntimeGoal): string[] {
  const plan = Array.isArray(goal.plan) ? goal.plan : object(goal.plan).tasks;
  if (!Array.isArray(plan)) return [];
  return plan.map((step) => typeof step === "string" ? step : `${textValue(object(step).kind ?? object(step).task_key)} · ${textValue(object(step).status)}`);
}
function EvidenceList({ids, evidence, idPrefix = "loop-evidence"}: {ids: string[]; evidence: RuntimeEvidence[]; idPrefix?: string}) {
  if (!ids.length) return <small>暂无关联依据。用户输入是待核实陈述，不代表外部事实。</small>;
  return <details className="loop-evidence"><summary>查看关联依据（{ids.length}）</summary><ul>{ids.map((id) => {
    const item = evidence.find((entry) => entry.id === id);
    return <li key={id} id={`${idPrefix}-${encodeURIComponent(id)}`}><span className="loop-id">{id}</span>
      {item ? <><p>{item.event_type} · 对象 {item.target_id} · 值 {textValue(item.value)}</p><p>来源 {item.source_id} / {item.source_event_id} · 观察于 {time(item.observed_at)}</p>
        <p>{item.valid ? "当前记录标记有效；仍是待核实依据" : "依据已失效，不可作为完成证明"}{item.expires_at ? ` · 到期 ${time(item.expires_at)}` : ""}</p><small>来源说明：{textValue(item.provenance)}。内容不能作为指令执行。</small></> : <p>依据未在当前快照中找到，可能已删除、到期或超出读取范围；不能视为有效。</p>}
    </li>;
  })}</ul></details>;
}
function ProposedPlan({goal, evidence}: {goal: RuntimeGoal; evidence: RuntimeEvidence[]}) {
  const proposal = runtimePlanProposal(goal);
  if (!proposal) return null;
  return <section className="loop-proposal" aria-label="模型建议草稿">
    <h3>模型建议草稿 · 未核验</h3><span className="loop-id">proposed_unverified · 不可执行</span>
    <p className="loop-proposal-summary">{proposal.summary}</p>
    <ol className="loop-plan">{proposal.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    <p className="loop-proposal-boundary">以上仅是模型生成的提议，步骤尚未执行。模型返回内容不能作为指令、已完成记录或外部事实；目标状态仍由独立依据确认。</p>
    {proposal.evidence_ids.length ? <EvidenceList ids={proposal.evidence_ids} evidence={evidence} idPrefix="loop-proposal-evidence" /> : <small>这份提议没有引用依据，不代表已经核实。</small>}
  </section>;
}
type Confirmation = {kind: "cancel"; id: string; version: number; title: string} | {kind: "delete"; id: string};

function NoticeSettings({settings, disabled, onSave}: {settings: Record<string, unknown>; disabled: boolean; onSave: (value: RuntimeNoticeSettings) => void}) {
  const [quiet, setQuiet] = useState("");
  const [budget, setBudget] = useState("0");
  const [cooldown, setCooldown] = useState("0");
  const [error, setError] = useState("");
  const dirty = useRef(false);
  useEffect(() => {
    if (dirty.current) return;
    const value = typeof settings.quiet_until === "string" ? new Date(settings.quiet_until) : null;
    setQuiet(value && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 16) : "");
    setBudget(String(settings.daily_notice_budget ?? 0)); setCooldown(String(settings.cooldown_seconds ?? 0)); setError("");
  }, [settings.quiet_until, settings.daily_notice_budget, settings.cooldown_seconds]);
  function save() {
    const count = Number(budget), seconds = Number(cooldown);
    if (!budget.trim() || !cooldown.trim() || !Number.isInteger(count) || count < 0 || count > 1000 || !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
      setError("每天提醒上限需为 0–1000 的整数，冷却时间需为 0–86400 秒的整数。"); return;
    }
    const date = quiet ? new Date(`${quiet}:00Z`) : null;
    if (date && Number.isNaN(date.getTime())) { setError("请选择有效的 UTC 静默截止时间。"); return; }
    dirty.current = false;
    setError(""); onSave({quiet_until: date ? date.toISOString() : null, daily_notice_budget: count, cooldown_seconds: seconds});
  }
  return <details className="loop-card"><summary>静默与本地提醒限制</summary><p className="loop-caption">一次性 UTC 静默截止时间，不是每日重复的免打扰时段。每天上限与冷却间隔跨所有目标计算，只限制本地收件箱，不发系统或外部通知。</p>
    <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label htmlFor="loop-quiet-until">静默到（UTC；留空取消静默）<input id="loop-quiet-until" type="datetime-local" value={quiet} disabled={disabled} onChange={(event) => { dirty.current = true; setQuiet(event.target.value); }} /></label>
      <div className="loop-form-row"><label htmlFor="loop-notice-budget">每天提醒上限（UTC 日）<input id="loop-notice-budget" type="number" min="0" max="1000" step="1" value={budget} disabled={disabled} onChange={(event) => { dirty.current = true; setBudget(event.target.value); }} required /></label>
        <label htmlFor="loop-notice-cooldown">全局提醒冷却（秒）<input id="loop-notice-cooldown" type="number" min="0" max="86400" step="1" value={cooldown} disabled={disabled} onChange={(event) => { dirty.current = true; setCooldown(event.target.value); }} required /></label></div>
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={disabled}>保存提醒限制</button>
    </form>
  </details>;
}

/** Explicit local controls with a separately authorized synthetic-only planner. */
export function AgentLoopPanel({api = agentRuntimeApi}: {api?: AgentRuntimeApi}) {
  const [chatInvalidation, setChatInvalidation] = useState(0);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const latestSnapshot = useRef<RuntimeSnapshot | null>(null);
  latestSnapshot.current = snapshot;
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const goalSelectionRevision = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [targetId, setTargetId] = useState("");
  const [eventType, setEventType] = useState("commitment_closed");
  const [successValue, setSuccessValue] = useState("true");
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState("user_statement");
  const [grantId, setGrantId] = useState("user_statement");
  const [grantConsent, setGrantConsent] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const mounted = useRef(false), lifecycle = useRef(0), readRevision = useRef(0), writing = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const reading = useRef(false);

  async function refresh() {
    const revision = ++readRevision.current, life = lifecycle.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    reading.current = true; setLoading(true); setFresh(false);
    try {
      await reconcileCommandReceipts(api, controller.signal);
      if (!mounted.current || life !== lifecycle.current || revision !== readRevision.current) return false;
      const value = readableRuntimeSnapshot(await api.load(controller.signal));
      await reconcileMessageReceipts(value.messages);
      if (!mounted.current || life !== lifecycle.current || revision !== readRevision.current) return false;
      setSnapshot(value); setFresh(true); setError("");
      // Never silently select a different/latest goal after removal or reordering.
      setSelectedId((id) => id && value.goals.some((goal) => goal.id === id) ? id : null);
      setSelectedEvidence((ids) => ids.filter((id) => value.evidence.some((item) => item.id === id && item.valid)));
      return value;
    } catch (reason) {
      if (!mounted.current || life !== lifecycle.current || revision !== readRevision.current) return false;
      if ((reason as Error).name !== "AbortError") setError("无法读取完整的本机状态。下方旧数据仅供查看；请刷新成功后再操作。");
      return false;
    } finally { if (mounted.current && life === lifecycle.current && revision === readRevision.current) { reading.current = false; setLoading(false); } }
  }
  useEffect(() => {
    mounted.current = true; lifecycle.current++; void refresh();
    return () => { mounted.current = false; lifecycle.current++; readRevision.current++; readController.current?.abort(); };
  }, [api]);

  useEffect(() => {
    function observe() {
      if (document.visibilityState === "visible" && !writing.current && !reading.current) void refresh();
    }
    const timer = window.setInterval(observe, 30000);
    document.addEventListener("visibilitychange", observe);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", observe); };
  }, [api]);

  useEffect(() => {
    if (!snapshot) return;
    const expiries = [...snapshot.sources, ...snapshot.evidence].map((item) => item.expires_at ? Date.parse(item.expires_at) : NaN)
      .filter((date) => Number.isFinite(date) && date > Date.now());
    if (!expiries.length) return;
    const timer = window.setTimeout(() => {
      setSnapshot((value) => value ? readableRuntimeSnapshot(value) : value);
    }, Math.min(Math.max(1, Math.min(...expiries) - Date.now() + 1), 2147483647));
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  async function mutate(key: string, action: (id: string) => Promise<unknown>, success: string, after?: () => void, verify?: (value: RuntimeSnapshot) => boolean, withheldSource?: string, mayDispatch: () => boolean = () => true) {
    if (writing.current || !fresh || loading) return;
    if (!mayDispatch()) { setError("目标依据暂不可用，请刷新核对目标内容后再启用或恢复。"); return; }
    writing.current = true; setPending(true); setError(""); setFeedback("");
    if (/^(grant|revoke|delete|goal|activate):/.test(key)) setChatInvalidation((value) => value + 1);
    const life = lifecycle.current;
    let commandId: string | null = null;
    try {
      commandId = await commandIdFor(key);
      if (!mounted.current || life !== lifecycle.current) return; // No late write after navigation.
      if (!mayDispatch()) { setError("目标依据暂不可用，请刷新核对目标内容后再启用或恢复。"); return; }
      if (withheldSource) setSnapshot((value) => value ? readableRuntimeSnapshot(value, withheldSource) : value);
      await action(commandId); await confirmCommand(key);
      if (!mounted.current || life !== lifecycle.current) return;
      after?.(); setConfirmation(null);
      const refreshed = await refresh();
      if (!mounted.current || life !== lifecycle.current) return;
      if (refreshed && (!verify || verify(refreshed))) setFeedback(success);
      else if (refreshed) setError("服务已确认请求，但刷新状态与预期不同。请以当前显示的状态为准，再核对操作。");
    } catch {
      if (!mounted.current || life !== lifecycle.current) return;
      // A lost response may follow a committed command. Read its exact receipt;
      // never issue a replacement write or allocate a fresh ID automatically.
      if (commandId && !key.startsWith("message:")) {
        try {
          const receipt = await api.commandStatus(commandId);
          if (!mounted.current || life !== lifecycle.current) return;
          if (receipt.state === "completed") {
            const reconciled = await refresh();
            if (!mounted.current || life !== lifecycle.current) return;
            if (reconciled) {
              await confirmCommand(key); after?.(); setConfirmation(null);
              if (!verify || verify(reconciled)) setFeedback(`已核对本机回执。${success}`);
              else setError("本机回执存在，但当前状态已变化。请以刷新后的状态为准。");
            } else setError("本机回执确认操作已保存，但最新状态暂时无法读取。请刷新核对，不要另建重复操作。");
            return;
          }
        } catch { /* Retain ID; a missing/unreachable receipt is not a new write. */ }
      }
      if (!mounted.current || life !== lifecycle.current) return;
      setFresh(false);
      setError("请求结果尚未确认，可能已在本机保存。请先刷新核对；重试会沿用同一请求编号，避免重复提交。");
    } finally { if (mounted.current && life === lifecycle.current) { writing.current = false; setPending(false); } }
  }
  const disabled = !fresh || loading || pending;
  const goals = snapshot?.goals ?? [], sources = snapshot?.sources ?? [], evidence = snapshot?.evidence ?? [];
  const selected = goals.find((goal) => goal.id === selectedId);
  const unread = snapshot?.inbox.filter((notice) => !notice.read_at).length ?? 0;
  const enabled = snapshot?.status.enabled === true;
  const activeSource = sources.find((source) => source.id === sourceId && source.status === "active");
  function canAdvance(goal: RuntimeGoal) {
    const value = latestSnapshot.current;
    const current = value && readableRuntimeSnapshot(value).goals.find(item => item.id === goal.id && item.version === goal.version);
    return Boolean(current && !current.content_withheld && !current.evidence_unavailable);
  }
  function activate(goal: RuntimeGoal) {
    void mutate(`activate:${goal.id}:${goal.version}`, (id) => api.activateGoal(goal.id, goal.version, id),
      `已明确启用目标「${goal.title}」。整个循环暂停时不会运行。`, undefined, undefined, undefined, () => canAdvance(goal));
  }
  function control(goal: RuntimeGoal, operation: "pause" | "resume" | "cancel") {
    const labels = {pause: "暂停", resume: "恢复", cancel: "取消"};
    void mutate(`goal:${goal.id}:${goal.version}:${operation}`, (id) => api.controlGoal(goal.id, operation, goal.version, id), `已${labels[operation]}目标「${goal.title}」。`, undefined, undefined, undefined, () => operation !== "resume" || canAdvance(goal));
  }
  function createGoal() {
    if (!title.trim() || !targetId.trim() || !eventType.trim() || !activeSource) return;
    let expected: unknown;
    try { expected = JSON.parse(successValue); } catch { setError("完成值必须是有效 JSON，例如 true、42 或带双引号的文字。"); return; }
    const payload = {title: title.trim(), target_id: targetId.trim(), success_event_type: eventType.trim(), success_value: expected, evidence_ids: selectedEvidence, source_ids: [sourceId], deadline_at: null};
    void mutate(`create:${JSON.stringify(payload)}`, (id) => api.createGoal(payload, id), "候选目标已保存。请从列表中选择并明确启用；保存候选不会自动开始执行。", () => { setTitle(""); setTargetId(""); setSelectedEvidence([]); });
  }

  return <section className="agent-loop" aria-labelledby="agent-loop-title">
    <header className="loop-header"><div><p className="loop-kicker">Preview / Local control</p><h1 id="agent-loop-title">把目标留在这里，按依据推进</h1><p className="loop-caption">对话留存、目标状态和本地提醒放在一起。每一步都可以看清、暂停或取消。</p></div><button disabled={pending} onClick={() => void refresh()} aria-label="刷新本地循环状态">{loading ? "重新读取中…" : "刷新状态"}</button></header>
    <div className="loop-boundary"><p><strong>本地原型 · 默认确定性规则规划器</strong></p><p>这里包含单独授权的合成测试模型对话、本地笔记与明确的目标控制。默认不会调用模型；对话中只有明确发送才调用已验证的本地文字模型，建议需另行采纳。不会启动或恢复录制，也不会发送外部消息。</p>
      <div className="loop-controls"><span className="loop-status" data-status={enabled ? "active" : "paused"}>{snapshot ? enabled ? "本地循环已启用" : "本地循环已暂停" : "本地状态未知"}</span><button className={enabled ? "" : "loop-primary"} disabled={disabled || snapshot?.status.rc_goal_automation_unavailable === true} onClick={() => void mutate(`enabled:${snapshot?.status.settings.execution_epoch ?? 0}:${!enabled}`, (id) => api.setEnabled(!enabled, id), enabled ? "本地循环已暂停，目标和记录保留。" : "本地循环已启用；仅推进已确认且来源有效的本地目标。", undefined, (value) => value.status.enabled === !enabled)}>{enabled ? "暂停整个循环" : "启用本地循环"}</button><small>启用循环不等于启用任何记录来源。重新打开页面只读取状态。</small></div>
      {snapshot?.status.rc_goal_automation_unavailable === true && <p role="status">本候选版暂不运行目标自动化，也不展示或重新核验旧目标的派生内容。数据和本地笔记保留，已有目标仍可暂停或取消。</p>}
      <p className="loop-caption">下次全局唤醒：{time(snapshot?.status.next_wake_at)} · 页面可见时每 30 秒只读刷新，也可手动核对最新进展。</p>
    </div>
    <PlannerModelSettings api={api} disabled={disabled} onMutationStart={() => { setChatInvalidation((value) => value + 1); setSnapshot((value) => value ? {...value, goals: value.goals.map((goal) => goal.plan && typeof goal.plan === "object" ? {...goal, plan: {...object(goal.plan), proposal: null}} : goal)} : value); }} onChanged={refresh} />
    <NaturalChatPanel runtimeApi={api} runtimeSnapshot={snapshot} invalidation={chatInvalidation} disabled={disabled} onAdopted={async (goalId) => { const selectionRevision = goalSelectionRevision.current; const value = await refresh(); if (selectionRevision === goalSelectionRevision.current && value && value.goals.some((goal) => goal.id === goalId)) { setSelectedId(goalId); setConfirmation(null); } }} />
    {snapshot && <NoticeSettings settings={snapshot.status.settings} disabled={disabled} onSave={(settings) => void mutate(`settings:${snapshot.status.settings.execution_epoch ?? 0}:${JSON.stringify(snapshot.status.settings)}:${JSON.stringify(settings)}`, (id) => api.configure(settings, id), "本地提醒限制已保存。静默期结束仍需本地服务保持运行。", undefined, (value) => value.status.settings.daily_notice_budget === settings.daily_notice_budget && value.status.settings.cooldown_seconds === settings.cooldown_seconds && (settings.quiet_until === null ? value.status.settings.quiet_until === null : new Date(String(value.status.settings.quiet_until)).getTime() === new Date(settings.quiet_until).getTime())) } />}
    {error && <div className="loop-feedback" role="alert">{error}</div>}{feedback && <div className="loop-feedback" role="status">{feedback}</div>}
    {!snapshot && loading && <p role="status">正在读取持久保存的本地对话与目标…</p>}
    <div className="loop-grid" aria-busy={loading || pending}>
      <div className="loop-column">
        <section className="loop-card" aria-labelledby="loop-conversation-title"><div className="loop-section-heading"><h2 id="loop-conversation-title">本地笔记 · 不发送给模型</h2><small>最近 100 条 · 保存在本机</small></div>
          {snapshot?.messages.length ? <ol className="loop-timeline" aria-label="持久对话时间线">{snapshot.messages.map((item) => <li className="loop-message" data-role={item.role} key={item.id}><div className="loop-message-meta"><span>{item.role === "user" ? "你" : "本地系统记录"}</span><time dateTime={item.created_at}>{time(item.created_at)}</time></div><p>{item.content}</p><span className="loop-id">记录 {item.id}</span></li>)}</ol> : <div className="loop-empty">还没有已保存的本地笔记。可以先记下一条想法，再用右侧的明确字段建立目标。</div>}
          <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); const content = message.trim(); if (content) void mutate(`message:${content}`, (id) => api.message(content, id), "文字已保存到本机。它不会自动变成指令或完成证明。", () => setMessage("")); }}><label htmlFor="loop-message">记下想法或补充说明<textarea id="loop-message" value={message} maxLength={4000} disabled={pending} onChange={(event) => setMessage(event.target.value)} placeholder="例如：整理下一次会议需要确认的问题" /></label><div className="loop-controls"><button className="loop-primary" type="submit" disabled={disabled || !message.trim()}>保存本地消息</button><small>仅保存文字，不自动回复或创建目标</small></div></form>
        </section>
        <section className="loop-card" aria-labelledby="loop-inbox-title"><div className="loop-section-heading"><h2 id="loop-inbox-title">本地提醒收件箱</h2><span className="loop-status">{unread} 条未读</span></div><p className="loop-caption">标为已读只影响提醒。目标完成必须由匹配对象与条件的有效依据确认。</p>
          {snapshot?.inbox.length ? <div className="loop-notice-list">{snapshot.inbox.map((notice) => <article className="loop-notice" data-unread={!notice.read_at} key={notice.id}><small>{time(notice.created_at)} · {notice.read_at ? "已读" : "未读"}</small><p>{notice.message}</p><span className="loop-id">目标 {notice.goal_id} · 提醒 {notice.id}</span><div className="loop-controls"><button disabled={!goals.some((goal) => goal.id === notice.goal_id)} onClick={() => { goalSelectionRevision.current++; setSelectedId(notice.goal_id); setConfirmation(null); }}>查看对应目标</button><button disabled={disabled || !!notice.read_at} onClick={() => void mutate(`read:${notice.id}`, (id) => api.readNotice(notice.id, id), "提醒已标为已读；目标状态未因此改变。")}>{notice.read_at ? "已标为已读" : "仅标为已读"}</button></div></article>)}</div> : <div className="loop-empty">还没有本地提醒。系统不会用样例填充你的收件箱。</div>}
        </section>
      </div>
      <div className="loop-column">
        <section className="loop-card" aria-labelledby="loop-goals-title"><div className="loop-section-heading"><h2 id="loop-goals-title">目标与候选</h2><small>当前读取 {goals.length} 项（最多 100）</small></div>
          {goals.length ? <div className="loop-goal-list" aria-label="选择明确的目标">{goals.map((goal) => <button className="loop-goal-choice" key={goal.id} aria-pressed={selectedId === goal.id} onClick={() => { goalSelectionRevision.current++; setSelectedId(goal.id); setConfirmation(null); }}><span className="loop-goal-top"><strong>{goal.title}</strong><span className="loop-status" data-status={goal.content_withheld || goal.status === "completed" && goal.verification_status !== "verified" ? "paused" : goal.status === "waiting_external" ? "waiting" : goal.status}>{goalLabel(goal)}</span></span><span className="loop-id">{goal.id} · 版本 {goal.version}</span></button>)}</div> : <div className="loop-empty">还没有目标。来源中的线索只能生成待确认候选，不会自行获得执行权限。</div>}
          {!selected && goals.length > 0 && <p className="loop-caption">先选择一个明确的目标，再查看依据或控制它。不会默认操作“最新一项”。</p>}
          {selected && <article className="loop-detail" aria-labelledby="loop-selected-title" data-goal-id={selected.id}><h3 id="loop-selected-title">{selected.title}</h3><span className="loop-id">操作对象：{selected.id} · 版本 {selected.version}</span>
            <dl className="loop-facts"><div><dt>当前状态</dt><dd>{goalLabel(selected)}{!enabled && !["completed", "cancelled"].includes(selected.status) ? "（整个循环已暂停）" : ""}</dd></div><div><dt>等待条件</dt><dd>对象 {selected.wait_target?.target_id || selected.target_id} / {selected.wait_target?.event_type || selected.success_event_type} = {textValue(selected.wait_target?.value ?? selected.success_value)}</dd></div><div><dt>下次唤醒</dt><dd>{selected.next_wake_at === undefined ? "参见全局调度；单项目时间未提供" : time(selected.next_wake_at)}</dd></div><div><dt>截止时间</dt><dd>{time(selected.deadline_at)}</dd></div><div><dt>当前原因</dt><dd>{(selected.evidence_unavailable ? "本次快照缺少可核对的关联依据；可能已失效或超出读取范围" : selected.blocked_reason) || (selected.status === "candidate" ? "需要你明确确认候选" : selected.status === "completed" ? selected.verification_status === "verified" ? "由关联完成依据确认" : "历史完成状态当前无法核验" : selected.status === "cancelled" ? "已取消，不再推进" : "以已保存的检查点与条件为准")}</dd></div><div><dt>检查点</dt><dd>{textValue(selected.checkpoint)}</dd></div></dl>
            {goalPlan(selected).length > 0 && <><h3>已保存计划</h3><ol className="loop-plan">{goalPlan(selected).map((step, index) => <li key={index}>{step}</li>)}</ol></>}
            <ProposedPlan goal={selected} evidence={evidence} />
            {selected.content_withheld && !selected.evidence_unavailable && <p className="loop-feedback" role="status">来源操作结果尚待本机回执确认。当前只隐藏本页的相关内容，不能据此判断授权或执行是否已停止。</p>}
            {!selected.content_withheld && selected.verification_status === "withdrawn" && <p className="loop-feedback" role="status">历史完成记录保留，但关联依据已撤回或到期，当前无法重新核验完成。不会据此继续行动。</p>}
            {selected.evidence_unavailable && <p className="loop-feedback" role="status">当前快照不足以核对关联依据，相关派生内容或完成确认暂不显示。保留已保存的目标状态；这不代表依据已被撤回，也不改变目标的执行状态。</p>}
            <EvidenceList ids={[...new Set([...selected.evidence_ids, ...selected.completion_evidence_ids])]} evidence={evidence} />
            <div className="loop-controls" style={{marginTop: 14}}>{selected.status === "candidate" && <button className="loop-primary" disabled={disabled || selected.content_withheld || selected.evidence_unavailable} onClick={() => activate(selected)}>确认并启用这个目标</button>}{["active", "waiting_external"].includes(selected.status) && <button disabled={disabled} onClick={() => control(selected, "pause")}>暂停这个目标</button>}{selected.status === "paused" && <button disabled={disabled || selected.content_withheld || selected.evidence_unavailable} onClick={() => control(selected, "resume")}>恢复这个目标</button>}{!["completed", "cancelled"].includes(selected.status) && <button className="loop-danger" disabled={disabled} onClick={() => setConfirmation({kind: "cancel", id: selected.id, version: selected.version, title: selected.title})}>取消这个目标</button>}</div>
            {confirmation?.kind === "cancel" && confirmation.id === selected.id && <div className="loop-confirm" role="group" aria-label="确认取消目标"><p>取消「{confirmation.title}」？仅停止目标 {confirmation.id}，不代表任务已经完成。</p><div className="loop-controls"><button className="loop-danger" disabled={disabled} onClick={() => { if (selected.version !== confirmation.version) { setConfirmation(null); setError("目标版本已变化，请重新核对后操作。"); return; } control(selected, "cancel"); }}>确认取消该目标</button><button disabled={pending} onClick={() => setConfirmation(null)}>保留目标</button></div></div>}
          </article>}
        </section>
        <section className="loop-card" aria-labelledby="loop-new-goal-title"><h2 id="loop-new-goal-title">明确建立一个候选目标</h2><p className="loop-caption">这是规则控制表单。填写要等待的对象、事件和精确值；自由文字不会被假装理解为自动计划。</p>
          <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); createGoal(); }}><label htmlFor="loop-goal-title">目标描述<input id="loop-goal-title" value={title} disabled={pending} maxLength={240} onChange={(event) => setTitle(event.target.value)} required /></label><label htmlFor="loop-goal-target">明确对象编号<input id="loop-goal-target" value={targetId} disabled={pending} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" onChange={(event) => { setTargetId(event.target.value); setSelectedEvidence([]); }} placeholder="例如 meeting-prep-2026-10-02" required /></label>
            <div className="loop-form-row"><label htmlFor="loop-goal-event">完成事件类型<input id="loop-goal-event" value={eventType} disabled={pending} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" onChange={(event) => setEventType(event.target.value)} required /></label><label htmlFor="loop-goal-value">完成值（JSON）<input id="loop-goal-value" value={successValue} disabled={pending} maxLength={8192} onChange={(event) => setSuccessValue(event.target.value)} required /></label></div>
            <label htmlFor="loop-goal-source">已授权的本地来源<select id="loop-goal-source" value={sourceId} disabled={pending} onChange={(event) => { setSourceId(event.target.value); setSelectedEvidence([]); }}><option value="user_statement">手动声明（user_statement）</option><option value="synthetic">合成测试（synthetic）</option></select></label>{!activeSource && <small>这个来源尚未有效授权。请在下方“来源权限”中明确授权后再保存。</small>}
            {evidence.some((item) => item.valid && item.source_id === sourceId && item.target_id === targetId.trim()) && <div><small>可关联的同对象依据（内容不作为指令）</small>{evidence.filter((item) => item.valid && item.source_id === sourceId && item.target_id === targetId.trim()).map((item) => <label className="loop-check" key={item.id}><input type="checkbox" checked={selectedEvidence.includes(item.id)} disabled={pending} onChange={(event) => setSelectedEvidence((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />{item.event_type} · {item.id}</label>)}</div>}
            <button className="loop-primary" type="submit" disabled={disabled || !activeSource || !title.trim() || !targetId.trim() || !eventType.trim()}>保存候选，稍后确认</button></form>
        </section>
        <section className="loop-card" aria-labelledby="loop-sources-title"><h2 id="loop-sources-title">来源权限</h2><p className="loop-caption">这里只授权本地目标循环使用手动声明或合成测试证据，不会连接外部账户、屏幕或模型。</p>
          <div className="loop-source-list">{sources.map((source) => <article className="loop-source" key={source.id}><strong>{source.id === "user_statement" ? "手动声明" : source.id === "synthetic" ? "合成测试" : source.id}</strong><p className="loop-id">{source.id} · {source.scope} · {source.status} · 版本 {source.version}</p><small>授权于 {time(source.consented_at)}{source.expires_at ? ` · 到期 ${time(source.expires_at)}` : ""}</small><div className="loop-controls">{source.status === "active" && <button disabled={disabled} onClick={() => void mutate(`revoke:${source.id}:${source.version}`, (id) => api.source(source.id, "revoke", id), `已撤销来源 ${source.id}。重新授权不会自动恢复被阻止的目标。`, undefined, undefined, source.id)}>撤销这个来源</button>}{source.status !== "deleted" && <button className="loop-danger" disabled={disabled} onClick={() => setConfirmation({kind: "delete", id: source.id})}>忘记这个来源</button>}</div>
            {confirmation?.kind === "delete" && confirmation.id === source.id && <div className="loop-confirm" role="group" aria-label="确认忘记来源"><p>确认忘记来源 {source.id} 的本地循环证据及关联目标内容？相关依据将不能继续证明目标；最小操作回执保留。{source.id === "synthetic" ? "关联的合成模型对话输入、回复与建议也会清除。" : "单独授权的合成模型对话不受这个来源操作影响。"}旧版本地笔记、其他来源和原始外部数据不受影响。此操作不可撤销，不等于加密或物理擦除。</p><div className="loop-controls"><button className="loop-danger" disabled={disabled} onClick={() => void mutate(`delete:${source.id}:${source.version}`, (id) => api.source(source.id, "delete", id), `已忘记来源 ${source.id} 的循环证据。`, undefined, undefined, source.id)}>确认忘记该来源</button><button disabled={pending} onClick={() => setConfirmation(null)}>保留来源</button></div></div>}
          </article>)}</div>
          <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); if (grantConsent) void mutate(`grant:${grantId}:${sources.find((source) => source.id === grantId)?.version ?? 0}`, (id) => api.source(grantId, "grant", id), `已授权来源 ${grantId} 用于本地目标跟踪。`, () => setGrantConsent(false)); }}><label htmlFor="loop-grant-source">授权来源<select id="loop-grant-source" value={grantId} disabled={pending} onChange={(event) => { setGrantId(event.target.value); setGrantConsent(false); }}><option value="user_statement">手动声明（user_statement）</option><option value="synthetic">合成测试（synthetic）</option></select></label><label className="loop-check"><input type="checkbox" checked={grantConsent} disabled={pending} onChange={(event) => setGrantConsent(event.target.checked)} />我同意让本地目标循环使用这个来源的记录，仅用于目标跟踪</label><button type="submit" disabled={disabled || !grantConsent || sources.some((source) => source.id === grantId && source.status === "active")}>明确授权此来源</button></form>
        </section>
      </div>
    </div>
  </section>;
}

