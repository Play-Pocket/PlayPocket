(function () {
  'use strict';

  const PP = window.PP;
  const { C, log, util, media, CATEGORY, report } = PP;

  const GAPLESS_LEAD_SECONDS = 0.03;
  const GAPLESS_ARM_WINDOW_MS = 700;
  const GAPLESS_MAX_REMAINING_SECONDS = 0.5;
  const MIN_FADE_SECONDS = 0.1;

  const decks = [makeDeck(0, util.byId('videoPlayer')), makeDeck(1, util.byId('videoPlayerB'))];
  let activeIndex = 0;
  let audioCtx = null;
  let transition = null;
  let transitionToken = 0;
  let standbyAbort = null;
  let prebufferPromise = null;
  let gaplessTimer = null;
  let gestureAttached = false;
  let masterVolume = 1;
  let playbackRate = 1;
  let monoEnabled = false;
  let config = {
    getTransitionConfig: () => ({ enabled: false, crossfade: false, fadeDuration: 3, nextTrackId: null }),
    prepareNext: async () => {}
  };

  function makeDeck(index, el) {
    if (el) {
      el.muted = false;
      el.defaultMuted = false;
    }
    return { index, el, graph: null, url: null, trackId: null, ready: false };
  }

  function activeDeck() {
    return decks[activeIndex];
  }

  function standbyDeck() {
    return decks[1 - activeIndex];
  }

  function activeEl() {
    return activeDeck().el;
  }

  function buildDeckGraph(deck) {
    const ctx = audioCtx;
    const source = ctx.createMediaElementSource(deck.el);
    const fadeGain = ctx.createGain();
    const normGain = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const LL = ctx.createGain();
    const LR = ctx.createGain();
    const RL = ctx.createGain();
    const RR = ctx.createGain();

    LL.gain.value = 1;
    RR.gain.value = 1;
    LR.gain.value = 0;
    RL.gain.value = 0;
    fadeGain.gain.value = deck.index === activeIndex ? 1 : 0;

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
    merger.connect(ctx.destination);

    return { source, fadeGain, normGain, matrix: { LL, LR, RL, RR } };
  }

  function resumeContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  function attachGestureResume() {
    if (gestureAttached) return;
    gestureAttached = true;
    window.addEventListener('pointerdown', resumeContext, { passive: true });
    window.addEventListener('keydown', resumeContext, { passive: true });
  }

  function ensureAudioGraph() {
    if (audioCtx) return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      audioCtx = new Ctx();
      for (const deck of decks) deck.graph = buildDeckGraph(deck);
      audioCtx.onstatechange = () => {
        if (audioCtx && audioCtx.state === 'suspended' && !activeEl().paused) resumeContext();
      };
      attachGestureResume();
      applyMono();
      return true;
    } catch (error) {
      report(CATEGORY.PLAYBACK, error, { scope: 'audio-graph', notify: false });
      audioCtx = null;
      for (const deck of decks) deck.graph = null;
      return false;
    }
  }

  function setMono(enabled) {
    monoEnabled = !!enabled;
    applyMono();
  }

  function applyMono() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const cross = monoEnabled ? 0.5 : 0;
    const through = monoEnabled ? 0.5 : 1;
    for (const deck of decks) {
      if (!deck.graph) continue;
      const { LL, LR, RL, RR } = deck.graph.matrix;
      LL.gain.setTargetAtTime(through, t, 0.05);
      RR.gain.setTargetAtTime(through, t, 0.05);
      LR.gain.setTargetAtTime(cross, t, 0.05);
      RL.gain.setTargetAtTime(cross, t, 0.05);
    }
  }

  function setFadeValue(deck, value) {
    if (!audioCtx || !deck.graph) return;
    const param = deck.graph.fadeGain.gain;
    const t = audioCtx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(value, t);
  }

  function applyNormalization(deck, gain) {
    if (!audioCtx || !deck.graph) return;
    const value = Number.isFinite(gain) && gain > 0 ? gain : 1;
    deck.graph.normGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.08);
  }

  function setVolume(value) {
    masterVolume = util.clamp(Number.isFinite(value) ? value : 1, 0, 1);
    for (const deck of decks) {
      if (deck.el) deck.el.volume = masterVolume;
    }
  }

  function getVolume() {
    return masterVolume;
  }

  function setPlaybackRate(rate) {
    playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    for (const deck of decks) {
      if (deck.el) deck.el.playbackRate = playbackRate;
    }
  }

  function applyAudioPreset(preset) {
    for (const deck of decks) {
      if (!deck.el) continue;
      if (preset === 'high') {
        deck.el.preload = 'auto';
        deck.el.preservesPitch = true;
      } else if (preset === 'low') {
        deck.el.preload = 'metadata';
        deck.el.preservesPitch = false;
      } else {
        deck.el.preload = 'metadata';
        deck.el.preservesPitch = true;
      }
    }
  }

  function clearDeck(deck) {
    const el = deck.el;
    try { el.pause(); } catch {}
    el.removeAttribute('src');
    try { el.load(); } catch {}
    media.urls.revoke(deck.url);
    deck.url = null;
    deck.trackId = null;
    deck.ready = false;
  }

  function setSource(deck, blob, trackId) {
    clearDeck(deck);
    deck.url = media.urls.create(blob, `deck${deck.index}`);
    deck.trackId = trackId;
    deck.ready = false;
    deck.el.src = deck.url;
    deck.el.volume = masterVolume;
    deck.el.playbackRate = playbackRate;
    deck.el.load();
  }

  function waitForReady(el, timeoutMs, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        resolve('aborted');
        return;
      }
      if (el.error) {
        resolve('error');
        return;
      }
      if (el.readyState >= 1 && el.currentSrc) {
        resolve('ready');
        return;
      }
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (status) => {
        cleanup();
        resolve(status);
      };
      const onReady = () => finish('ready');
      const onError = () => finish('error');
      const onAbort = () => finish('aborted');
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('error', onError);
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  function swapDecks() {
    const from = activeDeck();
    activeIndex = 1 - activeIndex;
    const to = activeDeck();
    to.el.classList.remove('is-standby');
    to.el.removeAttribute('aria-hidden');
    to.el.setAttribute('aria-label', 'ビデオプレーヤー');
    from.el.classList.add('is-standby');
    from.el.setAttribute('aria-hidden', 'true');
    from.el.removeAttribute('aria-label');
    return { from, to };
  }

  function clearGaplessTimer() {
    if (gaplessTimer) {
      clearTimeout(gaplessTimer);
      gaplessTimer = null;
    }
  }

  function resetStandby() {
    clearGaplessTimer();
    if (standbyAbort) {
      standbyAbort.abort();
      standbyAbort = null;
    }
    const deck = standbyDeck();
    if (deck.trackId !== null || deck.url) clearDeck(deck);
    setFadeValue(deck, 0);
  }

  async function prepareStandby(trackId, blob, normGain) {
    if (!audioCtx || !blob) return false;
    const deck = standbyDeck();
    if (deck.trackId === trackId && deck.ready) return true;
    if (standbyAbort) standbyAbort.abort();
    const abort = new AbortController();
    standbyAbort = abort;
    clearDeck(deck);
    setFadeValue(deck, 0);
    setSource(deck, blob, trackId);
    const status = await waitForReady(deck.el, C.STANDBY_READY_TIMEOUT_MS, abort.signal);
    if (abort.signal.aborted || standbyAbort !== abort || standbyDeck() !== deck || deck.trackId !== trackId) return false;
    standbyAbort = null;
    if (status !== 'ready') {
      clearDeck(deck);
      return false;
    }
    try { deck.el.currentTime = 0; } catch {}
    applyNormalization(deck, normGain);
    deck.ready = true;
    return true;
  }

  function hasStandbyFor(trackId) {
    const deck = standbyDeck();
    return deck.ready && deck.trackId === trackId && !transition;
  }

  function promoteStandby(trackId) {
    if (!hasStandbyFor(trackId)) return false;
    clearGaplessTimer();
    const { from, to } = swapDecks();
    setFadeValue(to, 1);
    setFadeValue(from, 0);
    clearDeck(from);
    return true;
  }

  function isTransitioning() {
    return !!transition;
  }

  function cancelTransition() {
    clearGaplessTimer();
    if (!transition) return;
    const current = transition;
    transition = null;
    transitionToken += 1;
    if (current.timer) clearTimeout(current.timer);
    if (current.wake) current.wake();
    setFadeValue(current.from, 1);
    setFadeValue(current.to, 0);
    clearDeck(current.to);
  }

  function completeTransition(current) {
    if (transition !== current) return false;
    transition = null;
    transitionToken += 1;
    if (current.timer) clearTimeout(current.timer);
    if (current.wake) current.wake();
    const { from, to } = swapDecks();
    setFadeValue(to, 1);
    setFadeValue(from, 0);
    clearDeck(from);
    PP.bus.emit('engine:swapped', { trackId: to.trackId, kind: current.kind });
    return true;
  }

  function settleTransition() {
    if (!transition) return;
    if (transition.phase === 'fading') completeTransition(transition);
    else cancelTransition();
  }

  function nextTrackStillValid(deck) {
    const cfg = config.getTransitionConfig();
    return !!cfg.nextTrackId && deck.trackId === cfg.nextTrackId;
  }

  async function startCrossfade(fadeDuration) {
    const from = activeDeck();
    const to = standbyDeck();
    if (!audioCtx || transition || !to.ready) return false;
    if (!nextTrackStillValid(to)) {
      resetStandby();
      return false;
    }

    const token = ++transitionToken;
    const current = { token, kind: 'crossfade', from, to, phase: 'starting', timer: null, wake: null };
    transition = current;

    const rate = from.el.playbackRate || 1;
    const remaining = Math.max(MIN_FADE_SECONDS, (from.el.duration || 0) - from.el.currentTime);
    const realFade = Math.max(MIN_FADE_SECONDS, Math.min(fadeDuration, remaining) / rate);

    resumeContext();
    try {
      to.el.currentTime = 0;
      await to.el.play();
    } catch (error) {
      if (transition === current) cancelTransition();
      if (error && error.name !== 'AbortError') log.warn('engine', error);
      return false;
    }
    if (transition !== current) return false;

    const now = audioCtx.currentTime;
    const fromParam = from.graph.fadeGain.gain;
    const toParam = to.graph.fadeGain.gain;
    fromParam.cancelScheduledValues(now);
    fromParam.setValueAtTime(fromParam.value, now);
    fromParam.linearRampToValueAtTime(0, now + realFade);
    toParam.cancelScheduledValues(now);
    toParam.setValueAtTime(0, now);
    toParam.linearRampToValueAtTime(1, now + realFade);
    current.phase = 'fading';

    await new Promise((resolve) => {
      current.wake = resolve;
      current.timer = setTimeout(resolve, realFade * 1000);
    });
    current.wake = null;
    if (transition !== current) return false;
    return completeTransition(current);
  }

  async function handoffNow() {
    const from = activeDeck();
    const to = standbyDeck();
    if (!audioCtx || transition || !to.ready) return false;
    if (!nextTrackStillValid(to)) {
      resetStandby();
      return false;
    }

    clearGaplessTimer();
    const token = ++transitionToken;
    const current = { token, kind: 'gapless', from, to, phase: 'starting', timer: null, wake: null };
    transition = current;

    resumeContext();
    setFadeValue(to, 1);
    try {
      to.el.currentTime = 0;
      await to.el.play();
    } catch (error) {
      if (transition === current) cancelTransition();
      if (error && error.name !== 'AbortError') log.warn('engine', error);
      return false;
    }
    if (transition !== current) return false;
    current.phase = 'fading';
    return completeTransition(current);
  }

  function scheduleGapless(remainingSeconds) {
    if (gaplessTimer) return;
    const rate = activeEl().playbackRate || 1;
    const ms = Math.max(0, (remainingSeconds / rate - GAPLESS_LEAD_SECONDS) * 1000);
    if (ms > GAPLESS_ARM_WINDOW_MS) return;
    gaplessTimer = setTimeout(() => {
      gaplessTimer = null;
      const el = activeEl();
      if (el.paused || transition) return;
      const left = (el.duration - el.currentTime) / (el.playbackRate || 1);
      if (!Number.isFinite(left) || left > GAPLESS_MAX_REMAINING_SECONDS) return;
      handoffNow();
    }, ms);
  }

  function handleTimeUpdate() {
    if (!audioCtx || transition) return;
    const cfg = config.getTransitionConfig();
    if (!cfg.enabled || !cfg.nextTrackId) return;

    const el = activeEl();
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const remaining = duration - el.currentTime;
    const fadeDuration = cfg.crossfade ? cfg.fadeDuration : 0;
    const lead = Math.max(fadeDuration, C.ENGINE_PREBUFFER_LEAD_SECONDS);
    const standby = standbyDeck();

    if (standby.trackId !== null && standby.trackId !== cfg.nextTrackId && !prebufferPromise) {
      resetStandby();
    }

    if (remaining <= lead && !standby.ready && !prebufferPromise) {
      prebufferPromise = Promise.resolve()
        .then(() => config.prepareNext())
        .catch((error) => log.warn('engine', error))
        .finally(() => { prebufferPromise = null; });
    }

    if (!standby.ready) return;
    if (cfg.crossfade) {
      if (remaining <= fadeDuration) startCrossfade(fadeDuration);
    } else {
      scheduleGapless(remaining);
    }
  }

  async function loadActive(blob, trackId, signal) {
    cancelTransition();
    const deck = activeDeck();
    if (standbyDeck().trackId !== null && standbyDeck().trackId !== trackId) resetStandby();
    clearGaplessTimer();
    setFadeValue(deck, 1);
    setSource(deck, blob, trackId);
    const status = await waitForReady(deck.el, C.LOAD_READY_TIMEOUT_MS, signal);
    if (status === 'ready') deck.ready = true;
    return status;
  }

  function bindActiveEvents(handlers) {
    for (const deck of decks) {
      for (const [name, handler] of Object.entries(handlers)) {
        deck.el.addEventListener(name, (event) => {
          if (deck !== activeDeck()) return;
          handler(event);
        });
      }
      deck.el.addEventListener('timeupdate', () => {
        if (deck === activeDeck()) handleTimeUpdate();
      });
    }
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

  async function analyzeLoudness(blob) {
    if (!blob || blob.size > C.NORMALIZATION_MAX_ANALYZE_BYTES) return 1;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = audioCtx || new OfflineAudioContext(1, 1, 44100);
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const rms = computeRMS(decoded);
      return rms > 0.0001 ? util.clamp(C.NORMALIZATION_TARGET_RMS / rms, 0.35, 3) : 1;
    } catch (error) {
      log.debug('engine', error);
      return 1;
    }
  }

  function debugSnapshot() {
    return {
      activeIndex,
      ctxState: audioCtx ? audioCtx.state : null,
      transition: transition ? { kind: transition.kind, phase: transition.phase } : null,
      decks: decks.map((deck) => ({
        index: deck.index,
        trackId: deck.trackId,
        ready: deck.ready,
        hasUrl: !!deck.url,
        muted: deck.el.muted,
        volume: deck.el.volume,
        paused: deck.el.paused,
        standbyClass: deck.el.classList.contains('is-standby'),
        fade: deck.graph ? deck.graph.fadeGain.gain.value : null,
        time: deck.el.currentTime
      }))
    };
  }

  PP.engine = Object.freeze({
    configure(next) {
      config = { ...config, ...next };
    },
    ensureAudioGraph,
    resumeContext,
    activeEl,
    standbyEl: () => standbyDeck().el,
    bindActiveEvents,
    setVolume,
    getVolume,
    setPlaybackRate,
    applyAudioPreset,
    setMono,
    applyNormalization: (gain) => applyNormalization(activeDeck(), gain),
    analyzeLoudness,
    loadActive,
    prepareStandby,
    hasStandbyFor,
    promoteStandby,
    resetStandby,
    startCrossfade,
    handoffNow,
    cancelTransition,
    settleTransition,
    isTransitioning,
    isStandbyReady: () => standbyDeck().ready,
    activeTrackId: () => activeDeck().trackId,
    clearActive() {
      cancelTransition();
      resetStandby();
      clearDeck(activeDeck());
    },
    hasAudioGraph: () => !!audioCtx,
    debugSnapshot: () => (PP.env.dev ? debugSnapshot() : null)
  });
}());
