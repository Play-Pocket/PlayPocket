const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, data) => ipcRenderer.invoke('write-file', path, data)
});

contextBridge.exposeInMainWorld('electronAPI', {
  setRPC: (data) => ipcRenderer.send('set-rpc', data)
});
