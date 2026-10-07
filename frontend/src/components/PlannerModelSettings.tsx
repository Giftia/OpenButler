import {useEffect, useRef, useState} from "react";
import {agentRuntimeApi, commandIdFor, confirmCommand, reconcileCommandReceipts, type AgentRuntimeApi, type PlannerConfiguration, type PlannerMode, type RuntimePlannerStatus} from "../lib/agentRuntimeApi";
import "./PlannerModelSettings.css";

const labels = {deterministic: "确定性规则规划器", local_model: "本地 HTTP 文字模型"};
const failures = {
  local_text_probe_failed: "本次文字模型验证失败；这份配置不可用。请检查本机服务后手动重试。",
  model_planner_unavailable: "最近的模型规划请求失败；没有自动切换回规则规划器。",
  planner_configuration_invalid: "保存的规划器配置无效；需要你明确重新配置或选择规则规划器。"
};

/** Only literal loopback HTTP targets are offered by this separate text control. */
export function plannerConfigurationError(configuration: PlannerConfiguration): string | null {
  const {endpoint, protocol, model} = configuration;
  try {
    if (endpoint !== endpoint.trim() || /[\s\\%]/.test(endpoint) || endpoint.endsWith("/")) throw new Error();
    const url = new URL(endpoint);
    const authority = endpoint.match(/^http:\/\/([^/]+)(?:\/|$)/)?.[1];
    const host = authority?.replace(/:\d+$/, "");
    if (url.protocol !== "http:" || !host || !(host === "localhost" || host === "[::1]" || /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255)) ||
        url.username || url.password || url.search || url.hash || endpoint.includes("/../") || endpoint.includes("/./") ||
        (protocol === "openai_compatible" ? url.pathname === "/" : url.pathname !== "/")) throw new Error();
  } catch { return protocol === "openai_compatible" ? "请输入本机 HTTP 地址并包含 API 前缀，例如 http://127.0.0.1:11434/v1；不能填写云端地址、凭据或查询参数。" : "请输入本机 HTTP 根地址，例如 http://127.0.0.1:11434；Ollama 原生协议不填写路径。"; }
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(model) ? null : "请填写本机已安装的模型名称，只使用字母、数字、点、下划线、冒号、斜线或连字符。";
}

function sameConfiguration(left: PlannerConfiguration | null, right: PlannerConfiguration) {
  return left?.protocol === right.protocol && left.endpoint === right.endpoint && left.model === right.model && left.scope === right.scope;
}

