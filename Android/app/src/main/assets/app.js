const DB_NAME = 'offline-playlist-db';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_PLAYLISTS = 'playlists';

const MAX_PLAYLIST_NAME_LENGTH = 80;
const MAX_IMPORTED_ITEMS = 500;
const MAX_IMPORTED_JSON_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_FILES_PER_DROP = 100;
const MAX_THUMBNAIL_LENGTH = 2_000_000;
const MAX_SHARED_PACKAGE_BYTES = 500 * 1024 * 1024;
const SHARE_PACKAGE_EXTENSION = '.playpocket.json';
const ANDROID_EMBEDDED_MEDIA_SAFE_BYTES = 150 * 1024 * 1024;

const APP_SETTINGS_KEY = 'playpocket-settings-v1';
const APP_SESSION_KEY = 'playpocket-session-v2';

const DEFAULT_APP_SETTINGS = {
  audioPreset: 'standard',
  resumePlayback: true,
  cacheEnabled: true,
  rpcEnabled: false,
  startupLaunch: false,
  minimizeOnClose: false,
  hardwareAcceleration: true
};

const ALLOWED_THUMB_PREFIXES = [
  'data:image/jpeg;base64,',
  'data:image/png;base64,',
  'data:image/webp;base64,',
  'data:image/gif;base64,'
];

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
  'video/quicktime',
  'video/x-msvideo'
]);

const runtimeAPI = window.electronAPI || window.AndroidBridge || null;
const isElectron = !!window.electronAPI;
const isAndroid = /Android/i.test(navigator.userAgent);

