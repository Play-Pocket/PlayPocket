const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell, session, Tray, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Schema = require('./app/shared/schema.js');
const CH = require('./main/channels.js');
const Validators = require('./main/validators.js');
const { createLogger } = require('./main/logger.js');
const { createJsonStore } = require('./main/storage.js');

const PLATFORM = Schema.PLATFORM_ELECTRON;
const IS_DEV = !app.isPackaged;
const TEST_MODE = IS_DEV && process.env.PLAYPOCKET_TEST_MODE === '1';
const log = createLogger({ isDev: IS_DEV });

const DISCORD_CLIENT_ID = '1489154338705375242';
const APP_ID = 'io.github.takkunlego0916.playpocket';
const MAX_RPC_RETRIES = 10;
const MAX_RENDERER_RECOVERIES = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60000;
const BLOCKED_REQUEST_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];

let RPC = null;
function loadDiscordRPC() {
  if (RPC !== null) return RPC;
  try {
    RPC = require('discord-rpc');
  } catch (error) {
    log.warn('rpc', 'discord-rpc の読み込みに失敗しました', error);
    RPC = false;
  }
  return RPC;
}

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

const settingsStore = createJsonStore({
  filePath: SETTINGS_PATH,
  backup: true,
  normalize: (raw) => Schema.normalizeSettings(raw, PLATFORM),
  sanitizePatch: (patch) => Schema.sanitizeSettingsPatch(patch, PLATFORM),
  debounceMs: 0,
  log
});

const stateStore = createJsonStore({
  filePath: STATE_PATH,
  backup: false,
  normalize: Schema.normalizeRuntimeState,
  sanitizePatch: Schema.sanitizeRuntimeStateInput,
  debounceMs: 300,
  log
});

let settings = settingsStore.load();
let runtimeState = stateStore.load();
let rpc = null;
let rpcReady = false;
let rpcRetryTimer = null;
let rpcPendingActivity = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let windowStateSaveTimer = null;
let lastKnownIsPlaying = false;
let cachedAppIcon;
let cachedThumbarIcons;
const rendererRecoveries = [];

function updateSettings(patch) {
  settings = settingsStore.merge(patch, { immediate: true });
  return settings;
}

function mergeRuntimeState(patch, options) {
  runtimeState = stateStore.merge(patch, options);
  return runtimeState;
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
    const overlapX = Math.max(0, Math.min(right, d.x + d.width) - Math.max(left, d.x));
    const overlapY = Math.max(0, Math.min(bottom, d.y + d.height) - Math.max(top, d.y));
    return overlapX > 40 && overlapY > 40;
  });
}

function resolveAppIcon() {
  if (cachedAppIcon !== undefined) return cachedAppIcon;
  const icoPath = path.join(__dirname, 'app', 'icons', 'appIcon.ico');
  const pngPath = path.join(__dirname, 'app', 'icons', 'appIcon.png');
  if (fs.existsSync(icoPath)) cachedAppIcon = nativeImage.createFromPath(icoPath);
  else if (fs.existsSync(pngPath)) cachedAppIcon = nativeImage.createFromPath(pngPath);
  else cachedAppIcon = null;
  return cachedAppIcon;
}

function resolveThumbarIcons() {
  if (cachedThumbarIcons !== undefined) return cachedThumbarIcons;
  const dir = path.join(__dirname, 'app', 'icons');
  const load = (name) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  };
  cachedThumbarIcons = {
    prev: load('thumb-prev.png'),
    play: load('thumb-play.png'),
    pause: load('thumb-pause.png'),
    next: load('thumb-next.png')
  };
  return cachedThumbarIcons;
}

function sendPlaybackCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CH.PLAYBACK_COMMAND, command);
}

