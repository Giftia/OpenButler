export function capturePauseMessage(reason?: string | null): string {
  const messages: Record<string, string> = {
    privacy_processing_failed: "本地 OCR 或遮挡处理失败，自动记录已暂停；请检查后重新预览并启动。",
    post_mask_ocr_failed: "遮挡后本机识字失败，自动记录已暂停；没有使用遮挡前文字或切换模型路线。",
    post_mask_ocr_empty: "遮挡后没有可识别文字，自动记录已暂停；请检查公开文档并重新预览。",
    post_mask_ocr_invalid: "遮挡后文字包含无效控制字符，自动记录已暂停；请重新预览。",
    post_mask_ocr_too_large: "遮挡后文字超过 2000 字符或 6000 字节上限，自动记录已暂停；请缩小文档内容后重新预览。",
    post_mask_ocr_image_changed: "遮挡后的图片无法与文字绑定，自动记录已暂停；请重新预览。",
    window_destroyed_unmapped_or_reconfigured: "所选窗口关闭、隐藏或尺寸改变，自动记录已暂停；请重新选择并确认。",
    source_binding_mismatch: "采集来源绑定不一致，自动记录已暂停；不会改录其他来源。",
    window_source_unavailable: "专用窗口采集暂不可用，自动记录已暂停；不会改录整个屏幕。",
    "lock-screen": "检测到会话锁定，自动记录已暂停。",
    suspend: "系统进入休眠，自动记录已暂停。",
    source_closed: "所选窗口已关闭，自动记录已暂停；不会切换到其他窗口。",
    source_identity_changed: "所选窗口身份已改变，自动记录已暂停；需重新选择并确认。",
    window_identity_changed: "所选窗口身份已改变，自动记录已暂停；需重新选择并确认。",
    window_identity_unverified: "自动记录已暂停：窗口身份连续性无法确认，请重新预览并确认。",
    window_unavailable: "所选窗口暂不可用，自动记录已暂停；不会改录其他窗口或整个屏幕。",
    source_unavailable: "所选窗口暂不可用，自动记录已暂停；不会改录其他窗口或整个屏幕。",
    session_limit_reached: "本次授权的时限已到，自动记录已停止。重新开始需要新的隐私预览。",
    session_expired: "本次授权的时限已到，自动记录已停止。重新开始需要新的隐私预览。",
    session_locked: "检测到会话锁定，自动记录已暂停。",
    lock_state_unknown: "无法验证锁屏状态，全屏记录不可用。专用公开窗口需要单独授权。",
    application_excluded_or_unknown: "应用被排除或状态无法确认，本次没有记录。",
  };
  return reason ? (Object.prototype.hasOwnProperty.call(messages, reason) ? messages[reason] : "") || (["idle", "recording", "recorded", "unchanged", "paused"].includes(reason) ? "" : "采集状态需要检查；请先暂停并重新确认窗口范围。") : "";
}

export function CaptureSessionSummary({state}: {state: Record<string, unknown> | null}) {
  if (!state) return <small>尚未读取桌面采集状态；不会自动开始录制。</small>;
  const source = state.capture_scope === "dedicated_public_window" ? "public_window" : state.sourceKind ?? state.source_kind;
  const target = state.sourceIdentity ?? state.windowTarget ?? state.window_target;
  const identity = target && typeof target === "object" ? target as Record<string, unknown> : {};
  const interval = state.intervalSeconds ?? state.interval_seconds;
  const end = state.sessionExpiresAt ?? state.sessionEndsAt ?? state.session_ends_at;
  const paused = capturePauseMessage(typeof state.lastResult === "string" ? state.lastResult : null);
  return <div className="preview-session-summary" aria-label="自动记录会话">
    <strong>{source === "public_window" ? "专用公开窗口 · 自动采样" : (source === "screen" || source === "full_screen") ? "已授权屏幕 · 自动采样" : "采集范围尚未确认"}</strong>
    {typeof identity.window_title === "string" && <span>窗口：{identity.window_title}</span>}
    {(typeof identity.window_id === "string" || typeof identity.window_id === "number") && <small>XID {String(identity.window_id)} · PID {String(identity.owner_pid ?? "未知")}</small>}
    {typeof interval === "number" && <small>采样间隔 {interval} 秒；采样之间的活动未知，不是连续视频。</small>}
    {source === "public_window" && <small>观察方式：{state.observation_mode === "masked_ocr_text" ? "遮挡后 OCR → 文字模型；无视觉理解" : state.observation_mode === "vision" ? "遮挡后截图 → 视觉模型" : "尚未确认"}</small>}
    {typeof end === "string" && !Number.isNaN(new Date(end).getTime()) && <small>本次最晚停止：{new Date(end).toLocaleString("zh-CN")}</small>}
    {source === "public_window" && <small>锁屏保护：当前云 X11 的锁定状态未知。授权仅限此公开窗口，不代表完整桌面记录能力。</small>}
    {paused && <p role="status">{paused}</p>}
  </div>;
}