let db;
let currentPlaylist = null;
let currentIndex = 0;
let playMode = 'order';
let shuffleOrder = [];
let videoListCache = Object.create(null);
let currentObjectUrl = null;
let currentPlayingId = null;
let pendingResumeTime = 0;
let sessionSaveTimer = null;
let appSettings = { ...DEFAULT_APP_SETTINGS };

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const playlistsEl = document.getElementById('playlists');
const newPlaylistName = document.getElementById('newPlaylistName');
const createPlaylistBtn = document.getElementById('createPlaylistBtn');
const trackListEl = document.getElementById('trackList');
const videoPlayer = document.getElementById('videoPlayer');
const videoStage = document.getElementById('videoStage');
const centerPlayBtn = document.getElementById('centerPlayBtn');
const seekBar = document.getElementById('seekBar');
const currentTimeEl = document.getElementById('currentTime');
const durationTimeEl = document.getElementById('durationTime');
const playPauseBtn = document.getElementById('playPauseBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const orderBtn = document.getElementById('orderBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const randomBtn = document.getElementById('randomBtn');
const speedSelect = document.getElementById('speedSelect');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const totalDurationEl = document.getElementById('totalDuration');
const exportMetaBtn = document.getElementById('exportMetaBtn');
const exportWithBlobsBtn = document.getElementById('exportWithBlobsBtn');
const importFile = document.getElementById('importFile');
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.querySelector('.sidebar');
const overlay = document.getElementById('overlay');

const sharePlaylistBtn = document.getElementById('sharePlaylistBtn');
const shareModal = document.getElementById('shareModal');
const closeShareBtn = document.getElementById('closeShareBtn');
const sharePlaylistSummary = document.getElementById('sharePlaylistSummary');
const downloadSharePackageBtn = document.getElementById('downloadSharePackageBtn');
const copyShareCodeBtn = document.getElementById('copyShareCodeBtn');
const shareCodeInput = document.getElementById('shareCodeInput');
const importShareCodeBtn = document.getElementById('importShareCodeBtn');
const shareStatus = document.getElementById('shareStatus');

const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsModal = document.getElementById('settingsModal');
const officialSiteLink = document.getElementById('officialSiteLink');

const audioPresetSelect = document.getElementById('audioPreset');
const resumePlaybackInput = document.getElementById('resumePlayback');
const rpcEnabledInput = document.getElementById('rpcEnabled');
const startupLaunchInput = document.getElementById('startupLaunch');
const minimizeOnCloseInput = document.getElementById('minimizeOnClose');
const cacheEnabledInput = document.getElementById('cacheEnabled');
const hardwareAccelerationInput = document.getElementById('hardwareAcceleration');
const clearCacheBtn = document.getElementById('clearCacheBtn');

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function normalizePlaylistName(name) {
  const n = safeText(name);
  if (!n) return '';
  return n.length > MAX_PLAYLIST_NAME_LENGTH ? n.slice(0, MAX_PLAYLIST_NAME_LENGTH) : n;
}

function clampNumber(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function uid() {
  if (window.crypto && crypto.randomUUID) return `id-${crypto.randomUUID()}`;
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function safeThumbnailSrc(src) {
  if (typeof src !== 'string' || src.length === 0) return null;
  if (src.length > MAX_THUMBNAIL_LENGTH) return null;
  for (const prefix of ALLOWED_THUMB_PREFIXES) {
    if (src.startsWith(prefix)) return src;
  }
  return null;
}

function sanitizeMimeType(type) {
  if (typeof type === 'string' && ALLOWED_VIDEO_TYPES.has(type)) return type;
  return 'video/mp4';
}

function displayTitle(name) {
  const text = safeText(name) || 'video';
  return text.replace(/\.[^/.]+$/, '');
}

function loadLocalSettings() {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      audioPreset: ['standard', 'high', 'low'].includes(parsed?.audioPreset) ? parsed.audioPreset : DEFAULT_APP_SETTINGS.audioPreset,
      resumePlayback: typeof parsed?.resumePlayback === 'boolean' ? parsed.resumePlayback : DEFAULT_APP_SETTINGS.resumePlayback,
      cacheEnabled: typeof parsed?.cacheEnabled === 'boolean' ? parsed.cacheEnabled : DEFAULT_APP_SETTINGS.cacheEnabled,
      rpcEnabled: typeof parsed?.rpcEnabled === 'boolean' ? parsed.rpcEnabled : DEFAULT_APP_SETTINGS.rpcEnabled,
      startupLaunch: typeof parsed?.startupLaunch === 'boolean' ? parsed.startupLaunch : DEFAULT_APP_SETTINGS.startupLaunch,
      minimizeOnClose: typeof parsed?.minimizeOnClose === 'boolean' ? parsed.minimizeOnClose : DEFAULT_APP_SETTINGS.minimizeOnClose,
      hardwareAcceleration: typeof parsed?.hardwareAcceleration === 'boolean' ? parsed.hardwareAcceleration : DEFAULT_APP_SETTINGS.hardwareAcceleration
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function saveLocalSettings() {
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings));
}

function loadSessionState() {
  try {
    const raw = localStorage.getItem(APP_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveSessionStateNow() {
  try {
    const state = {
      playlist: currentPlaylist,
      index: currentIndex,
      trackId: currentPlayingId,
      playMode,
      shuffleOrder: Array.isArray(shuffleOrder) ? shuffleOrder.slice() : [],
      time: Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0,
      speed: Number.isFinite(videoPlayer.playbackRate) ? videoPlayer.playbackRate : 1,
      volume: Number.isFinite(videoPlayer.volume) ? videoPlayer.volume : 1,
      wasPlaying: !videoPlayer.paused && !videoPlayer.ended,
      sidebarOpen: !!sidebar?.classList.contains('open'),
      settingsOpen: !!settingsModal?.classList.contains('open')
    };
    localStorage.setItem(APP_SESSION_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('セッション保存に失敗しました:', e);
  }
}

function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionStateNow, 200);
}

function syncSettingsUI() {
  if (audioPresetSelect) audioPresetSelect.value = appSettings.audioPreset || 'standard';
  if (resumePlaybackInput) resumePlaybackInput.checked = !!appSettings.resumePlayback;
  if (rpcEnabledInput) rpcEnabledInput.checked = !!appSettings.rpcEnabled;
  if (startupLaunchInput) startupLaunchInput.checked = !!appSettings.startupLaunch;
  if (minimizeOnCloseInput) minimizeOnCloseInput.checked = !!appSettings.minimizeOnClose;
  if (cacheEnabledInput) cacheEnabledInput.checked = !!appSettings.cacheEnabled;
  if (hardwareAccelerationInput) hardwareAccelerationInput.checked = !!appSettings.hardwareAcceleration;
}

function updateSettingsAvailability() {
  const desktopOnly = isAndroid || !isElectron;
  if (rpcEnabledInput) rpcEnabledInput.disabled = desktopOnly;
  if (startupLaunchInput) startupLaunchInput.disabled = desktopOnly;
  if (minimizeOnCloseInput) minimizeOnCloseInput.disabled = desktopOnly;
  if (hardwareAccelerationInput) hardwareAccelerationInput.disabled = isAndroid;
}

function applyAudioPreset() {
  if (!videoPlayer) return;
  const preset = appSettings.audioPreset || 'standard';

  if (preset === 'high') {
    videoPlayer.preload = 'auto';
    videoPlayer.preservesPitch = true;
  } else if (preset === 'low') {
    videoPlayer.preload = 'metadata';
    videoPlayer.preservesPitch = false;
  } else {
    videoPlayer.preload = 'metadata';
    videoPlayer.preservesPitch = true;
  }
}

async function loadAppSettings() {
  appSettings = loadLocalSettings();

  if (isElectron && runtimeAPI?.getSettings) {
    try {
      const remote = await runtimeAPI.getSettings();
      if (remote && typeof remote === 'object') {
        appSettings = {
          ...appSettings,
          ...remote,
          audioPreset: ['standard', 'high', 'low'].includes(remote?.audioPreset) ? remote.audioPreset : appSettings.audioPreset,
          resumePlayback: typeof remote?.resumePlayback === 'boolean' ? remote.resumePlayback : appSettings.resumePlayback
        };
      }
    } catch (e) {
      console.warn('設定の読み込みに失敗しました:', e);
    }
  }

  syncSettingsUI();
  updateSettingsAvailability();
  applyAudioPreset();
}

async function saveAppSettings(partial) {
  appSettings = { ...appSettings, ...partial };
  saveLocalSettings();
  syncSettingsUI();
  applyAudioPreset();

  if (isElectron && runtimeAPI?.setSettings) {
    try {
      const next = await runtimeAPI.setSettings(partial);
      if (next && typeof next === 'object') {
        appSettings = {
          ...appSettings,
          ...next,
          audioPreset: ['standard', 'high', 'low'].includes(next?.audioPreset) ? next.audioPreset : appSettings.audioPreset,
          resumePlayback: typeof next?.resumePlayback === 'boolean' ? next.resumePlayback : appSettings.resumePlayback
        };
        saveLocalSettings();
        syncSettingsUI();
      }
    } catch (e) {
      console.warn('設定保存に失敗しました:', e);
    }
  }
}

function sendRPC(data) {
  if (!isElectron) return;
  if (!appSettings.rpcEnabled) return;
  runtimeAPI?.setRPC?.(data);
}

function clearRPC() {
  if (!isElectron) return;
  if (!appSettings.rpcEnabled) return;
  runtimeAPI?.clearRPC?.();
}

function clearWebCache() {
  if (isElectron && runtimeAPI?.clearBrowserCache) {
    return runtimeAPI.clearBrowserCache();
  }
  if (window.AndroidBridge?.clearCache) {
    try {
      window.AndroidBridge.clearCache();
      return Promise.resolve(true);
    } catch {
      return Promise.reject(new Error('clearCache failed'));
    }
  }
  return Promise.resolve(false);
}

function openExternal(url) {
  if (isElectron && runtimeAPI?.openExternal) {
    return runtimeAPI.openExternal(url);
  }
  if (window.AndroidBridge?.openExternal) {
    try {
      window.AndroidBridge.openExternal(url);
      return Promise.resolve(true);
    } catch {
      return Promise.reject(new Error('openExternal failed'));
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return Promise.resolve(true);
}

function openSettings() {
  if (!settingsModal) return;
  settingsModal.classList.add('open');
  settingsModal.setAttribute('aria-hidden', 'false');
  scheduleSessionSave();
}

function closeSettings() {
  if (!settingsModal) return;
  settingsModal.classList.remove('open');
  settingsModal.setAttribute('aria-hidden', 'true');
  scheduleSessionSave();
}

function setShareStatus(message = '', tone = '') {
  if (!shareStatus) return;
  shareStatus.textContent = message;
  shareStatus.className = `share-status${tone ? ` ${tone}` : ''}`;
}

async function openShareModal() {
  if (!shareModal) return;
  const playlist = await getCurrentPlaylist();
  const name = playlist?.name || currentPlaylist || 'プレイリスト';
  const count = Array.isArray(playlist?.items) ? playlist.items.length : 0;
  if (sharePlaylistSummary) {
    sharePlaylistSummary.textContent = `「${name}」を共有します。${count} 本の動画が含まれています。`;
  }
  setShareStatus();
  shareModal.classList.add('open');
  shareModal.setAttribute('aria-hidden', 'false');
  scheduleSessionSave();
}

function closeShareModal() {
  if (!shareModal) return;
  shareModal.classList.remove('open');
  shareModal.setAttribute('aria-hidden', 'true');
  scheduleSessionSave();
}

function openSidebar() {
  sidebar?.classList.add('open');
  overlay?.classList.add('active');
  scheduleSessionSave();
}

function closeSidebar() {
  sidebar?.classList.remove('open');
  overlay?.classList.remove('active');
  scheduleSessionSave();
}

function toggleSidebar() {
  sidebar?.classList.toggle('open');
  overlay?.classList.toggle('active');
  scheduleSessionSave();
}

window.__ppClosePanels = function () {
  let changed = false;
  if (shareModal?.classList.contains('open')) {
    closeShareModal();
    changed = true;
  }
  if (settingsModal?.classList.contains('open')) {
    closeSettings();
    changed = true;
  }
  if (sidebar?.classList.contains('open')) {
    closeSidebar();
    changed = true;
  }
  return changed;
};

async function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_VIDEOS)) {
        idb.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains(STORE_PLAYLISTS)) {
        idb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'name' });
      }
    };

    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror = () => rej(req.error || new Error('IndexedDB open failed'));
  });
}

