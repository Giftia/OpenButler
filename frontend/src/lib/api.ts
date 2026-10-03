import type {PublicWindowIdentity} from "./captureTypes";
import type { EventItem, PluginManifest, PrivacyMode } from "../types";

export type CaptureConfig = {
  display_id: string;
  excluded_apps: string[];
  masks: Array<{x: number; y: number; width: number; height: number}>;
  confirmed: true;
};

export type RecordingState = {
  configured: boolean;
  authorized: boolean;
  active: boolean;
  record_count: number;
  processing_queue?: {capacity: number; queued: number; running: 0 | 1; backpressured: number; accepting: boolean};
  source_kind?: "public_window" | "full_screen";
  provenance?: CaptureProvenance;
};

export type ContextEngineStatus = {
  state: string;
  privacy_mode: PrivacyMode;
  capture_available: boolean;
  model_routes_available: boolean;
  recording: RecordingState;
};

export type CaptureProvenance = {
  observation_mode?: "vision" | "masked_ocr_text";
  source_kind?: "public_window" | "full_screen"; capture_scope?: string; session_id?: string; source_revision?: string;
  source_identity?: PublicWindowIdentity; session_expires_at?: string; lock_state?: string; lock_protection_supported?: boolean;
  capture_method?: string; sampling_interval_ms?: number; sampling_sequence?: number; sampling_gap_ms?: number | null;
  source_verified_before?: boolean; source_verified_after?: boolean;
};

export type OcrSourceExcerpt = {quote: string; start: number; end: number};
export type OcrSourceSpan = {
  observation_id: string; evidence_id: string; image_digest: string; source_text_digest: string;
  start: number; end: number; offset_unit: "unicode_codepoints";
};
export type OcrSourceGrounding = {
  version: 1; source_kind: "post_mask_ocr_text"; source_text_digest: string;
  observation_id: string; evidence_id: string; image_digest: string;
  offset_unit: "unicode_codepoints"; verification: "exact_source_spans_only"; semantic_verified: false;
  excerpts: OcrSourceExcerpt[];
  model_proposal: {title: string; summary: string; verification: "unverified_inference"};
};

export type ContextObservation = {
  extraction_version?: 1 | 2;
  current_facts?: {version: 2; inference: true; input_scope: "current_observation_only";
    observation_id: string; evidence_id: string; image_digest: string; captured_at: string;
    observation_route: "post_mask_ocr_to_text_model" | "masked_image_to_vision_to_text";
    title: string; summary: string; boundary: string; source_grounding?: OcrSourceGrounding} | null;
  id: string;
  captured_at: string;
  state: "recorded_pending" | "processing" | "ready" | "model_unavailable";
  title: string | null;
  summary: string | null;
  processing_reason?: string | null;
  boundary: string;
  evidence_available: boolean;
  evidence_id: string | null;
  source_label: string;
  source_kind?: "public_window" | "full_screen";
  recorded_at?: string;
  consent_revision?: string;
  evidence_kind?: "privacy_masked_captured_pixels";
  observation_mode?: "vision" | "masked_ocr_text";
  observation_route?: "post_mask_ocr_to_text_model" | "masked_image_to_vision_to_text";
  ocr_provenance?: {engine: string; stage: "post_mask"; image_digest: string; layout: "text_only_no_layout_guarantee"};
  provenance?: CaptureProvenance;
  temporal_context?: {prior_observation_ids?: string[] | null; inference?: boolean; coverage?: string; note?: string | null;
    association_state?: "skipped" | "pending" | "running" | "ready" | "failed";
    association_reason?: string | null;
    citation_basis?: "post_mask_ocr_spans" | "unverified_model_summaries";
    relations?: Array<{prior_observation_id: string; relation: "same_topic" | "different_topic" | "uncertain";
      current_quote: string; prior_quote: string;
      current_source_span?: OcrSourceSpan; prior_source_span?: OcrSourceSpan}> | null;
    prior_candidate_count?: number; prior_selected_count?: number; prior_omitted_count?: number;
    comparison?: {performed: boolean; prior_observation_ids: string[]; current_quote?: string; prior_quote?: string}} | null;
};

