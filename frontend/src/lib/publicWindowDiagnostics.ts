import type {PublicWindowSourceDiagnostics} from "./captureTypes";

export const publicWindowRejectionHints = [
  {key: "not_viewable", label: "当前不可见", hint: "请确认窗口已显示，可尝试还原最小化窗口。"},
  {key: "not_standard_window", label: "非标准独立窗口", hint: "请使用应用的普通主窗口，避免弹出层或临时菜单。"},
  {key: "unsupported_format", label: "画面格式不受支持", hint: "X11 采集需要不透明的 24 位窗口，可换用符合条件的专用公开测试窗口。"},
  {key: "bordered_window", label: "带有不支持的原生边框", hint: "当前采集路径不支持此类边框，可换用符合条件的专用公开测试窗口。"},
  {key: "invalid_size", label: "窗口尺寸无效或超限", hint: "可调整窗口大小，等待尺寸稳定后刷新。"},
  {key: "identity_unavailable", label: "窗口身份无法验证", hint: "请等待窗口稳定后刷新；仍不可用时可换用其他专用公开测试窗口。"},
  {key: "unknown_error", label: "窗口检查未完成", hint: "请稍后刷新；仍不可用时检查本机窗口采集服务。"},
] as const;

// IPC data is untrusted at runtime. Copy only a complete, bounded allowlist;
// never retain provider details, identifiers, arbitrary keys, or raw errors.
export function readPublicWindowSourceDiagnostics(value: unknown, acceptedCount: number): PublicWindowSourceDiagnostics | null {
  try {
    if (!Number.isSafeInteger(acceptedCount) || acceptedCount < 0 || acceptedCount > 200) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = Reflect.ownKeys(value);
    if (fields.length !== 1 || fields[0] !== "rejected_counts") return null;
    const raw = Object.getOwnPropertyDescriptor(value, "rejected_counts")?.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== publicWindowRejectionHints.length
      || keys.some((key) => !publicWindowRejectionHints.some((reason) => reason.key === key))) return null;
    const rejected_counts = {} as PublicWindowSourceDiagnostics["rejected_counts"];
    let total = acceptedCount;
    for (const {key} of publicWindowRejectionHints) {
      const count: unknown = Object.getOwnPropertyDescriptor(raw, key)?.value;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 200) return null;
      total += count;
      if (total > 200) return null;
      rejected_counts[key] = count;
    }
    return {rejected_counts};
  } catch {
    return null;
  }
}

export function publicWindowRejectedTotal(diagnostics: PublicWindowSourceDiagnostics | null): number {
  return diagnostics ? publicWindowRejectionHints.reduce((total, {key}) => total + diagnostics.rejected_counts[key], 0) : 0;
}
