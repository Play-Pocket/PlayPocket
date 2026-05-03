const DB_NAME = 'offline-playlist-db';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_PLAYLISTS = 'playlists';

const MAX_PLAYLIST_NAME_LENGTH  = 80;
const MAX_IMPORTED_ITEMS        = 500;
const MAX_IMPORTED_JSON_BYTES   = 50 * 1024 * 1024;
const MAX_VIDEO_FILES_PER_DROP  = 100;
const MAX_THUMBNAIL_LENGTH      = 2_000_000;

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

let db;
let currentPlaylist  = null;
let currentIndex     = 0;
let playMode         = 'order';
let shuffleOrder     = [];
let videoListCache   = Object.create(null);
let currentObjectUrl = null;

const fileInput          = document.getElementById('fileInput');
const dropZone           = document.getElementById('dropZone');
const playlistsEl        = document.getElementById('playlists');
const newPlaylistName    = document.getElementById('newPlaylistName');
const createPlaylistBtn  = document.getElementById('createPlaylistBtn');
const trackListEl        = document.getElementById('trackList');
const videoPlayer        = document.getElementById('videoPlayer');
const videoStage         = document.getElementById('videoStage');
const centerPlayBtn      = document.getElementById('centerPlayBtn');
const seekBar            = document.getElementById('seekBar');
const currentTimeEl      = document.getElementById('currentTime');
const durationTimeEl     = document.getElementById('durationTime');
const playPauseBtn       = document.getElementById('playPauseBtn');
const prevBtn            = document.getElementById('prevBtn');
const nextBtn            = document.getElementById('nextBtn');
const orderBtn           = document.getElementById('orderBtn');
const shuffleBtn         = document.getElementById('shuffleBtn');
const randomBtn          = document.getElementById('randomBtn');
const speedSelect        = document.getElementById('speedSelect');
const fullscreenBtn      = document.getElementById('fullscreenBtn');
const totalDurationEl    = document.getElementById('totalDuration');
const exportMetaBtn      = document.getElementById('exportMetaBtn');
const exportWithBlobsBtn = document.getElementById('exportWithBlobsBtn');
const importFile         = document.getElementById('importFile');
const menuToggle         = document.getElementById('menuToggle');
const sidebar            = document.querySelector('.sidebar');
const overlay            = document.getElementById('overlay');

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
  if (typeof src !== 'string' || src.length === 0)  return null;
  if (src.length > MAX_THUMBNAIL_LENGTH)             return null;
  for (const prefix of ALLOWED_THUMB_PREFIXES) {
    if (src.startsWith(prefix)) return src;
  }
  return null;
}

function sanitizeMimeType(type) {
  if (typeof type === 'string' && ALLOWED_VIDEO_TYPES.has(type)) return type;
  return 'video/mp4';
}

async function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_VIDEOS))
        idb.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      if (!idb.objectStoreNames.contains(STORE_PLAYLISTS))
        idb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'name' });
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = () => rej(req.error || new Error('IndexedDB open failed'));
  });
}

function idbPut(store, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r  = tx.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error || new Error('idbPut failed'));
  });
}

function idbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error || new Error('idbGet failed'));
  });
}

function idbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error || new Error('idbGetAll failed'));
  });
}

function idbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r  = tx.objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error || new Error('idbDelete failed'));
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
  if (await idbGet(STORE_PLAYLISTS, safeNew)) throw new Error('exists');
  const pl = await idbGet(STORE_PLAYLISTS, safeOld);
  if (!pl || !Array.isArray(pl.items)) throw new Error('notfound');
  await idbPut(STORE_PLAYLISTS, { name: safeNew, items: pl.items.slice() });
  await idbDelete(STORE_PLAYLISTS, safeOld);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function downloadBlob(blob, filename) {
  const a   = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma  = result.indexOf(',');
      res(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => rej(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  if (typeof base64 !== 'string' || !base64) throw new Error('invalid base64');
  let bin;
  try { bin = atob(base64); } catch { throw new Error('invalid base64'); }
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: sanitizeMimeType(type) });
}

