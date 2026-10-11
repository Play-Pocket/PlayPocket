(function () {
  'use strict';

  const PP = window.PP = window.PP || {};

  const C = Object.freeze({
    DB_NAME: 'offline-playlist-db',
    DB_VERSION: 1,
    STORE_VIDEOS: 'videos',
    STORE_PLAYLISTS: 'playlists',
    MAX_PLAYLIST_NAME_LENGTH: 80,
    MAX_IMPORTED_ITEMS: 500,
    MAX_IMPORTED_JSON_BYTES: 50 * 1024 * 1024,
    MAX_VIDEO_FILES_PER_DROP: 100,
    MAX_THUMBNAIL_LENGTH: 2000000,
    PLACEHOLDER_THUMB: `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90'><rect width='160' height='90' fill='#1b1b1b'/><circle cx='70' cy='58' r='9' fill='#1db954'/><rect x='77' y='26' width='4' height='32' fill='#1db954'/><path d='M81 26 q15 4 15 17 q-7 -9 -15 -9z' fill='#1db954'/></svg>")}`,
    SHARE_PACKAGE_EXTENSION: '.playpocket.json',
    BASE64_CHUNK_BYTES: 3 * 1024 * 1024,
    NORMALIZATION_TARGET_RMS: 0.12,
    NORMALIZATION_MAX_ANALYZE_BYTES: 150 * 1024 * 1024,
    ENGINE_PREBUFFER_LEAD_SECONDS: 2.4,
    LOAD_READY_TIMEOUT_MS: 8000,
    STANDBY_READY_TIMEOUT_MS: 4000,
    STATE_SAVE_DEBOUNCE_MS: 250,
    STATE_PERIODIC_SAVE_MS: 10000,
    ALLOWED_THUMB_PREFIXES: Object.freeze([
      'data:image/jpeg;base64,',
      'data:image/png;base64,',
      'data:image/webp;base64,',
      'data:image/gif;base64,'
    ]),
    ALLOWED_VIDEO_TYPES: new Set([
      'video/mp4',
      'video/webm',
      'video/ogg',
      'video/x-matroska',
      'video/quicktime',
      'video/x-msvideo',
      'audio/mpeg',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/wav',
      'audio/x-wav',
      'audio/flac',
      'audio/x-flac',
      'audio/ogg',
      'audio/opus',
      'audio/webm'
    ]),
    VIDEO_EXTENSIONS: Object.freeze(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', '3gp']),
    AUDIO_EXTENSIONS: Object.freeze(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba']),
    EXTENSION_MIME: Object.freeze({
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      ogv: 'video/ogg',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      wav: 'audio/wav',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/opus',
      weba: 'audio/webm'
    })
  });

  const query = new URLSearchParams(window.location.search);
  const env = Object.freeze({
    dev: query.get('dev') === '1',
    isAndroid: /Android/i.test(navigator.userAgent),
    isElectron: !!window.electronAPI
  });

  const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const LOG_DEDUPE_MS = 5000;
  const logThreshold = env.dev ? LOG_LEVELS.debug : LOG_LEVELS.warn;
  const logRecent = new Map();

  function formatLogArg(arg) {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  function writeLog(level, scope, args) {
    if (LOG_LEVELS[level] < logThreshold) return;
    const text = args.map(formatLogArg).join(' ');
    const key = `${level}|${scope}|${text}`;
    const now = Date.now();
    const entry = logRecent.get(key);
    if (entry && now - entry.at < LOG_DEDUPE_MS) {
      entry.suppressed += 1;
      return;
    }
    const suppressed = entry ? entry.suppressed : 0;
    logRecent.set(key, { at: now, suppressed: 0 });
    if (logRecent.size > 200) logRecent.delete(logRecent.keys().next().value);
    const suffix = suppressed > 0 ? ` (+${suppressed} similar)` : '';
    const method = level === 'debug' ? 'log' : level;
    console[method](`[${scope}] ${text}${suffix}`);
  }

  const log = Object.freeze({
    debug: (scope, ...args) => writeLog('debug', scope, args),
    info: (scope, ...args) => writeLog('info', scope, args),
    warn: (scope, ...args) => writeLog('warn', scope, args),
    error: (scope, ...args) => writeLog('error', scope, args)
  });

  const CATEGORY = Object.freeze({
    USER_INPUT: 'user-input',
    DATABASE: 'database',
    PLAYBACK: 'playback',
    IMPORT_EXPORT: 'import-export',
    IPC: 'ipc',
    SYSTEM: 'system'
  });

  const POLICY = Object.freeze({
    'user-input': { level: 'info', notify: true },
    database: { level: 'error', notify: true },
    playback: { level: 'warn', notify: false },
    'import-export': { level: 'error', notify: true },
    ipc: { level: 'warn', notify: false },
    system: { level: 'error', notify: true }
  });

  class PPError extends Error {
    constructor(code, message, options = {}) {
      super(message || code);
      this.name = 'PPError';
      this.code = code;
      this.category = options.category || CATEGORY.SYSTEM;
      if (options.cause) this.cause = options.cause;
    }
  }

  const ui = {
    alert(message) {
      try {
        window.alert(message);
      } catch (error) {
        log.warn('ui', error);
      }
    },
    confirm(message) {
      try {
        return window.confirm(message);
      } catch (error) {
        log.warn('ui', error);
        return false;
      }
    }
  };

  function report(category, error, options = {}) {
    const policy = POLICY[category] || POLICY.system;
    log[policy.level](options.scope || category, error);
    const notify = options.notify === undefined ? policy.notify : options.notify;
    if (notify && options.message) ui.alert(options.message);
  }

  function guard(category, fn, options) {
    return function guarded(...args) {
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.catch((error) => report(category, error, options));
        }
        return result;
      } catch (error) {
        report(category, error, options);
        return undefined;
      }
    };
  }

  function safeText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  }

  function normalizePlaylistName(name) {
    const n = safeText(name);
    if (!n) return '';
    return n.length > C.MAX_PLAYLIST_NAME_LENGTH ? n.slice(0, C.MAX_PLAYLIST_NAME_LENGTH) : n;
  }

  function clampNumber(n, fallback = 0) {
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function mod(n, m) {
    return ((n % m) + m) % m;
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
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function sanitizeThumbnail(value) {
    if (typeof value !== 'string' || value === '') return null;
    if (value.length >= C.MAX_THUMBNAIL_LENGTH) return null;
    for (const prefix of C.ALLOWED_THUMB_PREFIXES) {
      if (value.startsWith(prefix)) return value;
    }
    return null;
  }

  function sanitizeMimeType(type) {
    if (typeof type === 'string' && C.ALLOWED_VIDEO_TYPES.has(type)) return type;
    return 'video/mp4';
  }

  function fileExtension(name) {
    if (typeof name !== 'string') return '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function isAudioFile(file) {
    if (!file) return false;
    if (typeof file.type === 'string' && file.type.startsWith('audio/')) return true;
    return C.AUDIO_EXTENSIONS.includes(fileExtension(file.name));
  }

  function resolveMimeType(file) {
    const type = file && typeof file.type === 'string' ? file.type : '';
    if (C.ALLOWED_VIDEO_TYPES.has(type)) return type;
    return C.EXTENSION_MIME[fileExtension(file && file.name)] || 'video/mp4';
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function isAudioMime(type) {
    return typeof type === 'string' && type.startsWith('audio/');
  }

  function displayTitle(name) {
    const text = safeText(name) || 'video';
    return text.replace(/\.[^/.]+$/, '');
  }

  function sanitizeFilename(value, fallback = 'playlist') {
    let filename = safeText(value).replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 120);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(filename)) filename = `_${filename}`;
    return filename || fallback;
  }

  function formatByteLimit(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      const rounded = Math.round(gb * 100) / 100;
      return `${rounded}GB`;
    }
    return `${Math.round(bytes / (1024 * 1024))}MB`;
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function byId(id) {
    return document.getElementById(id);
  }

  const listeners = new Map();
  const bus = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = listeners.get(name);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
        } catch (error) {
          report(CATEGORY.SYSTEM, error, { scope: `bus:${name}`, notify: false });
        }
      }
    }
  };

  PP.C = C;
  PP.env = env;
  PP.log = log;
  PP.CATEGORY = CATEGORY;
  PP.PPError = PPError;
  PP.report = report;
  PP.guard = guard;
  PP.ui = ui;
  PP.bus = bus;
  PP.util = Object.freeze({
    safeText,
    normalizePlaylistName,
    clampNumber,
    clamp,
    mod,
    uid,
    formatTime,
    sanitizeThumbnail,
    sanitizeMimeType,
    fileExtension,
    isAudioFile,
    isAudioMime,
    formatSize,
    resolveMimeType,
    displayTitle,
    sanitizeFilename,
    formatByteLimit,
    shuffleArray,
    delay,
    byId
  });

  PP.state = {
    currentPlaylist: null,
    items: [],
    currentIndex: -1,
    currentTrackId: null,
    playMode: 'order',
    shuffleOrder: [],
    wantPlaying: false
  };

  PP.cache = {
    videoInfo: new Map()
  };
}());