function idbPut(store, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('idbPut failed'));
  });
}

function idbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('idbGet failed'));
  });
}

function idbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('idbGetAll failed'));
  });
}

function idbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error || new Error('idbDelete failed'));
  });
}

async function loadAllPlaylists() {
  const pls = await idbGetAll(STORE_PLAYLISTS);
  return Array.isArray(pls) ? pls : [];
}

async function ensureDefaultPlaylist() {
  const pls = await loadAllPlaylists();
  if (pls.length === 0) {
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    return 'Default';
  }
  return normalizePlaylistName(pls[0]?.name) || pls[0].name;
}

async function idbRenamePlaylist(oldName, newName) {
  const safeOld = normalizePlaylistName(oldName);
  const safeNew = normalizePlaylistName(newName);
  if (!safeOld || !safeNew) throw new Error('invalid');
  if (safeOld === safeNew) return;

  return new Promise((res, rej) => {
    let rejected = false;

    const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
    const store = tx.objectStore(STORE_PLAYLISTS);

    const getOld = store.get(safeOld);
    getOld.onsuccess = () => {
      if (!getOld.result || !Array.isArray(getOld.result.items)) {
        rejected = true;
        tx.abort();
        return rej(new Error('notfound'));
      }
      const items = getOld.result.items.slice();

      const checkNew = store.get(safeNew);
      checkNew.onsuccess = () => {
        if (checkNew.result) {
          rejected = true;
          tx.abort();
          return rej(new Error('exists'));
        }
        store.put({ name: safeNew, items });
        store.delete(safeOld);
      };
      checkNew.onerror = () => {
        rejected = true;
        rej(checkNew.error || new Error('lookup failed'));
      };
    };
    getOld.onerror = () => {
      rejected = true;
      rej(getOld.error || new Error('lookup failed'));
    };

    tx.oncomplete = () => { if (!rejected) res(); };
    tx.onerror = () => { if (!rejected) rej(tx.error || new Error('transaction failed')); };
    tx.onabort = () => {  };
  });
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFilename(value, fallback = 'playlist') {
  const filename = safeText(value).replace(/[<>:"/\\|?*]/g, '-').replace(/\.+$/g, '');
  return filename || fallback;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      res(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => rej(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  if (typeof base64 !== 'string' || !base64) throw new Error('invalid base64');
  let bin;
  try {
    bin = atob(base64);
  } catch {
    throw new Error('invalid base64');
  }
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: sanitizeMimeType(type) });
}

async function buildPlaylistExport(includeBlobs = false) {
  const pl = await getCurrentPlaylist();
  if (!pl) throw new Error('playlist-not-found');

  const items = [];
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (!meta) continue;
    const item = {
      id: safeText(String(meta.id || '')) || uid(),
      name: safeText(meta.name) || 'video',
      duration: clampNumber(Number(meta.duration), 0),
      mimeType: sanitizeMimeType(meta.mimeType),
      size: clampNumber(Number(meta.size), 0),
      thumbnail: safeThumbnailSrc(meta.thumbnail)
    };
    if (includeBlobs && meta.blob) item.blobBase64 = await blobToBase64(meta.blob);
    items.push(item);
  }

  return { name: pl.name, items };
}

async function getPlaylistTotalMediaSize(pl) {
  let total = 0;
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta && Number.isFinite(meta.size)) total += meta.size;
  }
  return total;
}

async function assertEmbeddedExportIsSafe() {
  if (!isAndroid) return;

  const pl = await getCurrentPlaylist();
  if (!pl) return;

  const total = await getPlaylistTotalMediaSize(pl);
  if (total > ANDROID_EMBEDDED_MEDIA_SAFE_BYTES) {
    const err = new Error('embedded-export-too-large-for-device');
    err.totalBytes = total;
    throw err;
  }
}

async function getUniquePlaylistName(baseName, suffix) {
  const normalized = normalizePlaylistName(baseName) || 'プレイリスト';
  const makeName = (tail) => {
    const available = Math.max(1, MAX_PLAYLIST_NAME_LENGTH - tail.length);
    return `${normalized.slice(0, available)}${tail}`;
  };
  const initial = makeName(suffix);
  if (!await idbGet(STORE_PLAYLISTS, initial)) return initial;

  for (let index = 2; index <= 999; index++) {
    const candidate = makeName(`${suffix} ${index}`);
    if (candidate && !await idbGet(STORE_PLAYLISTS, candidate)) return candidate;
  }
  throw new Error('playlist-name-unavailable');
}

