const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setRPC: (data) => ipcRenderer.send('set-rpc', data),
  clearRPC: () => ipcRenderer.send('clear-rpc'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  getStartupState: () => ipcRenderer.invoke('get-startup-state'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  saveRuntimeState: (partial) => ipcRenderer.invoke('save-runtime-state', partial),
  clearBrowserCache: () => ipcRenderer.invoke('clear-browser-cache'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  readFile: (filePath) => {
    if (typeof filePath !== 'string') {
      return Promise.reject(new Error('readFile: path must be a string'));
    }
    return ipcRenderer.invoke('read-file', filePath);
  },

  writeFile: (filePath, data) => {
    if (typeof filePath !== 'string') {
      return Promise.reject(new Error('writeFile: path must be a string'));
    }
    if (typeof data !== 'string') {
      return Promise.reject(new Error('writeFile: data must be a string'));
    }
    return ipcRenderer.invoke('write-file', filePath, data);
  },

  onPlaybackCommand: (handler) => {
    const listener = (_, command) => handler(command);
    ipcRenderer.on('playback-command', listener);
    return () => ipcRenderer.removeListener('playback-command', listener);
  }
});