function isSupportedVideoFile(file) {
  if (!(file instanceof File)) return false;
  if (typeof file.type === 'string' && file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|m4v|ogg|mkv)$/i.test(file.name || '');
}

function getVideoDuration(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v   = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch {} };
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      cleanup(); res(d);
    };
    v.onerror = () => { cleanup(); res(0); };
  });
}

async function generateThumbnail(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v   = document.createElement('video');
    v.preload = 'metadata'; v.src = url; v.muted = true; v.playsInline = true;
    let settled = false;
    const finish = (val) => {
      if (settled) return; settled = true;
      try { URL.revokeObjectURL(url); } catch {}
      res(val);
    };
    v.addEventListener('loadeddata', () => {
      try { v.currentTime = 0.1; } catch { finish(null); }
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 180;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, 320, 180);
        finish(c.toDataURL('image/jpeg', 0.7));
      } catch { finish(null); }
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
  if (playPauseBtn)  playPauseBtn.textContent  = paused ? '▶' : 'Ⅱ';
}

function updateSeekUI() {
  const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  const cur = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
  if (durationTimeEl) durationTimeEl.textContent = formatTime(dur);
  if (currentTimeEl)  currentTimeEl.textContent  = formatTime(cur);
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
}

function openSidebar()   { sidebar?.classList.add('open');    overlay?.classList.add('active'); }
function closeSidebar()  { sidebar?.classList.remove('open'); overlay?.classList.remove('active'); }
function toggleSidebar() { sidebar?.classList.toggle('open'); overlay?.classList.toggle('active'); }

async function addFiles(files) {
  const accepted = Array.from(files).filter(isSupportedVideoFile).slice(0, MAX_VIDEO_FILES_PER_DROP);
  if (accepted.length === 0) return;

  for (const f of accepted) {
    const id       = uid();
    const duration = await getVideoDuration(f);
    const thumb    = await generateThumbnail(f);
    const blob     = f.slice(0, f.size, f.type || 'video/mp4');
    const meta = {
      id,
      name:      safeText(f.name) || 'video',
      duration:  clampNumber(duration, 0),
      mimeType:  sanitizeMimeType(f.type),
      blob,
      thumbnail: thumb,
      size:      f.size
    };

    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;

    if (currentPlaylist) {
      const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
      if (pl && Array.isArray(pl.items)) { pl.items.push(id); await idbPut(STORE_PLAYLISTS, pl); }
    } else {
      const defaultName = await ensureDefaultPlaylist();
      let pl = await idbGet(STORE_PLAYLISTS, defaultName);
      if (!pl) { pl = { name: defaultName, items: [] }; await idbPut(STORE_PLAYLISTS, pl); }
      pl.items.push(id); await idbPut(STORE_PLAYLISTS, pl);
      currentPlaylist = defaultName; currentIndex = 0;
    }
  }

  await refreshPlaylistsUI(); await refreshTrackList(); await updateTotalDuration();
}

function getCurrentPlaylist() {
  if (!currentPlaylist) return Promise.resolve(null);
  return idbGet(STORE_PLAYLISTS, currentPlaylist).then(pl =>
    (!pl || !Array.isArray(pl.items)) ? null : pl
  );
}