async function importPlaylistPayload(payload, suffix) {
  const baseName = normalizePlaylistName(payload?.name);
  if (!baseName || !Array.isArray(payload?.items)) throw new Error('invalid');

  const name = await getUniquePlaylistName(baseName, suffix);
  const items = [];

  for (const it of payload.items.slice(0, MAX_IMPORTED_ITEMS)) {
    if (!it || typeof it !== 'object') continue;

    const id = uid();
    const metaName = normalizePlaylistName(it.name) || 'video';
    const duration = clampNumber(Number(it.duration), 0);
    const size = clampNumber(Number(it.size), 0);
    const thumbnail = safeThumbnailSrc(it.thumbnail);
    const mimeType = sanitizeMimeType(it.mimeType);
    let blob = null;

    if (typeof it.blobBase64 === 'string' && it.blobBase64.length > 0) {
      blob = base64ToBlob(it.blobBase64, mimeType);
    }

    const meta = { id, name: metaName, duration, mimeType, blob, thumbnail, size };
    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;
    items.push(id);
  }

  await idbPut(STORE_PLAYLISTS, { name, items });
  currentPlaylist = name;
  currentIndex = 0;
  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  updateSeekUI();
  closeSidebar();
  scheduleSessionSave();
  return { name, itemCount: items.length };
}

function isSupportedVideoFile(file) {
  if (!(file instanceof File)) return false;
  if (typeof file.type === 'string' && file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|m4v|ogg|mkv)$/i.test(file.name || '');
}

function getVideoDuration(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch {} };
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      cleanup();
      res(d);
    };
    v.onerror = () => { cleanup(); res(0); };
  });
}

async function generateThumbnail(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(url); } catch {}
      res(val);
    };

    v.addEventListener('loadeddata', () => {
      try { v.currentTime = 0.1; } catch { finish(null); }
    });

    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 180;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, 320, 180);
        finish(c.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(null);
      }
    });

    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 3000);
  });
}

function cleanupCurrentObjectUrl() {
  if (!currentObjectUrl) return;
  try { URL.revokeObjectURL(currentObjectUrl); } catch {}
  currentObjectUrl = null;
}

function setPlayerUIState() {
  const paused = videoPlayer.paused || videoPlayer.ended;
  videoStage?.classList.toggle('paused', paused);
  if (centerPlayBtn) centerPlayBtn.textContent = paused ? '▶' : 'Ⅱ';
  if (playPauseBtn) playPauseBtn.textContent = paused ? '▶' : 'Ⅱ';
}

function updateSeekUI() {
  const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  const cur = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
  if (durationTimeEl) durationTimeEl.textContent = formatTime(dur);
  if (currentTimeEl) currentTimeEl.textContent = formatTime(cur);
  if (seekBar) {
    if (dur > 0) {
      const ratio = Math.min(1, Math.max(0, cur / dur));
      if (!seekBar.matches(':active')) seekBar.value = String(Math.round(ratio * 1000));
    } else {
      seekBar.value = '0';
    }
  }
}

function seekFromBar() {
  const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  if (!seekBar || dur <= 0) return;
  const ratio = Math.min(1, Math.max(0, parseFloat(seekBar.value) / 1000));
  videoPlayer.currentTime = dur * ratio;
  updateSeekUI();
  scheduleSessionSave();
}

async function addFiles(files) {
  const accepted = Array.from(files)
    .filter(isSupportedVideoFile)
    .slice(0, MAX_VIDEO_FILES_PER_DROP);
  if (accepted.length === 0) return;

  for (const f of accepted) {
    const id = uid();
    const duration = await getVideoDuration(f);
    const thumb = await generateThumbnail(f);
    const blob = f.slice(0, f.size, f.type || 'video/mp4');
    const meta = {
      id,
      name: safeText(f.name) || 'video',
      duration: clampNumber(duration, 0),
      mimeType: sanitizeMimeType(f.type),
      blob,
      thumbnail: thumb,
      size: f.size
    };

    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;

    if (currentPlaylist) {
      const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
      if (pl && Array.isArray(pl.items)) {
        pl.items.push(id);
        await idbPut(STORE_PLAYLISTS, pl);
      }
    } else {
      const defaultName = await ensureDefaultPlaylist();
      let pl = await idbGet(STORE_PLAYLISTS, defaultName);
      if (!pl) {
        pl = { name: defaultName, items: [] };
        await idbPut(STORE_PLAYLISTS, pl);
      }
      pl.items.push(id);
      await idbPut(STORE_PLAYLISTS, pl);
      currentPlaylist = defaultName;
      currentIndex = 0;
    }
  }

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  scheduleSessionSave();
}

function getCurrentPlaylist() {
  if (!currentPlaylist) return Promise.resolve(null);
  return idbGet(STORE_PLAYLISTS, currentPlaylist).then(pl =>
    (!pl || !Array.isArray(pl.items)) ? null : pl
  );
}

async function deleteOrphanedVideo(id) {
  if (!id) return;
  const allPlaylists = await loadAllPlaylists();
  const stillReferenced = allPlaylists.some(
    p => Array.isArray(p.items) && p.items.includes(id)
  );
  if (!stillReferenced) {
    await idbDelete(STORE_VIDEOS, id);
    delete videoListCache[id];
  }
}

function renderTrackItem(meta, index, isPlaying) {
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.index = String(index);
  li.dataset.id = meta.id;
  li.draggable = true;
  if (isPlaying) li.classList.add('playing');

  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = 'サムネイル';
  img.referrerPolicy = 'no-referrer';
  img.src = safeThumbnailSrc(meta.thumbnail) ?? '';

  const metaWrap = document.createElement('div');
  metaWrap.className = 'meta';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = displayTitle(meta.name);

  const sub = document.createElement('div');
  sub.className = 'sub';
  const sizeMB = Number.isFinite(meta.size) ? Math.round(meta.size / 1024 / 1024) : 0;
  sub.textContent = `${formatTime(meta.duration)} • ${sizeMB} MB`;

  metaWrap.appendChild(title);
  metaWrap.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'track-actions';

  const playNowBtn = document.createElement('button');
  playNowBtn.className = 'small-btn play-now';
  playNowBtn.type = 'button';
  playNowBtn.textContent = '再生';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'small-btn remove';
  removeBtn.type = 'button';
  removeBtn.textContent = '削除';

  actions.appendChild(playNowBtn);
  actions.appendChild(removeBtn);

  li.appendChild(img);
  li.appendChild(metaWrap);
  li.appendChild(actions);

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(index));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));

  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    li.classList.remove('drag-over');

    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const toIndex = index;
    if (!Number.isInteger(fromIndex) || fromIndex === toIndex) return;

    const pl = await getCurrentPlaylist();
    if (!pl) return;

    const item = pl.items.splice(fromIndex, 1)[0];
    if (typeof item === 'undefined') return;

    pl.items.splice(toIndex, 0, item);
    await idbPut(STORE_PLAYLISTS, pl);

    if (currentIndex === fromIndex) currentIndex = toIndex;
    else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
    else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;

    await refreshTrackList();
    updateSeekUI();
    scheduleSessionSave();
  });

  playNowBtn.addEventListener('click', async () => {
    currentIndex = index;
    await playCurrent({ autoplay: true });
    await refreshTrackList();
    scheduleSessionSave();
  });

  removeBtn.addEventListener('click', async () => {
    if (!currentPlaylist) return;
    const pl = await getCurrentPlaylist();
    if (!pl) return;

    const removedId = pl.items[index];
    pl.items.splice(index, 1);
    await idbPut(STORE_PLAYLISTS, pl);

    if (removedId) {
      await deleteOrphanedVideo(removedId);
    }

    if (currentIndex >= pl.items.length) currentIndex = Math.max(0, pl.items.length - 1);
    await refreshTrackList();
    await updateTotalDuration();
    updateSeekUI();
    scheduleSessionSave();
  });

  return li;
}

