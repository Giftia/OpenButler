import {useEffect, useRef, useState} from "react";
import {agentRuntimeApi, type AgentRuntimeApi, type RuntimeSnapshot, type RuntimeGoal, type RuntimeEvidence} from "../lib/agentRuntimeApi";
import {NaturalChatRequestError, naturalChatApi, loadNaturalChatSnapshot, pendingNaturalOperations, rememberNaturalOperation, forgetNaturalOperation, type NaturalChatApi, type NaturalChatSnapshot, type NaturalTurn, type ChatProposal, type PendingNaturalOperation} from "../lib/naturalChatApi";
import "./NaturalChatPanel.css";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const future = (value: string | null | undefined, now: number) => value == null || Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
const sourceOf = (snapshot: RuntimeSnapshot | null | undefined) => snapshot?.sources.find((source) => source.id === "synthetic");
const statusLabels = {active: "已授权", revoked: "已撤销", withdrawn: "已失效"};
function availableScope(value: NaturalChatSnapshot | null, now: number) {
  if (!value) return false;
  const source = sourceOf(value.runtime), route = value.planner;
  return !!source && source.status === "active" && future(source.expires_at, now) && route.configured && route.model_ready && route.confirmed && !route.needs_validation && !!route.configuration;
}
function availableConversation(value: NaturalChatSnapshot | null, now: number) {
  const conversation = value?.conversation, source = value && sourceOf(value.runtime);
  return availableScope(value, now) && !!conversation && conversation.status === "active" && conversation.source_version === source?.version && conversation.route_revision === value?.planner.configuration_revision && same(conversation.route_configuration, value?.planner.configuration) && future(conversation.source_expires_at, now);
}
export function readableNaturalTurn(turn: NaturalTurn, value: NaturalChatSnapshot, now = Date.now()) {
  const conversation = value.conversation;
  if (!availableConversation(value, now) || !conversation || turn.conversation_id !== conversation.id || turn.conversation_version !== conversation.version || turn.source_version !== conversation.source_version || turn.route_revision !== conversation.route_revision || turn.status === "withdrawn") return false;
  if (turn.input_goal_contexts.some((context) => {
    const goal = value.runtime.goals.find((item) => item.id === context.id);
    return !goal || goal.content_withheld || Object.entries(context).some(([key, expected]) => !same((goal as unknown as Record<string, unknown>)[key], expected));
  })) return false;
  const valid = value.runtime.evidence.filter((item) => item.source_id === "synthetic" && item.source_version === conversation.source_version && item.valid && future(item.expires_at, now));
  if (turn.input_evidence_ids.some((id) => !valid.some((item) => item.id === id))) return false;
  return turn.citations.every((citation) => valid.some((item) => item.id === citation.id && item.target_id === citation.target_id && item.event_type === citation.event_type && item.observed_at === citation.observed_at)) && (!turn.proposal || turn.proposal.evidence_ids.every((id) => turn.input_evidence_ids.includes(id)));
}
const goalFields = ["id", "title", "target_id", "success_event_type", "success_value", "status", "version", "plan_version", "deadline_at", "source_ids", "evidence_ids"];
function parentGoalMatches(goal: RuntimeGoal, parent?: RuntimeSnapshot | null) {
  if (!parent) return true;
  const other = parent.goals.find((item) => item.id === goal.id);
  return !!other && !other.content_withheld && goalFields.every((key) => same((goal as unknown as Record<string, unknown>)[key], (other as unknown as Record<string, unknown>)[key]));
}
function parentEvidenceMatches(evidence: RuntimeEvidence, parent?: RuntimeSnapshot | null) {
  if (!parent) return true;
  const other = parent.evidence.find((item) => item.id === evidence.id);
  return !!other && other.valid && same(evidence, other);
}
function proposalKey(proposal: ChatProposal) { return `${proposal.id}:v${proposal.version}`; }
function freshIntent(before: NaturalChatSnapshot, after: NaturalChatSnapshot, goalId: string, evidenceIds: string[]) {
  if (!same(before.planner.configuration, after.planner.configuration) || before.planner.configuration_revision !== after.planner.configuration_revision || !same(sourceOf(before.runtime), sourceOf(after.runtime)) || before.conversation?.id !== after.conversation?.id || before.conversation?.version !== after.conversation?.version || before.conversation?.status !== after.conversation?.status) return false;
  if (goalId && !same(before.runtime.goals.find((goal) => goal.id === goalId), after.runtime.goals.find((goal) => goal.id === goalId))) return false;
  return evidenceIds.every((id) => same(before.runtime.evidence.find((item) => item.id === id), after.runtime.evidence.find((item) => item.id === id)));
}
const failureText = (code: string | null) => code === "model_budget_exhausted" ? "今天的模型调用额度已用完。等待额度恢复后可明确重试。" : "本次模型没有给出可用回复。失败或沉默不代表目标完成，也没有自动改用其他模型。";