function renderTrackItem(meta, index, isPlaying) {
  const li = document.createElement('li');
  li.className = 'track-item'; li.dataset.index = String(index);
  li.dataset.id = meta.id; li.draggable = true;
  if (isPlaying) li.classList.add('playing');

  const img = document.createElement('img');
  img.className = 'thumb'; img.alt = 'サムネイル'; img.referrerPolicy = 'no-referrer';
  img.src = safeThumbnailSrc(meta.thumbnail) ?? '';

  const metaWrap = document.createElement('div'); metaWrap.className = 'meta';
  const title    = document.createElement('div'); title.className = 'title';
  title.textContent = safeText(meta.name) || 'video';
  const sub = document.createElement('div'); sub.className = 'sub';
  const sizeMB = Number.isFinite(meta.size) ? Math.round(meta.size / 1024 / 1024) : 0;
  sub.textContent = `${formatTime(meta.duration)} • ${sizeMB} MB`;
  metaWrap.appendChild(title); metaWrap.appendChild(sub);

  const actions    = document.createElement('div'); actions.className = 'track-actions';
  const playNowBtn = document.createElement('button');
  playNowBtn.className = 'small-btn play-now'; playNowBtn.type = 'button'; playNowBtn.textContent = '再生';
  const removeBtn  = document.createElement('button');
  removeBtn.className = 'small-btn remove'; removeBtn.type = 'button'; removeBtn.textContent = '削除';
  actions.appendChild(playNowBtn); actions.appendChild(removeBtn);

  li.appendChild(img); li.appendChild(metaWrap); li.appendChild(actions);

  li.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(index)); li.classList.add('dragging'); });
  li.addEventListener('dragend',   () => li.classList.remove('dragging'));
  li.addEventListener('dragover',  e => { e.preventDefault(); li.classList.add('drag-over'); });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));

  li.addEventListener('drop', async (e) => {
    e.preventDefault(); li.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const toIndex   = index;
    if (!Number.isInteger(fromIndex) || fromIndex === toIndex) return;
    const pl = await getCurrentPlaylist(); if (!pl) return;
    const item = pl.items.splice(fromIndex, 1)[0];
    if (typeof item === 'undefined') return;
    pl.items.splice(toIndex, 0, item);
    await idbPut(STORE_PLAYLISTS, pl);
    if      (currentIndex === fromIndex)                          currentIndex = toIndex;
    else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
    else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
    await refreshTrackList();
  });

  playNowBtn.addEventListener('click', async () => {
    currentIndex = index; await playCurrent(); await refreshTrackList();
  });

  removeBtn.addEventListener('click', async () => {
    if (!currentPlaylist) return;
    const pl = await getCurrentPlaylist(); if (!pl) return;
    pl.items.splice(index, 1); await idbPut(STORE_PLAYLISTS, pl);
    if (currentIndex >= pl.items.length) currentIndex = Math.max(0, pl.items.length - 1);
    await refreshTrackList(); await updateTotalDuration(); updateSeekUI();
  });

  return li;
}

async function refreshPlaylistsUI() {
  playlistsEl.replaceChildren();
  const pls = await loadAllPlaylists();

  for (const p of pls) {
    const name = normalizePlaylistName(p?.name);
    if (!name) continue;

    const li = document.createElement('li'); li.className = 'playlist-item'; li.dataset.name = name;
    if (name === currentPlaylist) li.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'playlist-name'; nameSpan.textContent = name;
    nameSpan.title = 'クリックで選択 / ダブルクリックで名前変更';

    nameSpan.addEventListener('click', async () => {
      currentPlaylist = name; currentIndex = 0;
      await refreshPlaylistsUI(); await refreshTrackList();
      await updateTotalDuration(); updateSeekUI(); closeSidebar();
    });

    nameSpan.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const input = prompt('プレイリスト名を入力してください', name);
      if (input == null) return;
      const trimmed = normalizePlaylistName(input);
      if (!trimmed) { alert('無効な名前です'); return; }
      try {
        await idbRenamePlaylist(name, trimmed);
        if (currentPlaylist === name) currentPlaylist = trimmed;
        await refreshPlaylistsUI(); await refreshTrackList(); await updateTotalDuration();
      } catch (err) {
        alert(err?.message === 'exists' ? '同名のプレイリストが既に存在します' : '名前変更に失敗しました');
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn'; delBtn.type = 'button'; delBtn.textContent = '削除';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`プレイリスト「${name}」を削除しますか？`)) return;
      await idbDelete(STORE_PLAYLISTS, name);
      const plsAfter = await loadAllPlaylists();
      if (currentPlaylist === name) { currentPlaylist = plsAfter[0]?.name || null; currentIndex = 0; }
      if (plsAfter.length === 0) currentPlaylist = await ensureDefaultPlaylist();
      await refreshPlaylistsUI(); await refreshTrackList();
      await updateTotalDuration(); updateSeekUI();
    });

    li.appendChild(nameSpan); li.appendChild(delBtn);
    playlistsEl.appendChild(li);
  }
}

