const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getStatus:        () => ipcRenderer.invoke('installer:get-status'),
  getIconPath:      () => ipcRenderer.invoke('installer:get-icon-path'),
  chooseSourceDir:  () => ipcRenderer.invoke('installer:choose-source-dir'),
  chooseInstallDir: () => ipcRenderer.invoke('installer:choose-install-dir'),
  setSourceDir:  (sourceDir)  => ipcRenderer.invoke('installer:set-source-dir',  sourceDir),
  setInstallDir: (installDir) => ipcRenderer.invoke('installer:set-install-dir', installDir),
  install:   (payload) => ipcRenderer.invoke('installer:install',   payload),
  repair:    (payload) => ipcRenderer.invoke('installer:repair',    payload),
  update:    (payload) => ipcRenderer.invoke('installer:update',    payload),
  uninstall: (payload) => ipcRenderer.invoke('installer:uninstall', payload),
  openSourceDir:  () => ipcRenderer.invoke('installer:open-source-dir'),
  openInstallDir: () => ipcRenderer.invoke('installer:open-install-dir'),

  onLog: (callback) => {
    ipcRenderer.on('installer:log', (_event, message) => callback(message));
  }
});