/** Explicit synthetic conversations; opening, switching and refreshing only read. */
export function NaturalChatPanel({api = naturalChatApi, runtimeApi = agentRuntimeApi, runtimeSnapshot, invalidation = 0, disabled = false, onAdopted}: {
  api?: NaturalChatApi; runtimeApi?: AgentRuntimeApi; runtimeSnapshot?: RuntimeSnapshot | null; invalidation?: number; disabled?: boolean; onAdopted?: (goalId: string) => unknown | Promise<unknown>;
}) {
  const [snapshot, setSnapshot] = useState<NaturalChatSnapshot | null>(null), [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(""), [goalId, setGoalId] = useState(""), [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [consent, setConsent] = useState(false), [fresh, setFresh] = useState(false), [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState(""), [now, setNow] = useState(Date.now());
  const [journal, setJournal] = useState(pendingNaturalOperations), [observedInvalidation, setObservedInvalidation] = useState(invalidation);
  const [confirmation, setConfirmation] = useState<{conversationId: string; proposal: ChatProposal} | null>(null);
  const mounted = useRef(false), life = useRef(0), context = useRef(0), reads = useRef(0), writing = useRef(false), reading = useRef(false), selection = useRef("");
  const lastInvalidation = useRef(invalidation), parentSnapshot = useRef(runtimeSnapshot);
  parentSnapshot.current = runtimeSnapshot;
  const readController = useRef<AbortController | null>(null), invalidationRef = useRef(invalidation);
  invalidationRef.current = invalidation;
  const parentSource = sourceOf(runtimeSnapshot), ownSource = snapshot && sourceOf(snapshot.runtime);
  const parentMatches = runtimeSnapshot === undefined || runtimeSnapshot === null || same(parentSource, ownSource);
  const uncertainScope = journal.some((operation) => operation.conversationId === selectedId && ["consent", "revoke"].includes(operation.kind));
  const contentCurrent = observedInvalidation === invalidation && parentMatches && !uncertainScope && !disabled;
  const current = contentCurrent && availableConversation(snapshot, now);
  const blocked = disabled || pending || loading || !fresh || !contentCurrent;
  const conversation = snapshot?.conversation;
  const selectedGoal = snapshot?.runtime.goals.find((goal) => goal.id === goalId);
  const goals = snapshot?.runtime.goals.filter((goal) => !goal.content_withheld && goal.source_ids.length === 1 && goal.source_ids[0] === "synthetic" && parentGoalMatches(goal, runtimeSnapshot)) ?? [];
  const readableEvidence = snapshot?.runtime.evidence.filter((item) => item.valid && item.source_id === "synthetic" && item.source_version === ownSource?.version && future(item.expires_at, now) && parentEvidenceMatches(item, runtimeSnapshot) && (!goalId || item.target_id === selectedGoal?.target_id)) ?? [];
  const refreshJournal = () => setJournal(pendingNaturalOperations());
  const alive = (l: number, c: number) => mounted.current && life.current === l && context.current === c;

  async function refresh(id = selection.current): Promise<NaturalChatSnapshot | null> {
    const revision = ++reads.current, l = life.current, c = context.current, epoch = invalidationRef.current;
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    reading.current = true; setLoading(true); setFresh(false); setConfirmation(null);
    try {
      const value = await loadNaturalChatSnapshot(api, runtimeApi, id || null, controller.signal);
      if (!alive(l, c) || revision !== reads.current || epoch !== invalidationRef.current) return null;
      setSnapshot(value); setObservedInvalidation(epoch); setFresh(true); setError(""); setNow(Date.now());
      setEvidenceIds((ids) => ids.filter((item) => value.runtime.evidence.some((evidence) => evidence.id === item && evidence.valid)));
      if (snapshot && !freshIntent(snapshot, value, goalId, evidenceIds)) setConsent(false);
      return value;
    } catch (reason) {
      if (alive(l, c) && revision === reads.current) { setSnapshot(null); setConsent(false); if ((reason as Error).name !== "AbortError") setError("无法核对合成对话的最新状态。内容已隐藏；请重新读取后再操作。"); }
      return null;
    } finally { if (alive(l, c) && revision === reads.current) { reading.current = false; setLoading(false); } }
  }
  useEffect(() => {
    mounted.current = true; life.current++; writing.current = false; setPending(false); setConsent(false); setSnapshot(null); setSelectedId(""); selection.current = ""; refreshJournal(); void refresh("");
    return () => { mounted.current = false; life.current++; reads.current++; readController.current?.abort(); };
  }, [api, runtimeApi]);
  useEffect(() => {
    if (lastInvalidation.current === invalidation) return;
    lastInvalidation.current = invalidation;
    setConsent(false); setConfirmation(null); setFresh(false); setSnapshot(null); context.current++; reads.current++; readController.current?.abort(); reading.current = false; setLoading(false);
  }, [invalidation]);
  // Scope expiry hides text without waiting for another network response.
  useEffect(() => {
    if (!snapshot) return;
    const dates = [ownSource?.expires_at, conversation?.source_expires_at, ...snapshot.runtime.evidence.map((item) => item.expires_at), ...(conversation?.turns.flatMap((turn) => [turn.retry_after, turn.proposal?.deadline_at]) ?? [])];
    const next = dates.map((date) => date ? Date.parse(date) : NaN).filter((date) => Number.isFinite(date) && date > Date.now());
    if (!next.length) return;
    const timer = window.setTimeout(() => { setNow(Date.now()); setConsent(false); setConfirmation(null); }, Math.min(Math.max(1, Math.min(...next) - Date.now() + 1), 2147483647));
    return () => window.clearTimeout(timer);
  }, [snapshot, now]);
  useEffect(() => { if (!contentCurrent) { setConsent(false); setConfirmation(null); } }, [contentCurrent]);
  useEffect(() => {
    const observe = () => { if (document.visibilityState === "visible" && !writing.current && !reading.current && !readController.current?.signal.aborted) void refresh(); };
    const timer = window.setInterval(observe, 30000); document.addEventListener("visibilitychange", observe);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", observe); };
  }, [api, runtimeApi, snapshot, goalId, evidenceIds]);

  function select(id: string) {
    context.current++; reads.current++; readController.current?.abort(); selection.current = id; setSelectedId(id); setSnapshot(null); setDraft(""); setGoalId(""); setEvidenceIds([]); setConsent(false); setConfirmation(null); setError(""); setFeedback(""); void refresh(id);
  }
  async function preflight(l: number, c: number, before: NaturalChatSnapshot, goals = goalId, refs = evidenceIds, requireScope = true) {
    const value = await loadNaturalChatSnapshot(api, runtimeApi, selection.current || null);
    if (!alive(l, c) || invalidationRef.current !== observedInvalidation) return null;
    setSnapshot(value); setNow(Date.now());
    if (!freshIntent(before, value, goals, refs) || requireScope && !availableScope(value, Date.now())) { setConsent(false); setConfirmation(null); setFresh(true); setError("来源、模型路由或所选目标已经变化。已取消本次发送，请核对最新状态后重新确认。"); return null; }
    return value;
  }
  async function reconcile(operation: PendingNaturalOperation, l: number, c: number, rejectedStatus?: number) {
    try {
      let adopted: string | null = null;
      if (operation.kind === "turn") {
        const turn = await api.turn(operation.conversationId, operation.id);
        if (turn.status === "outcome_unknown") throw new Error("unknown");
      } else if (operation.kind === "adoption") {
        const receipt = await api.adoption(operation.conversationId, operation.id);
        if (receipt.receipt.proposal_id !== operation.proposalId) throw new Error("mismatch");
        adopted = receipt.receipt.goal_id;
      } else {
        const receipt = await runtimeApi.commandStatus(operation.id);
        if (receipt.state !== "completed") throw new Error("unknown");
      }
      if (!alive(l, c)) return false;
      refreshJournal(); const value = await refresh();
      if (!alive(l, c)) return false;
      setConsent(false);
      if (value) {
        forgetNaturalOperation(operation.id); refreshJournal();
        setFeedback(adopted ? `已核对采纳回执。目标 ${adopted} 已保存，请在下方查看其准确状态；本次操作不会启用整个循环。` : "已核对本机回执，当前显示重新读取的持久记录。");
        if (adopted) await onAdopted?.(adopted);
      } else setError("本机回执确认操作已保存，但最新状态无法读取。请求编号已保留，请再次核对。");
      return !!value;
    } catch (reason) {
      // Neither a POST error nor a missing lookup is sufficient alone. Only an
      // authoritative rejection + exact authoritative 404 + fresh state may
      // retire an ID; transport/parse errors remain unknown and never replay.
      if (rejectedStatus && reason instanceof NaturalChatRequestError && reason.status === 404 && reason.code === "runtime_item_not_found" && alive(l, c)) {
        const value = await refresh();
        if (alive(l, c) && value) {
          forgetNaturalOperation(operation.id); refreshJournal(); setConsent(false); setConfirmation(null);
          setError(`本机服务拒绝了这次请求（${rejectedStatus}），已核对这个请求没有持久回执。请检查最新授权与版本后再明确重试。`);
          return true;
        }
      }
      if (alive(l, c)) { setFresh(false); setConsent(false); setConfirmation(null); refreshJournal(); setError("请求结果尚未确认，可能已在本机保存。请核对同一请求编号；不会自动重发或把未知结果当成失败。"); }
      return false;
    }
  }
  async function perform(kind: "consent" | "revoke" | "send" | "adopt", proposal?: ChatProposal, retry?: NaturalTurn) {
    if (writing.current || blocked || !snapshot || (kind === "consent" && !consent)) return;
    if ((kind === "send" || kind === "adopt") && !current) return;
    if (kind === "send" && !retry && journal.some((operation) => operation.conversationId === selectedId && operation.kind === "turn")) return;
    if (kind === "adopt" && journal.some((operation) => operation.conversationId === selectedId && operation.kind === "adoption" && operation.proposalId === proposal?.id)) return;
    writing.current = true; setPending(true); setFresh(false); setError(""); setFeedback("");
    const l = life.current, c = context.current, before = snapshot;
    if (kind === "revoke" || kind === "consent") setObservedInvalidation(-1);
    let operation: PendingNaturalOperation | null = null;
    try {
      const freshState = await preflight(l, c, before, kind === "send" ? retry ? retry.goal_id || "" : goalId : "", kind === "send" ? retry?.request_evidence_ids ?? evidenceIds : [], kind !== "revoke");
      if (!freshState || !alive(l, c)) return;
      const active = freshState.conversation, source = sourceOf(freshState.runtime)!;
      const id = crypto.randomUUID();
      if (kind === "consent") {
        const target = active?.id || `synthetic-${crypto.randomUUID()}`;
        operation = {kind, conversationId: target, id}; rememberNaturalOperation(operation); refreshJournal();
        if (!active) { selection.current = target; setSelectedId(target); }
        setSnapshot(null); setConsent(false);
        await api.consent(target, {confirmed: true, expected_route_revision: freshState.planner.configuration_revision, expected_source_version: source.version, expected_version: active?.version ?? null}, id);
      } else if (kind === "revoke" && active) {
        operation = {kind, conversationId: active.id, id}; rememberNaturalOperation(operation); refreshJournal(); setSnapshot(null); setConsent(false);
        await api.revoke(active.id, active.version, id);
      } else if (kind === "send" && active && availableConversation(freshState, Date.now())) {
        const content = retry?.user_content ?? draft.trim(), selected = retry ? retry.goal_id : (goalId || null);
        const goal = selected ? freshState.runtime.goals.find((item) => item.id === selected) : null;
        const refs = retry?.request_evidence_ids ?? evidenceIds;
        if (!content || content.length > 2000 || !same(sourceOf(freshState.runtime), sourceOf(parentSnapshot.current ?? freshState.runtime)) || (selected && (!goal || !parentGoalMatches(goal, parentSnapshot.current) || goal.content_withheld || goal.source_ids.length !== 1 || goal.source_ids[0] !== "synthetic")) || refs.some((ref) => !freshState.runtime.evidence.some((item) => item.id === ref && item.valid && item.source_id === "synthetic" && item.source_version === source.version && parentEvidenceMatches(item, parentSnapshot.current) && future(item.expires_at, Date.now())))) throw new Error("invalid context");
        operation = {kind: "turn", conversationId: active.id, id}; rememberNaturalOperation(operation); refreshJournal();
        const response = await api.send(active.id, {request_id: id, content, goal_id: selected, expected_goal_version: retry ? retry.expected_goal_version : goal?.version ?? null, expected_version: active.version, evidence_ids: refs, retry_of: retry?.request_id ?? null});
        if (response.status === "outcome_unknown") {
          if (alive(l, c)) { await refresh(); setError("这轮请求结果未知。请核对原请求，不会自动重发。"); }
          return;
        }
      } else if (kind === "adopt" && active && proposal && confirmation?.conversationId === active.id && proposalKey(confirmation.proposal) === proposalKey(proposal)) {
        const turn = active.turns.find((item) => item.proposal?.id === proposal.id && item.proposal.version === proposal.version);
        if (!turn || !readableNaturalTurn(turn, freshState) || !!parentSnapshot.current && !readableNaturalTurn(turn, {...freshState, runtime: parentSnapshot.current}) || !same(turn.proposal, proposal) || turn.proposal?.status !== "proposed_unverified") { setConfirmation(null); setFresh(true); setError("这份建议或版本已经变化，请重新查看准确的建议后再采纳。"); return; }
        operation = {kind: "adoption", conversationId: active.id, proposalId: proposal.id, id}; rememberNaturalOperation(operation); refreshJournal();
        const result = await api.adopt(active.id, proposal.id, proposal.version, id);
        if (!alive(l, c)) return;
        setConfirmation(null); const value = await refresh();
        if (alive(l, c) && value) { forgetNaturalOperation(id); refreshJournal(); setFeedback(`已采纳建议 ${proposal.id} / 版本 ${proposal.version}，目标 ${result.receipt.goal_id} 已保存。整个循环的启用状态没有改变。`); await onAdopted?.(result.receipt.goal_id); }
        return;
      } else return;
      if (!alive(l, c)) return;
      setConsent(false); setConfirmation(null);
      if (kind === "send" && !retry) setDraft("");
      const value = await refresh();
      if (alive(l, c) && value) { forgetNaturalOperation(id); if (retry) forgetNaturalOperation(retry.request_id); refreshJournal(); setFeedback(kind === "consent" ? "已明确授权这个合成测试对话。只有点击发送才会调用已显示的本地文字模型。" : kind === "revoke" ? "这个对话的模型处理授权已撤销，派生内容已隐藏。" : "已重新读取本机保存的这轮对话。模型回复仍是未核验的生成内容。"); }
    } catch (reason) {
      if (!alive(l, c)) return;
      const rejectedStatus = reason instanceof NaturalChatRequestError && [400, 403, 404, 409, 422].includes(reason.status) ? reason.status : undefined;
      if (operation) await reconcile(operation, l, c, rejectedStatus);
      else { setFresh(false); setConsent(false); setError("无法完成操作前的状态核对。没有发送新请求，请刷新后重试。"); }
    } finally { if (mounted.current && life.current === l) { writing.current = false; setPending(false); } }
  }

  const unresolvedTurn = journal.some((item) => item.kind === "turn" && item.conversationId === selectedId);
  const route = snapshot?.planner.configuration;
  const confirmationTurn = confirmation && conversation?.turns.find((turn) => turn.proposal?.id === confirmation.proposal.id && turn.proposal.version === confirmation.proposal.version && same(turn.proposal, confirmation.proposal));
  const confirmationReadable = !!snapshot && !!confirmationTurn && readableNaturalTurn(confirmationTurn, snapshot, now) && (!runtimeSnapshot || readableNaturalTurn(confirmationTurn, {...snapshot, runtime: runtimeSnapshot}, now));
  return <section className="natural-chat loop-card" aria-labelledby="natural-chat-title" aria-busy={loading || pending}>
    <div className="loop-section-heading"><div><p className="loop-kicker">Preview / Synthetic conversation</p><h2 id="natural-chat-title">和本地模型讨论，再决定要跟进什么</h2></div><button disabled={pending} onClick={() => void refresh()}>{loading ? "正在读取合成对话…" : "刷新合成对话"}</button></div>
    <p className="loop-caption">这里只接受你编写的合成测试内容。支持持续对话、澄清问题和目标建议；不会读取下方旧笔记、屏幕或真实个人资料。打开或重开页面只读取记录，不调用模型。</p>
    <div className="natural-chat-selector"><label htmlFor="natural-conversation">选择明确的合成对话<select id="natural-conversation" value={selectedId} onChange={(event) => select(event.target.value)}><option value="">新建合成测试对话（尚未创建）</option>{snapshot?.conversations.map((item) => <option key={item.id} value={item.id}>{item.id} · {statusLabels[item.status]} · v{item.version}</option>)}{selectedId && !snapshot?.conversations.some((item) => item.id === selectedId) && <option value={selectedId}>{selectedId} · 待核对</option>}</select></label></div>
    {snapshot && <div className="natural-route"><strong>当前文字模型路由</strong><p>{route ? `${route.protocol} · ${route.endpoint} · ${route.model}` : "尚未配置本地文字模型；请先在上方配置并手动验证"}</p><small>路由版本 {snapshot.planner.configuration_revision} · 合成来源版本 {ownSource?.version ?? "未知"} · {ownSource?.status ?? "未授权"}。配置状态来自保存的验证结果，不代表此刻连通。</small></div>}
    {!contentCurrent && <p className="loop-feedback" role="status">来源、目标或模型路由待核对。相关内容已立即隐藏，请在操作结束后刷新核对。</p>}
    {conversation && !current && contentCurrent && <p className="loop-feedback" role="status">此对话授权已撤销、到期或与当前来源 / 模型路由不一致。旧回复与目标建议不再显示；重新授权不会恢复旧派生内容。</p>}
    <p className="natural-retention">本对话只在同一授权期间保留可读上下文。重新授权、撤销授权，或更换本地文字模型路由 / 规划器选择，会清除这段合成对话的输入、回复与建议内容；下方旧笔记不受影响。已采纳的独立目标请另行暂停或取消。</p>
    {snapshot && (!conversation || !current) && <div className="natural-consent"><label className="loop-check"><input id="natural-synthetic-consent" type="checkbox" checked={consent} disabled={blocked || !availableScope(snapshot, now)} onChange={(event) => setConsent(event.target.checked)} />我确认仅输入虚构测试内容，并授权这个对话由上面显示的本地文字模型处理；不包含旧笔记、真实个人资料或 user_statement</label><button className="loop-primary" disabled={blocked || !consent || !availableScope(snapshot, now)} onClick={() => void perform("consent")}>{conversation ? "按当前路由重新授权此对话" : "新建并授权合成测试对话"}</button>{!availableScope(snapshot, now) && <small>需先明确授权 synthetic 来源，并验证本地文字模型路由。</small>}</div>}
    {conversation && <div className="loop-controls"><span className="loop-id">对话 {conversation.id} · 版本 {conversation.version} · {statusLabels[conversation.status]}</span>{conversation.status === "active" && <button disabled={blocked} onClick={() => void perform("revoke")}>撤销此对话的模型授权</button>}</div>}
    {error && <p className="loop-feedback" role="alert">{error}</p>}{feedback && <p className="loop-feedback" role="status">{feedback}</p>}
    {journal.length > 0 && <section className="natural-recovery" aria-label="核对未确认的对话请求"><strong>以下请求需要核对，不会自动重发</strong>{journal.map((operation) => <div key={operation.id}><span className="loop-id">{operation.kind} · {operation.conversationId} · 请求 {operation.id}</span><button disabled={pending || loading} onClick={() => { if (selection.current !== operation.conversationId) select(operation.conversationId); void reconcile(operation, life.current, context.current); }}>核对请求 {operation.id}</button></div>)}</section>}
    {current && snapshot && conversation && <>
      <ol className="natural-turns" aria-label="合成模型对话时间线">{conversation.turns.map((turn) => {
        const readable = readableNaturalTurn(turn, snapshot, now) && (!runtimeSnapshot || readableNaturalTurn(turn, {...snapshot, runtime: runtimeSnapshot}, now));
        return <li key={turn.request_id} data-turn-id={turn.request_id}>
          <div className="loop-message-meta"><span>请求 {turn.request_id}</span><time dateTime={turn.created_at}>{new Date(turn.created_at).toLocaleString("zh-CN", {hour12: false})}</time></div>
          {!readable ? <p className="natural-withheld">这轮对话的来源、路由或依据已变化 / 到期，内容与建议已隐藏。</p> : <>
            {turn.user_content && <div className="natural-user"><strong>你 · 合成测试输入</strong><p>{turn.user_content}</p></div>}
            {turn.status === "completed" && turn.answer && <div className="natural-answer"><strong>{turn.reply_kind === "clarification" ? "本地安全检查需要补充信息" : turn.disposition === "question" ? "模型的澄清问题 · 未核验" : "模型回复 · 未核验"}</strong><p>{turn.answer}</p><small>{turn.reply_kind === "clarification" ? "本地检查尚未得到明确目标和完成条件；没有建立或采纳目标。" : "生成内容不代表事实、指令、已执行步骤或目标已完成。"}</small></div>}
            {turn.status === "failed" && <p role="status">{failureText(turn.error_code)}{turn.error_code ? `（${turn.error_code}）` : ""}</p>}
            {turn.status === "outcome_unknown" && <p role="status">这轮请求结果未知。可能已经调用本地模型，不能视为失败；先核对原请求，不会自动再调用。</p>}
            {turn.citations.length > 0 && <details className="natural-citations"><summary>查看已匹配的引用（{turn.citations.length}）</summary><ul>{turn.citations.map((citation) => <li key={citation.id}><span className="loop-id">{citation.id}</span><p>对象 {citation.target_id} · {citation.event_type} · {citation.observed_at}</p><small>untrusted · 仅验证引用对应授权本地记录，没有核实外部事实</small></li>)}</ul></details>}
            {turn.proposal && <article className="natural-proposal" aria-label={`目标建议 ${turn.proposal.id}`}>
              <h3>目标建议 · 未核验</h3><strong>{turn.proposal.title}</strong><p className="loop-id">建议 {turn.proposal.id} · 版本 {turn.proposal.version}</p><dl><dt>精确完成条件</dt><dd>对象 {turn.proposal.target_id} / 事件 {turn.proposal.success_event_type} = {JSON.stringify(turn.proposal.success_value)}</dd><dt>截止时间</dt><dd>{turn.proposal.deadline_at || "未设置"}</dd></dl><p>{turn.proposal.plan.summary}</p><ol>{turn.proposal.plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              <p className="loop-caption">这只是结构化建议。采纳会明确建立并批准这个本地目标；模型文字不会变成可执行命令，完成仍需要独立匹配依据。</p>
              {turn.proposal.status === "adopted" ? <p role="status">已采纳为目标 {turn.proposal.adopted_goal_id}。请在下方查看或控制这个准确目标。</p> : <button className="loop-primary" disabled={blocked || journal.some((operation) => operation.kind === "adoption" && operation.conversationId === conversation.id && operation.proposalId === turn.proposal?.id) || !future(turn.proposal.deadline_at, now)} onClick={() => setConfirmation({conversationId: conversation.id, proposal: turn.proposal!})}>采纳并跟进 · {turn.proposal.id} / v{turn.proposal.version}</button>}
            </article>}
            {["failed", "outcome_unknown"].includes(turn.status) && turn.user_content && <button disabled={blocked || !!turn.retry_after && Date.parse(turn.retry_after) > now} onClick={() => void perform("send", undefined, turn)}>明确重试原请求 {turn.request_id}</button>}
          </>}
        </li>;
      })}</ol>
      {!conversation.turns.length && <p className="loop-empty">这个对话还没有消息。发送一条虚构场景，模型可以回答、澄清，或提供待你采纳的目标建议。</p>}
      {confirmation && confirmationReadable && confirmation.conversationId === conversation.id && <div className="loop-confirm" role="group" aria-label="确认采纳准确的建议版本"><p>采纳「{confirmation.proposal.title}」？</p><p className="loop-id">仅采纳建议 {confirmation.proposal.id} · 版本 {confirmation.proposal.version} · 对话 {confirmation.conversationId}</p><p>将创建并批准这个目标。整个循环{snapshot.runtime.status.enabled ? "当前已启用，符合条件后可以推进这个目标" : "当前暂停；采纳不会自动启用循环"}。</p><div className="loop-controls"><button className="loop-primary" disabled={blocked} onClick={() => void perform("adopt", confirmation.proposal)}>确认采纳这个建议版本</button><button disabled={pending} onClick={() => setConfirmation(null)}>暂不采纳</button></div></div>}
      <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); void perform("send"); }}>
        <label htmlFor="natural-goal-context">可选：明确关联一个合成目标<select id="natural-goal-context" value={goalId} disabled={pending} onChange={(event) => { setGoalId(event.target.value); setEvidenceIds([]); setConfirmation(null); }}><option value="">不关联目标（不会默认选最新目标）</option>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title} · {goal.id} / v{goal.version}</option>)}{goalId && !goals.some((goal) => goal.id === goalId) && <option value={goalId}>{goalId} · 已不可用，请重新选择</option>}</select></label>
        {readableEvidence.length > 0 && <details><summary>可选：带入合成依据（最多 8 条）</summary>{readableEvidence.map((item) => <label className="loop-check" key={item.id}><input type="checkbox" disabled={pending || evidenceIds.length >= 8 && !evidenceIds.includes(item.id)} checked={evidenceIds.includes(item.id)} onChange={(event) => setEvidenceIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />{item.id} · {item.target_id} / {item.event_type} · untrusted</label>)}</details>}
        <label htmlFor="natural-message">给本地模型的合成测试消息<textarea id="natural-message" maxLength={2000} disabled={pending} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：虚构项目 demo-a 需要在收到 commitment_closed=true 后标为完成；请先帮我理清计划" /></label><div className="loop-controls"><button type="submit" className="loop-primary" disabled={blocked || !draft.trim() || unresolvedTurn || !!goalId && !goals.some((goal) => goal.id === goalId)}>{pending ? "正在核对并处理…" : "发送给本地模型"}</button><small>仅本轮明确发送才调用模型。采纳建议是另一步，回复不会自动授权行动。</small></div>
      </form>
    </>}
  </section>;
}
