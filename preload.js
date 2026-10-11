const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CH = Object.freeze({
  RPC_SET: 'rpc:set',
  RPC_CLEAR: 'rpc:clear',
  PLAYBACK_STATE: 'playback:state',
  PLAYBACK_COMMAND: 'playback:command',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  STARTUP_STATE: 'app:startup-state',
  STATE_SAVE: 'state:save',
  STATE_SAVE_FINAL: 'state:save-final',
  CACHE_CLEAR: 'cache:clear',
  EXTERNAL_OPEN: 'external:open',
  TRANSCODE_TO_MP4: 'media:transcode-to-mp4',
  TRANSCODE_PROGRESS: 'media:transcode-progress'
});

const PLAYBACK_COMMANDS = new Set(['toggle-play-pause', 'next-track', 'previous-track', 'toggle-fullscreen', 'show-window']);

function plainObjectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

contextBridge.exposeInMainWorld('electronAPI', {
  setRPC: (data) => {
    const payload = plainObjectOrNull(data);
    if (payload) ipcRenderer.send(CH.RPC_SET, payload);
  },
  clearRPC: () => ipcRenderer.send(CH.RPC_CLEAR),
  updatePlaybackState: (data) => {
    const payload = plainObjectOrNull(data);
    if (payload) ipcRenderer.send(CH.PLAYBACK_STATE, { isPlaying: payload.isPlaying === true });
  },

  getSettings: () => ipcRenderer.invoke(CH.SETTINGS_GET),
  getStartupState: () => ipcRenderer.invoke(CH.STARTUP_STATE),
  setSettings: (partial) => ipcRenderer.invoke(CH.SETTINGS_SET, plainObjectOrNull(partial) || {}),
  saveRuntimeState: (partial) => ipcRenderer.invoke(CH.STATE_SAVE, plainObjectOrNull(partial) || {}),
  saveRuntimeStateFinal: (partial) => {
    const payload = plainObjectOrNull(partial);
    if (payload) ipcRenderer.send(CH.STATE_SAVE_FINAL, payload);
  },
  clearBrowserCache: () => ipcRenderer.invoke(CH.CACHE_CLEAR),
  openExternal: (url) => ipcRenderer.invoke(CH.EXTERNAL_OPEN, typeof url === 'string' ? url : ''),

  transcodeFile: (file, onProgress) => {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      filePath = '';
    }
    if (typeof filePath !== 'string' || !filePath) return Promise.reject(new Error('invalid-file-path'));
    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let listener = null;
    if (typeof onProgress === 'function') {
      listener = (_event, payload) => {
        if (payload && payload.jobId === jobId && typeof payload.percent === 'number') onProgress(payload.percent);
      };
      ipcRenderer.on(CH.TRANSCODE_PROGRESS, listener);
    }
    return ipcRenderer.invoke(CH.TRANSCODE_TO_MP4, { filePath, jobId }).finally(() => {
      if (listener) ipcRenderer.removeListener(CH.TRANSCODE_PROGRESS, listener);
    });
  },

  onPlaybackCommand: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, command) => {
      if (typeof command === 'string' && PLAYBACK_COMMANDS.has(command)) handler(command);
    };
    ipcRenderer.on(CH.PLAYBACK_COMMAND, listener);
    return () => ipcRenderer.removeListener(CH.PLAYBACK_COMMAND, listener);
  }
});
