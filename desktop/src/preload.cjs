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
});
