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
  hardwareAcceleration: true,
  autoAudioQuality: true,
  compactUI: false,
  notificationControlsEnabled: true,
  videoDisplayEnabled: true,
  crossfadeEnabled: false,
  crossfadeDuration: 3,
  gaplessEnabled: true,
  seamlessPlayback: true,
  volumeNormalization: false,
  monoAudio: false
};

const NORMALIZATION_TARGET_RMS = 0.12;
const NORMALIZATION_MAX_ANALYZE_BYTES = 150 * 1024 * 1024;
const ENGINE_PREBUFFER_LEAD_SECONDS = 2.4;

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
let activeLoadSequence = 0;
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
const videoPlayerB = document.getElementById('videoPlayerB');
const videoStage = document.getElementById('videoStage');
const audioOnlyCard = document.getElementById('audioOnlyCard');
const audioOnlyThumb = document.getElementById('audioOnlyThumb');
const audioOnlyTitle = document.getElementById('audioOnlyTitle');
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

const autoAudioQualityInput = document.getElementById('autoAudioQuality');
const compactUIInput = document.getElementById('compactUI');
const notificationControlsEnabledInput = document.getElementById('notificationControlsEnabled');
const videoDisplayEnabledInput = document.getElementById('videoDisplayEnabled');
const crossfadeEnabledInput = document.getElementById('crossfadeEnabled');
const crossfadeDurationInput = document.getElementById('crossfadeDuration');
const crossfadeDurationValueEl = document.getElementById('crossfadeDurationValue');
const crossfadeDurationRow = document.getElementById('crossfadeDurationRow');
const gaplessEnabledInput = document.getElementById('gaplessEnabled');
const seamlessPlaybackInput = document.getElementById('seamlessPlayback');
const volumeNormalizationInput = document.getElementById('volumeNormalization');
const monoAudioInput = document.getElementById('monoAudio');

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
      hardwareAcceleration: typeof parsed?.hardwareAcceleration === 'boolean' ? parsed.hardwareAcceleration : DEFAULT_APP_SETTINGS.hardwareAcceleration,
      autoAudioQuality: typeof parsed?.autoAudioQuality === 'boolean' ? parsed.autoAudioQuality : DEFAULT_APP_SETTINGS.autoAudioQuality,
      compactUI: typeof parsed?.compactUI === 'boolean' ? parsed.compactUI : DEFAULT_APP_SETTINGS.compactUI,
      notificationControlsEnabled: typeof parsed?.notificationControlsEnabled === 'boolean' ? parsed.notificationControlsEnabled : DEFAULT_APP_SETTINGS.notificationControlsEnabled,
      videoDisplayEnabled: typeof parsed?.videoDisplayEnabled === 'boolean' ? parsed.videoDisplayEnabled : DEFAULT_APP_SETTINGS.videoDisplayEnabled,
      crossfadeEnabled: typeof parsed?.crossfadeEnabled === 'boolean' ? parsed.crossfadeEnabled : DEFAULT_APP_SETTINGS.crossfadeEnabled,
      crossfadeDuration: Number.isFinite(Number(parsed?.crossfadeDuration)) ? Math.min(10, Math.max(1, Number(parsed.crossfadeDuration))) : DEFAULT_APP_SETTINGS.crossfadeDuration,
      gaplessEnabled: typeof parsed?.gaplessEnabled === 'boolean' ? parsed.gaplessEnabled : DEFAULT_APP_SETTINGS.gaplessEnabled,
      seamlessPlayback: typeof parsed?.seamlessPlayback === 'boolean' ? parsed.seamlessPlayback : DEFAULT_APP_SETTINGS.seamlessPlayback,
      volumeNormalization: typeof parsed?.volumeNormalization === 'boolean' ? parsed.volumeNormalization : DEFAULT_APP_SETTINGS.volumeNormalization,
      monoAudio: typeof parsed?.monoAudio === 'boolean' ? parsed.monoAudio : DEFAULT_APP_SETTINGS.monoAudio
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

  if (autoAudioQualityInput) autoAudioQualityInput.checked = !!appSettings.autoAudioQuality;
  if (compactUIInput) compactUIInput.checked = !!appSettings.compactUI;
  if (notificationControlsEnabledInput) notificationControlsEnabledInput.checked = !!appSettings.notificationControlsEnabled;
  if (videoDisplayEnabledInput) videoDisplayEnabledInput.checked = !!appSettings.videoDisplayEnabled;
  if (crossfadeEnabledInput) crossfadeEnabledInput.checked = !!appSettings.crossfadeEnabled;
  if (gaplessEnabledInput) gaplessEnabledInput.checked = !!appSettings.gaplessEnabled;
  if (seamlessPlaybackInput) seamlessPlaybackInput.checked = !!appSettings.seamlessPlayback;
  if (volumeNormalizationInput) volumeNormalizationInput.checked = !!appSettings.volumeNormalization;
  if (monoAudioInput) monoAudioInput.checked = !!appSettings.monoAudio;

  const fadeDur = clampCrossfadeDuration(appSettings.crossfadeDuration);
  if (crossfadeDurationInput) crossfadeDurationInput.value = String(fadeDur);
  if (crossfadeDurationValueEl) crossfadeDurationValueEl.textContent = String(fadeDur);
  if (crossfadeDurationRow) crossfadeDurationRow.classList.toggle('disabled', !appSettings.crossfadeEnabled);

  applyCompactUISetting();
  applyVideoDisplaySetting();
  applyMonoSetting();
}

function clampCrossfadeDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function applyCompactUISetting() {
  const root = document.getElementById('app');
  if (root) root.classList.toggle('compact-ui', !!appSettings.compactUI);
}

function applyVideoDisplaySetting() {
  if (videoStage) videoStage.classList.toggle('video-hidden', !appSettings.videoDisplayEnabled);
}

function updateSettingsAvailability() {
  const desktopOnly = isAndroid || !isElectron;
  if (rpcEnabledInput) rpcEnabledInput.disabled = desktopOnly;
  if (startupLaunchInput) startupLaunchInput.disabled = desktopOnly;
  if (minimizeOnCloseInput) minimizeOnCloseInput.disabled = desktopOnly;
  if (hardwareAccelerationInput) hardwareAccelerationInput.disabled = isAndroid;

  const notificationControlsRow = notificationControlsEnabledInput?.closest('.settings-row');
  if (notificationControlsEnabledInput) notificationControlsEnabledInput.disabled = !isAndroid;
  if (notificationControlsRow) notificationControlsRow.style.display = isAndroid ? '' : 'none';
}

let autoQualityDowngrade = false;
let connectionMonitorAttached = false;

function applyAudioPreset() {
  if (!videoPlayer) return;
  const preset = (appSettings.autoAudioQuality && autoQualityDowngrade)
    ? 'low'
    : (appSettings.audioPreset || 'standard');

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

function getNetworkConnection() {
  return navigator.connection || navigator.webkitConnection || navigator.mozConnection || null;
}

function evaluateAutoAudioQuality() {
  if (!appSettings.autoAudioQuality) {
    autoQualityDowngrade = false;
    applyAudioPreset();
    return;
  }

  const conn = getNetworkConnection();
  if (!conn) {
    autoQualityDowngrade = false;
    applyAudioPreset();
    return;
  }

  const slowTypes = ['slow-2g', '2g', '3g'];
  const downlink = Number(conn.downlink);
  autoQualityDowngrade = !!conn.saveData ||
    slowTypes.includes(conn.effectiveType) ||
    (Number.isFinite(downlink) && downlink > 0 && downlink < 1.5);

  applyAudioPreset();
}

function attachConnectionMonitor() {
  if (connectionMonitorAttached) return;
  const conn = getNetworkConnection();
  if (!conn || typeof conn.addEventListener !== 'function') return;
  conn.addEventListener('change', evaluateAutoAudioQuality);
  connectionMonitorAttached = true;
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

  ensureAudioGraph();
  syncSettingsUI();
  updateSettingsAvailability();
  attachConnectionMonitor();
  evaluateAutoAudioQuality();

  if (isAndroid) {
    runtimeAPI?.setNotificationControlsEnabled?.(!!appSettings.notificationControlsEnabled);
  }
}

async function saveAppSettings(partial) {
  appSettings = { ...appSettings, ...partial };
  saveLocalSettings();
  syncSettingsUI();
  attachConnectionMonitor();
  evaluateAutoAudioQuality();

  if (isAndroid && Object.prototype.hasOwnProperty.call(partial, 'notificationControlsEnabled')) {
    runtimeAPI?.setNotificationControlsEnabled?.(!!appSettings.notificationControlsEnabled);
  }

  if (Object.prototype.hasOwnProperty.call(partial, 'volumeNormalization')) {
    await reapplyNormalizationForCurrentTrack();
  }

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

window.__ppHandlePlaybackCommand = function (command) {
  try {
    if (command === 'previous-track') prevBtn?.click();
    else if (command === 'next-track') nextBtn?.click();
    else if (command === 'toggle-play-pause') playPauseBtn?.click();
  } catch (e) {}
};

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

let lastKnownTrackTitle = '';

function setPlayerUIState() {
  const paused = videoPlayer.paused || videoPlayer.ended;
  videoStage?.classList.toggle('paused', paused);
  if (centerPlayBtn) centerPlayBtn.textContent = paused ? '▶' : 'Ⅱ';
  if (playPauseBtn) playPauseBtn.textContent = paused ? '▶' : 'Ⅱ';
  if (isAndroid) {
    runtimeAPI?.updatePlaybackState?.(!paused, lastKnownTrackTitle);
  }
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

function attachUserGestureResume() {
  if (attachUserGestureResume.done) return;
  attachUserGestureResume.done = true;
  const resume = () => {
    if (engineAudioCtx && engineAudioCtx.state === 'suspended') {
      engineAudioCtx.resume().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
}

function buildDeckGraph(el) {
  const source = engineAudioCtx.createMediaElementSource(el);
  const fadeGain = engineAudioCtx.createGain();
  const normGain = engineAudioCtx.createGain();
  const splitter = engineAudioCtx.createChannelSplitter(2);
  const merger = engineAudioCtx.createChannelMerger(2);
  const LL = engineAudioCtx.createGain();
  const LR = engineAudioCtx.createGain();
  const RL = engineAudioCtx.createGain();
  const RR = engineAudioCtx.createGain();

  LL.gain.value = 1;
  RR.gain.value = 1;
  LR.gain.value = 0;
  RL.gain.value = 0;

  source.connect(fadeGain);
  fadeGain.connect(normGain);
  normGain.connect(splitter);
  splitter.connect(LL, 0);
  splitter.connect(LR, 0);
  splitter.connect(RL, 1);
  splitter.connect(RR, 1);
  LL.connect(merger, 0, 0);
  RL.connect(merger, 0, 0);
  LR.connect(merger, 0, 1);
  RR.connect(merger, 0, 1);
  merger.connect(engineAudioCtx.destination);

  return { el, fadeGain, normGain, splitterGains: { LL, LR, RL, RR } };
}

let engineAudioCtx = null;
let deckAGraph = null;
let deckBGraph = null;

function ensureAudioGraph() {
  if (engineAudioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    engineAudioCtx = new Ctx();
    deckAGraph = buildDeckGraph(videoPlayer);
    deckBGraph = buildDeckGraph(videoPlayerB);
    attachUserGestureResume();
  } catch (e) {
    console.warn('オーディオグラフの初期化に失敗しました:', e);
    engineAudioCtx = null;
  }
}

function setDeckMono(deckGraph, enabled) {
  if (!engineAudioCtx || !deckGraph) return;
  const t = engineAudioCtx.currentTime;
  const { LL, LR, RL, RR } = deckGraph.splitterGains;
  const cross = enabled ? 0.5 : 0;
  const through = enabled ? 0.5 : 1;
  LL.gain.setTargetAtTime(through, t, 0.05);
  RR.gain.setTargetAtTime(through, t, 0.05);
  LR.gain.setTargetAtTime(cross, t, 0.05);
  RL.gain.setTargetAtTime(cross, t, 0.05);
}

function applyMonoSetting() {
  if (!engineAudioCtx) return;
  setDeckMono(deckAGraph, !!appSettings.monoAudio);
  setDeckMono(deckBGraph, !!appSettings.monoAudio);
}
function computeRMS(audioBuffer) {
  let sumSquares = 0;
  let count = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    const step = Math.max(1, Math.floor(data.length / 200000));
    for (let i = 0; i < data.length; i += step) {
      const v = data[i];
      sumSquares += v * v;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

async function analyzeAndCacheLoudness(meta) {
  if (!meta || !meta.blob) return 1;
  if (Number.isFinite(meta.normGain)) return meta.normGain;
  if (meta.blob.size > NORMALIZATION_MAX_ANALYZE_BYTES) {
    meta.normGain = 1;
    return 1;
  }

  try {
    const arrayBuffer = await meta.blob.arrayBuffer();
    const ctx = engineAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const rms = computeRMS(audioBuffer);
    const gain = rms > 0.0001 ? Math.min(3, Math.max(0.35, NORMALIZATION_TARGET_RMS / rms)) : 1;
    meta.normGain = gain;
    await idbPut(STORE_VIDEOS, meta);
    return gain;
  } catch (e) {
    meta.normGain = 1;
    return 1;
  }
}

function applyNormalizationForDeck(deckGraph, meta) {
  if (!engineAudioCtx || !deckGraph) return;
  const gainVal = (appSettings.volumeNormalization && meta && Number.isFinite(meta.normGain)) ? meta.normGain : 1;
  deckGraph.normGain.gain.setTargetAtTime(gainVal, engineAudioCtx.currentTime, 0.08);
}

async function reapplyNormalizationForCurrentTrack() {
  if (!engineAudioCtx || !currentPlayingId) return;
  const meta = videoListCache[currentPlayingId] || await idbGet(STORE_VIDEOS, currentPlayingId);
  if (!meta) return;
  applyNormalizationForDeck(deckAGraph, meta);
}

function maybeAnalyzeCurrentTrack(meta) {
  if (!meta) return;
  applyNormalizationForDeck(deckAGraph, meta);
  if (!appSettings.volumeNormalization || Number.isFinite(meta.normGain)) return;

  analyzeAndCacheLoudness(meta).then((gain) => {
    if (currentPlayingId === meta.id) applyNormalizationForDeck(deckAGraph, { normGain: gain });
  }).catch(() => {});
}

function updateAudioOnlyCard(meta) {
  if (audioOnlyThumb) audioOnlyThumb.src = safeThumbnailSrc(meta?.thumbnail) || '';
  if (audioOnlyTitle) audioOnlyTitle.textContent = displayTitle(meta?.name);
}

function getPlaylistLength(pl) {
  return pl && Array.isArray(pl.items) ? pl.items.length : 0;
}
let engineStandbyId = null;
let engineStandbyReady = false;
let enginePrebufferPromise = null;
let engineTransitioning = false;

function transitionsEnabled() {
  return !!(appSettings.crossfadeEnabled || appSettings.gaplessEnabled || appSettings.seamlessPlayback);
}

function peekNextTrackId(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (playMode === 'random') return null;
  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== items.length || !shuffleOrder.every((x) => items.includes(x))) return null;
    return shuffleOrder[(currentIndex + 1) % shuffleOrder.length] || null;
  }
  return items[(currentIndex + 1) % items.length] || null;
}

function resetEngineStandbyState() {
  engineStandbyId = null;
  engineStandbyReady = false;
  enginePrebufferPromise = null;
  if (deckBGraph && engineAudioCtx) {
    deckBGraph.fadeGain.gain.cancelScheduledValues(engineAudioCtx.currentTime);
    deckBGraph.fadeGain.gain.setValueAtTime(0, engineAudioCtx.currentTime);
  }
}

async function prebufferNextForEngine() {
  if (!engineAudioCtx || engineTransitioning) return;
  const startSequence = activeLoadSequence;
  const pl = await getCurrentPlaylist();
  const nextId = peekNextTrackId(pl && Array.isArray(pl.items) ? pl.items : []);
  if (!nextId) return;

  const meta = videoListCache[nextId] || await idbGet(STORE_VIDEOS, nextId);
  if (!meta || !meta.blob) return;
  if (activeLoadSequence !== startSequence) return;

  try {
    const url = URL.createObjectURL(meta.blob);
    videoPlayerB.src = url;
    videoPlayerB.load();
    await waitForVideoReady(videoPlayerB, 4000);
    if (activeLoadSequence !== startSequence) {
      try { videoPlayerB.pause(); videoPlayerB.removeAttribute('src'); videoPlayerB.load(); } catch (e) {}
      return;
    }
    videoPlayerB.currentTime = 0;
    engineStandbyId = nextId;
    engineStandbyReady = true;
    if (appSettings.volumeNormalization) {
      const analyzed = Number.isFinite(meta.normGain) ? meta.normGain : await analyzeAndCacheLoudness(meta);
      applyNormalizationForDeck(deckBGraph, { normGain: analyzed });
    } else {
      applyNormalizationForDeck(deckBGraph, null);
    }
  } catch (e) {
    engineStandbyId = null;
    engineStandbyReady = false;
  }
}

async function advanceIndexForEngine() {
  const pl = await getCurrentPlaylist();
  const len = getPlaylistLength(pl);
  if (len === 0) return false;
  if (playMode === 'shuffle' && shuffleOrder.length === len) {
    currentIndex = (currentIndex + 1) % shuffleOrder.length;
  } else {
    currentIndex = (currentIndex + 1) % len;
  }
  return true;
}
async function startCrossfade(fadeDur) {
  if (!engineStandbyReady || engineTransitioning || !engineAudioCtx) return;
  engineTransitioning = true;
  const startSequence = activeLoadSequence;

  try {
    videoPlayerB.currentTime = 0;
    await videoPlayerB.play();

    const t = engineAudioCtx.currentTime;
    deckAGraph.fadeGain.gain.cancelScheduledValues(t);
    deckAGraph.fadeGain.gain.setValueAtTime(deckAGraph.fadeGain.gain.value, t);
    deckAGraph.fadeGain.gain.linearRampToValueAtTime(0, t + fadeDur);
    deckBGraph.fadeGain.gain.cancelScheduledValues(t);
    deckBGraph.fadeGain.gain.setValueAtTime(0, t);
    deckBGraph.fadeGain.gain.linearRampToValueAtTime(1, t + fadeDur);
  } catch (e) {}

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, fadeDur * 1000)));

  const standbyPos = videoPlayerB.currentTime;
  resetEngineStandbyState();

  const advanced = (activeLoadSequence === startSequence) && await advanceIndexForEngine();
  if (advanced) {
    const pl = await getCurrentPlaylist();
    const len = getPlaylistLength(pl);
    const id = (playMode === 'shuffle' && shuffleOrder.length === len)
      ? shuffleOrder[currentIndex % shuffleOrder.length]
      : pl.items[currentIndex];

    if (id) {
      await loadAndPlayById(id, { autoplay: true, resumeTime: standbyPos });
      const drift = videoPlayerB.currentTime - videoPlayer.currentTime;
      if (Math.abs(drift) > 0.15 && videoPlayerB.currentTime > 0) {
        try { videoPlayer.currentTime = videoPlayerB.currentTime; } catch (e) {}
      }
      await refreshTrackList();
    }
  }

  try {
    videoPlayerB.pause();
    videoPlayerB.removeAttribute('src');
    videoPlayerB.load();
  } catch (e) {}

  if (deckAGraph) deckAGraph.fadeGain.gain.setTargetAtTime(1, engineAudioCtx.currentTime, 0.05);
  if (deckBGraph) deckBGraph.fadeGain.gain.setTargetAtTime(0, engineAudioCtx.currentTime, 0.05);

  scheduleSessionSave();
  engineTransitioning = false;
}

async function performGaplessHandoff() {
  if (engineTransitioning) return;
  engineTransitioning = true;
  const startSequence = activeLoadSequence;

  try {
    if (deckBGraph && engineAudioCtx) {
      deckBGraph.fadeGain.gain.setValueAtTime(1, engineAudioCtx.currentTime);
    }
    videoPlayerB.currentTime = 0;
    await videoPlayerB.play();
  } catch (e) {}

  resetEngineStandbyState();

  const advanced = (activeLoadSequence === startSequence) && await advanceIndexForEngine();
  if (advanced) {
    await playCurrent();
  }

  try {
    videoPlayerB.pause();
    videoPlayerB.removeAttribute('src');
    videoPlayerB.load();
  } catch (e) {}

  if (deckBGraph && engineAudioCtx) {
    deckBGraph.fadeGain.gain.setValueAtTime(0, engineAudioCtx.currentTime);
  }

  scheduleSessionSave();
  engineTransitioning = false;
}

function handleEngineTimeUpdate() {
  if (!engineAudioCtx || !transitionsEnabled() || engineTransitioning) return;
  if (playMode === 'random') return;

  const duration = videoPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const remaining = duration - videoPlayer.currentTime;

  const crossfade = !!appSettings.crossfadeEnabled;
  const fadeDur = crossfade ? clampCrossfadeDuration(appSettings.crossfadeDuration) : 0;
  const leadTime = Math.max(fadeDur, ENGINE_PREBUFFER_LEAD_SECONDS);

  if (remaining <= leadTime && !enginePrebufferPromise && !engineStandbyReady) {
    enginePrebufferPromise = prebufferNextForEngine().finally(() => {
      enginePrebufferPromise = null;
    });
  }

  if (crossfade && engineStandbyReady && remaining <= fadeDur) {
    startCrossfade(fadeDur);
  }
}
async function loadAndPlayById(id, options = {}) {
  const autoplay = options.autoplay !== false;
  const resumeTime = Number.isFinite(options.resumeTime) ? Math.max(0, options.resumeTime) : 0;
  const updateState = options.updateState !== false;

  const loadId = ++activeLoadSequence;
  const meta = await idbGet(STORE_VIDEOS, id);
  if (loadId !== activeLoadSequence) return false;
  if (!meta || !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    return false;
  }

  cleanupCurrentObjectUrl();

  if (engineStandbyId !== id) {
    resetEngineStandbyState();
  }

  currentPlayingId = id;
  currentObjectUrl = URL.createObjectURL(meta.blob);
  videoPlayer.src = currentObjectUrl;
  videoPlayer.load();
  videoPlayer.playbackRate = parseFloat(speedSelect?.value || '1') || 1;
  applyAudioPreset();
  updateAudioOnlyCard(meta);
  maybeAnalyzeCurrentTrack(meta);
  lastKnownTrackTitle = displayTitle(meta.name);

  const vol = parseFloat(localStorage.getItem('playerVolume') || '1');
  videoPlayer.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;

  await waitForVideoReady(videoPlayer);
  if (loadId !== activeLoadSequence) return false;

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

  if (loadId !== activeLoadSequence) return false;

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
  handleEngineTimeUpdate();
  const now = Date.now();
  if (now - _lastSessionSaveFromTimeupdate > 5000) {
    _lastSessionSaveFromTimeupdate = now;
    scheduleSessionSave();
  }
});

videoPlayer.addEventListener('durationchange', updateSeekUI);

videoPlayer.addEventListener('ended', async () => {
  if (engineTransitioning) return;

  if (transitionsEnabled() && !appSettings.crossfadeEnabled && engineStandbyReady && playMode !== 'random') {
    await performGaplessHandoff();
    return;
  }

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

autoAudioQualityInput?.addEventListener('change', async () => {
  await saveAppSettings({ autoAudioQuality: autoAudioQualityInput.checked });
});

compactUIInput?.addEventListener('change', async () => {
  await saveAppSettings({ compactUI: compactUIInput.checked });
});

notificationControlsEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ notificationControlsEnabled: notificationControlsEnabledInput.checked });
});

videoDisplayEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ videoDisplayEnabled: videoDisplayEnabledInput.checked });
});

crossfadeEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ crossfadeEnabled: crossfadeEnabledInput.checked });
});

crossfadeDurationInput?.addEventListener('input', () => {
  if (crossfadeDurationValueEl) crossfadeDurationValueEl.textContent = crossfadeDurationInput.value;
});

crossfadeDurationInput?.addEventListener('change', async () => {
  await saveAppSettings({ crossfadeDuration: clampCrossfadeDuration(crossfadeDurationInput.value) });
});

gaplessEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ gaplessEnabled: gaplessEnabledInput.checked });
});

seamlessPlaybackInput?.addEventListener('change', async () => {
  await saveAppSettings({ seamlessPlayback: seamlessPlaybackInput.checked });
});

volumeNormalizationInput?.addEventListener('change', async () => {
  await saveAppSettings({ volumeNormalization: volumeNormalizationInput.checked });
});

monoAudioInput?.addEventListener('change', async () => {
  await saveAppSettings({ monoAudio: monoAudioInput.checked });
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