/** GET on mount only. Model processing requires a separate explicit consent and click. */
export function PlannerModelSettings({api = agentRuntimeApi, disabled = false, onMutationStart, onChanged}: {
  api?: AgentRuntimeApi; disabled?: boolean; onMutationStart?: () => void; onChanged?: () => unknown | Promise<unknown>;
}) {
  const [status, setStatus] = useState<RuntimePlannerStatus | null>(null);
  const [mode, setMode] = useState<PlannerMode>("deterministic");
  const [protocol, setProtocol] = useState<PlannerConfiguration["protocol"]>("openai_compatible");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434/v1");
  const [model, setModel] = useState("");
  const [consent, setConsent] = useState(false);
  const [fresh, setFresh] = useState(false), [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const mounted = useRef(false), lifecycle = useRef(0), readRevision = useRef(0), writing = useRef(false);
  const configurationDirty = useRef(false), selectionDirty = useRef(false);
  const readController = useRef<AbortController | null>(null);

  async function refresh(): Promise<RuntimePlannerStatus | null> {
    const revision = ++readRevision.current, life = lifecycle.current;
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    setLoading(true); setFresh(false);
    try {
      await reconcileCommandReceipts(api, controller.signal);
      if (!mounted.current || life !== lifecycle.current || revision !== readRevision.current) return null;
      const current = await api.plannerStatus(controller.signal);
      if (!mounted.current || life !== lifecycle.current || revision !== readRevision.current) return null;
      setStatus(current); setFresh(true); setError("");
      if (!selectionDirty.current) setMode(current.selected_mode);
      if (!configurationDirty.current && current.configuration) {
        setProtocol(current.configuration.protocol); setEndpoint(current.configuration.endpoint); setModel(current.configuration.model);
      }
      return current;
    } catch (reason) {
      if (mounted.current && life === lifecycle.current && revision === readRevision.current && (reason as Error).name !== "AbortError") {
        setError("无法核对最新规划器状态。旧状态仅供查看；请先刷新成功再操作。");
      }
      return null;
    } finally { if (mounted.current && life === lifecycle.current && revision === readRevision.current) setLoading(false); }
  }

  useEffect(() => {
    mounted.current = true; lifecycle.current++; writing.current = false; setPending(false);
    configurationDirty.current = false; selectionDirty.current = false; setConsent(false); setStatus(null); setMode("deterministic");
    setProtocol("openai_compatible"); setEndpoint("http://127.0.0.1:11434/v1"); setModel(""); void refresh();
    return () => { mounted.current = false; lifecycle.current++; readRevision.current++; readController.current?.abort(); };
  }, [api]);

  async function mutate(key: string, action: (id: string) => Promise<unknown>, verify: (value: RuntimePlannerStatus) => boolean, success: string) {
    if (writing.current || disabled || !fresh || loading) return;
    writing.current = true; setPending(true); setFresh(false); setError(""); setFeedback("");
    const life = lifecycle.current;
    let commandId: string | null = null;
    const active = () => mounted.current && life === lifecycle.current;
    async function readback(receipt = false) {
      const current = await refresh();
      if (!active()) return;
      await onChanged?.();
      if (!active()) return;
      if (!current) { setError("本机回执已确认，但最新规划器状态暂时不可读。请刷新核对，不要另建重复请求。"); return; }
      if (!verify(current)) { setError("请求已获本机回执，但当前配置或选择与请求不一致。请以刷新后的状态为准。"); return; }
      setConsent(false);
      setFeedback(`${receipt ? "已核对本机回执。" : ""}${success}`);
    }
    try {
      commandId = await commandIdFor(key);
      if (!active()) return;
      onMutationStart?.();
      await action(commandId);
      // Replay responses are receipts, not planner statuses. Always read back.
      await confirmCommand(key);
      if (!active()) return;
      await readback();
    } catch {
      if (!active()) return;
      if (commandId) {
        try {
          const receipt = await api.commandStatus(commandId);
          if (!active()) return;
          if (receipt.state === "completed") { await confirmCommand(key); if (active()) await readback(true); return; }
        } catch { /* Unknown receipts retain the same request ID for explicit retry. */ }
      }
      if (!active()) return;
      setFresh(false); setError("请求结果尚未确认，可能已经保存。请先刷新核对；相同版本与内容的重试会沿用请求编号。");
    } finally { if (active()) { writing.current = false; setPending(false); } }
  }

  const blocked = disabled || !fresh || loading || pending;
  const configuration: PlannerConfiguration = {protocol, endpoint: endpoint.trim(), model: model.trim(), scope: "synthetic_only"};
  const selected = status?.selected_mode;
  const repairDeterministic = mode === "deterministic" && selected === "deterministic" && !!status &&
    (!status.ready || status.last_failure === "planner_configuration_invalid");
  const quota = status?.daily_budget;
  const quotaValid = quota && [quota.limit, quota.used, quota.remaining].every((count) => Number.isSafeInteger(count) && count >= 0) && typeof quota.resets_at === "string";
  function editConfiguration() { configurationDirty.current = true; setConsent(false); setFeedback(""); }
  function configure() {
    if (!consent || !status) return;
    const invalid = plannerConfigurationError(configuration);
    if (invalid) { setError(invalid); return; }
    const version = status.configuration_revision;
    void mutate(`planner:configure:${version}:${JSON.stringify(configuration)}`, (id) => api.configurePlanner(configuration, id),
      (current) => current.configuration_revision > version && sameConfiguration(current.configuration, configuration) && current.confirmed,
      "配置与验证结果已核对。请查看模型配置状态；需要另行明确选择才会切换规划器。");
  }
  function select() {
    if (!status || mode === status.selected_mode && !repairDeterministic) return;
    const version = status.configuration_revision, requested = mode, repair = repairDeterministic;
    selectionDirty.current = false;
    void mutate(`planner:select:${version}:${requested}`, (id) => api.selectPlanner(requested, id),
      (current) => current.selected_mode === requested && current.ready &&
        (repair ? current.configuration_revision > version && current.last_failure !== "planner_configuration_invalid" : current.configuration_revision >= version),
      `已${repair ? "恢复" : "选择"}${labels[requested]}。选择本身不会发送验证请求，也不会启用已暂停的循环。`);
  }

  return <section className="loop-card planner-model-settings" aria-labelledby="planner-model-title" aria-busy={loading || pending}>
    <div className="loop-section-heading"><h2 id="planner-model-title">目标规划器</h2><button type="button" disabled={pending} onClick={() => void refresh()} aria-label="刷新规划器状态">{loading ? "读取规划器中…" : "刷新规划器状态"}</button></div>
    <p className="loop-caption">默认使用确定性规则。本地文字模型有独立配置与授权，不使用录屏、图像模型或来源跟踪的授权。</p>
    <p className="loop-caption">重新配置文字模型或更改规划器选择，会清除单独授权的合成对话输入、回复与建议上下文。旧笔记保留；已采纳的独立目标需另行暂停或取消。</p>
    <dl className="planner-status-grid">
      <div><dt>当前已选模式</dt><dd data-testid="planner-selected-mode">{selected ? labels[selected] : "尚未读取"}{status && !fresh ? "（待刷新核对）" : ""}</dd></div>
      <div><dt>所选模式状态</dt><dd>{status ? status.ready ? "服务报告配置可用" : "当前不可用；未自动回退" : "未知"}</dd></div>
      <div><dt>本地模型配置</dt><dd>{status ? !status.configured ? "未配置" : status.model_ready ? "已验证配置" : status.needs_validation ? "已保存 · 需要验证" : "已保存 · 当前不可用" : "未知"}</dd></div>
      <div><dt>上次手动验证</dt><dd>{status ? {never: "尚未验证", passed: "通过（不是实时连通检查）", failed: "失败"}[status.last_attempt] : "未知"}</dd></div>
    </dl>
    {status && <p className="loop-caption">配置版本 {status.configuration_revision} · 页面重开只读取本机保存状态，不自动配置、探测或调用模型。已验证配置不保证模型此刻连通。</p>}
    {quotaValid && <p className="loop-caption">UTC 当日自动模型尝试：{quota.used} / {quota.limit}，剩余 {quota.remaining}。手动验证不计入此额度。</p>}
    {status?.last_failure && <p className="loop-feedback" role="alert">{failures[status.last_failure]} <span className="loop-id">{status.last_failure}</span></p>}
    {error && <p className="loop-feedback" role="alert">{error}</p>}{feedback && <p className="loop-feedback" role="status">{feedback}</p>}
    <form className="planner-selection" onSubmit={(event) => { event.preventDefault(); select(); }}>
      <label htmlFor="planner-mode">选择下一次使用的规划方式<select id="planner-mode" value={mode} disabled={blocked} onChange={(event) => { selectionDirty.current = true; setMode(event.target.value as PlannerMode); setFeedback(""); }}><option value="deterministic">确定性规则规划器</option><option value="local_model">本地 HTTP 文字模型（仅合成测试）</option></select></label>
      <button type="submit" disabled={blocked || !status || mode === selected && !repairDeterministic || mode === "local_model" && (!status.model_ready || !status.confirmed || status.needs_validation)}>{repairDeterministic ? "明确恢复规则规划器" : "明确选择此规划器"}</button>
      {mode === "local_model" && <small>仅允许 synthetic 合成测试目标与依据进入本地模型。user_statement 手动声明、对话记录和屏幕内容都不在此授权范围。</small>}
    </form>
    <details className="planner-configuration"><summary>配置并验证本地文字模型</summary>
      <p className="loop-caption">先手动启动本机模型服务。此处只接受回环 HTTP 地址，不支持云端、自定义远程服务或 API 密钥。</p>
      <form className="loop-composer" onSubmit={(event) => { event.preventDefault(); configure(); }}>
        <div className="loop-form-row"><label htmlFor="planner-protocol">文字协议<select id="planner-protocol" value={protocol} disabled={pending} onChange={(event) => { editConfiguration(); setProtocol(event.target.value as PlannerConfiguration["protocol"]); }}><option value="openai_compatible">OpenAI 兼容 · openai_compatible</option><option value="ollama_native">Ollama 原生 · ollama_native</option></select></label><label htmlFor="planner-model">本机模型名称<input id="planner-model" value={model} maxLength={200} disabled={pending} onChange={(event) => { editConfiguration(); setModel(event.target.value); }} autoComplete="off" placeholder="填写本机已安装的模型名称" required /></label></div>
        <label htmlFor="planner-endpoint">本机 HTTP 地址<input id="planner-endpoint" type="url" value={endpoint} maxLength={512} disabled={pending} onChange={(event) => { editConfiguration(); setEndpoint(event.target.value); }} autoComplete="off" required /></label>
        <small>{protocol === "openai_compatible" ? "OpenAI 兼容地址需含 API 前缀，例如 http://127.0.0.1:11434/v1" : "Ollama 原生地址不含路径，例如 http://127.0.0.1:11434"}</small>
        <label className="planner-consent"><input id="planner-synthetic-consent" type="checkbox" checked={consent} disabled={blocked} onChange={(event) => setConsent(event.target.checked)} />我同意将 synthetic 合成测试文字发送到上方本机模型用于验证与目标规划；不包含手动声明、对话或屏幕内容</label>
        <div className="loop-controls"><button type="submit" className="loop-primary" disabled={blocked || !consent || !model.trim() || !endpoint.trim()}>手动验证并保存配置</button><small>会发送合成验证文字；配置失败会使这份模型配置不可用</small></div>
      </form>
    </details>
  </section>;
}