function updateThumbar(isPlaying) {
  if (process.platform !== 'win32') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setThumbarButtons !== 'function') return;

  lastKnownIsPlaying = isPlaying;

  if (!settings.taskbarControlsEnabled) {
    try { mainWindow.setThumbarButtons([]); } catch {}
    return;
  }

  const icons = resolveThumbarIcons();

  try {
    mainWindow.setThumbarButtons([
      { tooltip: '前へ', icon: icons.prev, click: () => sendPlaybackCommand('previous-track') },
      {
        tooltip: isPlaying ? '一時停止' : '再生',
        icon: isPlaying ? icons.pause : icons.play,
        click: () => sendPlaybackCommand('toggle-play-pause')
      },
      { tooltip: '次へ', icon: icons.next, click: () => sendPlaybackCommand('next-track') }
    ]);
  } catch (error) {
    log.warn('thumbar', 'タスクバーボタンの更新に失敗しました', error);
  }
}

function flushRpcActivity() {
  if (!rpc || !rpcReady || !rpcPendingActivity) return;
  const payload = rpcPendingActivity;
  try {
    if (payload.paused) {
      Promise.resolve(rpc.clearActivity()).catch((error) => log.warn('rpc', error));
      return;
    }
    Promise.resolve(rpc.setActivity({
      details: payload.title,
      state: payload.playlist,
      startTimestamp: payload.startTimestamp,
      endTimestamp: payload.endTimestamp,
      largeImageKey: 'app',
      largeImageText: 'PlayPocket',
      instance: false
    })).catch((error) => log.warn('rpc', error));
  } catch (error) {
    log.warn('rpc', error);
  }
}

function clearRpcRetryTimer() {
  if (rpcRetryTimer) {
    clearTimeout(rpcRetryTimer);
    rpcRetryTimer = null;
  }
}

function shutdownRPC({ keepPending = false } = {}) {
  clearRpcRetryTimer();
  const current = rpc;
  rpc = null;
  rpcReady = false;
  if (!keepPending) rpcPendingActivity = null;
  if (!current) return;
  try { Promise.resolve(current.clearActivity()).catch(() => {}); } catch {}
  try { Promise.resolve(current.destroy()).catch(() => {}); } catch {}
}

function scheduleRpcRetry(attempt) {
  if (isQuitting || !settings.rpcEnabled) return;
  if (attempt >= MAX_RPC_RETRIES) {
    log.warn('rpc', 'RPC 再接続の上限に達しました。Discord が起動しているか確認してください。');
    return;
  }
  clearRpcRetryTimer();
  const delay = Math.min(30000, 5000 * (attempt + 1));
  rpcRetryTimer = setTimeout(() => {
    rpcRetryTimer = null;
    if (isQuitting || !settings.rpcEnabled || rpc) return;
    initRPC(attempt + 1);
  }, delay);
  if (typeof rpcRetryTimer.unref === 'function') rpcRetryTimer.unref();
}

function initRPC(attempt = 0) {
  if (!settings.rpcEnabled || rpc) return;

  const RPCLib = loadDiscordRPC();
  if (!RPCLib) return;

  const client = new RPCLib.Client({ transport: 'ipc' });
  rpc = client;
  rpcReady = false;

  let wasReady = false;

  client.on('ready', () => {
    if (rpc !== client) return;
    wasReady = true;
    rpcReady = true;
    log.debug('rpc', 'Discord RPC Ready');
    flushRpcActivity();
  });

  client.on('error', (error) => log.warn('rpc', error));

  client.on('disconnected', () => {
    if (rpc !== client) return;
    log.debug('rpc', 'RPC disconnected');
    shutdownRPC({ keepPending: true });
    scheduleRpcRetry(wasReady ? 0 : attempt);
  });

  client.login({ clientId: DISCORD_CLIENT_ID }).catch((error) => {
    if (rpc !== client) return;
    log.debug('rpc', error);
    shutdownRPC({ keepPending: true });
    scheduleRpcRetry(attempt);
  });
}

function ensureRPCState() {
  if (settings.rpcEnabled) initRPC();
  else shutdownRPC();
}

function isWindowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function updateTrayMenu() {
  if (!tray) return;

  const template = [
    { label: isWindowVisible() ? 'ウィンドウを隠す' : 'ウィンドウを表示', click: () => toggleMainWindow() },
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
  try { tray.destroy(); } catch {}
  tray = null;
}

function applyTraySetting() {
  if (settings.trayEnabled) createTray();
  else destroyTray();
  updateTrayMenu();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  updateTrayMenu();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) hideMainWindow();
  else showMainWindow();
}

function captureWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return runtimeState.windowBounds || null;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  return Schema.sanitizeWindowBounds({ ...bounds, maximized });
}

function persistWindowBounds(options) {
  const bounds = captureWindowBounds();
  if (bounds) mergeRuntimeState({ windowBounds: bounds }, options);
}

function clearWindowStateTimer() {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
}

function queueWindowStateSave() {
  if (!settings.restoreLastState) return;
  clearWindowStateTimer();
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    persistWindowBounds();
  }, 300);
}

function flushAllStores() {
  clearWindowStateTimer();
  try { persistWindowBounds(); } catch {}
  stateStore.flushSync();
  settingsStore.flushSync();
}

function quitApp() {
  isQuitting = true;
  shutdownRPC();
  destroyTray();
  globalShortcut.unregisterAll();
  flushAllStores();
  app.quit();
}

function applyStartupSetting(enabled) {
  if (!app.isPackaged) return;
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
    }
  } catch (error) {
    log.warn('startup', '起動時自動起動設定に失敗しました', error);
  }
}

function isMainWindowSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = mainWindow.webContents;
  if (event.sender !== contents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== contents.mainFrame) return false;
  return typeof frame.url === 'string' && frame.url.startsWith('file:');
}

function requireMainWindowSender(event) {
  if (!isMainWindowSender(event)) throw new Error('Unauthorized IPC sender');
}

function isAllowedPermissionRequest(webContents, permission) {
  return permission === 'clipboard-sanitized-write' &&
    Boolean(mainWindow) &&
    !mainWindow.isDestroyed() &&
    webContents === mainWindow.webContents &&
    webContents.getURL().startsWith('file:');
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
    } catch (error) {
      log.warn('shortcut', `ショートカット登録失敗: ${accelerator}`, error);
    }
  }
}