createPlaylistBtn.addEventListener('click', async () => {
  const name = normalizePlaylistName(newPlaylistName.value);
  if (!name) return;
  if (await idbGet(STORE_PLAYLISTS, name)) { alert('同名のプレイリストが既に存在します'); return; }
  await idbPut(STORE_PLAYLISTS, { name, items: [] });
  newPlaylistName.value = ''; currentPlaylist = name; currentIndex = 0;
  await refreshPlaylistsUI(); await refreshTrackList();
  await updateTotalDuration(); updateSeekUI(); closeSidebar();
});

async function refreshTrackList() {
  trackListEl.replaceChildren();
  const pl = await getCurrentPlaylist(); if (!pl) return;
  for (const id of pl.items) {
    if (!videoListCache[id]) {
      const v = await idbGet(STORE_VIDEOS, id);
      if (v) videoListCache[id] = v;
    }
  }
  pl.items.forEach((id, i) => {
    const meta = videoListCache[id]; if (!meta) return;
    trackListEl.appendChild(renderTrackItem(meta, i, i === currentIndex));
  });
}

async function loadAndPlayById(id) {
  const meta = await idbGet(STORE_VIDEOS, id);
  if (!meta || !meta.blob) return;

  cleanupCurrentObjectUrl();
  currentObjectUrl = URL.createObjectURL(meta.blob);
  videoPlayer.src  = currentObjectUrl;
  videoPlayer.load();
  videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;

  const vol = parseFloat(localStorage.getItem('playerVolume'));
  videoPlayer.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;

  try { await videoPlayer.play(); } catch {}
  setPlayerUIState(); updateSeekUI();

  if (window.electronAPI?.setRPC) {
    const cleanTitle = String(meta.name || 'video').replace(/\.[^/.]+$/, '');
    window.electronAPI.setRPC({
      title:          cleanTitle,
      playlist:       currentPlaylist,
      startTimestamp: Date.now(),
      endTimestamp:   Date.now() + (clampNumber(meta.duration, 0) * 1000),
      paused:         false
    });
  }
}

async function playCurrent() {
  if (!currentPlaylist) return;
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl || !Array.isArray(pl.items) || pl.items.length === 0) return;

  let id = null;
  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== pl.items.length || !shuffleOrder.every(x => pl.items.includes(x))) {
      shuffleOrder = shuffleArray(pl.items.slice()); currentIndex = 0;
    }
    id = shuffleOrder[currentIndex % shuffleOrder.length];
  } else if (playMode === 'random') {
    id = pl.items[Math.floor(Math.random() * pl.items.length)];
  } else {
    currentIndex = ((currentIndex % pl.items.length) + pl.items.length) % pl.items.length;
    id = pl.items[currentIndex];
  }

  if (!id) return;
  await loadAndPlayById(id); await refreshTrackList();
}

async function updateTotalDuration() {
  const pl = await getCurrentPlaylist();
  if (!pl) { totalDurationEl.textContent = '00:00:00'; return; }
  let total = 0;
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta && Number.isFinite(meta.duration)) total += meta.duration;
  }
  totalDurationEl.textContent = formatTime(total);
}

function createVolumeControls() {
  const playerControls = document.querySelector('.player-controls');
  if (!playerControls) return;

  const volWrap   = document.createElement('div'); volWrap.className = 'volume-controls';
  const muteBtn   = document.createElement('button');
  muteBtn.className = 'small-btn'; muteBtn.type = 'button'; muteBtn.title = 'ミュート/ミュート解除';
  const volSlider = document.createElement('input');
  volSlider.type = 'range'; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.01; volSlider.value = '1';
  const volLabel  = document.createElement('div');
  volLabel.style.color = 'var(--muted)'; volLabel.style.fontSize = '13px'; volLabel.textContent = '100%';

  const saved   = parseFloat(localStorage.getItem('playerVolume'));
  const initVol = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  volSlider.value = String(initVol); volLabel.textContent = `${Math.round(initVol * 100)}%`;
  videoPlayer.volume = initVol; muteBtn.textContent = initVol > 0 ? '🔊' : '🔇';

  volSlider.addEventListener('input', () => {
    const v = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
    videoPlayer.volume = v; localStorage.setItem('playerVolume', String(v));
    volLabel.textContent = `${Math.round(v * 100)}%`; muteBtn.textContent = v > 0 ? '🔊' : '🔇';
  });

  muteBtn.addEventListener('click', () => {
    if (videoPlayer.volume > 0) {
      volSlider.dataset.prev = volSlider.value; volSlider.value = '0';
      videoPlayer.volume = 0; localStorage.setItem('playerVolume', '0');
      volLabel.textContent = '0%'; muteBtn.textContent = '🔇';
    } else {
      const prev = Math.min(1, Math.max(0, parseFloat(volSlider.dataset.prev || '1') || 1));
      volSlider.value = String(prev); videoPlayer.volume = prev;
      localStorage.setItem('playerVolume', String(prev));
      volLabel.textContent = `${Math.round(prev * 100)}%`; muteBtn.textContent = '🔊';
    }
  });

  volWrap.appendChild(muteBtn); volWrap.appendChild(volSlider); volWrap.appendChild(volLabel);
  playerControls.appendChild(volWrap);
}