async function refreshPlaylistsUI() {
  playlistsEl.replaceChildren();
  const pls = await loadAllPlaylists();

  for (const p of pls) {
    const name = normalizePlaylistName(p?.name);
    if (!name) continue;

    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.dataset.name = name;
    if (name === currentPlaylist) li.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'playlist-name';
    nameSpan.textContent = name;
    nameSpan.title = 'クリックで選択 / ダブルクリックで名前変更';

    nameSpan.addEventListener('click', async () => {
      currentPlaylist = name;
      currentIndex = 0;
      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
      updateSeekUI();
      closeSidebar();
      scheduleSessionSave();
    });

    nameSpan.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const input = prompt('プレイリスト名を入力してください', name);
      if (input == null) return;
      const trimmed = normalizePlaylistName(input);
      if (!trimmed) {
        alert('無効な名前です');
        return;
      }
      try {
        await idbRenamePlaylist(name, trimmed);
        if (currentPlaylist === name) currentPlaylist = trimmed;
        await refreshPlaylistsUI();
        await refreshTrackList();
        await updateTotalDuration();
        scheduleSessionSave();
      } catch (err) {
        alert(err?.message === 'exists' ? '同名のプレイリストが既に存在します' : '名前変更に失敗しました');
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn';
    delBtn.type = 'button';
    delBtn.textContent = '削除';

    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`プレイリスト「${name}」を削除しますか？`)) return;

      const targetPl = await idbGet(STORE_PLAYLISTS, name);
      const itemIds = (targetPl && Array.isArray(targetPl.items)) ? targetPl.items.slice() : [];

      await idbDelete(STORE_PLAYLISTS, name);

      for (const id of itemIds) {
        await deleteOrphanedVideo(id);
      }

      const plsAfter = await loadAllPlaylists();
      if (currentPlaylist === name) {
        currentPlaylist = plsAfter[0]?.name || null;
        currentIndex = 0;
      }
      if (plsAfter.length === 0) {
        currentPlaylist = await ensureDefaultPlaylist();
      }

      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
      updateSeekUI();
      scheduleSessionSave();
    });

    li.appendChild(nameSpan);
    li.appendChild(delBtn);
    playlistsEl.appendChild(li);
  }
}

createPlaylistBtn.addEventListener('click', async () => {
  const name = normalizePlaylistName(newPlaylistName.value);
  if (!name) return;

  const exists = await idbGet(STORE_PLAYLISTS, name);
  if (exists) {
    alert('同名のプレイリストが既に存在します');
    return;
  }

  await idbPut(STORE_PLAYLISTS, { name, items: [] });
  newPlaylistName.value = '';
  currentPlaylist = name;
  currentIndex = 0;
  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  updateSeekUI();
  closeSidebar();
  scheduleSessionSave();
});

async function refreshTrackList() {
  trackListEl.replaceChildren();

  const pl = await getCurrentPlaylist();
  if (!pl) return;

  const missingIds = pl.items.filter(id => !videoListCache[id]);
  if (missingIds.length > 0) {
    const fetched = await Promise.all(missingIds.map(id => idbGet(STORE_VIDEOS, id)));
    fetched.forEach((v, i) => { if (v) videoListCache[missingIds[i]] = v; });
  }

  pl.items.forEach((id, i) => {
    const meta = videoListCache[id];
    if (!meta) return;
    trackListEl.appendChild(renderTrackItem(meta, i, i === currentIndex));
  });
}

function waitForVideoReady(video, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      video.removeEventListener('loadedmetadata', finish);
      video.removeEventListener('error', finish);
      clearTimeout(timer);
      resolve();
    }
    video.addEventListener('loadedmetadata', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
  });
}

async function loadAndPlayById(id, options = {}) {
  const autoplay = options.autoplay !== false;
  const resumeTime = Number.isFinite(options.resumeTime) ? Math.max(0, options.resumeTime) : 0;
  const updateState = options.updateState !== false;

  const meta = await idbGet(STORE_VIDEOS, id);
  if (!meta || !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    return false;
  }

  cleanupCurrentObjectUrl();

  currentPlayingId = id;
  currentObjectUrl = URL.createObjectURL(meta.blob);
  videoPlayer.src = currentObjectUrl;
  videoPlayer.load();
  videoPlayer.playbackRate = parseFloat(speedSelect?.value || '1') || 1;
  applyAudioPreset();

  const vol = parseFloat(localStorage.getItem('playerVolume') || '1');
  videoPlayer.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;

  await waitForVideoReady(videoPlayer);

  if (resumeTime > 0 && Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    const safeTime = Math.min(resumeTime, Math.max(0, videoPlayer.duration - 0.25));
    try { videoPlayer.currentTime = safeTime; } catch {}
    pendingResumeTime = safeTime;
  } else {
    pendingResumeTime = 0;
  }

  if (autoplay) {
    try {
      await videoPlayer.play();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('videoPlayer.play() failed:', err);
      }
    }
  } else {
    try { videoPlayer.pause(); } catch {}
  }

  setPlayerUIState();
  updateSeekUI();

  if (autoplay && isElectron) {
    const cleanTitle = displayTitle(meta.name);
    sendRPC({
      title: cleanTitle,
      playlist: currentPlaylist,
      startTimestamp: Date.now(),
      endTimestamp: Date.now() + (clampNumber(meta.duration, 0) * 1000),
      paused: false
    });
  }

  if (updateState) scheduleSessionSave();
  return true;
}

