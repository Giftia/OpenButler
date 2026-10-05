import {useEffect, useId, useRef, useState} from "react";
import {Box, CheckCircle2, ChevronRight, Download, FileText, Image, Info, Laptop, RefreshCw, Settings2, X} from "lucide-react";
import {formatModelBytes, isActiveDownload, modelCatalogError, roleLabel, trustedCatalogLink, validDownloadJob} from "../lib/modelCatalog";
import type {ModelCatalogBridge, ModelCatalogEntry, ModelDownloadJob, ModelHostInspection, ModelRole} from "../lib/modelCatalog";
import "./ModelCatalog.css";

type Props = {
  onPick: (role: ModelRole, endpoint: string, model: string) => void;
  onOpenAdvanced: () => void;
  assignments: {image: string; text: string; status: string};
  disabled?: boolean;
  bridge?: Partial<ModelCatalogBridge>;
};
const downloadLabels: Record<ModelDownloadJob["state"], string> = {
  starting: "准备下载", downloading: "下载中", verifying: "校验中", succeeded: "已下载，待测试", failed: "下载失败", interrupted: "停止状态未确认",
};
const activeStates = ["starting", "downloading", "verifying"];

export function ModelCatalog({onPick, onOpenAdvanced, assignments, disabled = false, bridge = window.openbutlerDesktop}: Props) {
  const scope = useId();
  const detailButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [entries, setEntries] = useState<ModelCatalogEntry[]>([]);
  const [role, setRole] = useState<ModelRole>("image");
  const [mode, setMode] = useState<"candidates" | "installed">("candidates");
  const [allModels, setAllModels] = useState(false);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434");
  const [serviceOpen, setServiceOpen] = useState(false);
  const [inspection, setInspection] = useState<ModelHostInspection | null>(null);
  const [job, setJob] = useState<ModelDownloadJob | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inspect" | "download" | "cancel" | null>(null);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [downloadUncertain, setDownloadUncertain] = useState(false);
  const lastJob = useRef<ModelDownloadJob | null>(null);
  const verifiedThisView = useRef<string | null>(null);
  const control = useRef({active: false, revision: 0, mutation: false, polling: false});
  const available = Boolean(bridge?.getBuiltinModelCatalog && bridge?.inspectBuiltinModelHost && bridge?.startBuiltinModelDownload && bridge?.getBuiltinModelDownload && bridge?.cancelBuiltinModelDownload);
  const running = isActiveDownload(job);
  const blockedJob = job?.serverState === "unknown";
  const selectedHost = inspection?.ok && inspection.endpoint === endpoint.trim() ? inspection : null;
  const connected = selectedHost?.runtime?.available === true;
  const selectedEntry = entries.find((entry) => entry.id === details);
  const jobEntry = entries.find((entry) => entry.id === job?.catalogId);

  function adoptJob(value: unknown) {
    if (value === null) { lastJob.current = null; setJob(null); return; }
    if (!validDownloadJob(value)) throw new Error("invalid_download_state");
    const previous = lastJob.current;
    lastJob.current = value;
    if (value.state === "succeeded" && previous?.id === value.id && isActiveDownload(previous)) {
      verifiedThisView.current = value.id;
      setInspection((current) => current?.endpoint === value.endpoint ? {...current, entries: current.entries?.map((entry) => entry.id === value.catalogId
        ? {...entry, installed: true, digestMatches: true, imageMetadataVerified: true} : entry)} : current);
    }
    setJob(value);
  }

  useEffect(() => {
    const state = control.current; state.active = true;
    const revision = ++state.revision;
    async function load() {
      if (!available) { setLoaded(true); return; }
      try {
        // Static catalog and local journal only: opening this view never probes a model service.
        const [catalog, snapshot] = await Promise.all([bridge!.getBuiltinModelCatalog!(), bridge!.getBuiltinModelDownload!()]);
        if (!state.active || revision !== state.revision) return;
        if (!catalog.ok || !Array.isArray(catalog.entries) || catalog.entries.length > 32
          || catalog.entries.some((entry) => !entry || typeof entry.id !== "string" || !Array.isArray(entry.roles) || !Array.isArray(entry.assets) || entry.assets.length > 64
            || !Number.isSafeInteger(entry.downloadBytes) || entry.downloadBytes < 0)) throw new Error("invalid_catalog");
        setEntries(catalog.entries);
        if (!snapshot.ok) { setDownloadUncertain(true); throw new Error("invalid_download_state"); }
        adoptJob(snapshot.job);
        if (snapshot.job) setEndpoint(snapshot.job.endpoint);
      } catch { if (state.active && revision === state.revision) setMessage("无法读取模型目录，请重新打开页面"); }
      finally { if (state.active && revision === state.revision) setLoaded(true); }
    }
    void load();
    return () => { state.active = false; state.revision++; };
  }, [bridge, available]);

  useEffect(() => {
    if (!running || !job || !bridge?.getBuiltinModelDownload) return;
    const state = control.current, jobId = job.id;
    let disposed = false;
    const timer = window.setInterval(async () => {
      if (disposed || state.polling || state.mutation) return;
      state.polling = true;
      const revision = state.revision;
      try {
        const result = await bridge.getBuiltinModelDownload!({jobId});
        if (disposed || !state.active || revision !== state.revision) return;
        if (!result.ok || !result.job || result.job.id !== jobId) throw new Error("invalid_download_state");
        adoptJob(result.job);
        setMessage("");
      } catch { if (!disposed && state.active && revision === state.revision) setMessage("下载状态暂时无法读取，请勿重复下载"); }
      finally { state.polling = false; }
    }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [running, job?.id, bridge]);

  async function inspect() {
    if (!available || disabled || control.current.mutation || running) return;
    const state = control.current, version = ++state.revision, target = endpoint.trim();
    state.mutation = true; verifiedThisView.current = null; setBusy("inspect"); setMessage(""); setInspection(null);
    try {
      const result = await bridge!.inspectBuiltinModelHost!({endpoint: target, protocol: "ollama_native"});
      if (!state.active || version !== state.revision) return;
      if (!result.ok || result.endpoint !== target || !result.inspectionId || !result.runtime || !Array.isArray(result.entries)) {
        setMessage(modelCatalogError(result.error_code)); return;
      }
      setInspection(result); setEndpoint(target); setServiceOpen(false);
      // Explicit inspection refreshes installed metadata; it cannot prove an interrupted server pull stopped.
      const snapshot = await bridge!.getBuiltinModelDownload!();
      if (state.active && version === state.revision && snapshot.ok) adoptJob(snapshot.job);
    } catch { if (state.active && version === state.revision) setMessage("检测未完成，请检查服务地址"); }
    finally { state.mutation = false; if (state.active && version === state.revision) setBusy(null); }
  }

  async function download(entry: ModelCatalogEntry) {
    if (disabled || control.current.mutation || running || blockedJob || downloadUncertain || !connected || !selectedHost?.inspectionId || !entry.downloadSupported) return;
    const state = control.current, version = ++state.revision;
    state.mutation = true; setBusy("download"); setMessage("");
    try {
      const result = await bridge!.startBuiltinModelDownload!({inspectionId: selectedHost.inspectionId, catalogId: entry.id, downloadConsent: true});
      if (!state.active || version !== state.revision) return;
      if (result.job) adoptJob(result.job);
      if (!result.ok) setMessage(modelCatalogError(result.error_code));
    } catch { if (state.active && version === state.revision) { setDownloadUncertain(true); setMessage("下载结果未确认，请先刷新状态"); } }
    finally { state.mutation = false; if (state.active && version === state.revision) setBusy(null); }
  }

  async function disconnect() {
    if (!job || !running || control.current.mutation) return;
    const state = control.current, version = ++state.revision, jobId = job.id;
    state.mutation = true; setBusy("cancel"); setMessage("");
    try {
      const result = await bridge!.cancelBuiltinModelDownload!({jobId});
      if (!state.active || version !== state.revision) return;
      if (result.job && result.job.id === jobId) adoptJob(result.job);
      if (!result.ok) setMessage(modelCatalogError(result.error_code));
    } catch { if (state.active && version === state.revision) setMessage("断开结果未确认，请先刷新状态"); }
    finally { state.mutation = false; if (state.active && version === state.revision) setBusy(null); }
  }

  async function refreshDownload() {
    if (!available || control.current.mutation) return;
    const state = control.current, version = ++state.revision;
    state.mutation = true;
    try {
      const result = await bridge!.getBuiltinModelDownload!();
      if (state.active && version === state.revision) {
        if (!result.ok) throw new Error("invalid_download_state");
        adoptJob(result.job); setDownloadUncertain(false); setMessage("");
      }
    } catch { if (state.active && version === state.revision) setMessage("下载状态暂时无法读取"); }
    finally { state.mutation = false; }
  }

  async function openCatalogLink(event: React.MouseEvent<HTMLAnchorElement>, entry: ModelCatalogEntry, kind: "source" | "license") {
    if (!bridge?.openBuiltinModelCatalogLink) return;
    event.preventDefault();
    try {
      const result = await bridge.openBuiltinModelCatalogLink({catalogId: entry.id, kind});
      if (!result.ok && control.current.active) setMessage("无法打开官方链接，请稍后重试");
    } catch { if (control.current.active) setMessage("无法打开官方链接，请稍后重试"); }
  }

  function installed(entry: ModelCatalogEntry) {
    const record = selectedHost?.entries?.find((item) => item.id === entry.id);
    if (record) return Boolean(record.installed && record.digestMatches && (!entry.roles.includes("image") || record.imageMetadataVerified));
    return Boolean(job && verifiedThisView.current === job.id && job.catalogId === entry.id && job.endpoint === endpoint.trim() && job.state === "succeeded" && job.serverState === "terminal");
  }
  function pick(entry: ModelCatalogEntry, target: ModelRole) {
    if (disabled || busy || running || !installed(entry) || !entry.roles.includes(target)) return;
    onPick(target, endpoint.trim(), entry.model);
    setMessage(`已填入${roleLabel[target]}草稿，请在下方手动测试`);
  }
  const candidates = entries.filter((entry) => entry.roles.includes(role) && (mode !== "installed" || installed(entry)))
    .sort((a, b) => (a.roles.length - b.roles.length) || a.downloadBytes - b.downloadBytes);
  const visibleEntries = allModels ? candidates : candidates.slice(0, 2);
  const percent = job?.totalBytes ? Math.min(100, Math.max(0, Math.floor(job.completedBytes / job.totalBytes * 100))) : null;
  const actionDisabled = disabled || !loaded || Boolean(busy) || running;

  return <div className="model-catalog" aria-label="设备模型目录">
    <header className="catalog-heading"><div><h2>模型</h2><p className="catalog-eyebrow">按运行设备推荐</p></div><span className="catalog-version">本地优先</span></header>
    <div className="catalog-layout">
      <div className="catalog-main">
        <section className="catalog-host" aria-label="模型运行设备">
          <span className="catalog-icon host-icon"><Laptop size={32} /></span>
          <div className="catalog-host-copy"><h3>运行设备：{connected ? "服务端配置未知" : "待连接"}</h3>
            <p>{connected ? `Ollama ${selectedHost?.runtime?.version || "版本未知"}` : "连接已有的 Ollama 服务"}</p>
            <span className={`catalog-status ${connected ? "connected" : ""}`}><i />{connected ? "已连接 · 硬件待确认" : "未检测"}</span>
          </div>
          <button className="catalog-secondary" disabled={actionDisabled || !available} onClick={() => setServiceOpen(!serviceOpen)}>{serviceOpen ? "收起" : "更换服务"}</button>
          {serviceOpen && <div className="catalog-service"><label htmlFor={`${scope}-endpoint`}>本机 Ollama 地址</label><div><input id={`${scope}-endpoint`} data-testid="catalog-endpoint" autoComplete="off" spellCheck={false} value={endpoint} disabled={actionDisabled} onChange={(event) => {control.current.revision++; setEndpoint(event.target.value); setInspection(null); setMessage("");}} /><button className="catalog-primary" disabled={actionDisabled || !available} onClick={() => void inspect()}>{busy === "inspect" ? "检测中" : "检测连接"}</button></div><small>只检测此地址，不扫描其他端口</small></div>}
          {!connected && !serviceOpen && <button className="catalog-primary catalog-connect" disabled={actionDisabled || !available} onClick={() => void inspect()}>{busy === "inspect" ? "检测中" : "检测连接"}</button>}
          <div className="catalog-host-meta"><span>{endpoint}</span><details><summary>设备详情</summary><p>Ollama 未提供可验证的硬件信息，暂不判断内存是否够用。</p>
            {selectedHost?.device && <p>应用所在设备：{selectedHost.device.platform} · {selectedHost.device.arch} · 内存上限 {formatModelBytes(selectedHost.device.memoryBytes)}（{selectedHost.device.memorySource.startsWith("cgroup") ? "容器限制" : selectedHost.device.memorySource === "physical" ? "系统读取" : "未知"}）。这是应用所在设备，不代表模型运行设备。</p>}
            <p>自定义远程服务请用高级设置；此处不支持远程下载。</p></details></div>
        </section>

        <section className="catalog-candidates" aria-labelledby={`${scope}-candidates-title`}>
          <div className="catalog-section-heading"><h3 id={`${scope}-candidates-title`}>{mode === "installed" ? "已安装模型" : "推荐候选"}</h3><button className="catalog-link" disabled={!available} onClick={() => {setMode(mode === "installed" ? "candidates" : "installed"); setAllModels(false);}}>{mode === "installed" ? "推荐候选" : "已安装"}</button></div>
          <div className="catalog-role-tabs" role="tablist" aria-label="模型用途" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next: ModelRole = event.key === "Home" ? "image" : event.key === "End" ? "text" : role === "image" ? "text" : "image";
            setRole(next); setDetails(null); setAllModels(false);
            (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === "image" ? 0 : 1])?.focus();
          }}>{(["image", "text"] as const).map((target) => <button role="tab" tabIndex={role === target ? 0 : -1} aria-selected={role === target} key={target} onClick={() => {setRole(target); setDetails(null); setAllModels(false);}}>{target === "image" ? <Image size={19} /> : <FileText size={19} />}{roleLabel[target]}</button>)}</div>
          {!available && <div className="catalog-empty"><Box size={30} /><strong>请在桌面版打开模型目录</strong><p>这里需要连接你选择的本机 Ollama 服务</p></div>}
          {available && !loaded && <p className="catalog-empty">正在读取目录…</p>}
          {available && loaded && visibleEntries.length === 0 && <div className="catalog-empty"><Box size={30} /><strong>{mode === "installed" ? "尚未找到已校验的模型" : "暂无候选"}</strong><p>{mode === "installed" ? "先检测当前服务，或在高级设置中选择已有模型" : "可在高级设置中手动配置"}</p></div>}
          {visibleEntries.map((entry, index) => <article className="catalog-model-row" key={entry.id}>
            <span className={`catalog-icon model-icon model-color-${index % 3}`}><Box size={28} /></span>
            <div className="catalog-model-copy"><div className="catalog-name"><h4>{entry.name}</h4><span className={`catalog-capability ${role === "image" ? "vision" : ""}`}>{role === "image" ? "视觉" : "文字"}</span></div>
              <p>Ollama · {entry.quantization}</p><p>下载 {formatModelBytes(entry.downloadBytes)} · 内存待测 <span className="catalog-unmeasured">未实测</span></p>
              <button className="catalog-link" ref={(node) => {detailButtons.current[entry.id] = node;}} aria-expanded={details === entry.id} onClick={() => setDetails(details === entry.id ? null : entry.id)}>详情 <ChevronRight size={14} /></button>
            </div>
            <div className="catalog-model-action">{installed(entry) ? <><span className="catalog-installed"><CheckCircle2 size={15} />已下载</span><button className="catalog-secondary" disabled={actionDisabled} onClick={() => pick(entry, role)}>填入配置</button></> : <button className="catalog-primary" disabled={actionDisabled || !connected || blockedJob || downloadUncertain || !entry.downloadSupported} onClick={() => void download(entry)}><Download size={16} />下载</button>}</div>
          </article>)}
          {candidates.length > 2 && <button className="catalog-more" onClick={() => setAllModels(!allModels)}><Box size={20} /><span>{allModels ? "收起更多模型" : "更多模型"}</span><ChevronRight size={19} /></button>}
          <div className="catalog-note"><Info size={17} /><span>{connected ? "按任务和运行环境列出；设备适配待测试" : "先检测服务，再下载适合用途的版本"}</span></div>
          <p className="catalog-download-scope">点击下载：由此地址的 Ollama 从官方模型库下载。仅下载，不启用模型。</p>
        </section>

        {selectedEntry && <section className="catalog-detail" aria-label={`${selectedEntry.name}版本详情`}>
          <div className="catalog-section-heading"><h3>{selectedEntry.name}</h3><button className="catalog-icon-button" aria-label="关闭版本详情" onClick={() => {setDetails(null); detailButtons.current[selectedEntry.id]?.focus();}}><X size={18} /></button></div>
          <dl><div><dt>精确版本</dt><dd>{selectedEntry.model}</dd></div><div><dt>运行环境</dt><dd>Ollama · {selectedEntry.quantization}</dd></div><div><dt>下载总量</dt><dd>{formatModelBytes(selectedEntry.downloadBytes)}</dd></div><div><dt>运行内存</dt><dd>待测</dd></div><div><dt>来源</dt><dd><a href={trustedCatalogLink(selectedEntry.sourceUrl)} onClick={(event) => void openCatalogLink(event, selectedEntry, "source")} target="_blank" rel="noreferrer">官方模型库 ↗</a></dd></div><div><dt>许可证</dt><dd><a href={trustedCatalogLink(selectedEntry.license.url)} onClick={(event) => void openCatalogLink(event, selectedEntry, "license")} target="_blank" rel="noreferrer">{selectedEntry.license.name} ↗</a></dd></div></dl>
          <div className="catalog-note"><Info size={17} /><span>文件大小不等于运行内存。尚无此设备的速度或质量结果。</span></div>
          <details><summary>版本校验与文件清单</summary><p className="catalog-digest">{selectedEntry.manifestDigest}</p><ul>{selectedEntry.assets.map((asset) => <li key={asset.digest}><span>{formatModelBytes(asset.size)} · {asset.mediaType}</span><span className="catalog-digest">{asset.digest}</span></li>)}</ul>{selectedEntry.notes.map((note) => <p key={note}>{note}</p>)}</details>
        </section>}

        {job && <section className={`catalog-download catalog-download-${job.state}`} aria-label="模型下载进度" aria-live="polite">
          <div className="catalog-section-heading"><div><h3>{job.state === "succeeded" && jobEntry && !installed(jobEntry) ? "上次下载已完成" : downloadLabels[job.state]}</h3><p>{jobEntry?.name || job.model}</p></div>{job.state === "succeeded" && <CheckCircle2 size={24} />}</div>
          {activeStates.includes(job.state) && <><div className="catalog-progress"><progress aria-label="下载进度" max={100} value={percent ?? undefined} /><strong>{percent === null ? "计算中" : `${percent}%`}</strong></div><p>{formatModelBytes(job.completedBytes)} / {formatModelBytes(job.totalBytes)} <span>· {job.state === "verifying" ? "验证文件和能力元数据" : "仅文件传输，尚未测试模型"}</span></p></>}
          <small className="catalog-job-endpoint">{job.endpoint}</small>
          {job.state === "succeeded" && <><p>{jobEntry && installed(jobEntry) ? "文件版本已校验，尚未测试效果" : "当前安装状态未确认，请重新检测服务"}</p>{jobEntry && <button className="catalog-primary" disabled={actionDisabled || !installed(jobEntry) || !jobEntry.roles.includes(role) || job.endpoint !== endpoint.trim()} onClick={() => pick(jobEntry, role)}>填入{roleLabel[role]}配置</button>}</>}
          {job.state === "failed" && <><p role="alert">{modelCatalogError(job.error_code)}</p>{job.canRetry && jobEntry && <button className="catalog-secondary" disabled={actionDisabled || !connected || job.endpoint !== endpoint.trim()} onClick={() => void download(jobEntry)}>重试下载</button>}</>}
          {job.serverState === "unknown" && <p className="catalog-warning">连接已断开，Ollama 是否停止下载尚未确认。新下载已锁定；检测连接只能核对已安装文件，不能确认服务已停止。</p>}
          <div className="catalog-download-actions">{running && <button className="catalog-secondary" disabled={Boolean(busy)} onClick={() => void disconnect()}>{busy === "cancel" ? "正在断开" : "断开下载"}</button>}<button className="catalog-link" disabled={Boolean(busy)} onClick={() => void refreshDownload()}><RefreshCw size={15} />刷新状态</button></div>
          {running && <small>离开页面会继续下载。断开连接不代表服务已停止。</small>}
        </section>}
        {message && <p className="catalog-message" role="status">{message}{downloadUncertain && <button className="catalog-link" onClick={() => void refreshDownload()}>刷新下载状态</button>}</p>}
      </div>
      <aside className="catalog-assignments" aria-label="当前任务模型"><h3>任务模型</h3>{(["image", "text"] as const).map((target) => <div className="catalog-assignment" key={target}><span className="catalog-icon">{target === "image" ? <Image size={20} /> : <FileText size={20} />}</span><div><strong>{roleLabel[target]}</strong><p>{assignments[target] || "未配置"}</p>{assignments[target] && <small>{assignments.status}</small>}</div></div>)}<p>图像和文字可用不同模型</p><button className="catalog-link" onClick={onOpenAdvanced}><Settings2 size={17} />手动配置<ChevronRight size={16} /></button><div className="catalog-assignment-note">下载 → 测试 → 手动启用</div></aside>
    </div>
    <footer className="catalog-footer"><span>只下载文件，不调用模型或开启录制</span><button className="catalog-link" onClick={onOpenAdvanced}><Settings2 size={17} />高级设置<ChevronRight size={16} /></button></footer>
  </div>;
}
