const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell, session, Tray, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const RPC = require('discord-rpc');

const DISCORD_CLIENT_ID = '1489154338705375242';
const APP_ID = 'io.github.takkunlego0916.playpocket';

const DEFAULT_SETTINGS = {
  audioPreset: 'standard',
  rpcEnabled: true,
  startupLaunch: false,
  minimizeOnClose: true,
  cacheEnabled: true,
  hardwareAcceleration: true,
  restoreLastState: true,
  trayEnabled: true,
  alwaysOnTop: false,
  keyboardShortcutsEnabled: true
};

function resolveAppDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'PlayPocket');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'PlayPocket');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'PlayPocket');
}

const APP_DATA_DIR = resolveAppDataDir();
const SETTINGS_PATH = path.join(APP_DATA_DIR, 'settings.json');
const STATE_PATH = path.join(APP_DATA_DIR, 'state.json');
const CACHE_DIR = path.join(APP_DATA_DIR, 'Cache');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    console.warn(`JSON読み込み失敗: ${filePath}`, e);
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`JSON保存失敗: ${filePath}`, e);
    return false;
  }
}

function sanitizeWindowBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const next = {
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    width: Math.max(900, Math.round(width)),
    height: Math.max(600, Math.round(height)),
    maximized: !!bounds.maximized
  };
  return next;
}

function boundsIntersectAnyDisplay(bounds) {
  if (!bounds) return false;
  const displays = screen.getAllDisplays();
  const left = bounds.x ?? 0;
  const top = bounds.y ?? 0;
  const right = left + bounds.width;
  const bottom = top + bounds.height;

  return displays.some((display) => {
    const d = display.bounds;
    const dx1 = d.x;
    const dy1 = d.y;
    const dx2 = d.x + d.width;
    const dy2 = d.y + d.height;
    const overlapX = Math.max(0, Math.min(right, dx2) - Math.max(left, dx1));
    const overlapY = Math.max(0, Math.min(bottom, dy2) - Math.max(top, dy1));
    return overlapX > 40 && overlapY > 40;
  });
}

function loadSettings() {
  const raw = safeReadJson(SETTINGS_PATH, {});
  const parsed = raw && typeof raw === 'object' ? raw : {};

  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    audioPreset: ['standard', 'high', 'low'].includes(parsed?.audioPreset) ? parsed.audioPreset : DEFAULT_SETTINGS.audioPreset,
    rpcEnabled: typeof parsed?.rpcEnabled === 'boolean' ? parsed.rpcEnabled : DEFAULT_SETTINGS.rpcEnabled,
    startupLaunch: typeof parsed?.startupLaunch === 'boolean' ? parsed.startupLaunch : DEFAULT_SETTINGS.startupLaunch,
    minimizeOnClose: typeof parsed?.minimizeOnClose === 'boolean' ? parsed.minimizeOnClose : DEFAULT_SETTINGS.minimizeOnClose,
    cacheEnabled: typeof parsed?.cacheEnabled === 'boolean' ? parsed.cacheEnabled : DEFAULT_SETTINGS.cacheEnabled,
    hardwareAcceleration: typeof parsed?.hardwareAcceleration === 'boolean' ? parsed.hardwareAcceleration : DEFAULT_SETTINGS.hardwareAcceleration,
    restoreLastState: typeof parsed?.restoreLastState === 'boolean' ? parsed.restoreLastState : DEFAULT_SETTINGS.restoreLastState,
    trayEnabled: typeof parsed?.trayEnabled === 'boolean' ? parsed.trayEnabled : DEFAULT_SETTINGS.trayEnabled,
    alwaysOnTop: typeof parsed?.alwaysOnTop === 'boolean' ? parsed.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    keyboardShortcutsEnabled: typeof parsed?.keyboardShortcutsEnabled === 'boolean' ? parsed.keyboardShortcutsEnabled : DEFAULT_SETTINGS.keyboardShortcutsEnabled
  };
}

function sanitizeSettingsInput(partial = {}) {
  const out = {};

  if (typeof partial.audioPreset === 'string' && ['standard', 'high', 'low'].includes(partial.audioPreset)) {
    out.audioPreset = partial.audioPreset;
  }
  if (typeof partial.rpcEnabled === 'boolean') out.rpcEnabled = partial.rpcEnabled;
  if (typeof partial.startupLaunch === 'boolean') out.startupLaunch = partial.startupLaunch;
  if (typeof partial.minimizeOnClose === 'boolean') out.minimizeOnClose = partial.minimizeOnClose;
  if (typeof partial.cacheEnabled === 'boolean') out.cacheEnabled = partial.cacheEnabled;
  if (typeof partial.hardwareAcceleration === 'boolean') out.hardwareAcceleration = partial.hardwareAcceleration;
  if (typeof partial.restoreLastState === 'boolean') out.restoreLastState = partial.restoreLastState;
  if (typeof partial.trayEnabled === 'boolean') out.trayEnabled = partial.trayEnabled;
  if (typeof partial.alwaysOnTop === 'boolean') out.alwaysOnTop = partial.alwaysOnTop;
  if (typeof partial.keyboardShortcutsEnabled === 'boolean') out.keyboardShortcutsEnabled = partial.keyboardShortcutsEnabled;

  return out;
}