async function playCurrent(options = {}) {
  const autoplay = options.autoplay !== false;
  const resumeTime = Number.isFinite(options.resumeTime) ? Math.max(0, options.resumeTime) : 0;
  const pl = await getCurrentPlaylist();
  if (!pl || pl.items.length === 0) return false;

  let id = null;

  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== pl.items.length || !shuffleOrder.every(x => pl.items.includes(x))) {
      shuffleOrder = shuffleArray(pl.items.slice());
      currentIndex = 0;
    }
    id = shuffleOrder[currentIndex % shuffleOrder.length];
  } else if (playMode === 'random') {
    id = pl.items[Math.floor(Math.random() * pl.items.length)];
  } else {
    currentIndex = ((currentIndex % pl.items.length) + pl.items.length) % pl.items.length;
    id = pl.items[currentIndex];
  }

  if (!id) return false;
  const ok = await loadAndPlayById(id, { autoplay, resumeTime });
  await refreshTrackList();
  return ok;
}

async function updateTotalDuration() {
  const pl = await getCurrentPlaylist();
  if (!pl) {
    totalDurationEl.textContent = '00:00:00';
    return;
  }

  let total = 0;
  for (const id of pl.items) {
    const meta = videoListCache[id] || await idbGet(STORE_VIDEOS, id);
    if (meta && Number.isFinite(meta.duration)) total += meta.duration;
  }
  totalDurationEl.textContent = formatTime(total);
}

function createVolumeControls() {
  const playerControls = document.querySelector('.player-controls');
  if (!playerControls) return;

  if (playerControls.querySelector('.volume-controls')) return;

  const volWrap = document.createElement('div');
  volWrap.className = 'volume-controls';
  Object.assign(volWrap.style, { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' });

  const muteBtn = document.createElement('button');
  muteBtn.className = 'small-btn';
  muteBtn.type = 'button';
  muteBtn.title = 'ミュート/ミュート解除';
  muteBtn.textContent = '🔊';

  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = 0;
  volSlider.max = 1;
  volSlider.step = 0.01;
  volSlider.style.width = '120px';

  const volLabel = document.createElement('div');
  volLabel.style.color = 'var(--muted)';
  volLabel.style.fontSize = '13px';

  const saved = parseFloat(localStorage.getItem('playerVolume') || '1');
  const initVol = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  volSlider.value = String(initVol);
  volLabel.textContent = `${Math.round(initVol * 100)}%`;
  videoPlayer.volume = initVol;
  muteBtn.textContent = initVol > 0 ? '🔊' : '🔇';

  volSlider.addEventListener('input', () => {
    const v = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
    videoPlayer.volume = v;
    localStorage.setItem('playerVolume', String(v));
    volLabel.textContent = `${Math.round(v * 100)}%`;
    muteBtn.textContent = v > 0 ? '🔊' : '🔇';
    scheduleSessionSave();
  });

  muteBtn.addEventListener('click', () => {
    if (videoPlayer.volume > 0) {
      volSlider.dataset.prev = volSlider.value;
      volSlider.value = '0';
      videoPlayer.volume = 0;
      localStorage.setItem('playerVolume', '0');
      volLabel.textContent = '0%';
      muteBtn.textContent = '🔇';
    } else {
      const prev = Math.min(1, Math.max(0, parseFloat(volSlider.dataset.prev || '1') || 1));
      volSlider.value = String(prev);
      videoPlayer.volume = prev;
      localStorage.setItem('playerVolume', String(prev));
      volLabel.textContent = `${Math.round(prev * 100)}%`;
      muteBtn.textContent = '🔊';
    }
    scheduleSessionSave();
  });

  volWrap.appendChild(muteBtn);
  volWrap.appendChild(volSlider);
  volWrap.appendChild(volLabel);
  playerControls.appendChild(volWrap);
}

function setMode(m) {
  playMode = m;
  orderBtn.classList.toggle('active', m === 'order');
  shuffleBtn.classList.toggle('active', m === 'shuffle');
  randomBtn.classList.toggle('active', m === 'random');
  if (m === 'shuffle') shuffleOrder = [];
  scheduleSessionSave();
}

function findRestorableTrack(saved, pl) {
  if (!saved || !pl || !Array.isArray(pl.items)) return null;

  if (typeof saved.trackId === 'string' && pl.items.includes(saved.trackId)) {
    return saved.trackId;
  }

  const idx = Number.isInteger(saved.index) ? saved.index : -1;
  if (idx >= 0 && idx < pl.items.length) {
    return pl.items[idx];
  }

  return pl.items[0] || null;
}

async function restorePlaybackState() {
  if (!appSettings.resumePlayback) return null;

  const saved = loadSessionState();
  if (!saved || typeof saved !== 'object') return null;

  if (typeof saved.playMode === 'string' && ['order', 'shuffle', 'random'].includes(saved.playMode)) {
    setMode(saved.playMode);
  }

  if (typeof saved.speed === 'number' && Number.isFinite(saved.speed)) {
    const speed = Math.min(2, Math.max(0.5, saved.speed));
    if (speedSelect) speedSelect.value = String(speed);
    videoPlayer.playbackRate = speed;
  }

  if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
    const vol = Math.min(1, Math.max(0, saved.volume));
    videoPlayer.volume = vol;
    localStorage.setItem('playerVolume', String(vol));
  }

  if (typeof saved.sidebarOpen === 'boolean') {
    if (saved.sidebarOpen) openSidebar();
    else closeSidebar();
  }

  if (typeof saved.settingsOpen === 'boolean') {
    if (saved.settingsOpen) openSettings();
    else closeSettings();
  }

  if (typeof saved.playlist === 'string') {
    const savedName = normalizePlaylistName(saved.playlist);
    const pl = savedName ? await idbGet(STORE_PLAYLISTS, savedName) : null;
    if (pl && Array.isArray(pl.items)) {
      currentPlaylist = pl.name;
    }
  }

  const pl = await getCurrentPlaylist();
  if (!pl || !Array.isArray(pl.items) || pl.items.length === 0) return null;

  if (saved.playMode === 'shuffle' && Array.isArray(saved.shuffleOrder)) {
    shuffleOrder = saved.shuffleOrder.filter(id => pl.items.includes(id));
  } else {
    shuffleOrder = [];
  }

  const trackId = findRestorableTrack(saved, pl);
  if (!trackId) return null;

  const resolvedIndex = pl.items.indexOf(trackId);
  if (resolvedIndex >= 0) currentIndex = resolvedIndex;

  const resumeTime = typeof saved.time === 'number' && Number.isFinite(saved.time) ? Math.max(0, saved.time) : 0;
  const autoplay = !!saved.wasPlaying;

  return { trackId, resumeTime, autoplay };
}

playPauseBtn.addEventListener('click', async () => {
  if (videoPlayer.paused) {
    try { await videoPlayer.play(); } catch (err) {
      if (err.name !== 'AbortError') console.warn('play() failed:', err);
    }
    sendRPC({ paused: false });
  } else {
    videoPlayer.pause();
    sendRPC({ paused: true });
  }
  setPlayerUIState();
  scheduleSessionSave();
});

centerPlayBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (videoPlayer.paused) {
    try { await videoPlayer.play(); } catch (err) {
      if (err.name !== 'AbortError') console.warn('play() failed:', err);
    }
  } else {
    videoPlayer.pause();
  }
  setPlayerUIState();
  scheduleSessionSave();
});

