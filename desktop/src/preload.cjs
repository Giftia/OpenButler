const {contextBridge, ipcRenderer} = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const apiBase = readArg("openbutler-api-base");

contextBridge.exposeInMainWorld("openbutlerDesktop", {
  apiBase,
  getRuntime: () => ipcRenderer.invoke("openbutler:get-runtime"),
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
});
