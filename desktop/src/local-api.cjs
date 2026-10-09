const {pathToFileURL} = require("node:url");

const SESSION_HEADER = "X-OpenButler-Session";
const SYNC_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const TASK_SYNC_FAILURES = new Set([
  "task_context_incomplete", "invalid_discovery_result", "discovery_source_mismatch",
  "discovery_authorization_changed", "local_model_unavailable", "local_provider_failed",
  "local_provider_timeout", "invalid_provider_response", "local_discovery_failed",
]);

function isFrontendUrl(url, indexPath) {
  return typeof url === "string" && url.split("#", 1)[0] === pathToFileURL(indexPath).href;
}

function isTrustedSender(event, window, indexPath) {
  try {
    if (!window || window.isDestroyed()) return false;
    const contents = window.webContents;
    const frame = event?.senderFrame;
    return !contents.isDestroyed() && event.sender === contents
      && Boolean(frame) && frame === contents.mainFrame
      && isFrontendUrl(frame.url, indexPath);
  } catch {
    // A sender frame can disappear while an IPC invocation is being delivered.
    return false;
  }
}

function restrictNavigation(contents, indexPath) {
  contents.setWindowOpenHandler(() => ({action: "deny"}));
  contents.on("will-navigate", (event, url) => {
    if (!isFrontendUrl(url, indexPath)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isFrontendUrl(event.url, indexPath)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function validateApiPath(apiPath) {
  if (typeof apiPath !== "string" || apiPath.length > 8192
      || !apiPath.startsWith("/api/") || /[\\#\x00-\x20\x7f]/.test(apiPath)) {
    throw new Error("Invalid local API path.");
  }
  const pathname = apiPath.split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error("Invalid local API path.");
  }
  // Reject encoded separators and second-stage escapes before URL normalization.
  if (decoded === "/api/" || /[\\?#%\x00-\x20\x7f]/.test(decoded)
      || /%2f/i.test(pathname) || decoded.includes("//")
      || decoded.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Invalid local API path.");
  }
  return apiPath;
}

function failure(status, error) {
  return {ok: false, status, error};
}

function createLocalApiRequest({getWindow, getFrontendIndexPath, getBackendState, getSessionToken,
  fetchImpl = globalThis.fetch, timeoutMs = 15000}) {
  return async (event, apiPath, options = {}) => {
    if (!isTrustedSender(event, getWindow(), getFrontendIndexPath())) {
      return failure(403, "Desktop request denied.");
    }
    let method;
    try {
      validateApiPath(apiPath);
      if (!options || typeof options !== "object" || Array.isArray(options)
          || Object.keys(options).some((key) => key !== "method" && key !== "body")) {
        throw new Error("Invalid options.");
      }
      method = options.method ?? "GET";
      const canonicalPath = decodeURIComponent(apiPath.split("?", 1)[0]);
      if (canonicalPath.startsWith("/api/model_settings/")) {
        throw new Error("Private desktop endpoint.");
      }
      if (canonicalPath.startsWith("/api/context-engine/")) {
        const readable = method === "GET" && [
          "/api/context-engine/status", "/api/context-engine/observations",
        ].includes(canonicalPath);
        const controllable = method === "POST" && [
          "/api/context-engine/capture/pause", "/api/context-engine/capture/revoke",
          "/api/context-engine/daily-review",
        ].includes(canonicalPath);
        const recordAction = method === "POST" && /^\/api\/context-engine\/observations\/[0-9a-f-]{36}\/(retry|delete)$/.test(canonicalPath);
        if (!readable && !controllable && !recordAction) {
          throw new Error("Private desktop endpoint.");
        }
      }
      if (canonicalPath === "/api/tasks" || canonicalPath.startsWith("/api/tasks/")
          || canonicalPath.startsWith("/api/task-activity/")) {
        const id = "[a-z]+_[0-9a-f]{32}";
        // Receipt routes are exact: no encoded spellings, queries, suffixes or
        // generic CRUD authority on operation identifiers.
        if ((canonicalPath === "/api/task-activity/sync" || canonicalPath.startsWith("/api/task-activity/sync/")) && apiPath !== canonicalPath) throw new Error("Invalid sync route.");
        const readable = method === "GET" && (
          canonicalPath === "/api/tasks" || new RegExp(`^/api/tasks/${id}$`).test(canonicalPath)
          || /^\/api\/task-activity\/(settings|activities|discoveries|sync)$/.test(canonicalPath)
          || new RegExp(`^/api/task-activity/sync/${SYNC_UUID}$`).test(canonicalPath));
        const create = method === "POST" && (
          ["/api/tasks", "/api/task-activity/activities", "/api/task-activity/sync"].includes(canonicalPath)
          || new RegExp(`^/api/tasks/${id}/(?:resources|merge|unmerge)$`).test(canonicalPath)
          || new RegExp(`^/api/task-activity/discoveries/${id}/resolve$`).test(canonicalPath)
          || new RegExp(`^/api/task-activity/sync/${SYNC_UUID}/stop$`).test(canonicalPath));
        const edit = method === "PATCH" && new RegExp(`^/api/tasks/${id}$`).test(canonicalPath);
        const relate = method === "PUT" && (canonicalPath === "/api/task-activity/settings"
          || new RegExp(`^/api/tasks/${id}/(?:checkpoint|runtime-goal|activities/${id})$`).test(canonicalPath));
        if (!readable && !create && !edit && !relate) throw new Error("Private task endpoint.");
      }
      if (canonicalPath.startsWith("/api/agent-runtime/")) {
        const base = "/api/agent-runtime";
        const id = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";
        const readable = method === "GET" && (
          ["status", "planner", "sources", "evidence", "goals", "inbox", "runs", "chat", "conversations"]
            .some((route) => canonicalPath === `${base}/${route}`)
          || new RegExp(`^${base}/(?:goals|commands|conversations)/${id}$`).test(canonicalPath)
          || new RegExp(`^${base}/conversations/${id}/(?:turns|adoptions)/${id}$`).test(canonicalPath));
        const explicitWrite = method === "POST" && (
          ["enabled", "settings", "evidence", "goals", "chat"].some((route) => canonicalPath === `${base}/${route}`)
          || new RegExp(`^${base}/sources/(?:synthetic|user_statement)/(?:grant|revoke|delete)$`).test(canonicalPath)
          || new RegExp(`^${base}/planner/(?:configure|select)$`).test(canonicalPath)
          || new RegExp(`^${base}/conversations/${id}/(?:consent|revoke|turns)$`).test(canonicalPath)
          || new RegExp(`^${base}/conversations/${id}/proposals/${id}/adopt$`).test(canonicalPath)
          || new RegExp(`^${base}/goals/${id}/(?:activate|control)$`).test(canonicalPath)
          || new RegExp(`^${base}/inbox/${id}/read$`).test(canonicalPath));
        const explicitEdit = method === "PATCH" && new RegExp(`^${base}/goals/${id}$`).test(canonicalPath);
        if (!readable && !explicitWrite && !explicitEdit) throw new Error("Private runtime endpoint.");
      }
      if (typeof method !== "string" || !METHODS.has(method)
          || (options.body != null && typeof options.body !== "string")
          || ((method === "GET" || method === "HEAD") && options.body != null)) {
        throw new Error("Invalid options.");
      }
    } catch {
      return failure(400, "Invalid local API request.");
    }

    const {apiBase, running} = getBackendState();
    const token = getSessionToken();
    if (!running || !/^[a-f0-9]{64}$/.test(token)
        || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(apiBase)) {
      return failure(503, "Local service unavailable.");
    }

    const controller = new AbortController();
    let timer;
    try {
      const url = new URL(apiPath, apiBase);
      if (url.origin !== apiBase || !url.pathname.startsWith("/api/")) {
        return failure(400, "Invalid local API request.");
      }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Local API timeout."));
        }, timeoutMs);
      });
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(url.href, {
          method,
          body: options.body ?? undefined,
          headers: {"Content-Type": "application/json", [SESSION_HEADER]: token},
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        });
        const status = response.status;
        if (response.redirected || (status >= 300 && status < 400)) {
          return failure(502, "Local API redirect denied.");
        }
        if (!response.ok) {
          // Only this fixed task diagnostic vocabulary may cross the bridge.
          // Never expose model output, source text or arbitrary exception text.
          if (method === "POST" && apiPath === "/api/task-activity/sync" && [409, 422].includes(status)) {
            let code;
            try {
              const raw = await response.text();
              if (raw.length <= 128 && !raw.includes(token)) {
                const value = JSON.parse(raw);
                if (value && typeof value === "object" && !Array.isArray(value)
                    && Object.keys(value).length === 1 && (TASK_SYNC_FAILURES.has(value.detail)
                      || status === 409 && ["version_conflict", "command_conflict"].includes(value.detail))) code = value.detail;
              }
            } catch { /* Unknown diagnostics remain opaque. */ }
            if (!isTrustedSender(event, getWindow(), getFrontendIndexPath())
                || getSessionToken() !== token || !getBackendState().running
                || getBackendState().apiBase !== apiBase) {
              return failure(503, "Local service unavailable.");
            }
            return code ? {...failure(status, "Local API request failed."), code}
              : failure(status, "Local API request failed.");
          }
          // A missing durable conversation receipt is useful for explicit
          // reconciliation, but never forward arbitrary backend error text.
          const receiptLookup = method === "GET" && new RegExp(
            "^/api/agent-runtime/conversations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}/(?:turns|adoptions)/[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$"
          ).test(decodeURIComponent(url.pathname));
          const commandLookup = method === "GET" && /^\/api\/agent-runtime\/commands\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(decodeURIComponent(url.pathname));
          const taskSyncLookup = method === "GET" && new RegExp(`^/api/task-activity/sync/${SYNC_UUID}$`).test(apiPath);
          const missingCode = taskSyncLookup ? "task_sync_not_found" : commandLookup ? "runtime_command_not_found" : receiptLookup ? "runtime_item_not_found" : null;
          if (status === 404 && missingCode) {
            let missing = false;
            try {
              const raw = await response.text();
              if (raw.length <= 128 && !raw.includes(token)) {
                const value = JSON.parse(raw);
                missing = value && typeof value === "object" && !Array.isArray(value)
                  && Object.keys(value).length === 1 && value.detail === missingCode;
              }
            } catch { /* Invalid/missing response proof remains opaque. */ }
            if (!isTrustedSender(event, getWindow(), getFrontendIndexPath())
                || getSessionToken() !== token || !getBackendState().running
                || getBackendState().apiBase !== apiBase) {
              return failure(503, "Local service unavailable.");
            }
            if (missing) return {...failure(status, "Local API request failed."), code: missingCode};
          }
          return failure(status, "Local API request failed.");
        }
        const raw = method === "HEAD" || status === 204 ? "null" : await response.text();
        const data = JSON.parse(raw);
        // Never forward an accidentally echoed session credential or a stale response.
        if (raw.includes(token) || JSON.stringify(data).includes(token)) {
          return failure(502, "Invalid local API response.");
        }
        if (!isTrustedSender(event, getWindow(), getFrontendIndexPath())
            || getSessionToken() !== token || !getBackendState().running
            || getBackendState().apiBase !== apiBase) {
          return failure(503, "Local service unavailable.");
        }
        return {ok: true, status, data};
      })()]);
    } catch {
      return failure(controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? "Local API request timed out." : "Local API request failed.");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

module.exports = {SESSION_HEADER, isFrontendUrl, isTrustedSender, restrictNavigation,
  validateApiPath, createLocalApiRequest};