function loadRuntimeState() {
  const raw = safeReadJson(STATE_PATH, {});
  const parsed = raw && typeof raw === 'object' ? raw : {};

  const windowBounds = sanitizeWindowBounds(parsed.windowBounds);
  const lastVolume = Number(parsed.lastVolume);
  const lastSpeed = Number(parsed.lastSpeed);
  const lastCurrentIndex = Number(parsed.lastCurrentIndex);

  return {
    windowBounds,
    lastPlaylist: typeof parsed.lastPlaylist === 'string' ? parsed.lastPlaylist : null,
    lastCurrentIndex: Number.isFinite(lastCurrentIndex) ? Math.max(0, Math.floor(lastCurrentIndex)) : 0,
    lastPlayMode: ['order', 'shuffle', 'random'].includes(parsed?.lastPlayMode) ? parsed.lastPlayMode : 'order',
    lastVolume: Number.isFinite(lastVolume) ? Math.min(1, Math.max(0, lastVolume)) : 1,
    lastSpeed: Number.isFinite(lastSpeed) && lastSpeed > 0 ? Math.min(4, Math.max(0.25, lastSpeed)) : 1,
    lastTrackId: typeof parsed.lastTrackId === 'string' ? parsed.lastTrackId : null,
    lastTime: Number.isFinite(Number(parsed.lastTime)) ? Math.max(0, Number(parsed.lastTime)) : 0,
    isPlaying: typeof parsed.isPlaying === 'boolean' ? parsed.isPlaying : false
  };
}

function sanitizeRuntimeStateInput(partial = {}) {
  const out = {};
  if (partial.windowBounds) {
    const bounds = sanitizeWindowBounds(partial.windowBounds);
    if (bounds) out.windowBounds = bounds;
  }
  if (typeof partial.lastPlaylist === 'string') out.lastPlaylist = partial.lastPlaylist;
  if (Number.isFinite(Number(partial.lastCurrentIndex))) out.lastCurrentIndex = Math.max(0, Math.floor(Number(partial.lastCurrentIndex)));
  if (['order', 'shuffle', 'random'].includes(partial.lastPlayMode)) out.lastPlayMode = partial.lastPlayMode;
  if (Number.isFinite(Number(partial.lastVolume))) out.lastVolume = Math.min(1, Math.max(0, Number(partial.lastVolume)));
  if (Number.isFinite(Number(partial.lastSpeed)) && Number(partial.lastSpeed) > 0) out.lastSpeed = Math.min(4, Math.max(0.25, Number(partial.lastSpeed)));
  if (typeof partial.lastTrackId === 'string') out.lastTrackId = partial.lastTrackId;
  if (Number.isFinite(Number(partial.lastTime))) out.lastTime = Math.max(0, Number(partial.lastTime));
  if (typeof partial.isPlaying === 'boolean') out.isPlaying = partial.isPlaying;
  return out;
}

function mergeRuntimeState(partial = {}) {
  runtimeState = {
    ...runtimeState,
    ...sanitizeRuntimeStateInput(partial)
  };
  safeWriteJson(STATE_PATH, runtimeState);
  return runtimeState;
}

function resolveAppIcon() {
  const icoPath = path.join(__dirname, 'app', 'icons', 'appIcon.ico');
  const pngPath = path.join(__dirname, 'app', 'icons', 'appIcon.png');
  if (fs.existsSync(icoPath)) return nativeImage.createFromPath(icoPath);
  if (fs.existsSync(pngPath)) return nativeImage.createFromPath(pngPath);
  return null;
}

