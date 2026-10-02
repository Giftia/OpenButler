import {useEffect, useRef, useState} from "react";
import {MaskEditor, type MaskedEditingCanvas} from "./MaskEditor";
import {clampMask, sameMask, validImageBounds, type ImageBounds, type MaskRect} from "../lib/maskGeometry";
import {createPrivacyPreviewGate, type PreviewTicket} from "../lib/privacyPreviewGate";
import {publicCaptureFailure} from "../lib/publicCaptureFailure";
import {pauseBuiltinCaptureApi} from "../lib/api";
import type {CaptureCapabilities, CaptureObservationMode, PublicWindowCaptureConfig, PublicWindowSource} from "../lib/captureTypes";

export function PublicWindowCaptureSetup({active, capabilities, onComplete, onStartingChange}: {
  active: boolean; capabilities: CaptureCapabilities | null; onComplete: () => void;
  onStartingChange: (starting: boolean) => void;
}) {
  const [sources, setSources] = useState<PublicWindowSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [publicOnly, setPublicOnly] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const [sessionSeconds, setSessionSeconds] = useState(600);
  const [observationMode, setObservationMode] = useState<CaptureObservationMode>("vision");
  const [masks, setMasks] = useState<MaskRect[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "start" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelBlocked, setCancelBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<(MaskedEditingCanvas & {ticket: PreviewTicket; configKey: string; sourceRevision: string; ocrText?: string}) | null>(null);
  const gate = useRef(createPrivacyPreviewGate());
  const operation = useRef<"preview" | "start" | null>(null);
  const cancelPending = useRef(false);
  const previewLease = useRef(false);
  const listing = useRef(0);
  const mounted = useRef(false);
  const selected = sources.find((item) => item.id === sourceId);
  const available = capabilities?.public_window.supported === true;

  useEffect(() => {
    mounted.current = true; gate.current.open();
    void readSources();
    return () => { mounted.current = false; listing.current++; gate.current.close(); cancelPreviewLease(); };
  }, []);

  function invalidate(clear = false) {
    gate.current.invalidate(); setConfirmed(false);
    setPreview((old) => clear ? null : old ? {...old, fresh: false} : null);
    if (clear) cancelPreviewLease();
  }
  async function readSources() {
    if (operation.current === "start" || active) return;
    const request = ++listing.current;
    invalidate(true); setLoading(true); setMessage("");
    try {
      const result = await window.openbutlerDesktop?.getCaptureWindows?.();
      if (!mounted.current || request !== listing.current) return;
      if (!result?.ok) { setSources([]); setSourceId(""); setMessage("专用窗口列表暂不可用，请检查本机窗口采集能力后重试。"); return; }
      setSources(result.sources); setSourceId(""); setPublicOnly(false); setMasks([]);
      if (!result.sources.length) setMessage("没有可选的独立窗口。请打开仅含公开测试内容的专用窗口，再刷新列表。");
    } catch {
      if (mounted.current && request === listing.current) { setSources([]); setSourceId(""); setMessage("读取窗口列表失败；没有获取任何画面。"); }
    } finally { if (mounted.current && request === listing.current) setLoading(false); }
  }
  function change(action: () => void, clear = false) {
    if (operation.current === "start" || active || cancelPending.current || cancelBlocked) return;
    invalidate(clear); action(); setMessage("");
  }
  function cancelPreviewLease() {
    if (previewLease.current && !cancelPending.current) {
      // Serialize cancellation before allowing a new preview/start: a late pause
      // must never tear down a newer source or observation-mode lease.
      previewLease.current = false; cancelPending.current = true; if (mounted.current) setCancelling(true);
      void (async () => {
        try {
          if (!window.openbutlerDesktop?.pauseBuiltinCapture) throw new Error("cancel_unavailable");
          const receipt = await window.openbutlerDesktop.pauseBuiltinCapture();
          if (receipt?.ok !== true || receipt.active === true) throw new Error("cancel_unconfirmed");
        } catch {
          if (mounted.current) { setCancelBlocked(true); setMessage("旧预览无法确认取消，请先在今日暂停记录，再重新打开设置。"); }
        } finally { cancelPending.current = false; if (mounted.current) setCancelling(false); }
      })();
    }
  }
  function config(): PublicWindowCaptureConfig | null {
    if (!available || !selected || !publicOnly || ![10, 30, 60].includes(intervalSeconds) || ![60, 300, 600, 1800].includes(sessionSeconds)) return null;
    if (masks.some((rect) => ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
      || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
      || (preview?.bounds && !sameMask(rect, clampMask(rect, preview.bounds))))) return null;
    return {capture_scope: "dedicated_public_window", display_id: selected.source_identity.window_id,
      source_identity: selected.source_identity, excluded_apps: ["password", "1password", "keepass", "bitwarden", "密码"], masks: masks.map((mask) => ({...mask})),
      interval_seconds: intervalSeconds, session_duration_seconds: sessionSeconds, observation_mode: observationMode, confirmed: true};
  }
  const currentConfig = config();
  const configKey = currentConfig ? JSON.stringify(currentConfig) : "";
  const fresh = !!preview && preview.fresh && !!preview.bounds && preview.configKey === configKey && gate.current.isCurrent(preview.ticket);
  const disabled = active || busy === "start" || cancelling || cancelBlocked;

  async function checkPreview() {
    if (operation.current || editing || active || cancelPending.current || cancelBlocked) return;
    const value = config();
    if (!value || !window.openbutlerDesktop?.getMaskedCapturePreview) return;
    invalidate(); const ticket = gate.current.request(); operation.current = "preview"; setBusy("preview");
    previewLease.current = true;
    setMessage("正在处理所选窗口的单次隐私预览；尚未开始自动记录。");
    try {
      const result = await window.openbutlerDesktop.getMaskedCapturePreview(value);
      if (!gate.current.isCurrent(ticket)) return;
      if (!result.ok) { setMessage(publicCaptureFailure(result.error_code)); return; }
      if (!result.previewDataUrl.startsWith("data:image/png;base64,") || !result.source_revision
        || result.observation_mode !== value.observation_mode
        || (value.observation_mode === "masked_ocr_text" && (result.post_mask_ocr_complete !== true
          || typeof result.post_mask_ocr_text !== "string" || !result.post_mask_ocr_text.trim()
          || !/^[0-9a-f]{64}$/.test(result.post_mask_ocr_image_digest || "")))) {
        setMessage("窗口隐私预览未完成。窗口可能已改变或不可用；不会切换到其他来源。"); return;
      }
      setPreview({url: result.previewDataUrl, bounds: null, fresh: true, maskedRegions: result.masked_regions ?? result.maskedRegions ?? 0,
        ticket, configKey: JSON.stringify(value), sourceRevision: result.source_revision,
        ocrText: value.observation_mode === "masked_ocr_text" ? result.post_mask_ocr_text : undefined});
      setMessage("检查这一次遮挡后预览，再明确开始。之后每帧自动重复本机 OCR 和遮挡规则，无需逐帧手动打码。");
    } catch { if (gate.current.isCurrent(ticket)) setMessage("窗口预览失败，自动记录尚未开始。请检查本机 OCR 与窗口状态。"); }
    finally {
      operation.current = null;
      if (mounted.current) { setBusy(null); if (!gate.current.isCurrent(ticket)) setMessage("范围已更改，旧预览已忽略；请重新预览。"); }
    }
  }
  function imageLoaded(ticket: PreviewTicket, bounds: ImageBounds) {
    if (!preview || preview.ticket !== ticket) return;
    if (!validImageBounds(bounds)) { invalidate(true); setMessage("预览图像无法验证，请重试。"); return; }
    const next = masks.map((mask) => clampMask(mask, bounds));
    const changed = next.some((mask, index) => !sameMask(mask, masks[index]));
    if (changed) { invalidate(); setMasks(next); setMessage("遮挡区域已按窗口边界调整，请重新预览。"); }
    setPreview((old) => old?.ticket === ticket ? {...old, bounds, fresh: old.fresh && !changed && gate.current.isCurrent(ticket)} : old);
  }
  async function pauseFailedStart() {
    await Promise.all([pauseBuiltinCaptureApi().catch(() => undefined), window.openbutlerDesktop?.pauseBuiltinCapture?.().catch(() => undefined)]);
  }
  async function start() {
    if (operation.current || editing || active || cancelPending.current || cancelBlocked || !confirmed || !fresh || !preview) return;
    const value = config();
    if (!value || !window.openbutlerDesktop?.startBuiltinCapture) return;
    invalidate(); previewLease.current = false; const ticket = gate.current.request(); operation.current = "start"; setBusy("start"); onStartingChange(true);
    let failureCode: unknown;
    try {
      const result = await window.openbutlerDesktop.startBuiltinCapture(value);
      if (!result.ok) { failureCode = result.error_code; throw new Error("capture_start_failed"); }
      if (!gate.current.isCurrent(ticket)) { await pauseFailedStart(); return; }
      onComplete();
    } catch {
      await pauseFailedStart();
      if (gate.current.isCurrent(ticket)) setMessage(publicCaptureFailure(failureCode, "start"));
    } finally {
      operation.current = null; onStartingChange(false);
      if (mounted.current) setBusy(null);
    }
  }

  return <section className="public-window-setup" aria-label="专用公开窗口自动记录">
    <p className="policy-note">只记录你明确选择的专用公开工作窗口。不会获取整屏缩略图；不会在窗口关闭或身份改变后改录其他来源。</p>
    <p className="capture-capability-warning">当前云 X11 锁屏状态未知，锁屏保护不受支持。此范围只用于公开内容，不等于完整桌面记录能力。</p>
    {!available && <p role="alert">此环境的专用窗口采集暂不可用；不会退回全屏采集。</p>}
    <label><span>选择专用公开窗口</span><select aria-label="选择专用公开窗口" value={sourceId} disabled={disabled || loading || editing || !available}
      onChange={(event) => change(() => { setSourceId(event.target.value); setPublicOnly(false); setMasks([]); }, true)}>
      <option value="">请选择一个仅含公开内容的窗口</option>
      {sources.map((source) => <option key={source.id} value={source.id}>{source.label} · PID {source.source_identity.owner_pid}</option>)}
    </select></label>
    <button className="secondary" disabled={disabled || !!busy || editing || loading} onClick={() => void readSources()}>刷新窗口列表</button>
    {selected && <div className="preview-target-identity" aria-label="已绑定窗口身份">
      <strong>{selected.source_identity.window_title}</strong>
      <span>XID {selected.source_identity.window_id} · PID {selected.source_identity.owner_pid}</span>
      <small>进程 {selected.source_identity.owner_process_name} · 类名 {selected.source_identity.wm_class}</small>
      <small>客户区 {selected.source_identity.content_bounds.width} × {selected.source_identity.content_bounds.height}；标题、进程与尺寸变化会暂停。</small>
    </div>}
    <label className="preview-confirm"><input aria-label="确认窗口仅包含公开内容" type="checkbox" checked={publicOnly} disabled={disabled || !selected || editing}
      onChange={(event) => change(() => setPublicOnly(event.target.checked))} />我确认此专用窗口仅包含公开测试内容，并授权先生成一次遮挡后预览</label>
    <div className="public-window-sampling">
      <label><span>观察方式</span><select aria-label="公开窗口观察方式" value={observationMode} disabled={disabled || editing}
        onChange={(event) => change(() => setObservationMode(event.target.value as CaptureObservationMode), true)}>
        <option value="vision">视觉模型：读取遮挡后截图</option>
        <option value="masked_ocr_text">OCR 文字：仅公开文本文档</option>
      </select></label>
      <label><span>自动采样间隔</span><select aria-label="自动采样间隔" value={intervalSeconds} disabled={disabled || editing} onChange={(event) => change(() => setIntervalSeconds(Number(event.target.value)))}>
        <option value={10}>每 10 秒</option><option value={30}>每 30 秒</option><option value={60}>每 60 秒</option>
      </select></label>
      <label><span>本次最长记录时间</span><select aria-label="本次最长记录时间" value={sessionSeconds} disabled={disabled || editing} onChange={(event) => change(() => setSessionSeconds(Number(event.target.value)))}>
        <option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={600}>10 分钟</option><option value={1800}>30 分钟</option>
      </select></label>
    </div>
    <p className="policy-note">{observationMode === "masked_ocr_text"
      ? "OCR 文字模式：每帧先隐私遮挡，再对最终图片重新本机识字，仅将遮挡后文字交给文字模型。没有视觉理解，不会自动切回视觉模型；空白、识字失败或内容过长会停止。"
      : "视觉模式：将遮挡后的图片交给已配置的视觉模型；不会自动改用 OCR 文字模式。"}</p>
    <p>每帧自动执行本机 OCR 和当前遮挡规则，固定区域会重复使用。规则可能遗漏敏感信息，尚不具备完整敏感区域识别模型；请只放入公开内容。</p>
    <button className="secondary" disabled={!currentConfig || !!busy || editing || disabled} onClick={() => void checkPreview()}>检查公开窗口隐私预览</button>
    <p className="capture-optional-mask-note">固定遮挡区域可选，不需要每帧操作。标题或应用含 password、1password、keepass、bitwarden、密码时排除。更改窗口、观察方式、规则或采样设置后，需要重新检查一次预览。</p>
    <MaskEditor key={preview?.ticket.requestId ?? "window-no-preview"} masks={masks} canvas={preview} disabled={disabled} editing={editing}
      onChange={(next) => change(() => setMasks(next))} onEditStart={() => invalidate()} onEditingChange={setEditing}
      onImageLoad={(bounds) => { if (preview) imageLoaded(preview.ticket, bounds); }}
      onImageError={() => { invalidate(true); setMessage("预览图片无法显示；不会开始自动记录。"); }} />
    {preview?.ocrText && <details className="policy-note"><summary>本次遮挡后 OCR 文字预览（可能识别有误）</summary><p style={{whiteSpace: "pre-wrap"}}>{preview.ocrText}</p></details>}
    <label className="preview-confirm"><input aria-label="确认公开窗口最新预览" type="checkbox" checked={confirmed} disabled={!fresh || !!busy || editing || active}
      onChange={(event) => { if (fresh && !busy && !editing) setConfirmed(event.target.checked); }} />我已检查最新遮挡后预览，同意按此窗口、观察方式、规则及本次时限自动记录</label>
    <button className="primary" disabled={!fresh || !confirmed || !!busy || editing || active} onClick={() => void start()}>{busy === "start" ? "正在启动自动记录…" : "开始公开窗口自动记录"}</button>
    <small>可随时在今日暂停或停止并撤销授权。采样间隔内的活动未知；窗口内容中的文字不构成执行指令。</small>
    {active && <p role="status">已有录制运行。请先回到今日暂停，再设置新范围。</p>}
    {message && <p className="policy-note" role="status">{message}</p>}
  </section>;
}
