(function () {
  'use strict';

  const PP = window.PP;
  const { C, util, log, CATEGORY, report, engine, media, db, state, bus } = PP;

  const MAX_AUTO_SKIP = 5;

  const el = {
    stage: util.byId('videoStage'),
    centerPlay: util.byId('centerPlayBtn'),
    playPause: util.byId('playPauseBtn'),
    prev: util.byId('prevBtn'),
    next: util.byId('nextBtn'),
    seek: util.byId('seekBar'),
    currentTime: util.byId('currentTime'),
    durationTime: util.byId('durationTime'),
    audioCard: util.byId('audioOnlyCard'),
    audioThumb: util.byId('audioOnlyThumb'),
    audioTitle: util.byId('audioOnlyTitle'),
    speed: util.byId('speedSelect'),
    fullscreen: util.byId('fullscreenBtn'),
    order: util.byId('orderBtn'),
    shuffle: util.byId('shuffleBtn'),
    random: util.byId('randomBtn'),
    app: util.byId('app')
  };

  let loadToken = 0;
  let pending = null;
  let draining = false;
  let abortCtl = null;
  let consecutiveFailures = 0;
  let nowInfo = null;
  let sessionReady = false;
  let saveTimer = null;
  let saving = false;
  let saveDirty = false;
  let lastPeriodicSave = 0;
  let autoQualityDowngrade = false;
  let connectionMonitorAttached = false;
  let volumeUI = null;

  function settings() {
    return PP.settings.get();
  }

  function videoEl() {
    return engine.activeEl();
  }

  function mod(n, m) {
    return util.mod(n, m);
  }

  function currentTitle() {
    return nowInfo ? util.displayTitle(nowInfo.name) : '';
  }

  function isShuffleValid() {
    const items = state.items;
    const order = state.shuffleOrder;
    if (order.length !== items.length) return false;
    const set = new Set(items);
    if (set.size !== items.length) return false;
    const seen = new Set();
    for (const id of order) {
      if (!set.has(id) || seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }

  function buildShuffle() {
    const items = state.items;
    const current = state.currentTrackId;
    const rest = items.filter((id) => id !== current);
    util.shuffleArray(rest);
    if (current && items.includes(current)) {
      state.shuffleOrder = [current, ...rest];
      state.currentIndex = 0;
    } else {
      state.shuffleOrder = rest;
      state.currentIndex = -1;
    }
  }

  function syncShuffleOrder() {
    const items = state.items;
    if (items.length === 0) {
      state.shuffleOrder = [];
      state.currentIndex = -1;
      return;
    }
    const set = new Set(items);
    const oldOrder = state.shuffleOrder;
    const anchor = state.currentTrackId;
    const oldPos = anchor ? oldOrder.indexOf(anchor) : -1;
    const order = Array.from(new Set(oldOrder.filter((id) => set.has(id))));
    if (order.length === 0) {
      buildShuffle();
      return;
    }
    const present = new Set(order);
    const missing = items.filter((id) => !present.has(id));
    util.shuffleArray(missing);
    const anchorPos = anchor ? order.indexOf(anchor) : -1;
    for (const id of missing) {
      const start = anchorPos + 1;
      const pos = start + Math.floor(Math.random() * (order.length - start + 1));
      order.splice(pos, 0, id);
    }
    state.shuffleOrder = order;
    const idx = anchor ? order.indexOf(anchor) : -1;
    if (idx >= 0) {
      state.currentIndex = idx;
    } else if (oldPos >= 0) {
      state.currentIndex = oldOrder.slice(0, oldPos).filter((id) => set.has(id)).length - 1;
    } else {
      state.currentIndex = -1;
    }
  }

  function syncOrderIndex(prevItems) {
    const items = state.items;
    const anchor = state.currentTrackId;
    if (!anchor) {
      state.currentIndex = -1;
      return;
    }
    const idx = items.indexOf(anchor);
    if (idx >= 0) {
      state.currentIndex = idx;
      return;
    }
    const oldPos = Array.isArray(prevItems) ? prevItems.indexOf(anchor) : -1;
    if (oldPos >= 0) {
      const set = new Set(items);
      state.currentIndex = prevItems.slice(0, oldPos).filter((id) => set.has(id)).length - 1;
    } else {
      state.currentIndex = -1;
    }
  }

  function onPlaylistChanged(prevItems) {
    if (state.playMode === 'shuffle') syncShuffleOrder();
    else syncOrderIndex(prevItems);
    engine.resetStandby();
  }

  function onPlaylistSwitched() {
    state.shuffleOrder = [];
    state.currentIndex = -1;
    if (state.playMode === 'shuffle' && state.items.length) syncShuffleOrder();
    engine.resetStandby();
  }

  function positionOf(id) {
    if (state.playMode === 'shuffle') {
      if (!isShuffleValid()) syncShuffleOrder();
      return state.shuffleOrder.indexOf(id);
    }
    return state.items.indexOf(id);
  }

  function pickByStep(delta) {
    const items = state.items;
    const len = items.length;
    if (len === 0) return null;
    if (state.playMode === 'random') {
      const id = items[Math.floor(Math.random() * len)];
      state.currentIndex = items.indexOf(id);
      return id;
    }
    if (state.playMode === 'shuffle' && !isShuffleValid()) syncShuffleOrder();
    const list = state.playMode === 'shuffle' ? state.shuffleOrder : items;
    if (list.length === 0) return null;
    let base = state.currentIndex;
    if (base < 0 && delta < 0) base = 0;
    const idx = mod(base + delta, list.length);
    state.currentIndex = idx;
    return list[idx];
  }

  function peekNextId() {
    const items = state.items;
    if (items.length === 0 || state.playMode === 'random') return null;
    if (state.playMode === 'shuffle') {
      if (!isShuffleValid()) return null;
      return state.shuffleOrder[mod(state.currentIndex + 1, state.shuffleOrder.length)] || null;
    }
    return items[mod(state.currentIndex + 1, items.length)] || null;
  }

  function transitionsEnabled() {
    const s = settings();
    return !!(s.crossfadeEnabled || s.gaplessEnabled || s.seamlessPlayback);
  }

  function getTransitionConfig() {
    const s = settings();
    return {
      enabled: transitionsEnabled() && state.playMode !== 'random',
      crossfade: !!s.crossfadeEnabled,
      fadeDuration: s.crossfadeDuration,
      nextTrackId: peekNextId()
    };
  }

  async function resolveNormGain(id, info, blob) {
    if (!settings().volumeNormalization) return 1;
    const known = media.norm.get(id) ?? info?.normGain;
    if (Number.isFinite(known) && known > 0) return known;
    const gain = await engine.analyzeLoudness(blob);
    media.norm.set(id, gain);
    return gain;
  }

  async function prepareNext() {
    const nextId = peekNextId();
    if (!nextId) return;
    const token = loadToken;
    const record = await db.getVideo(nextId);
    if (token !== loadToken || !record || !(record.blob instanceof Blob)) return;
    const gain = await resolveNormGain(nextId, db.toInfo(record), record.blob);
    if (token !== loadToken || peekNextId() !== nextId) return;
    await engine.prepareStandby(nextId, record.blob, gain);
  }

  function applyNormalizationForCurrent(info, blob) {
    if (!settings().volumeNormalization) {
      engine.applyNormalization(1);
      return;
    }
    const known = media.norm.get(info.id) ?? info.normGain;
    if (Number.isFinite(known) && known > 0) {
      engine.applyNormalization(known);
      return;
    }
    engine.applyNormalization(1);
    resolveNormGain(info.id, info, blob).then((gain) => {
      if (state.currentTrackId === info.id && settings().volumeNormalization) engine.applyNormalization(gain);
    }).catch((error) => log.debug('player', error));
  }

  async function reapplyNormalization() {
    const id = engine.activeTrackId();
    if (!id) return;
    if (!settings().volumeNormalization) {
      engine.applyNormalization(1);
      return;
    }
    const record = await db.getVideo(id);
    if (!record || !(record.blob instanceof Blob) || engine.activeTrackId() !== id) return;
    applyNormalizationForCurrent(db.toInfo(record), record.blob);
  }

  function setPlayerUIState() {
    const v = videoEl();
    const showPaused = (v.paused || v.ended) && !(draining && state.wantPlaying);
    if (el.stage) el.stage.classList.toggle('paused', showPaused);
    if (el.centerPlay) el.centerPlay.textContent = showPaused ? '▶' : 'Ⅱ';
    if (el.playPause) el.playPause.textContent = showPaused ? '▶' : 'Ⅱ';
    PP.platform.reportPlaybackState({ isPlaying: !showPaused, title: currentTitle() });
  }

  function updateSeekUI() {
    const v = videoEl();
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const current = Number.isFinite(v.currentTime) ? v.currentTime : 0;

    if (el.durationTime) el.durationTime.textContent = util.formatTime(duration);
    if (el.currentTime) el.currentTime.textContent = util.formatTime(current);

    if (el.seek && duration > 0) {
      const ratio = util.clamp(current / duration, 0, 1);
      if (!el.seek.matches(':active')) el.seek.value = String(Math.round(ratio * 1000));
    } else if (el.seek) {
      el.seek.value = '0';
    }
  }

  function updateAudioOnlyCard(info) {
    if (el.audioThumb) el.audioThumb.src = util.sanitizeThumbnail(info?.thumbnail) || '';
    if (el.audioTitle) el.audioTitle.textContent = util.displayTitle(info?.name);
  }

  function updatePresence() {
    if (!nowInfo) return;
    const v = videoEl();
    if (v.paused || v.ended) {
      PP.platform.setPresence(null);
      return;
    }
    const rate = v.playbackRate || 1;
    const position = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : nowInfo.duration;
    const now = Date.now();
    const start = now - Math.round((position / rate) * 1000);
    const payload = {
      title: currentTitle(),
      playlist: state.currentPlaylist || 'PlayPocket',
      startTimestamp: start
    };
    if (Number.isFinite(duration) && duration > 0) payload.endTimestamp = start + Math.round((duration / rate) * 1000);
    PP.platform.setPresence(payload);
  }

  function buildSnapshot() {
    const v = videoEl();
    const items = state.items;
    let index = state.currentTrackId ? items.indexOf(state.currentTrackId) : -1;
    if (index < 0) index = Math.max(0, Math.min(items.length - 1, state.currentIndex));
    return {
      playlist: state.currentPlaylist,
      index: Math.max(0, index),
      trackId: state.currentTrackId,
      playMode: state.playMode,
      shuffleOrder: state.playMode === 'shuffle' ? state.shuffleOrder.slice(0, 5000) : [],
      time: util.clampNumber(v.currentTime, 0),
      speed: util.clampNumber(parseFloat(el.speed?.value || '1'), 1),
      volume: engine.getVolume(),
      wasPlaying: !!(!v.paused && !v.ended)
    };
  }

  async function runSave() {
    saveTimer = null;
    if (!sessionReady) return;
    if (saving) {
      saveDirty = true;
      return;
    }
    saving = true;
    try {
      await PP.platform.saveSession(buildSnapshot());
    } catch (error) {
      report(CATEGORY.IPC, error, { scope: 'session', notify: false });
    } finally {
      saving = false;
      if (saveDirty) {
        saveDirty = false;
        scheduleSessionSave();
      }
    }
  }

  function scheduleSessionSave() {
    if (!sessionReady) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSave, C.STATE_SAVE_DEBOUNCE_MS);
  }

  function flushSessionFinal() {
    if (!sessionReady) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      PP.platform.saveSessionFinal(buildSnapshot());
    } catch (error) {
      log.debug('player', error);
    }
  }

  function markSessionReady() {
    sessionReady = true;
  }

  function notifyTrackChanged() {
    bus.emit('player:track-changed', { trackId: state.currentTrackId });
  }

  function unplayableMessage() {
    return 'この動画はプレースホルダです。元ファイルを再追加してください。';
  }

  function handleLoadFailure(job, kind) {
    log.warn('player', `load failed (${kind}): ${job.id}`);
    setPlayerUIState();
    if (job.userInitiated) {
      state.wantPlaying = false;
      setPlayerUIState();
      PP.ui.alert(kind === 'placeholder' ? unplayableMessage() : 'この動画を再生できませんでした。ファイル形式に対応していない可能性があります。');
      return;
    }
    if (job.restore || !state.wantPlaying) return;
    consecutiveFailures += 1;
    const limit = Math.min(state.items.length, MAX_AUTO_SKIP);
    if (consecutiveFailures >= limit) {
      consecutiveFailures = 0;
      state.wantPlaying = false;
      setPlayerUIState();
      return;
    }
    advance(1, { userInitiated: false });
  }

  async function playActive(job) {
    const v = videoEl();
    engine.resumeContext();
    try {
      await v.play();
    } catch (error) {
      if (error && error.name === 'NotAllowedError') state.wantPlaying = false;
      else if (error && error.name !== 'AbortError') log.warn('player', error);
    }
    return job.token === loadToken;
  }

  async function performLoad(job, signal) {
    const stale = () => signal.aborted || job.token !== loadToken;
    const id = job.id;

    if (!job.seekTime && engine.hasStandbyFor(id)) {
      const cached = PP.cache.videoInfo.get(id);
      const info = cached || (await db.getVideoInfos([id]))[0];
      if (stale()) return false;
      if (info && engine.promoteStandby(id)) {
        nowInfo = info;
        consecutiveFailures = 0;
        updateAudioOnlyCard(info);
        if (state.wantPlaying) await playActive(job);
        else videoEl().pause();
        if (stale()) return false;
        setPlayerUIState();
        updateSeekUI();
        updatePresence();
        scheduleSessionSave();
        return true;
      }
    }

    const record = await db.getVideo(id);
    if (stale()) return false;
    if (!record || !(record.blob instanceof Blob)) {
      handleLoadFailure(job, 'placeholder');
      return false;
    }
    const info = db.toInfo(record);
    PP.cache.videoInfo.set(id, info);

    const status = await engine.loadActive(record.blob, id, signal);
    if (stale()) return false;
    if (status === 'error') {
      handleLoadFailure(job, 'error');
      return false;
    }

    nowInfo = info;
    updateAudioOnlyCard(info);
    applyNormalizationForCurrent(info, record.blob);

    const v = videoEl();
    if (job.seekTime > 0 && Number.isFinite(v.duration) && v.duration > 0) {
      try { v.currentTime = Math.min(job.seekTime, Math.max(0, v.duration - 0.1)); } catch {}
    }

    if (state.wantPlaying) await playActive(job);
    else v.pause();
    if (stale()) return false;

    consecutiveFailures = 0;
    setPlayerUIState();
    updateSeekUI();
    if (!job.suppressPresence) updatePresence();
    scheduleSessionSave();
    bus.emit('player:loaded', { trackId: id });
    return true;
  }

  async function drain() {
    draining = true;
    try {
      while (pending) {
        const job = pending;
        pending = null;
        abortCtl = new AbortController();
        let ok = false;
        try {
          ok = await performLoad(job, abortCtl.signal);
        } catch (error) {
          report(CATEGORY.PLAYBACK, error, { scope: 'load', notify: false });
        }
        job.resolve(ok);
      }
    } finally {
      draining = false;
      abortCtl = null;
      setPlayerUIState();
    }
  }

  function requestLoad(request) {
    return new Promise((resolve) => {
      if (pending) pending.resolve(false);
      if (abortCtl) abortCtl.abort();
      loadToken += 1;
      state.currentTrackId = request.id;
      state.wantPlaying = request.autoplay !== false;
      pending = { seekTime: 0, ...request, token: loadToken, resolve };
      notifyTrackChanged();
      if (!draining) drain();
    });
  }

  function advance(delta, options = {}) {
    engine.settleTransition();
    const id = pickByStep(delta);
    if (!id) return Promise.resolve(false);
    return requestLoad({ id, autoplay: true, userInitiated: !!options.userInitiated });
  }

  function step(delta) {
    return advance(delta, { userInitiated: true });
  }

  function playTrackById(id, options = {}) {
    if (!state.items.includes(id)) return Promise.resolve(false);
    engine.settleTransition();
    if (state.playMode === 'shuffle' && !isShuffleValid()) syncShuffleOrder();
    const position = positionOf(id);
    if (position >= 0) state.currentIndex = position;
    return requestLoad({
      id,
      autoplay: options.autoplay !== false,
      seekTime: options.seekTime || 0,
      userInitiated: options.userInitiated !== false,
      restore: !!options.restore,
      suppressPresence: !!options.suppressPresence
    });
  }

  function startFromCurrent(options = {}) {
    const items = state.items;
    if (items.length === 0) return Promise.resolve(false);
    let id = state.currentTrackId && items.includes(state.currentTrackId) ? state.currentTrackId : null;
    if (!id) {
      if (state.playMode === 'random') id = items[Math.floor(Math.random() * items.length)];
      else if (state.playMode === 'shuffle') {
        if (!isShuffleValid()) syncShuffleOrder();
        id = state.shuffleOrder[mod(Math.max(0, state.currentIndex), state.shuffleOrder.length)];
      } else id = items[mod(Math.max(0, state.currentIndex), items.length)];
    }
    return playTrackById(id, { autoplay: true, userInitiated: options.userInitiated !== false });
  }

  async function togglePlayPause() {
    engine.settleTransition();
    if (draining || pending) {
      state.wantPlaying = !state.wantPlaying;
      setPlayerUIState();
      return;
    }
    if (!engine.activeTrackId()) {
      await startFromCurrent();
      return;
    }
    const v = videoEl();
    if (v.paused || v.ended) {
      state.wantPlaying = true;
      engine.resumeContext();
      try {
        await v.play();
      } catch (error) {
        if (error && error.name !== 'AbortError') log.warn('player', error);
      }
    } else {
      state.wantPlaying = false;
      v.pause();
    }
    setPlayerUIState();
    scheduleSessionSave();
  }

  function seekBy(seconds) {
    engine.settleTransition();
    const v = videoEl();
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    if (duration <= 0) return;
    v.currentTime = util.clamp((Number.isFinite(v.currentTime) ? v.currentTime : 0) + seconds, 0, duration);
    updateSeekUI();
    scheduleSessionSave();
  }

  function seekFromBar() {
    engine.settleTransition();
    const v = videoEl();
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    if (!el.seek || duration <= 0) return;
    const ratio = util.clamp(parseFloat(el.seek.value) / 1000, 0, 1);
    v.currentTime = duration * ratio;
    updateSeekUI();
    scheduleSessionSave();
  }

  async function toggleFullscreen() {
    try {
      const target = document.querySelector('.video-shell') || el.stage || document.documentElement;
      if (!document.fullscreenElement) await target.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      log.debug('player', error);
    }
  }

  function setMode(mode) {
    if (!PPSchema.PLAY_MODES.includes(mode)) return;
    const changed = state.playMode !== mode;
    state.playMode = mode;
    for (const [key, node] of [['order', el.order], ['shuffle', el.shuffle], ['random', el.random]]) {
      if (!node) continue;
      node.classList.toggle('active', key === mode);
      node.setAttribute('aria-selected', key === mode ? 'true' : 'false');
    }
    if (changed) {
      state.shuffleOrder = [];
      if (mode === 'shuffle') syncShuffleOrder();
      else syncOrderIndex(state.items);
      engine.resetStandby();
    }
    scheduleSessionSave();
  }

  function applySpeed(value) {
    const speed = Number.isFinite(value) && value > 0 ? value : 1;
    if (el.speed) {
      let best = null;
      for (const option of Array.from(el.speed.options)) {
        const diff = Math.abs(parseFloat(option.value) - speed);
        if (best === null || diff < best.diff) best = { diff, value: option.value };
      }
      if (best) el.speed.value = best.value;
      engine.setPlaybackRate(parseFloat(el.speed.value) || 1);
    } else {
      engine.setPlaybackRate(speed);
    }
  }

  function setVolumeUI(value) {
    if (!volumeUI) return;
    volumeUI.slider.value = String(value);
    volumeUI.label.textContent = `${Math.round(value * 100)}%`;
    volumeUI.mute.textContent = value > 0 ? '🔊' : '🔇';
  }

  function applyVolume(value, { persist = true } = {}) {
    const v = util.clamp(Number.isFinite(value) ? value : 1, 0, 1);
    engine.setVolume(v);
    setVolumeUI(v);
    if (persist) {
      try { localStorage.setItem('playerVolume', String(v)); } catch {}
      scheduleSessionSave();
    }
    return v;
  }

  function createVolumeControls() {
    const controls = document.querySelector('.player-controls');
    if (!controls || controls.querySelector('.volume-controls')) return;

    const wrap = document.createElement('div');
    wrap.className = 'volume-controls';
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' });

    const mute = document.createElement('button');
    mute.className = 'small-btn';
    mute.type = 'button';
    mute.title = 'ミュート/ミュート解除';
    mute.textContent = '🔊';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.01;
    slider.style.width = '120px';
    slider.setAttribute('aria-label', '音量');

    const label = document.createElement('div');
    label.style.color = 'var(--muted)';
    label.style.fontSize = '13px';

    volumeUI = { mute, slider, label };

    let saved = 1;
    try { saved = parseFloat(localStorage.getItem('playerVolume') || '1'); } catch {}
    applyVolume(Number.isFinite(saved) ? saved : 1, { persist: false });

    slider.addEventListener('input', () => applyVolume(parseFloat(slider.value) || 0));
    mute.addEventListener('click', () => {
      if (engine.getVolume() > 0) {
        slider.dataset.prev = String(engine.getVolume());
        applyVolume(0);
      } else {
        applyVolume(util.clamp(parseFloat(slider.dataset.prev || '1') || 1, 0, 1));
      }
    });

    wrap.appendChild(mute);
    wrap.appendChild(slider);
    wrap.appendChild(label);
    controls.appendChild(wrap);
    setVolumeUI(engine.getVolume());
  }

  function getNetworkConnection() {
    return navigator.connection || navigator.webkitConnection || navigator.mozConnection || null;
  }

  function applyAudioQuality() {
    const s = settings();
    const preset = s.autoAudioQuality && autoQualityDowngrade ? 'low' : s.audioPreset || 'standard';
    engine.applyAudioPreset(preset);
  }

  function evaluateAutoAudioQuality() {
    const conn = getNetworkConnection();
    if (!settings().autoAudioQuality || !conn) {
      autoQualityDowngrade = false;
    } else {
      const slow = ['slow-2g', '2g', '3g'];
      const downlink = Number(conn.downlink);
      autoQualityDowngrade = !!conn.saveData ||
        slow.includes(conn.effectiveType) ||
        (Number.isFinite(downlink) && downlink > 0 && downlink < 1.5);
    }
    applyAudioQuality();
  }

  function attachConnectionMonitor() {
    if (connectionMonitorAttached) return;
    const conn = getNetworkConnection();
    if (!conn || typeof conn.addEventListener !== 'function') return;
    conn.addEventListener('change', evaluateAutoAudioQuality);
    connectionMonitorAttached = true;
  }

  function applyDisplaySettings() {
    const s = settings();
    if (el.app) el.app.classList.toggle('compact-ui', !!s.compactUI);
    if (el.stage) el.stage.classList.toggle('video-hidden', !s.videoDisplayEnabled);
  }

  function applySettings(prev, next) {
    applyDisplaySettings();
    engine.setMono(next.monoAudio);
    attachConnectionMonitor();
    evaluateAutoAudioQuality();
    if (!prev || prev.volumeNormalization !== next.volumeNormalization) reapplyNormalization().catch((error) => log.debug('player', error));
    if (prev && !prev.rpcEnabled && next.rpcEnabled) updatePresence();
    const transitionChanged = prev && (
      prev.crossfadeEnabled !== next.crossfadeEnabled ||
      prev.gaplessEnabled !== next.gaplessEnabled ||
      prev.seamlessPlayback !== next.seamlessPlayback ||
      prev.volumeNormalization !== next.volumeNormalization
    );
    if (transitionChanged) engine.resetStandby();
  }

  function onEnded() {
    if (engine.isTransitioning()) return;
    const cfg = getTransitionConfig();
    if (cfg.enabled && !cfg.crossfade && cfg.nextTrackId && engine.isStandbyReady()) {
      state.wantPlaying = true;
      engine.handoffNow().then((ok) => {
        if (!ok) advance(1, { userInitiated: false });
      });
      return;
    }
    if (state.items.length === 0) return;
    advance(1, { userInitiated: false });
  }

  function onSwapped({ trackId }) {
    state.currentTrackId = trackId;
    const position = positionOf(trackId);
    if (position >= 0) state.currentIndex = position;
    state.wantPlaying = true;
    consecutiveFailures = 0;
    const cached = PP.cache.videoInfo.get(trackId);
    const apply = (info) => {
      if (!info || state.currentTrackId !== trackId) return;
      nowInfo = info;
      updateAudioOnlyCard(info);
      setPlayerUIState();
      updatePresence();
    };
    if (cached) apply(cached);
    else db.getVideoInfos([trackId]).then((infos) => apply(infos[0])).catch((error) => log.debug('player', error));
    notifyTrackChanged();
    updateSeekUI();
    scheduleSessionSave();
  }

  function onMediaError() {
    if (draining) return;
    log.warn('player', 'media error during playback');
    if (!state.wantPlaying || state.items.length === 0) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= Math.min(state.items.length, MAX_AUTO_SKIP)) {
      consecutiveFailures = 0;
      state.wantPlaying = false;
      setPlayerUIState();
      return;
    }
    advance(1, { userInitiated: false });
  }

  function bindEngineEvents() {
    engine.bindActiveEvents({
      loadedmetadata: () => {
        updateSeekUI();
        setPlayerUIState();
      },
      durationchange: updateSeekUI,
      timeupdate: () => {
        updateSeekUI();
        const now = Date.now();
        if (!videoEl().paused && now - lastPeriodicSave > C.STATE_PERIODIC_SAVE_MS) {
          lastPeriodicSave = now;
          scheduleSessionSave();
        }
      },
      seeked: () => {
        updatePresence();
        scheduleSessionSave();
      },
      ended: onEnded,
      play: () => {
        setPlayerUIState();
        updateSeekUI();
        updatePresence();
        scheduleSessionSave();
      },
      pause: () => {
        if (draining || engine.isTransitioning()) return;
        if (!videoEl().ended) state.wantPlaying = false;
        PP.platform.setPresence(null);
        setPlayerUIState();
        updateSeekUI();
        scheduleSessionSave();
      },
      volumechange: () => {
        const v = engine.getVolume();
        try { localStorage.setItem('playerVolume', String(v)); } catch {}
        scheduleSessionSave();
      },
      error: onMediaError
    });
  }

  function bindUI() {
    el.playPause?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, () => togglePlayPause(), { scope: 'ui' }));
    el.centerPlay?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, (event) => {
      event.stopPropagation();
      return togglePlayPause();
    }, { scope: 'ui' }));
    el.stage?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, (event) => {
      if (event.target === el.centerPlay) return undefined;
      return togglePlayPause();
    }, { scope: 'ui' }));
    el.seek?.addEventListener('input', updateSeekUI);
    el.seek?.addEventListener('change', seekFromBar);
    el.fullscreen?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, () => toggleFullscreen(), { scope: 'ui' }));
    el.prev?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, () => step(-1), { scope: 'ui' }));
    el.next?.addEventListener('click', PP.guard(CATEGORY.PLAYBACK, () => step(1), { scope: 'ui' }));
    el.order?.addEventListener('click', () => setMode('order'));
    el.shuffle?.addEventListener('click', () => setMode('shuffle'));
    el.random?.addEventListener('click', () => setMode('random'));
    el.speed?.addEventListener('change', () => {
      engine.setPlaybackRate(parseFloat(el.speed.value) || 1);
      updatePresence();
      scheduleSessionSave();
    });
    createVolumeControls();
  }

  function init() {
    engine.configure({ getTransitionConfig, prepareNext });
    engine.ensureAudioGraph();
    bindEngineEvents();
    bus.on('engine:swapped', onSwapped);
    bindUI();
  }

  async function restore(session, restoreEnabled) {
    if (!restoreEnabled || !session) return;
    if (Number.isFinite(session.volume)) applyVolume(session.volume, { persist: false });
    if (Number.isFinite(session.speed)) applySpeed(session.speed);
    if (session.playMode) setMode(session.playMode);
  }

  async function restoreTrack(session) {
    const items = state.items;
    if (!session || items.length === 0) return false;
    let id = null;
    if (session.trackId && items.includes(session.trackId)) id = session.trackId;
    else if (Number.isFinite(session.index)) id = items[util.clamp(Math.floor(session.index), 0, items.length - 1)];
    else id = items[0];
    if (!id) return false;
    if (state.playMode === 'shuffle' && Array.isArray(session.shuffleOrder) && session.shuffleOrder.length > 0) {
      const known = new Set(items);
      state.shuffleOrder = Array.from(new Set(session.shuffleOrder.filter((entry) => known.has(entry))));
      syncShuffleOrder();
    }
    return playTrackById(id, {
      autoplay: !!session.wasPlaying,
      seekTime: Number.isFinite(session.time) ? session.time : 0,
      userInitiated: false,
      restore: true
    });
  }

  function stopAll() {
    loadToken += 1;
    if (pending) {
      pending.resolve(false);
      pending = null;
    }
    if (abortCtl) abortCtl.abort();
    engine.clearActive();
    nowInfo = null;
    state.currentTrackId = null;
    state.wantPlaying = false;
    updateAudioOnlyCard(null);
    setPlayerUIState();
    updateSeekUI();
    notifyTrackChanged();
  }

  function handleCommand(command) {
    if (command === 'toggle-play-pause') togglePlayPause();
    else if (command === 'next-track') step(1);
    else if (command === 'previous-track') step(-1);
    else if (command === 'toggle-fullscreen') toggleFullscreen();
  }

  function debugSnapshot() {
    if (!PP.env.dev) return null;
    return {
      loadToken,
      draining,
      hasPending: !!pending,
      nowId: nowInfo ? nowInfo.id : null,
      state: { ...state, items: state.items.slice(), shuffleOrder: state.shuffleOrder.slice() },
      engine: engine.debugSnapshot(),
      urls: media.urls.count()
    };
  }

  PP.player = Object.freeze({
    init,
    restore,
    restoreTrack,
    applySettings,
    applyDisplaySettings,
    onPlaylistChanged,
    onPlaylistSwitched,
    playTrackById,
    startFromCurrent,
    step,
    togglePlayPause,
    seekBy,
    setMode,
    toggleFullscreen,
    handleCommand,
    stopAll,
    updateSeekUI,
    setPlayerUIState,
    scheduleSessionSave,
    flushSessionFinal,
    markSessionReady,
    isBusy: () => draining || !!pending,
    debugSnapshot
  });
}());