function shouldRecoverRenderer() {
  const now = Date.now();
  while (rendererRecoveries.length && now - rendererRecoveries[0] > RENDERER_RECOVERY_WINDOW_MS) {
    rendererRecoveries.shift();
  }
  if (rendererRecoveries.length >= MAX_RENDERER_RECOVERIES) return false;
  rendererRecoveries.push(now);
  return true;
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  };

  if (useSavedBounds) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  const win = new BrowserWindow(windowOptions);
  mainWindow = win;

  win.on('close', (event) => {
    if (isQuitting) return;

    if (settings.trayEnabled) {
      event.preventDefault();
      hideMainWindow();
    } else if (settings.minimizeOnClose) {
      event.preventDefault();
      try { win.minimize(); } catch {}
    }
  });

  win.on('move', queueWindowStateSave);
  win.on('resize', queueWindowStateSave);
  win.on('maximize', queueWindowStateSave);
  win.on('unmaximize', queueWindowStateSave);

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer', `render-process-gone: ${details.reason}`);
    if (isQuitting || details.reason === 'clean-exit') return;
    if (!shouldRecoverRenderer()) return;
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 500);
  });

  const indexPath = path.resolve(__dirname, 'app', 'index.html');
  win.loadFile(indexPath, IS_DEV ? { query: { dev: '1' } } : undefined).catch((error) => {
    log.error('window', 'index.html の読み込みに失敗しました', error);
  });

  win.once('ready-to-show', () => {
    if (TEST_MODE) return;
    if (settings.restoreLastState && savedBounds?.maximized) {
      try { win.maximize(); } catch {}
    }
    win.show();
    win.focus();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function applySettingsSideEffects(prev, next) {
  if (TEST_MODE) return;
  if (prev.startupLaunch !== next.startupLaunch) applyStartupSetting(next.startupLaunch);

  if (prev.cacheEnabled !== next.cacheEnabled && !next.cacheEnabled) {
    session.defaultSession.clearCache().catch((error) => log.warn('cache', 'キャッシュ切り替え処理失敗', error));
  }

  if (prev.rpcEnabled !== next.rpcEnabled) ensureRPCState();

  if (prev.alwaysOnTop !== next.alwaysOnTop && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAlwaysOnTop(!!next.alwaysOnTop); } catch {}
  }

  if (prev.trayEnabled !== next.trayEnabled) applyTraySetting();
  if (prev.keyboardShortcutsEnabled !== next.keyboardShortcutsEnabled) registerGlobalShortcuts();
  if (prev.taskbarControlsEnabled !== next.taskbarControlsEnabled) updateThumbar(lastKnownIsPlaying);
}

function registerIpcHandlers() {
  ipcMain.on(CH.RPC_SET, (event, data) => {
    if (!isMainWindowSender(event)) return;
    if (!settings.rpcEnabled) return;
    const payload = Validators.sanitizeRpcPayload(data);
    if (!payload) return;
    rpcPendingActivity = payload;
    flushRpcActivity();
  });

  ipcMain.on(CH.RPC_CLEAR, (event) => {
    if (!isMainWindowSender(event)) return;
    rpcPendingActivity = { paused: true };
    flushRpcActivity();
  });

  ipcMain.on(CH.PLAYBACK_STATE, (event, data) => {
    if (!isMainWindowSender(event)) return;
    const state = Validators.sanitizePlaybackState(data);
    if (state) updateThumbar(state.isPlaying);
  });

  ipcMain.on(CH.STATE_SAVE_FINAL, (event, partial) => {
    if (!isMainWindowSender(event)) return;
    mergeRuntimeState(partial, { immediate: true });
  });

  ipcMain.handle(CH.SETTINGS_GET, (event) => {
    requireMainWindowSender(event);
    return settings;
  });

  ipcMain.handle(CH.STARTUP_STATE, (event) => {
    requireMainWindowSender(event);
    return { settings, runtimeState };
  });

  ipcMain.handle(CH.SETTINGS_SET, (event, partial) => {
    requireMainWindowSender(event);
    const patch = Schema.sanitizeSettingsPatch(partial, PLATFORM);
    if (Object.keys(patch).length === 0) return settings;
    const prev = settings;
    const next = updateSettings(patch);
    applySettingsSideEffects(prev, next);
    return next;
  });

  ipcMain.handle(CH.STATE_SAVE, (event, partial) => {
    requireMainWindowSender(event);
    mergeRuntimeState(partial);
    return true;
  });

  ipcMain.handle(CH.CACHE_CLEAR, async (event) => {
    requireMainWindowSender(event);
    await session.defaultSession.clearCache();
    return true;
  });

  ipcMain.handle(CH.EXTERNAL_OPEN, async (event, url) => {
    requireMainWindowSender(event);
    const safeUrl = Validators.sanitizeExternalUrl(url);
    if (!safeUrl) return false;
    await shell.openExternal(safeUrl);
    return true;
  });
}

if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_ID); } catch {}
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
  } catch (error) {
    log.warn('cache', 'キャッシュディレクトリ設定失敗', error);
  }
}

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
Menu.setApplicationMenu(null);

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (navEvent) => navEvent.preventDefault());
  contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
});

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isAllowedPermissionRequest(webContents, permission));
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    return Boolean(webContents && isAllowedPermissionRequest(webContents, permission));
  });
  ses.webRequest.onBeforeRequest({ urls: BLOCKED_REQUEST_URLS }, (_details, callback) => {
    callback({ cancel: true });
  });

  registerIpcHandlers();
  createWindow();

  if (!TEST_MODE) {
    applyTraySetting();
    registerGlobalShortcuts();
    updateThumbar(false);

    setImmediate(() => {
      applyStartupSetting(settings.startupLaunch);
      ensureRPCState();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  shutdownRPC();
  destroyTray();
  globalShortcut.unregisterAll();
  flushAllStores();
});

app.on('will-quit', () => {
  stateStore.flushSync();
  settingsStore.flushSync();
});

app.on('window-all-closed', () => {
  if (settings.trayEnabled) return;
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  log.error('process', 'Uncaught Exception', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('process', 'Unhandled Rejection', reason);
});