videoStage?.addEventListener('click', (e) => {
  if (e.target === centerPlayBtn) return;
  if (videoPlayer.paused) {
    videoPlayer.play().catch((err) => {
      if (err.name !== 'AbortError') console.warn('play() failed:', err);
    });
  } else {
    videoPlayer.pause();
  }
  setPlayerUIState();
  scheduleSessionSave();
});

seekBar?.addEventListener('input', () => {
  updateSeekUI();
});

seekBar?.addEventListener('change', () => {
  seekFromBar();
});

fullscreenBtn?.addEventListener('click', async () => {
  try {
    const target = document.querySelector('.video-shell') || videoStage || document.documentElement;
    if (!document.fullscreenElement) {
      await target.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {}
});

prevBtn.addEventListener('click', async () => {
  const pl = await getCurrentPlaylist();
  const len = pl?.items?.length || 0;
  if (!len) return;
  if (playMode === 'random') { await playCurrent({ autoplay: true }); return; }
  currentIndex = (currentIndex - 1 + len) % len;
  await playCurrent({ autoplay: true });
  scheduleSessionSave();
});

nextBtn.addEventListener('click', async () => {
  const pl = await getCurrentPlaylist();
  const len = pl?.items?.length || 0;
  if (!len) return;
  if (playMode === 'random') { await playCurrent({ autoplay: true }); return; }
  currentIndex = (currentIndex + 1) % len;
  await playCurrent({ autoplay: true });
  scheduleSessionSave();
});

orderBtn.addEventListener('click', () => setMode('order'));
shuffleBtn.addEventListener('click', () => setMode('shuffle'));
randomBtn.addEventListener('click', () => setMode('random'));

speedSelect.addEventListener('change', async () => {
  videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;
  scheduleSessionSave();
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  await addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', async e => {
  await addFiles(e.target.files);
  fileInput.value = '';
});

exportMetaBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const exportObj = await buildPlaylistExport(false);
  const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
  downloadBlob(blob, `${sanitizeFilename(exportObj.name)}.playlist.json`);
});

exportWithBlobsBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  try {
    await assertEmbeddedExportIsSafe();
    const exportObj = await buildPlaylistExport(true);
    const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
    downloadBlob(blob, `${sanitizeFilename(exportObj.name)}.playlist.full.json`);
  } catch (error) {
    console.error(error);
    if (error?.message === 'embedded-export-too-large-for-device') {
      alert('このプレイリストは動画の合計サイズが大きく、この端末では埋め込みエクスポートに失敗する可能性があります。動画を減らすか、埋め込みなしのエクスポートをお使いください。');
    } else {
      alert('エクスポートに失敗しました');
    }
  }
});

importFile.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;

  try {
    const maxBytes = f.name.toLowerCase().endsWith(SHARE_PACKAGE_EXTENSION)
      ? MAX_SHARED_PACKAGE_BYTES
      : MAX_IMPORTED_JSON_BYTES;
    if (f.size > maxBytes) throw new Error('file-too-large');

    const obj = JSON.parse(await f.text());
    if (!obj || typeof obj !== 'object') throw new Error('invalid');

    await importPlaylistPayload(obj, ' (import)');
  } catch (err) {
    alert('インポートに失敗しました');
  }

  importFile.value = '';
});

sharePlaylistBtn?.addEventListener('click', async () => {
  if (!currentPlaylist) {
    alert('共有するプレイリストを選択してください');
    return;
  }
  await openShareModal();
});

closeShareBtn?.addEventListener('click', closeShareModal);

shareModal?.addEventListener('click', (event) => {
  if (event.target === shareModal) closeShareModal();
});

downloadSharePackageBtn?.addEventListener('click', async () => {
  try {
    setShareStatus('共有ファイルを作成しています。動画の容量によっては時間がかかります。');
    downloadSharePackageBtn.disabled = true;
    await assertEmbeddedExportIsSafe();
    const playlist = await buildPlaylistExport(true);
    const sharePackage = {
      format: 'playpocket-share',
      version: 1,
      mediaIncluded: true,
      ...playlist
    };
    const packageBlob = new Blob([JSON.stringify(sharePackage)], { type: 'application/json' });
    if (packageBlob.size > MAX_SHARED_PACKAGE_BYTES) throw new Error('share-package-too-large');
    downloadBlob(packageBlob, `${sanitizeFilename(playlist.name)}${SHARE_PACKAGE_EXTENSION}`);
    setShareStatus('共有ファイルを端末に保存しました。ファイルアプリなどから他のアプリに送信してください。', 'success');
  } catch (error) {
    console.error(error);
    let message = '共有ファイルを作成できませんでした。動画の容量を確認して、もう一度試してください。';
    if (error?.message === 'share-package-too-large') {
      message = '共有ファイルは 500MB までです。動画を減らして、もう一度試してください。';
    } else if (error?.message === 'embedded-export-too-large-for-device') {
      message = 'この端末では動画の合計サイズが大きすぎて共有ファイルを作成できません。動画を減らすか、軽量共有コードをお使いください。';
    }
    setShareStatus(message, 'error');
  } finally {
    downloadSharePackageBtn.disabled = false;
  }
});

