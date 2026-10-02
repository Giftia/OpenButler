export type ModelRole = "image" | "text";
export type ModelCatalogEntry = {
  id: string; name: string; backend: "ollama"; model: string; manifestDigest: string;
  downloadBytes: number; roles: ModelRole[]; quantization: string;
  license: {name: string; url: string}; sourceUrl: string; notes: string[];
  assets: Array<{digest: string; size: number; mediaType: string}>; downloadSupported: boolean;
};
export type ModelHostInspection = {
  ok: boolean; inspectionId?: string; endpoint: string;
  runtime?: {available: boolean; version: string | null; hostRelation: "unknown"; hardwareVerified: false};
  device?: {platform: string; arch: string; memoryBytes: number | null; memorySource: "cgroup_v2" | "cgroup_v1" | "physical" | "unknown";
    availableMemoryBytes: number | null; cpuCount: number | null; gpu: "unknown"; scope: "desktop_process"};
  entries?: Array<{id: string; installed: boolean; digestMatches: boolean; imageMetadataVerified: boolean; fit: "unknown"}>;
  error_code?: string;
};
export type ModelDownloadJob = {
  id: string; catalogId: string; endpoint: string; model: string; manifestDigest: string;
  state: "starting" | "downloading" | "verifying" | "succeeded" | "failed" | "interrupted";
  phase: string; completedBytes: number; totalBytes: number; error_code?: string;
  serverState: "active" | "terminal" | "unknown"; canRetry: boolean; updatedAt: string;
};
export type ModelCatalogBridge = {
  openBuiltinModelCatalogLink?: (input: {catalogId: string; kind: "source" | "license"}) => Promise<{ok: boolean; error_code?: string}>;
  getBuiltinModelCatalog: () => Promise<{ok: boolean; catalogVersion: string; entries: ModelCatalogEntry[]}>;
  inspectBuiltinModelHost: (input: {endpoint: string; protocol: "ollama_native"}) => Promise<ModelHostInspection>;
  startBuiltinModelDownload: (input: {inspectionId: string; catalogId: string; downloadConsent: true}) => Promise<{ok: boolean; job?: ModelDownloadJob; error_code?: string}>;
  getBuiltinModelDownload: (input?: {jobId?: string}) => Promise<{ok: boolean; job: ModelDownloadJob | null; error_code?: string}>;
  cancelBuiltinModelDownload: (input: {jobId: string}) => Promise<{ok: boolean; job?: ModelDownloadJob; error_code?: string}>;
};

export const roleLabel: Record<ModelRole, string> = {image: "图像理解", text: "文字整理"};
export const isActiveDownload = (job: ModelDownloadJob | null) => Boolean(job && ["starting", "downloading", "verifying"].includes(job.state));
export function formatModelBytes(bytes: number | null | undefined): string {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1e9).toFixed(2)} GB` : "未知";
}
export function modelCatalogError(code?: string): string {
  const errors: Record<string, string> = {
    catalog_invalid_endpoint: "请输入本机 Ollama 地址，例如 http://127.0.0.1:11434",
    catalog_unavailable: "无法连接 Ollama，请检查地址和服务",
    catalog_inspection_busy: "正在检测服务，请稍后重试",
    catalog_inspection_stale: "检测已过期，请重新检测连接",
    catalog_server_state_unknown: "服务是否仍在下载未知，请先检查 Ollama",
    catalog_digest_mismatch: "文件版本校验未通过，不能使用",
    catalog_asset_mismatch: "下载文件与固定版本不一致，已断开连接",
    catalog_vision_unverified: "此版本的图像能力未确认",
    catalog_request_timeout: "服务响应超时，请核对下载状态",
    catalog_request_interrupted: "下载连接中断，请核对服务状态",
    catalog_server_error: "Ollama 已报告下载失败，可重试",
    catalog_http_error: "服务返回错误，请检查 Ollama",
    catalog_incomplete_stream: "传输未完整结束，服务状态待确认",
    catalog_invalid_response: "服务返回格式不符，未采用结果",
    catalog_response_too_large: "服务返回内容超出安全上限",
    catalog_journal_unavailable: "下载记录不可用，已禁止新下载",
    catalog_job_not_found: "找不到此下载任务，请刷新状态",
    catalog_already_installed: "此模型已安装，请重新检测并填入配置",
    catalog_existing_digest_mismatch: "已有模型与固定版本不同，请在高级设置中处理",
    catalog_reinspection_required: "请重新检测模型版本",
    catalog_entry_unavailable: "此版本暂不支持下载",
    catalog_download_consent_required: "需要确认从官方模型库下载",
    catalog_verification_interrupted: "文件下载已结束，校验被中断",
    catalog_cancelled_before_download: "下载请求尚未发送",

    invalid_local_endpoint: "请填写本机 Ollama 地址，例如 http://127.0.0.1:11434",
    unsupported_discovery_protocol: "此处仅支持本机 Ollama",
    runtime_unavailable: "无法连接 Ollama，请检查地址和服务",
    stale_inspection: "设备信息已过期，请重新检测",
    invalid_inspection: "请先检测当前服务",
    inspection_expired: "检测已过期，请重新检测",
    download_busy: "已有下载任务，请先查看其状态",
    download_state_unknown: "服务是否仍在下载未知，请先检查 Ollama",
    manifest_mismatch: "文件版本与目录不一致，不能使用",
    digest_mismatch: "文件校验未通过，不能使用",
    image_metadata_missing: "未确认图像能力，请换一个版本",
    download_timeout: "下载超时，服务状态需要核对",
    download_interrupted: "下载连接已断开，服务是否停止未知",
    download_consent_required: "需要确认从官方模型库下载",
  };
  return code && Object.prototype.hasOwnProperty.call(errors, code) ? errors[code] : "操作未完成，请检查服务后重试";
}
export function trustedCatalogLink(url: string): string | undefined {
  try { const value = new URL(url); return value.protocol === "https:" && !value.username && !value.password && ["ollama.com", "www.apache.org", "apache.org", "huggingface.co", "github.com", "opensource.org"].includes(value.hostname) ? url : undefined; } catch { return undefined; }
}

// Fail closed on malformed IPC snapshots; provider text is never rendered as HTML.
export function validDownloadJob(value: unknown): value is ModelDownloadJob {
  if (!value || typeof value !== "object") return false;
  const job = value as ModelDownloadJob;
  return typeof job.id === "string" && job.id.length <= 100 && typeof job.catalogId === "string" && job.catalogId.length <= 100
    && typeof job.endpoint === "string" && job.endpoint.length <= 500 && typeof job.model === "string" && job.model.length <= 200
    && ["starting", "downloading", "verifying", "succeeded", "failed", "interrupted"].includes(job.state)
    && ["active", "terminal", "unknown"].includes(job.serverState)
    && Number.isFinite(job.completedBytes) && job.completedBytes >= 0 && Number.isFinite(job.totalBytes) && job.totalBytes >= 0
    && typeof job.canRetry === "boolean";
}
