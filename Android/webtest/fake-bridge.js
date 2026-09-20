'use strict';

const state = { calls: [], playback: [], saved: {}, mode: 'ok' };
window.__bridge = state;

function record(name, args) {
  state.calls.push({ name, args });
}

window.AndroidBridge = {
  setNotificationControlsEnabled(enabled) {
    record('setNotificationControlsEnabled', [enabled]);
  },
  updatePlaybackState(isPlaying, title) {
    state.playback.push({ isPlaying, title });
  },
  clearCache() {
    record('clearCache', []);
  },
  openExternal(url) {
    record('openExternal', [url]);
  },
  beginSave(requestId, fileName, mimeType, totalBytes) {
    record('beginSave', [requestId, fileName, mimeType, totalBytes]);
    if (state.mode === 'beginFail') return false;
    state.saved[requestId] = { fileName, mimeType, totalBytes, chunks: [], done: false, cancelled: false };
    setTimeout(() => window.__ppOnSaveReady && window.__ppOnSaveReady(requestId, state.mode !== 'cancel'), 25);
    return true;
  },
  writeSaveChunk(saveId, base64) {
    const entry = state.saved[saveId];
    if (!entry || state.mode === 'writeFail') return false;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    entry.chunks.push(bytes);
    return true;
  },
  finishSave(saveId) {
    const entry = state.saved[saveId];
    if (!entry) return false;
    entry.done = true;
    return state.mode !== 'finishFail';
  },
  cancelSave(saveId) {
    const entry = state.saved[saveId];
    if (entry) entry.cancelled = true;
    record('cancelSave', [saveId]);
  }
};
