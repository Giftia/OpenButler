import type { EventItem, PluginManifest, PrivacyMode } from "../types";

const API_BASE =
  typeof window !== "undefined" && window.openbutlerDesktop?.apiBase
    ? window.openbutlerDesktop.apiBase
    : import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
