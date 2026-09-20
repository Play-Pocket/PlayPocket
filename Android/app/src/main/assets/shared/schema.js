(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PPSchema = api;
}(function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const PLATFORM_ELECTRON = 'electron';
  const PLATFORM_ANDROID = 'android';
  const ALL_PLATFORMS = [PLATFORM_ELECTRON, PLATFORM_ANDROID];
  const PLAY_MODES = ['order', 'shuffle', 'random'];
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const MAX_ID_LENGTH = 200;
  const MAX_PLAYLIST_LENGTH = 200;
  const MAX_SHUFFLE_ORDER_LENGTH = 5000;

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function safeJsonParse(text) {
    return JSON.parse(text, (key, value) => (FORBIDDEN_KEYS.has(key) ? undefined : value));
  }

  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function cleanString(value, maxLength) {
    if (typeof value !== 'string') return null;
    if (value.length === 0 || value.length > maxLength) return null;
    return value;
  }

  function defineSetting(key, type, defaults, options = {}) {
    return Object.freeze({
      key,
      type,
      defaults: Object.freeze({ ...defaults }),
      platforms: Object.freeze(Object.keys(defaults)),
      values: options.values ? Object.freeze(options.values.slice()) : null,
      min: options.min,
      max: options.max,
      round: !!options.round,
      aliases: Object.freeze((options.aliases || []).slice())
    });
  }

  const SETTING_DEFS = Object.freeze([
    defineSetting('audioPreset', 'enum', { electron: 'standard', android: 'standard' }, { values: ['standard', 'high', 'low'] }),
    defineSetting('restoreLastState', 'boolean', { electron: true }),
    defineSetting('resumePlayback', 'boolean', { android: true }),
    defineSetting('rpcEnabled', 'boolean', { electron: true, android: false }),
    defineSetting('startupLaunch', 'boolean', { electron: false, android: false }),
    defineSetting('minimizeOnClose', 'boolean', { electron: true, android: false }),
    defineSetting('cacheEnabled', 'boolean', { electron: true, android: true }),
    defineSetting('hardwareAcceleration', 'boolean', { electron: true, android: true }),
    defineSetting('trayEnabled', 'boolean', { electron: true }),
    defineSetting('alwaysOnTop', 'boolean', { electron: false }),
    defineSetting('keyboardShortcutsEnabled', 'boolean', { electron: true }),
    defineSetting('autoAudioQuality', 'boolean', { electron: true, android: true }),
    defineSetting('compactUI', 'boolean', { electron: false, android: false }),
    defineSetting('taskbarControlsEnabled', 'boolean', { electron: true }),
    defineSetting('notificationControlsEnabled', 'boolean', { android: true }),
    defineSetting('videoDisplayEnabled', 'boolean', { electron: true, android: true }),
    defineSetting('crossfadeEnabled', 'boolean', { electron: false, android: false }),
    defineSetting('crossfadeDuration', 'number', { electron: 3, android: 3 }, { min: 1, max: 10, round: true }),
    defineSetting('gaplessEnabled', 'boolean', { electron: true, android: true }),
    defineSetting('seamlessPlayback', 'boolean', { electron: true, android: true }),
    defineSetting('volumeNormalization', 'boolean', { electron: false, android: false }),
    defineSetting('monoAudio', 'boolean', { electron: false, android: false })
  ]);

  const SETTINGS_MIGRATIONS = Object.freeze({});

  function assertPlatform(platform) {
    if (!ALL_PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
    return platform;
  }

  function defsFor(platform) {
    assertPlatform(platform);
    return SETTING_DEFS.filter((def) => def.platforms.includes(platform));
  }

  function coerceSetting(def, value, fallback) {
    if (def.type === 'boolean') return typeof value === 'boolean' ? value : fallback;
    if (def.type === 'enum') return typeof value === 'string' && def.values.includes(value) ? value : fallback;
    if (def.type === 'number') {
      const n = toNumber(value);
      if (!Number.isFinite(n)) return fallback;
      return clamp(def.round ? Math.round(n) : n, def.min, def.max);
    }
    return fallback;
  }

  function defaultSettings(platform) {
    const out = {};
    for (const def of defsFor(platform)) out[def.key] = def.defaults[platform];
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  function migrateSettings(raw, platform) {
    let source = { ...raw };
    let version = Number.isInteger(source.schemaVersion) && source.schemaVersion >= 1 ? source.schemaVersion : 1;
    while (version < SCHEMA_VERSION) {
      const step = SETTINGS_MIGRATIONS[version];
      if (typeof step === 'function') {
        const next = step(source, platform);
        if (isPlainObject(next)) source = next;
      }
      version += 1;
    }
    for (const def of defsFor(platform)) {
      if (source[def.key] !== undefined) continue;
      for (const alias of def.aliases) {
        if (source[alias] !== undefined) {
          source[def.key] = source[alias];
          break;
        }
      }
    }
    return source;
  }

  function normalizeSettings(raw, platform) {
    const source = isPlainObject(raw) ? migrateSettings(raw, platform) : {};
    const out = {};
    for (const def of defsFor(platform)) {
      out[def.key] = coerceSetting(def, source[def.key], def.defaults[platform]);
    }
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  function sanitizeSettingsPatch(partial, platform) {
    const out = {};
    if (!isPlainObject(partial)) return out;
    for (const def of defsFor(platform)) {
      if (!Object.prototype.hasOwnProperty.call(partial, def.key)) continue;
      const value = coerceSetting(def, partial[def.key], undefined);
      if (value !== undefined) out[def.key] = value;
    }
    return out;
  }

  function sanitizeWindowBounds(bounds) {
    if (!isPlainObject(bounds)) return null;
    const width = toNumber(bounds.width);
    const height = toNumber(bounds.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    const x = toNumber(bounds.x);
    const y = toNumber(bounds.y);
    return {
      x: Number.isFinite(x) ? clamp(Math.round(x), -100000, 100000) : undefined,
      y: Number.isFinite(y) ? clamp(Math.round(y), -100000, 100000) : undefined,
      width: clamp(Math.round(width), 900, 20000),
      height: clamp(Math.round(height), 600, 20000),
      maximized: !!bounds.maximized
    };
  }

  function defaultRuntimeState() {
    return {
      windowBounds: null,
      lastPlaylist: null,
      lastCurrentIndex: 0,
      lastPlayMode: 'order',
      lastVolume: 1,
      lastSpeed: 1,
      lastTrackId: null,
      lastTime: 0,
      isPlaying: false
    };
  }

  function normalizeRuntimeState(raw) {
    const s = isPlainObject(raw) ? raw : {};
    const base = defaultRuntimeState();
    const index = toNumber(s.lastCurrentIndex);
    const volume = toNumber(s.lastVolume);
    const speed = toNumber(s.lastSpeed);
    const time = toNumber(s.lastTime);
    return {
      windowBounds: sanitizeWindowBounds(s.windowBounds),
      lastPlaylist: cleanString(s.lastPlaylist, MAX_PLAYLIST_LENGTH),
      lastCurrentIndex: Number.isFinite(index) ? clamp(Math.floor(index), 0, 1000000) : base.lastCurrentIndex,
      lastPlayMode: PLAY_MODES.includes(s.lastPlayMode) ? s.lastPlayMode : base.lastPlayMode,
      lastVolume: Number.isFinite(volume) ? clamp(volume, 0, 1) : base.lastVolume,
      lastSpeed: Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.25, 4) : base.lastSpeed,
      lastTrackId: cleanString(s.lastTrackId, MAX_ID_LENGTH),
      lastTime: Number.isFinite(time) ? clamp(time, 0, 10000000) : base.lastTime,
      isPlaying: typeof s.isPlaying === 'boolean' ? s.isPlaying : base.isPlaying
    };
  }

  function sanitizeRuntimeStateInput(partial) {
    const out = {};
    if (!isPlainObject(partial)) return out;
    if (partial.windowBounds !== undefined && partial.windowBounds !== null) {
      const bounds = sanitizeWindowBounds(partial.windowBounds);
      if (bounds) out.windowBounds = bounds;
    }
    if (typeof partial.lastPlaylist === 'string' && partial.lastPlaylist.length <= MAX_PLAYLIST_LENGTH) {
      out.lastPlaylist = partial.lastPlaylist;
    }
    const index = toNumber(partial.lastCurrentIndex);
    if (Number.isFinite(index)) out.lastCurrentIndex = clamp(Math.floor(index), 0, 1000000);
    if (PLAY_MODES.includes(partial.lastPlayMode)) out.lastPlayMode = partial.lastPlayMode;
    const volume = toNumber(partial.lastVolume);
    if (Number.isFinite(volume)) out.lastVolume = clamp(volume, 0, 1);
    const speed = toNumber(partial.lastSpeed);
    if (Number.isFinite(speed) && speed > 0) out.lastSpeed = clamp(speed, 0.25, 4);
    if (typeof partial.lastTrackId === 'string' && partial.lastTrackId.length <= MAX_ID_LENGTH) {
      out.lastTrackId = partial.lastTrackId;
    }
    const time = toNumber(partial.lastTime);
    if (Number.isFinite(time)) out.lastTime = clamp(time, 0, 10000000);
    if (typeof partial.isPlaying === 'boolean') out.isPlaying = partial.isPlaying;
    return out;
  }

  function normalizeSessionState(raw) {
    if (!isPlainObject(raw)) return null;
    const out = {};
    if (typeof raw.playlist === 'string' && raw.playlist.length <= MAX_PLAYLIST_LENGTH) out.playlist = raw.playlist;
    const index = toNumber(raw.index);
    if (Number.isFinite(index)) out.index = clamp(Math.floor(index), 0, 1000000);
    if (typeof raw.trackId === 'string' && raw.trackId.length > 0 && raw.trackId.length <= MAX_ID_LENGTH) out.trackId = raw.trackId;
    if (PLAY_MODES.includes(raw.playMode)) out.playMode = raw.playMode;
    if (Array.isArray(raw.shuffleOrder)) {
      out.shuffleOrder = raw.shuffleOrder
        .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)
        .slice(0, MAX_SHUFFLE_ORDER_LENGTH);
    }
    const time = toNumber(raw.time);
    if (Number.isFinite(time)) out.time = clamp(time, 0, 10000000);
    const speed = toNumber(raw.speed);
    if (Number.isFinite(speed) && speed > 0) out.speed = clamp(speed, 0.5, 2);
    const volume = toNumber(raw.volume);
    if (Number.isFinite(volume)) out.volume = clamp(volume, 0, 1);
    if (typeof raw.wasPlaying === 'boolean') out.wasPlaying = raw.wasPlaying;
    if (typeof raw.sidebarOpen === 'boolean') out.sidebarOpen = raw.sidebarOpen;
    if (typeof raw.settingsOpen === 'boolean') out.settingsOpen = raw.settingsOpen;
    return out;
  }

  return Object.freeze({
    SCHEMA_VERSION,
    PLATFORM_ELECTRON,
    PLATFORM_ANDROID,
    PLAY_MODES,
    SETTING_DEFS,
    isPlainObject,
    safeJsonParse,
    defsFor,
    defaultSettings,
    normalizeSettings,
    sanitizeSettingsPatch,
    sanitizeWindowBounds,
    defaultRuntimeState,
    normalizeRuntimeState,
    sanitizeRuntimeStateInput,
    normalizeSessionState
  });
}));