const API_BASE =
  typeof window !== "undefined" && window.openbutlerDesktop?.apiBase
    ? window.openbutlerDesktop.apiBase
    : import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.openbutlerDesktop : undefined;
  if (bridge?.requestApi) {
    if (init?.body != null && typeof init.body !== "string") {
      throw new Error("Invalid desktop request body.");
    }
    const response = await bridge.requestApi(path, {method: init?.method, body: init?.body});
    if (!response.ok) throw new Error(`${response.status} ${response.error}`);
    return response.data as T;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {"Content-Type": "application/json", ...(init?.headers ?? {})},
    ...init
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function getEvents(q?: string) {
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<{items: EventItem[]; count: number}>(`/api/events${query}`);
}

export function simulateEvents(scenario = "daily_context") {
  return request<{created: EventItem[]; count: number}>("/api/events/simulate", {
    method: "POST",
    body: JSON.stringify({scenario})
  });
}

export function getPlugins() {
  return request<{items: PluginManifest[]; count: number; privacy_mode: PrivacyMode}>("/api/plugins");
}

export function getPrivacyMode() {
  return request<{mode: PrivacyMode}>("/api/privacy-mode");
}

export function getDesktopStatus() {
  return request<Record<string, any>>("/api/desktop/status");
}

export function getContextEngineStatus() {
  return request<ContextEngineStatus>("/api/context-engine/status");
}

export function pauseBuiltinCaptureApi() {
  return request<RecordingState>("/api/context-engine/capture/pause", {method: "POST"});
}

export function revokeBuiltinCaptureApi() {
  return request<RecordingState>("/api/context-engine/capture/revoke", {method: "POST"});
}

export function getContextObservations() {
  return request<{count: number; items: ContextObservation[]}>("/api/context-engine/observations");
}

export type DailyReview = {
  status: "ready" | "empty" | "unavailable";
  reason: string | null;
  day: string;
  timezone: string;
  generated_at: string;
  boundary: string;
  counts: {total: number; ready: number; pending: number; failed: number;
    expired_evidence: number; missing_evidence: number; invalid_records: number;
    eligible: number; included: number; omitted: number};
  coverage: {requested_start: string; requested_end: string; evaluated_until: string;
    observed_start: string | null; observed_end: string | null; observation_count: number;
    gap_threshold_seconds: number; gaps: Array<{start: string; end: string; seconds: number}>;
    gap_count: number; gaps_truncated: boolean};
  truncated: boolean;
  conclusions: Array<{text: string; evidence_refs: Array<{observation_id: string;
    evidence_id: string; captured_at: string}>}>;
};

export function generateDailyReview(day: string, timezone: string) {
  return request<DailyReview>("/api/context-engine/daily-review", {
    method: "POST", body: JSON.stringify({day, timezone, confirmed: true})
  });
}

export function retryContextObservation(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid observation ID");
  return request<{ok: boolean; queued?: boolean; reason?: string}>(`/api/context-engine/observations/${id}/retry`, {method: "POST"});
}

export function deleteContextObservation(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid observation ID");
  return request<{deleted: boolean}>(`/api/context-engine/observations/${id}/delete`, {method: "POST"});
}

export function setPrivacyMode(mode: PrivacyMode) {
  return request<{mode: PrivacyMode}>("/api/privacy-mode", {
    method: "POST",
    body: JSON.stringify({mode})
  });
}

export function askButler(message: string) {
  return request<{answer: string; privacy_mode: PrivacyMode; evidence_event_count: number}>("/api/chat", {
    method: "POST",
    body: JSON.stringify({message})
  });
}

export function getWorkstationCameras() {
  return request<{items: Array<Record<string, unknown>>; count: number; local_eyes: Record<string, unknown>}>(
    "/api/vision/cameras"
  );
}

export function getWorkstationStatus() {
  return request<Record<string, any>>("/api/vision/status");
}

export function startWorkstationSession(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/vision/session/start", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function stopWorkstationSession(session_id?: string) {
  return request<Record<string, any>>("/api/vision/session/stop", {
    method: "POST",
    body: JSON.stringify({session_id})
  });
}

export function getWorkstationEvents() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/vision/events");
}

export function getWorkstationSummaryToday() {
  return request<Record<string, any>>("/api/vision/summary/today");
}

export function getWorkstationSettings() {
  return request<Record<string, any>>("/api/vision/settings");
}

