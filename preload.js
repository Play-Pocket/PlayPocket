const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setRPC: (data) => ipcRenderer.send('set-rpc', data),
  clearRPC: () => ipcRenderer.send('clear-rpc'),

  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, data) => ipcRenderer.invoke('write-file', path, data)
});
