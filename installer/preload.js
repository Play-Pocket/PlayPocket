const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getStatus: () => ipcRenderer.invoke('installer:get-status'),
  getIconPath: () => ipcRenderer.invoke('installer:get-icon-path'),
  chooseInstallDir: () => ipcRenderer.invoke('installer:choose-install-dir'),
  setInstallDir: (installDir) => ipcRenderer.invoke('installer:set-install-dir', installDir),
  openInstallDir: (installDir) => ipcRenderer.invoke('installer:open-install-dir', installDir),
  install: (payload) => ipcRenderer.invoke('installer:install', payload),
  repair: (payload) => ipcRenderer.invoke('installer:repair', payload),
  update: (payload) => ipcRenderer.invoke('installer:update', payload),
  uninstall: (payload) => ipcRenderer.invoke('installer:uninstall', payload),
  onProgress: (callback) => {
    ipcRenderer.on('installer:progress', (_event, payload) => callback(payload));
  }
});
