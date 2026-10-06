/** Only these local machine codes may cross the UI diagnostic boundary. */
const knownFailures: Record<string, string> = {
  window_source_unavailable: "所选窗口采集暂不可用，请确认窗口仍然打开后重试。",
  foreground_unknown: "无法确认当前前台窗口，预览已安全停止。请将专用公开窗口保持可见后重试。",
  window_identity_changed: "所选窗口的标题、进程或尺寸已改变，请刷新列表并重新选择。",
  source_binding_mismatch: "采集来源与已选窗口身份不一致，请重新选择窗口。",
  opaque_visible_client_required: "需要可见且不透明的普通应用窗口。请取消最小化，并选择不透明的专用公开窗口。",
  isolated_pixmap_unavailable: "无法取得此窗口的独立画面，预览已安全停止；不会退回整屏采集。",
  xcomposite_unavailable: "当前桌面不支持所需的独立窗口采集能力；不会退回整屏采集。",
  x11_display_unavailable: "当前 X11 显示服务不可用，请检查桌面会话。",
  public_window_platform_unsupported: "当前平台不支持此专用窗口采集方式。",
  client_window_required: "请选择普通应用的客户区窗口，不能使用桌面或窗口管理器表面。",
  window_selection_required: "尚未绑定可用窗口，请刷新列表并重新选择。",
  window_identity_unavailable: "无法验证所选窗口的完整身份，请重新选择。",
  window_owner_unavailable: "无法验证所选窗口的所属进程，请重新选择。",
  window_bounds_unavailable: "无法确认所选窗口的边界，未采集画面。",
  pixmap_bounds_changed: "窗口画面的尺寸已改变，请重新选择并预览。",
  unsupported_window_pixel_format: "此窗口的像素格式暂不受支持，未生成预览。",
  window_destroyed_unmapped_or_reconfigured: "窗口已关闭、隐藏或重新配置，请刷新列表并重新选择。",
  application_excluded_or_unknown: "当前前台应用或目标窗口被排除，或其状态无法确认。请检查排除规则。",
  local_redaction_unavailable: "本机 OCR 或遮挡处理暂不可用，请检查本机识字组件。",
  post_mask_ocr_failed: "遮挡后的再次本机识字失败；不会使用遮挡前文字或切换模型路线。",
  post_mask_ocr_empty: "遮挡后没有可识别的文字，请使用含清晰公开文字的文档。",
  post_mask_ocr_invalid: "遮挡后文字包含无效控制字符，已安全停止；请检查公开文档并重试。",
  post_mask_ocr_too_large: "遮挡后文字超过 2000 字符或 6000 字节上限，请缩小公开文档内容；不会截断文字。",
  post_mask_ocr_image_changed: "再次识字时图片发生变化，已安全停止。请重新预览。",
  invalid_observation_mode: "观察方式无效，请重新选择视觉或 OCR 文字模式。",
  privacy_processing_failed: "本机隐私处理未完成，请检查 OCR 与遮挡配置。",
  privacy_preview_required: "最新隐私预览已失效，请重新预览并确认。",
  capture_already_active: "已有录制正在运行，请先暂停，再设置本次范围。",
  window_source_cancelled: "窗口采集请求已取消，请重新检查预览。",
  session_expired: "本次授权时限已到，请重新预览并确认新的会话。",
};

export function publicCaptureFailure(code: unknown, stage: "preview" | "start" = "preview"): string {
  const prefix = stage === "start" ? "启动未完成，已尝试暂停。" : "窗口隐私预览未完成，自动记录尚未开始。";
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(knownFailures, code)) {
    return `${prefix}${knownFailures[code]}（${code}）`;
  }
  return `${prefix}请检查本机服务与窗口范围后重新预览并确认；不会切换到其他来源。`;
}
