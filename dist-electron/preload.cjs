// electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: () => import_electron.ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => import_electron.ipcRenderer.invoke("save-settings", settings),
  selectDirectory: () => import_electron.ipcRenderer.invoke("select-directory"),
  onLogMessage: (callback) => {
    import_electron.ipcRenderer.on("log-message", (_event, data) => callback(data));
  },
  removeLogListener: () => {
    import_electron.ipcRenderer.removeAllListeners("log-message");
  },
  windowControl: (action) => import_electron.ipcRenderer.send("window-control", action)
});
