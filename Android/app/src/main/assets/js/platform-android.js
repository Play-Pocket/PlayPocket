(function () {
  'use strict';

  const PP = window.PP;
  const { util, log } = PP;
  const bridge = window.AndroidBridge || null;

  const SETTINGS_KEY = 'playpocket-settings-v1';
  const SESSION_KEY = 'playpocket-session-v2';
  const EMBEDDED_EXPORT_LIMIT_BYTES = 150 * 1024 * 1024;
  const SAVE_CHUNK_BYTES = 384 * 1024;
  const SAVE_PICKER_TIMEOUT_MS = 10 * 60 * 1000;
  const TITLE_LIMIT = 200;
  const COMMANDS = new Set(['previous-track', 'next-track', 'toggle-play-pause']);
  const DESKTOP_ONLY_SETTINGS = ['rpcEnabled', 'startupLaunch', 'minimizeOnClose', 'hardwareAcceleration'];

  const el = {
    sidebar: document.querySelector('.sidebar'),
    overlay: util.byId('overlay'),
    menuToggle: util.byId('menuToggle'),
    settingsModal: util.byId('settingsModal')
  };

  const saveWaiters = new Map();
  let saveCounter = 0;
  let lastReportedPlayback = null;

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = PPSchema.safeJsonParse(raw);
      return PPSchema.isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      log.warn('storage', error);
      return false;
    }
  }

  function cleanTitle(title) {
    return util.safeText(typeof title === 'string' ? title : '').slice(0, TITLE_LIMIT);
  }

  function isSidebarOpen() {
    return !!el.sidebar && el.sidebar.classList.contains('open');
  }

  function isSettingsOpen() {
    return !!el.settingsModal && el.settingsModal.classList.contains('open');
  }

  function openSidebar() {
    if (el.sidebar) el.sidebar.classList.add('open');
    if (el.overlay) el.overlay.classList.add('active');
    PP.player.scheduleSessionSave();
  }

  function closeSidebar() {
    if (el.sidebar) el.sidebar.classList.remove('open');
    if (el.overlay) el.overlay.classList.remove('active');
    PP.player.scheduleSessionSave();
  }

  function toggleSidebar() {
    if (isSidebarOpen()) closeSidebar();
    else openSidebar();
  }

  function buildSession(snapshot) {
    return {
      playlist: snapshot.playlist,
      index: snapshot.index,
      trackId: snapshot.trackId,
      playMode: snapshot.playMode,
      shuffleOrder: snapshot.shuffleOrder,
      time: snapshot.time,
      speed: snapshot.speed,
      volume: snapshot.volume,
      wasPlaying: snapshot.wasPlaying,
      sidebarOpen: isSidebarOpen(),
      settingsOpen: isSettingsOpen()
    };
  }

  function applyAvailability() {
    for (const id of DESKTOP_ONLY_SETTINGS) {
      const node = util.byId(id);
      if (node) node.disabled = true;
    }
    const notification = util.byId('notificationControlsEnabled');
    if (notification) {
      notification.disabled = false;
      const row = notification.closest('.settings-row');
      if (row) row.style.display = '';
    }
  }

  function notifyBridge(method, ...args) {
    try {
      if (bridge && typeof bridge[method] === 'function') return bridge[method](...args);
    } catch (error) {
      log.debug('bridge', method, error);
    }
    return undefined;
  }

  window.__ppOnSaveReady = function (id, ok) {
    const resolve = saveWaiters.get(String(id));
    if (resolve) {
      saveWaiters.delete(String(id));
      resolve(ok === true);
    }
  };

  window.__ppClosePanels = function () {
    try {
      return !!(PP.app && PP.app.closePanels());
    } catch {
      return false;
    }
  };

  async function saveFile(blob, filename) {
    if (!bridge || typeof bridge.beginSave !== 'function') return 'unsupported';

    saveCounter += 1;
    const id = `save-${Date.now().toString(36)}-${saveCounter}`;
    const readyPromise = new Promise((resolve) => {
      saveWaiters.set(id, resolve);
      setTimeout(() => {
        if (saveWaiters.has(id)) {
          saveWaiters.delete(id);
          resolve(false);
        }
      }, SAVE_PICKER_TIMEOUT_MS);
    });

    let started = false;
    try {
      started = bridge.beginSave(id, filename, blob.type || 'application/octet-stream', blob.size) === true;
    } catch (error) {
      log.warn('save', error);
    }
    if (!started) {
      saveWaiters.delete(id);
      return 'failed';
    }

    const ready = await readyPromise;
    if (!ready) return 'cancelled';

    try {
      for (let offset = 0; offset < blob.size; offset += SAVE_CHUNK_BYTES) {
        const text = await PP.media.sliceToBase64(blob.slice(offset, offset + SAVE_CHUNK_BYTES));
        if (bridge.writeSaveChunk(id, text) !== true) throw new Error('write failed');
      }
      return bridge.finishSave(id) === true ? 'saved' : 'failed';
    } catch (error) {
      log.warn('save', error);
      notifyBridge('cancelSave', id);
      return 'failed';
    }
  }

  PP.platform = Object.freeze({
    name: 'android',
    capabilities: Object.freeze({ keyboard: false, sidebar: true, fullscreenApi: true, extensionVideoFallback: true, flushOnHidden: true, renameGesture: 'dblclick' }),
    embeddedExportLimitBytes: EMBEDDED_EXPORT_LIMIT_BYTES,

    async loadStartup() {
      return {
        settings: readJson(SETTINGS_KEY),
        session: PPSchema.normalizeSessionState(readJson(SESSION_KEY))
      };
    },

    restoreEnabled(settings) {
      return !!settings.resumePlayback;
    },

    async saveSettings(patch) {
      const current = PPSchema.normalizeSettings(readJson(SETTINGS_KEY), 'android');
      const next = PPSchema.normalizeSettings({ ...current, ...patch }, 'android');
      writeJson(SETTINGS_KEY, next);
      if (Object.prototype.hasOwnProperty.call(patch, 'notificationControlsEnabled')) {
        notifyBridge('setNotificationControlsEnabled', !!next.notificationControlsEnabled);
      }
      return next;
    },

    async saveSession(snapshot) {
      writeJson(SESSION_KEY, buildSession(snapshot));
    },

    saveSessionFinal(snapshot) {
      writeJson(SESSION_KEY, buildSession(snapshot));
    },

    reportPlaybackState({ isPlaying, title }) {
      const safeTitle = cleanTitle(title);
      const key = `${isPlaying ? 1 : 0}|${safeTitle}`;
      if (key === lastReportedPlayback) return;
      lastReportedPlayback = key;
      notifyBridge('updatePlaybackState', !!isPlaying, safeTitle);
    },

    setPresence() {},
    clearPresence() {},

    async clearCache() {
      if (!bridge || typeof bridge.clearCache !== 'function') return false;
      bridge.clearCache();
      return true;
    },

    async openExternal(url) {
      if (bridge && typeof bridge.openExternal === 'function') {
        bridge.openExternal(url);
        return true;
      }
      return false;
    },

    onCommand(handler) {
      window.__ppHandlePlaybackCommand = function (command) {
        if (typeof command === 'string' && COMMANDS.has(command)) handler(command);
      };
      return () => {
        delete window.__ppHandlePlaybackCommand;
      };
    },

    closePanels() {
      if (!isSidebarOpen()) return false;
      closeSidebar();
      return true;
    },

    afterRestore(session) {
      applyAvailability();
      notifyBridge('setNotificationControlsEnabled', !!PP.settings.get().notificationControlsEnabled);
      if (!session) return;
      if (session.sidebarOpen === true) openSidebar();
      else if (session.sidebarOpen === false) closeSidebar();
      if (session.settingsOpen === true) PP.app.openSettings();
      else if (session.settingsOpen === false) PP.app.closeSettings();
    },

    saveFile
  });

  if (el.menuToggle) el.menuToggle.addEventListener('click', toggleSidebar);
  if (el.overlay) el.overlay.addEventListener('click', closeSidebar);
  PP.bus.on('library:playlist-selected', closeSidebar);
}());