function setMode(m) {
  playMode = m;
  orderBtn.classList.toggle('active',   m === 'order');
  shuffleBtn.classList.toggle('active', m === 'shuffle');
  randomBtn.classList.toggle('active',  m === 'random');
  if (m === 'shuffle') shuffleOrder = [];
}

playPauseBtn.addEventListener('click', async () => {
  if (videoPlayer.paused) {
    try { await videoPlayer.play(); } catch {}
    if (window.electronAPI?.setRPC) window.electronAPI.setRPC({ paused: false });
  } else {
    videoPlayer.pause();
    if (window.electronAPI?.setRPC) window.electronAPI.setRPC({ paused: true });
  }
  setPlayerUIState();
});

centerPlayBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (videoPlayer.paused) { try { await videoPlayer.play(); } catch {} }
  else videoPlayer.pause();
  setPlayerUIState();
});

videoStage?.addEventListener('click', (e) => {
  if (e.target === centerPlayBtn) return;
  if (videoPlayer.paused) videoPlayer.play().catch(() => {});
  else videoPlayer.pause();
  setPlayerUIState();
});

seekBar?.addEventListener('input',  () => updateSeekUI());
seekBar?.addEventListener('change', () => seekFromBar());

fullscreenBtn?.addEventListener('click', async () => {
  try {
    const target = document.querySelector('.video-shell') || videoStage || document.documentElement;
    if (!document.fullscreenElement) await target.requestFullscreen();
    else                             await document.exitFullscreen();
  } catch {}
});

prevBtn.addEventListener('click', async () => {
  const pl  = await getCurrentPlaylist();
  const len = pl?.items?.length || 0; if (!len) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex - 1 + len) % len; await playCurrent();
});

nextBtn.addEventListener('click', async () => {
  const pl  = await getCurrentPlaylist();
  const len = pl?.items?.length || 0; if (!len) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex + 1) % len; await playCurrent();
});

orderBtn.addEventListener('click',   () => setMode('order'));
shuffleBtn.addEventListener('click', () => setMode('shuffle'));
randomBtn.addEventListener('click',  () => setMode('random'));

speedSelect.addEventListener('change', () => {
  videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;
});

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault(); dropZone.classList.remove('drag'); await addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', async e => { await addFiles(e.target.files); fileInput.value = ''; });

exportMetaBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const pl = await getCurrentPlaylist(); if (!pl) return;
  const exportObj = { name: pl.name, items: [] };
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id); if (!meta) continue;
    exportObj.items.push({ id: meta.id, name: meta.name, duration: meta.duration,
      mimeType: meta.mimeType || 'video/mp4', size: meta.size, thumbnail: meta.thumbnail });
  }
  downloadBlob(new Blob([JSON.stringify(exportObj)], { type: 'application/json' }), `${pl.name}.playlist.json`);
});

exportWithBlobsBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const pl = await getCurrentPlaylist(); if (!pl) return;
  const exportObj = { name: pl.name, items: [] };
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id); if (!meta || !meta.blob) continue;
    const base = await blobToBase64(meta.blob);
    exportObj.items.push({ id: meta.id, name: meta.name, duration: meta.duration,
      mimeType: meta.mimeType || 'video/mp4', size: meta.size,
      thumbnail: meta.thumbnail, blobBase64: base });
  }
  downloadBlob(new Blob([JSON.stringify(exportObj)], { type: 'application/json' }), `${pl.name}.playlist.full.json`);
});

importFile.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    if (f.size > MAX_IMPORTED_JSON_BYTES) throw new Error('file-too-large');
    const obj = JSON.parse(await f.text());
    if (!obj || typeof obj !== 'object') throw new Error('invalid');
    const baseName = normalizePlaylistName(obj.name);
    if (!baseName || !Array.isArray(obj.items)) throw new Error('invalid');
    const name = `${baseName} (import)`;
    const items = [];
    for (const it of obj.items.slice(0, MAX_IMPORTED_ITEMS)) {
      if (!it || typeof it !== 'object') continue;
      const id        = safeText(String(it.id || '')) || uid();
      const metaName  = normalizePlaylistName(it.name) || 'video';
      const duration  = clampNumber(Number(it.duration), 0);
      const size      = clampNumber(Number(it.size), 0);
      const thumbnail = safeThumbnailSrc(it.thumbnail);
      const mimeType  = sanitizeMimeType(it.mimeType);
      if (typeof it.blobBase64 === 'string' && it.blobBase64.length > 0) {
        const blob = base64ToBlob(it.blobBase64, mimeType);
        const meta = { id, name: metaName, duration, mimeType, blob, thumbnail, size };
        await idbPut(STORE_VIDEOS, meta); videoListCache[id] = meta; items.push(id);
      } else {
        const meta = { id, name: metaName, duration, mimeType, blob: null, thumbnail, size };
        await idbPut(STORE_VIDEOS, meta); videoListCache[id] = meta; items.push(id);
      }
    }
    await idbPut(STORE_PLAYLISTS, { name, items });
    currentPlaylist = name; currentIndex = 0;
    await refreshPlaylistsUI(); await refreshTrackList();
    await updateTotalDuration(); updateSeekUI();
  } catch { alert('インポートに失敗しました'); }
  importFile.value = '';
});

videoPlayer.addEventListener('loadedmetadata', () => { updateSeekUI(); setPlayerUIState(); });
videoPlayer.addEventListener('timeupdate',     updateSeekUI);
videoPlayer.addEventListener('durationchange', updateSeekUI);

videoPlayer.addEventListener('ended', async () => {
  const pl = await getCurrentPlaylist(); if (!pl || pl.items.length === 0) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex + 1) % pl.items.length; await playCurrent();
});

videoPlayer.addEventListener('play', async () => {
  const pl = await getCurrentPlaylist(); if (!pl || pl.items.length === 0) return;
  const id   = pl.items[currentIndex];
  const meta = await idbGet(STORE_VIDEOS, id);
  if (meta && !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    videoPlayer.pause();
  }
  setPlayerUIState(); updateSeekUI();
});

videoPlayer.addEventListener('pause', () => {
  if (window.electronAPI?.setRPC) window.electronAPI.setRPC({ paused: true });
  setPlayerUIState(); updateSeekUI();
});

window.addEventListener('beforeunload', () => cleanupCurrentObjectUrl());

if (menuToggle) menuToggle.addEventListener('click', toggleSidebar);
if (overlay)    overlay.addEventListener('click',    closeSidebar);

async function init() {
  await openDB();
  const vids = await idbGetAll(STORE_VIDEOS);
  vids.forEach(v => { if (v && v.id) videoListCache[v.id] = v; });
  const defaultOrFirst = await ensureDefaultPlaylist();
  const pls = await loadAllPlaylists();
  currentPlaylist = pls.length ? (normalizePlaylistName(pls[0]?.name) || pls[0].name) : defaultOrFirst;
  createVolumeControls();
  await refreshPlaylistsUI(); await refreshTrackList();
  await updateTotalDuration(); setPlayerUIState(); updateSeekUI();
}

init().catch(err => { console.error(err); alert('初期化に失敗しました'); });