copyShareCodeBtn?.addEventListener('click', async () => {
  try {
    const playlist = await buildPlaylistExport(false);
    const codePlaylist = {
      name: playlist.name,
      items: playlist.items.map(({ name, duration, mimeType, size }) => ({ name, duration, mimeType, size }))
    };
    const code = window.PlayPocketShare.createCode({
      version: 1,
      kind: 'playlist-metadata',
      playlist: codePlaylist
    });
    await window.PlayPocketShare.copyText(code);
    setShareStatus('共有コードをコピーしました。動画データは含まれません。', 'success');
  } catch (error) {
    console.error(error);
    setShareStatus('共有コードをコピーできませんでした。プレイリストを短くして、もう一度試してください。', 'error');
  }
});

importShareCodeBtn?.addEventListener('click', async () => {
  try {
    const decoded = window.PlayPocketShare.parseCode(shareCodeInput?.value || '');
    if (decoded?.version !== 1 || decoded?.kind !== 'playlist-metadata') throw new Error('invalid-share-code');
    const imported = await importPlaylistPayload(decoded.playlist, ' (shared)');
    if (shareCodeInput) shareCodeInput.value = '';
    setShareStatus(`「${imported.name}」を読み込みました。動画データは含まれません。`, 'success');
  } catch (error) {
    console.error(error);
    setShareStatus('共有コードを読み込めませんでした。コード全体を貼り付けてください。', 'error');
  }
});

videoPlayer.addEventListener('loadedmetadata', () => {
  if (pendingResumeTime > 0 && Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    try {
      videoPlayer.currentTime = Math.min(pendingResumeTime, Math.max(0, videoPlayer.duration - 0.25));
    } catch {}
  }
  updateSeekUI();
  setPlayerUIState();
});

let _lastSessionSaveFromTimeupdate = 0;
videoPlayer.addEventListener('timeupdate', () => {
  updateSeekUI();
  const now = Date.now();
  if (now - _lastSessionSaveFromTimeupdate > 5000) {
    _lastSessionSaveFromTimeupdate = now;
    scheduleSessionSave();
  }
});

videoPlayer.addEventListener('durationchange', updateSeekUI);

videoPlayer.addEventListener('ended', async () => {
  const pl = await getCurrentPlaylist();
  if (!pl || pl.items.length === 0) return;
  if (playMode === 'random') { await playCurrent({ autoplay: true }); return; }
  currentIndex = (currentIndex + 1) % pl.items.length;
  await playCurrent({ autoplay: true });
  scheduleSessionSave();
});

videoPlayer.addEventListener('play', async () => {
  const pl = await getCurrentPlaylist();
  if (!pl || pl.items.length === 0) return;
  const id = currentPlayingId || pl.items[currentIndex];
  const meta = id ? await idbGet(STORE_VIDEOS, id) : null;
  if (meta && !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    videoPlayer.pause();
  }
  setPlayerUIState();
  updateSeekUI();
  sendRPC({
    title: displayTitle(meta?.name || '再生中'),
    playlist: currentPlaylist,
    startTimestamp: Date.now() - Math.floor((videoPlayer.currentTime || 0) * 1000),
    endTimestamp: Date.now() + Math.floor(Math.max(0, (videoPlayer.duration || 0) - (videoPlayer.currentTime || 0)) * 1000),
    paused: false
  });
  scheduleSessionSave();
});

videoPlayer.addEventListener('pause', () => {
  sendRPC({ paused: true });
  setPlayerUIState();
  updateSeekUI();
  scheduleSessionSave();
});

videoPlayer.addEventListener('volumechange', () => {
  const v = Math.min(1, Math.max(0, videoPlayer.volume || 0));
  localStorage.setItem('playerVolume', String(v));
  scheduleSessionSave();
});

openSettingsBtn?.addEventListener('click', openSettings);
closeSettingsBtn?.addEventListener('click', closeSettings);

settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

officialSiteLink?.addEventListener('click', async (e) => {
  e.preventDefault();
  await openExternal('https://playpocket.f5.si');
});

audioPresetSelect?.addEventListener('change', async () => {
  await saveAppSettings({ audioPreset: audioPresetSelect.value });
});

resumePlaybackInput?.addEventListener('change', async () => {
  await saveAppSettings({ resumePlayback: resumePlaybackInput.checked });
});

rpcEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ rpcEnabled: rpcEnabledInput.checked });
  if (!rpcEnabledInput.checked) clearRPC();
});

startupLaunchInput?.addEventListener('change', async () => {
  await saveAppSettings({ startupLaunch: startupLaunchInput.checked });
});

minimizeOnCloseInput?.addEventListener('change', async () => {
  await saveAppSettings({ minimizeOnClose: minimizeOnCloseInput.checked });
});

cacheEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ cacheEnabled: cacheEnabledInput.checked });
  alert('キャッシュ設定を保存しました。反映は再起動後です。');
});

hardwareAccelerationInput?.addEventListener('change', async () => {
  await saveAppSettings({ hardwareAcceleration: hardwareAccelerationInput.checked });
  alert('ハードウェアアクセラレーションの変更は再起動後に反映されます。');
});

clearCacheBtn?.addEventListener('click', async () => {
  try {
    await clearWebCache();
    alert('キャッシュを削除しました。');
  } catch {
    alert('キャッシュ削除に失敗しました。');
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSessionStateNow();
});

window.addEventListener('pagehide', () => {
  saveSessionStateNow();
});

window.addEventListener('beforeunload', () => {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  cleanupCurrentObjectUrl();
  saveSessionStateNow();
});

if (menuToggle) menuToggle.addEventListener('click', toggleSidebar);
if (overlay) overlay.addEventListener('click', closeSidebar);

async function init() {
  await openDB();

  const defaultOrFirst = await ensureDefaultPlaylist();
  const pls = await loadAllPlaylists();
  currentPlaylist = pls.length ? (normalizePlaylistName(pls[0]?.name) || pls[0].name) : defaultOrFirst;

  await loadAppSettings();
  createVolumeControls();

  const restorePlan = await restorePlaybackState();

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  setPlayerUIState();
  updateSeekUI();

  if (restorePlan?.trackId) {
    currentPlayingId = restorePlan.trackId;
    await loadAndPlayById(restorePlan.trackId, {
      autoplay: restorePlan.autoplay,
      resumeTime: restorePlan.resumeTime
    });
    await refreshTrackList();
  }

  scheduleSessionSave();
}

init().catch(err => {
  console.error(err);
  alert('初期化に失敗しました');
});
