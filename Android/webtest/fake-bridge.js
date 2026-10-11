'use strict';

const state = { calls: [], playback: [], saved: {}, transcodes: {}, mode: 'ok' };
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
  beginTranscode(id, fileName, totalBytes) {
    record('beginTranscode', [id, fileName, totalBytes]);
    if (state.mode === 'transcodeBeginFail') return false;
    state.transcodes[id] = { fileName, chunks: [], bytes: null };
    return true;
  },
  writeTranscodeChunk(id, base64) {
    const entry = state.transcodes[id];
    if (!entry) return false;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    entry.chunks.push(bytes);
    return true;
  },
  finishTranscode(id) {
    const entry = state.transcodes[id];
    if (!entry) return false;
    const total = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of entry.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    entry.bytes = merged;
    const ok = state.mode !== 'transcodeFail';
    setTimeout(() => {
      if (window.__ppOnTranscodeProgress) window.__ppOnTranscodeProgress(id, 100);
      if (window.__ppOnTranscodeReady) window.__ppOnTranscodeReady(id, ok, ok ? total : 0);
    }, 20);
    return true;
  },
  readTranscodeChunk(id, offset, length) {
    const entry = state.transcodes[id];
    if (!entry || !entry.bytes) return '';
    const start = Number(offset);
    if (start < 0 || start >= entry.bytes.length) return '';
    const slice = entry.bytes.subarray(start, Math.min(entry.bytes.length, start + Number(length)));
    let binary = '';
    for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
    return btoa(binary);
  },
  cancelTranscode(id) {
    delete state.transcodes[id];
    record('cancelTranscode', [id]);
  },
  cancelSave(saveId) {
    const entry = state.saved[saveId];
    if (entry) entry.cancelled = true;
    record('cancelSave', [saveId]);
  }
};