function isSafePath(base, full) {
  const rel = path.relative(base, full);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function shutdownRPC() {
  if (!rpc) return;
  try { rpc.clearActivity(); } catch (e) {}
  try { rpc.destroy(); } catch (e) {}
  rpc = null;
  rpcRetries = 0;
}

function initRPC() {
  if (!settings.rpcEnabled) return;
  if (rpc) return;

  rpcRetries = 0;
  rpc = new RPC.Client({ transport: 'ipc' });

  const capturedRpc = rpc;

  rpc.on('ready', () => {
    rpcRetries = 0;
    console.log('Discord RPC Ready');
  });

  rpc.on('disconnected', () => {
    console.log('RPC disconnected');
    if (!settings.rpcEnabled || isQuitting) return;

    if (rpcRetries < MAX_RPC_RETRIES) {
      rpcRetries++;
      console.log(`RPC 再接続試行 ${rpcRetries}/${MAX_RPC_RETRIES}`);
      setTimeout(() => {
        if (!settings.rpcEnabled || isQuitting) return;
        if (rpc !== capturedRpc) return;
        capturedRpc.login({ clientId: DISCORD_CLIENT_ID }).catch(console.error);
      }, 5000);
    } else {
      console.warn('RPC 再接続の上限に達しました。Discord が起動しているか確認してください。');
    }
  });

  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(console.error);
}

function ensureRPCState() {
  if (settings.rpcEnabled) initRPC();
  else shutdownRPC();
}

function updateTrayMenu() {
  if (!tray) return;

  const template = [
    { label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? 'ウィンドウを隠す' : 'ウィンドウを表示', click: () => toggleMainWindow() },
    { type: 'separator' },
    { label: '再生 / 一時停止', click: () => sendPlaybackCommand('toggle-play-pause') },
    { label: '前へ', click: () => sendPlaybackCommand('previous-track') },
    { label: '次へ', click: () => sendPlaybackCommand('next-track') },
    { label: '全画面切替', click: () => sendPlaybackCommand('toggle-fullscreen') },
    { type: 'separator' },
    { label: '終了', click: () => quitApp() }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip('PlayPocket');
}

function createTray() {
  if (tray || !settings.trayEnabled) return;

  const icon = resolveAppIcon();
  if (!icon) return;

  tray = new Tray(icon);
  tray.on('click', () => toggleMainWindow());
  updateTrayMenu();
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch (e) {}
  tray = null;
}

function applyTraySetting() {
  if (settings.trayEnabled) createTray();
  else destroyTray();
  updateTrayMenu();
}

function sendPlaybackCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playback-command', command);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

function quitApp() {
  isQuitting = true;
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  shutdownRPC();
  destroyTray();
  globalShortcut.unregisterAll();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mergeRuntimeState({ windowBounds: captureWindowBounds() });
    } catch (e) {}
  }
  app.quit();
}

function applyStartupSetting(enabled) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: !!enabled
      });
    }
  } catch (e) {
    console.warn('起動時自動起動設定失敗:', e);
  }
}

function captureWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return runtimeState.windowBounds || null;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  return sanitizeWindowBounds({
    ...bounds,
    maximized
  });
}

let settings = loadSettings();
let runtimeState = loadRuntimeState();
let rpc = null;
let mainWindow = null;
let tray = null;
let rpcRetries = 0;
let isQuitting = false;
const MAX_RPC_RETRIES = 10;
let windowStateSaveTimer = null;

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(APP_ID);
  } catch (e) {}
}

if (!settings.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

if (!settings.cacheEnabled) {
  app.commandLine.appendSwitch('disable-http-cache');
} else {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    app.commandLine.appendSwitch('disk-cache-dir', CACHE_DIR);
  } catch (e) {
    console.warn('キャッシュディレクトリ設定失敗:', e);
  }
}

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function queueWindowStateSave() {
  if (!settings.restoreLastState) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    mergeRuntimeState({ windowBounds: captureWindowBounds() });
  }, 300);
}

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  if (!settings.keyboardShortcutsEnabled) return;

  const shortcuts = [
    ['MediaPlayPause', () => sendPlaybackCommand('toggle-play-pause')],
    ['MediaNextTrack', () => sendPlaybackCommand('next-track')],
    ['MediaPreviousTrack', () => sendPlaybackCommand('previous-track')],
    ['F11', () => sendPlaybackCommand('toggle-fullscreen')],
    ['CommandOrControl+Alt+P', () => toggleMainWindow()]
  ];

  for (const [accelerator, action] of shortcuts) {
    try {
      globalShortcut.register(accelerator, action);
    } catch (e) {
      console.warn(`ショートカット登録失敗: ${accelerator}`, e);
    }
  }
}

