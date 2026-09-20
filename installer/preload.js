const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getVersion: () => ipcRenderer.invoke('installer:get-version'),
  getStatus: () => ipcRenderer.invoke('installer:get-status'),
  getLaunchIntent: () => ipcRenderer.invoke('installer:get-launch-intent'),
  getIconPath: () => ipcRenderer.invoke('installer:get-icon-path'),
  chooseInstallDir: () => ipcRenderer.invoke('installer:choose-install-dir'),
  setInstallDir: (installDir) => ipcRenderer.invoke('installer:set-install-dir', installDir),
  openInstallDir: (installDir) => ipcRenderer.invoke('installer:open-install-dir', installDir),
  install: (payload) => ipcRenderer.invoke('installer:install', payload),
  repair: (payload) => ipcRenderer.invoke('installer:repair', payload),
  update: (payload) => ipcRenderer.invoke('installer:update', payload),
  uninstall: (payload) => ipcRenderer.invoke('installer:uninstall', payload),
  onProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('installer:progress', listener);
    return () => ipcRenderer.removeListener('installer:progress', listener);
  }
});