export function updateWorkstationSettings(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/vision/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteWorkstationData(todayOnly: boolean) {
  return request<Record<string, any>>(todayOnly ? "/api/vision/data/today" : "/api/vision/data", {
    method: "DELETE"
  });
}

export function getPCActivityStatus() {
  return request<Record<string, any>>("/api/pc-activity/minecontext/status");
}

export function queryPCActivityAtTime(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/pc-activity/minecontext/query-at-time", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function searchPCActivity(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/pc-activity/minecontext/search", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function importPCActivities(payload: Record<string, unknown> = {}) {
  return request<Record<string, any>>("/api/pc-activity/minecontext/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getPCActivityEvents() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/pc-activity/events");
}

export function getPCActivitySummaryToday() {
  return request<Record<string, any>>("/api/pc-activity/summary/today");
}

export function getPCActivityWorkflowCandidates() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/pc-activity/workflow-candidates");
}

export function getPCActivitySettings() {
  return request<Record<string, any>>("/api/pc-activity/settings");
}

export function updatePCActivitySettings(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/pc-activity/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deletePCActivityEvents() {
  return request<Record<string, any>>("/api/pc-activity/events", {
    method: "DELETE"
  });
}

export function getButlerHome() {
  return request<Record<string, any>>("/api/butler/home");
}

export function getButlerReadiness() {
  return request<Record<string, any>>("/api/butler/readiness");
}

export function getButlerMVPReport() {
  return request<Record<string, any>>("/api/butler/mvp-report");
}

export function getButlerDataInsufficientDrill() {
  return request<Record<string, any>>("/api/butler/demo/data-insufficient-drill");
}

export function getButlerLatestHarnessRuns() {
  return request<{items: Array<Record<string, any>>; count: number; evidence_boundary: string}>("/api/butler/harness/runs/latest");
}

export function getButlerProductizationObjectiveStatus() {
  return request<Record<string, any>>("/api/butler/productization/objectives/status");
}

export function getButlerProductizationDemoPack() {
  return request<Record<string, any>>("/api/butler/productization/demo-pack");
}

export function runButlerDemoPath(payload: Record<string, unknown> = {}) {
  return request<Record<string, any>>("/api/butler/demo/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function resetButlerDemo() {
  return request<Record<string, any>>("/api/butler/demo/reset", {method: "POST"});
}

export function getButlerTimeline() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/butler/timeline");
}

export function rebuildButlerTimeline() {
  return request<Record<string, any>>("/api/butler/timeline/rebuild", {method: "POST"});
}

export function getButlerMetricsToday() {
  return request<Record<string, any>>("/api/butler/metrics/today");
}

export function getButlerMetricsRange(days = 7) {
  return request<Record<string, any>>(`/api/butler/metrics?days=${encodeURIComponent(String(days))}`);
}

export function getButlerInsights() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/butler/insights");
}

export function getButlerInsightNoiseEvaluation() {
  return request<Record<string, any>>("/api/butler/insights/noise-evaluation");
}

export function generateButlerInsights(force = false) {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/butler/insights/generate", {
    method: "POST",
    body: JSON.stringify({force})
  });
}

export function submitInsightFeedback(insightId: string, feedback_type: string, comment?: string) {
  return request<Record<string, any>>(`/api/butler/insights/${encodeURIComponent(insightId)}/feedback`, {
    method: "POST",
    body: JSON.stringify({feedback_type, comment})
  });
}

export function dismissInsight(insightId: string) {
  return request<Record<string, any>>(`/api/butler/insights/${encodeURIComponent(insightId)}/dismiss`, {method: "POST"});
}

export function snoozeInsight(insightId: string, minutes = 60) {
  return request<Record<string, any>>(`/api/butler/insights/${encodeURIComponent(insightId)}/snooze`, {
    method: "POST",
    body: JSON.stringify({minutes})
  });
}

export function getButlerBriefingsToday() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/butler/briefings/today");
}

export function generateButlerBriefing(type = "evening") {
  return request<Record<string, any>>("/api/butler/briefings/generate", {
    method: "POST",
    body: JSON.stringify({type})
  });
}

export function getButlerGoals() {
  return request<{items: Array<Record<string, any>>; count: number}>("/api/butler/goals");
}

export function createButlerGoal(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/butler/goals", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateButlerGoal(goalId: string, payload: Record<string, unknown>) {
  return request<Record<string, any>>(`/api/butler/goals/${encodeURIComponent(goalId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function getButlerContextRecovery() {
  return request<Record<string, any>>("/api/butler/context-recovery");
}

export function getButlerSettings() {
  return request<Record<string, any>>("/api/butler/settings");
}

export function updateButlerSettings(payload: Record<string, unknown>) {
  return request<Record<string, any>>("/api/butler/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function exportButlerData() {
  return request<Record<string, any>>("/api/butler/export");
}

export function deleteButlerData() {
  return request<Record<string, any>>("/api/butler/data", {
    method: "DELETE"
  });
}