function createWindow() {
  const icon = resolveAppIcon();
  const savedBounds = settings.restoreLastState ? runtimeState.windowBounds : null;
  const useSavedBounds = savedBounds && boundsIntersectAnyDisplay(savedBounds);

  const windowOptions = {
    width: useSavedBounds ? savedBounds.width : 1200,
    height: useSavedBounds ? savedBounds.height : 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    alwaysOnTop: !!settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };

  if (useSavedBounds) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self' blob: data:",
            "img-src 'self' blob: data:",
            "media-src 'self' blob: data:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'"
          ].join('; ')
        ]
      }
    });
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('close', (e) => {
    if (!isQuitting && (settings.trayEnabled || settings.minimizeOnClose)) {
      e.preventDefault();
      hideMainWindow();
      try { mainWindow.minimize(); } catch (err) {}
    }
  });

  mainWindow.on('move', queueWindowStateSave);
  mainWindow.on('resize', queueWindowStateSave);
  mainWindow.on('maximize', queueWindowStateSave);
  mainWindow.on('unmaximize', queueWindowStateSave);

  Menu.setApplicationMenu(null);

  const indexPath = path.resolve(__dirname, 'app', 'index.html');
  if (!fs.existsSync(indexPath)) {
    mainWindow.loadURL('data:text/html,<h2>index.htmlが無い</h2>');
  } else {
    mainWindow.loadURL(`file://${indexPath.replace(/\\/g, '/')}`);
  }

  mainWindow.once('ready-to-show', () => {
    if (settings.restoreLastState && savedBounds?.maximized) {
      try { mainWindow.maximize(); } catch (e) {}
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on('set-rpc', (_, data = {}) => {
  if (!rpc || !settings.rpcEnabled) return;

  if (data?.paused) {
    try { rpc.clearActivity(); } catch (e) {}
    return;
  }

  const title = String(data.title || '再生中').slice(0, 128);
  const state = String(data.playlist || 'PlayPocketで再生中').slice(0, 128);
  const now = Date.now();
  const start = Number.isFinite(data.startTimestamp) ? data.startTimestamp : now;
  const end = Number.isFinite(data.endTimestamp) ? data.endTimestamp : undefined;

  try {
    rpc.setActivity({
      details: title,
      state,
      startTimestamp: start,
      endTimestamp: end,
      largeImageKey: 'app',
      largeImageText: 'PlayPocket',
      instance: false
    });
  } catch (e) {
    console.error('RPC error:', e);
  }
});

ipcMain.on('clear-rpc', () => {
  if (!rpc || !settings.rpcEnabled) return;
  try {
    rpc.clearActivity();
  } catch (e) {
    console.error('RPC clear error:', e);
  }
});

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('get-startup-state', () => {
  return {
    settings,
    runtimeState
  };
});

ipcMain.handle('set-settings', async (_, partial = {}) => {
  const next = {
    ...settings,
    ...sanitizeSettingsInput(partial)
  };

  const prev = settings;
  settings = next;
  safeWriteJson(SETTINGS_PATH, settings);

  if (prev.startupLaunch !== settings.startupLaunch) {
    applyStartupSetting(settings.startupLaunch);
  }

  if (prev.cacheEnabled !== settings.cacheEnabled) {
    try {
      if (!settings.cacheEnabled) {
        await session.defaultSession.clearCache();
      }
    } catch (e) {
      console.warn('キャッシュ切り替え処理失敗:', e);
    }
  }

  if (prev.rpcEnabled !== settings.rpcEnabled) {
    if (!settings.rpcEnabled) shutdownRPC();
    else ensureRPCState();
  }

  if (prev.alwaysOnTop !== settings.alwaysOnTop && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAlwaysOnTop(!!settings.alwaysOnTop); } catch (e) {}
  }

  if (prev.trayEnabled !== settings.trayEnabled) {
    applyTraySetting();
  }

  if (prev.keyboardShortcutsEnabled !== settings.keyboardShortcutsEnabled) {
    registerGlobalShortcuts();
  }

  return settings;
});

ipcMain.handle('save-runtime-state', async (_, partial = {}) => {
  const next = mergeRuntimeState(partial);
  return next;
});

ipcMain.handle('clear-browser-cache', async () => {
  await session.defaultSession.clearCache();
  return true;
});

ipcMain.handle('open-external', async (_, url) => {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(() => {
  applyStartupSetting(settings.startupLaunch);
  ensureRPCState();
  createWindow();
  applyTraySetting();
  registerGlobalShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  try {
    mergeRuntimeState({ windowBounds: captureWindowBounds() });
  } catch (e) {}
  shutdownRPC();
  destroyTray();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (settings.trayEnabled) return;
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('read-file', async (_, relativePath) => {
  try {
    if (typeof relativePath !== 'string') throw new Error('Invalid path type');
    const base = APP_DATA_DIR;
    const full = path.resolve(base, relativePath);
    if (!isSafePath(base, full)) throw new Error('Access denied');
    return fs.readFileSync(full, 'utf8');
  } catch (e) {
    console.error('read-file error:', e);
    throw e;
  }
});

ipcMain.handle('write-file', async (_, relativePath, data) => {
  try {
    if (typeof relativePath !== 'string') throw new Error('Invalid path type');
    if (typeof data !== 'string') throw new Error('Invalid data type: data must be a string');
    const base = APP_DATA_DIR;
    const full = path.resolve(base, relativePath);
    if (!isSafePath(base, full)) throw new Error('Access denied');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data, 'utf8');
    return true;
  } catch (e) {
    console.error('write-file error:', e);
    throw e;
  }
});

ipcMain.handle('get-app-paths', () => {
  return {
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    home: app.getPath('home'),
    temp: app.getPath('temp'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents')
  };
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
