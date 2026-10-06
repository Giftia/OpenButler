import type {ContextObservation} from "../lib/api";

function time(value?: string) {
  if (!value) return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", {hour12: false});
}
export function CaptureObservationProvenance({item}: {item: ContextObservation}) {
  const provenance = item.provenance;
  const identity = provenance?.source_identity;
  const publicWindow = item.source_kind === "public_window" || provenance?.capture_scope === "dedicated_public_window";
  const gap = provenance?.sampling_gap_ms;
  const interval = provenance?.sampling_interval_ms;
  const ocrText = item.observation_mode === "masked_ocr_text";
  return <div className="preview-observation-provenance" aria-label="采集事实与覆盖边界">
    <small>采集事实：{publicWindow ? "专用公开窗口" : item.source_kind === "full_screen" ? "已授权屏幕" : item.source_label} · {item.evidence_kind === "privacy_masked_captured_pixels" ? "实际截图（已隐私遮挡）" : "本机遮挡后图像依据"}</small>
    {ocrText && <small>分析路线：遮挡后本机 OCR → 文字模型。没有视觉理解，文字识别可能有误，不能确认布局、图片或完整操作。</small>}
    {ocrText && item.ocr_provenance && <small>OCR 依据：{item.ocr_provenance.engine} · 最终遮挡图像 SHA-256 {item.ocr_provenance.image_digest}</small>}
    <small>采集时间 {time(item.captured_at)}{item.recorded_at ? ` · 入库时间 ${time(item.recorded_at)}` : ""}</small>
    {identity && <small>窗口 {identity.window_title} · XID {identity.window_id} · PID {identity.owner_pid}</small>}
    {typeof interval === "number" && <small>计划采样间隔 {interval / 1000} 秒{provenance?.sampling_sequence === 1 ? " · 本会话首个采样" : typeof gap === "number" ? ` · 超出计划间隔的额外采样延迟 ${Math.round(gap / 1000)} 秒` : " · 前次采样间隔未知"}</small>}
    {publicWindow && <small>仅此窗口的离散观察点；采样空隙与其他窗口的活动未知。锁屏状态未知。</small>}
    {item.extraction_version !== 2 && item.temporal_context && <small>连续上下文为推断：{item.temporal_context.note || "只结合已有观察点，不能补全未采样时段。"}</small>}
    {item.summary && <small>{ocrText ? "遮挡后 OCR 文字的原文摘录与模型推断需区分；两者都不证明每次点击、完整行为或外部任务已完成。" : "AI 标题与摘要是基于遮挡后截图的推断，不证明每次点击、完整行为或外部任务已完成。"}</small>}
    {!item.evidence_available && <small>截图依据已过期或不可用，不能将摘要作为仍可核验的依据。</small>}
  </div>;
}
