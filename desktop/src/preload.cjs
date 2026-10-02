const {contextBridge, ipcRenderer} = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const apiBase = readArg("openbutler-api-base");
const channel = readArg("openbutler-channel") || "stable";

contextBridge.exposeInMainWorld("openbutlerDesktop", {
  apiBase,
  channel,
  requestApi: (path, options = {}) => ipcRenderer.invoke("openbutler:request-api", path, {
    method: options.method,
    body: options.body,
  }),
  getRuntime: () => ipcRenderer.invoke("openbutler:get-runtime"),
  getCaptureWindows: () => ipcRenderer.invoke("openbutler:get-capture-windows"),
  getCaptureCapabilities: () => ipcRenderer.invoke("openbutler:get-capture-capabilities"),
  getCaptureDisplays: () => ipcRenderer.invoke("openbutler:get-capture-displays"),
  getMaskedCapturePreview: (config) => ipcRenderer.invoke("openbutler:get-masked-capture-preview", config),
  startBuiltinCapture: (config) => ipcRenderer.invoke("openbutler:start-builtin-capture", config),
  pauseBuiltinCapture: () => ipcRenderer.invoke("openbutler:pause-builtin-capture"),
  getCaptureState: () => ipcRenderer.invoke("openbutler:get-capture-state"),
  getMaskedEvidence: (id) => ipcRenderer.invoke("openbutler:get-masked-evidence", id),
  getBuiltinModelRoutes: () => ipcRenderer.invoke("openbutler:get-builtin-model-routes"),
  listBuiltinLocalModels: (input) => ipcRenderer.invoke("openbutler:list-builtin-local-models", {
    endpoint: input?.endpoint, protocol: input?.protocol,
  }),
  useBuiltinLocalModelsForSession: (configuration) => ipcRenderer.invoke("openbutler:use-builtin-local-models-for-session", configuration),
  revokeBuiltinSessionModels: () => ipcRenderer.invoke("openbutler:revoke-builtin-session-models"),
  saveBuiltinModelRoutes: (routes) => ipcRenderer.invoke("openbutler:save-builtin-model-routes", routes),
  restartBackend: () => ipcRenderer.invoke("openbutler:restart-backend"),
  chooseMineContextHome: () => ipcRenderer.invoke("openbutler:choose-minecontext-home"),
  openDataFolder: () => ipcRenderer.invoke("openbutler:open-data-folder"),
  getMineContextStatus: () => ipcRenderer.invoke("openbutler:get-minecontext-status"),
  scanMineContextInstallations: () => ipcRenderer.invoke("openbutler:scan-minecontext-installations"),
  chooseMineContextInstaller: () => ipcRenderer.invoke("openbutler:choose-minecontext-installer"),
  downloadMineContextInstaller: () => ipcRenderer.invoke("openbutler:download-minecontext-installer"),
  installMineContextWithApproval: () => ipcRenderer.invoke("openbutler:install-minecontext-with-approval"),
  openMineContextDownloadPage: () => ipcRenderer.invoke("openbutler:open-minecontext-download-page"),
  startMineContext: () => ipcRenderer.invoke("openbutler:start-minecontext"),
  testMineContextModelConfig: (config) => ipcRenderer.invoke("openbutler:test-minecontext-model-config", config),
  applyMineContextModelConfig: (config) => ipcRenderer.invoke("openbutler:apply-minecontext-model-config", config),
  showMainWindow: () => ipcRenderer.invoke("openbutler:show-main-window"),
  quitApp: () => ipcRenderer.invoke("openbutler:quit-app"),
  getAcceptancePack: () => ipcRenderer.invoke("openbutler:get-acceptance-pack"),
  saveAcceptanceFeedback: (feedback) => ipcRenderer.invoke("openbutler:save-acceptance-feedback", feedback),
});
