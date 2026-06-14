const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');

const execFileAsync = promisify(execFile);

const APP_ID = 'io.github.takkunlego0916.playpocket.installer';
const PRODUCT_NAME = 'PlayPocket';
const INSTALL_FOLDER_NAME = 'PlayPocket';

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(APP_ID);
  } catch {}
}

let mainWindow = null;
let state = {
  sourceDir: '',
  installDir: ''
};

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getUserDataDir() {
  return path.join(app.getPath('userData'), 'installer');
}

function getStatePath() {
  return path.join(getUserDataDir(), 'state.json');
}

function getDefaultSourceDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'release');
  }
  return path.resolve(__dirname, 'release');
}

function getDefaultInstallDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', INSTALL_FOLDER_NAME);
}

function getDesktopShortcutPath() {
  return path.join(app.getPath('desktop'), `${PRODUCT_NAME}.lnk`);
}

function getStartMenuShortcutDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', PRODUCT_NAME);
}

function getStartMenuShortcutPath() {
  return path.join(getStartMenuShortcutDir(), `${PRODUCT_NAME}.lnk`);
}

function getUninstallShortcutPath() {
  return path.join(getStartMenuShortcutDir(), `${PRODUCT_NAME} アンインストール.lnk`);
}

function getInstallerIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  return path.resolve(__dirname, 'build', 'icon.ico');
}


function compareVersions(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:log', message);
  }
}

async function existsDir(dir) {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function loadState() {
  const saved = await readJson(getStatePath(), {});
  state = {
    sourceDir: typeof saved.sourceDir === 'string' && saved.sourceDir ? saved.sourceDir : getDefaultSourceDir(),
    installDir: typeof saved.installDir === 'string' && saved.installDir ? saved.installDir : getDefaultInstallDir()
  };
  return state;
}

async function saveState(next = {}) {
  state = {
    ...state,
    ...next
  };
  await writeJson(getStatePath(), state);
  return state;
}

async function walkFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function isExecutableNameAllowed(fileName) {
  const lower = fileName.toLowerCase();
  return !lower.includes('uninstall');
}

function extractVersionFromName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const match = base.match(/([0-9]+(?:\.[0-9]+)+)/);
  return match ? match[1] : null;
}

async function findLatestExe(dir) {
  if (!dir) return null;
  if (!(await existsDir(dir))) return null;

  const files = await walkFiles(dir);
  const exes = files.filter(f => f.toLowerCase().endsWith('.exe'));
  const filtered = exes.filter(f => isExecutableNameAllowed(path.basename(f)));

  if (!filtered.length) return null;

  const stats = await Promise.all(filtered.map(async (file) => {
    const st = await fsp.stat(file);
    return {
      file,
      name: path.basename(file),
      mtimeMs: st.mtimeMs,
      size: st.size,
      version: extractVersionFromName(file)
    };
  }));

  stats.sort((a, b) => {
    const aHasVer = a.version ? 1 : 0;
    const bHasVer = b.version ? 1 : 0;
    if (aHasVer !== bHasVer) return bHasVer - aHasVer;
    if (a.version && b.version) {
      const vCmp = compareVersions(a.version, b.version);
      if (vCmp !== 0) return vCmp;
    }
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.size - a.size;
  });

  return stats[0];
}

function isSameOrNested(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function createShortcut(shortcutPath, targetPath, workingDir, iconPath) {
  await ensureDir(path.dirname(shortcutPath));
  const script = [
    `$w = New-Object -ComObject WScript.Shell`,
    `$s = $w.CreateShortcut(${psQuote(shortcutPath)})`,
    `$s.TargetPath = ${psQuote(targetPath)}`,
    `$s.WorkingDirectory = ${psQuote(workingDir)}`,
    `$s.IconLocation = ${psQuote(`${iconPath},0`)}`,
    `$s.Save()`
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
}

async function removeFileSafe(filePath) {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {}
}

async function removeDirSafe(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {}
}

async function copyReleaseToInstall(sourceDir, installDir) {
  const sourceStat = await fsp.stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error('sourceDir is not a directory');
  }
  if (isSameOrNested(path.resolve(sourceDir), path.resolve(installDir))) {
    throw new Error('installDir must not be inside sourceDir');
  }

  sendLog('インストール先の既存ファイルをクリア中...');
  await removeDirSafe(installDir);
  await ensureDir(path.dirname(installDir));

  sendLog('ファイルをコピー中...');
  await fsp.cp(sourceDir, installDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true
  });
  sendLog('ファイルのコピーが完了しました');
}

async function getInstalledExe(installDir) {
  return findLatestExe(installDir);
}

async function syncShortcuts(installDir) {
  const installedExe = await getInstalledExe(installDir);
  if (!installedExe) return;

  const targetPath = installedExe.file;
  const workingDir = path.dirname(targetPath);
  const iconPath = targetPath;

  sendLog('デスクトップショートカットを作成中...');
  await createShortcut(getDesktopShortcutPath(), targetPath, workingDir, iconPath);

  sendLog('スタートメニューショートカットを作成中...');
  await createShortcut(getStartMenuShortcutPath(), targetPath, workingDir, iconPath);

  await ensureDir(getStartMenuShortcutDir());
  const uninstallTarget = process.execPath;
  await createShortcut(getUninstallShortcutPath(), uninstallTarget, path.dirname(uninstallTarget), uninstallTarget);

  sendLog('ショートカットの作成が完了しました');
}

async function removeShortcuts() {
  await removeFileSafe(getDesktopShortcutPath());
  await removeFileSafe(getStartMenuShortcutPath());
  await removeFileSafe(getUninstallShortcutPath());
  await removeDirSafe(getStartMenuShortcutDir());
}

async function buildStatus() {
  const sourceDir = state.sourceDir || getDefaultSourceDir();
  const installDir = state.installDir || getDefaultInstallDir();

  const sourceLatest = await findLatestExe(sourceDir);
  const installedLatest = await getInstalledExe(installDir);

  return {
    sourceDir,
    installDir,
    sourceExists: await existsDir(sourceDir),
    installExists: await existsDir(installDir),
    sourceLatestExe: sourceLatest ? sourceLatest.file : null,
    sourceLatestName: sourceLatest ? sourceLatest.name : null,
    sourceLatestVersion: sourceLatest ? sourceLatest.version : null,
    sourceLatestTime: sourceLatest ? sourceLatest.mtimeMs : null,
    installedExe: installedLatest ? installedLatest.file : null,
    installedName: installedLatest ? installedLatest.name : null,
    installedVersion: installedLatest ? installedLatest.version : null,
    installedTime: installedLatest ? installedLatest.mtimeMs : null,
    installedSize: installedLatest ? installedLatest.size : null
  };
}

async function performInstallLike(action, payload = {}) {
  const sourceDir = typeof payload.sourceDir === 'string' && payload.sourceDir ? payload.sourceDir : state.sourceDir || getDefaultSourceDir();
  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();

  await saveState({ sourceDir, installDir });

  const latest = await findLatestExe(sourceDir);
  if (!latest) {
    throw new Error('release フォルダ内に exe が見つかりません');
  }
  sendLog(`対象 exe: ${latest.name}${latest.version ? ` (v${latest.version})` : ''}`);

  await copyReleaseToInstall(sourceDir, installDir);
  await syncShortcuts(installDir);

  const message =
    action === 'repair' ? '修復が完了しました' :
    action === 'update'  ? 'アップデートが完了しました' :
                           'インストールが完了しました';
  return { action, message };
}

async function performUpdate(payload = {}) {
  const sourceDir = typeof payload.sourceDir === 'string' && payload.sourceDir ? payload.sourceDir : state.sourceDir || getDefaultSourceDir();
  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();

  await saveState({ sourceDir, installDir });

  const sourceLatest = await findLatestExe(sourceDir);
  if (!sourceLatest) {
    throw new Error('release フォルダ内に exe が見つかりません');
  }

  const installedLatest = await getInstalledExe(installDir);
  if (!installedLatest) {
    sendLog('未インストールのため、新規インストールを実行します...');
    await copyReleaseToInstall(sourceDir, installDir);
    await syncShortcuts(installDir);
    return { action: 'update', message: '未インストールだったため、新規インストールを実行しました' };
  }

  sendLog(`ソース:          ${sourceLatest.name}${sourceLatest.version ? ` (v${sourceLatest.version})` : ''}`);
  sendLog(`インストール済み: ${installedLatest.name}${installedLatest.version ? ` (v${installedLatest.version})` : ''}`);

  let isUpToDate = false;
  if (sourceLatest.version && installedLatest.version) {
    isUpToDate = compareVersions(sourceLatest.version, installedLatest.version) >= 0;
  } else {
    isUpToDate = sourceLatest.mtimeMs <= installedLatest.mtimeMs;
  }

  if (isUpToDate) {
    return { action: 'update', message: 'すでに最新です' };
  }

  await copyReleaseToInstall(sourceDir, installDir);
  await syncShortcuts(installDir);
  return { action: 'update', message: 'アップデートが完了しました' };
}

async function performUninstall(payload = {}) {
  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();

  sendLog('ショートカットを削除中...');
  await removeShortcuts();

  sendLog('インストールフォルダを削除中...');
  await removeDirSafe(installDir);

  await saveState({
    installDir,
    sourceDir: typeof payload.sourceDir === 'string' && payload.sourceDir ? payload.sourceDir : state.sourceDir || getDefaultSourceDir()
  });

  return { action: 'uninstall', message: 'アンインストールが完了しました' };
}

async function chooseSourceDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'release フォルダを選択',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function chooseInstallDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'インストール先を選択',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    title: 'PlayPocket Installer',
    backgroundColor: '#070b14',
    icon: getInstallerIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}


ipcMain.handle('installer:get-status', async () => buildStatus());

ipcMain.handle('installer:get-icon-path', async () => {
  const iconPath = getInstallerIconPath();
  if (!iconPath) return null;
  try {
    return pathToFileURL(iconPath).href;
  } catch {
    return null;
  }
});

ipcMain.handle('installer:choose-source-dir', async () => chooseSourceDir());

ipcMain.handle('installer:choose-install-dir', async () => chooseInstallDir());

ipcMain.handle('installer:set-source-dir', async (_, sourceDir) => {
  if (typeof sourceDir !== 'string' || !sourceDir) return false;
  await saveState({ sourceDir });
  return true;
});

ipcMain.handle('installer:set-install-dir', async (_, installDir) => {
  if (typeof installDir !== 'string' || !installDir) return false;
  await saveState({ installDir });
  return true;
});

ipcMain.handle('installer:install', async (_, payload) => performInstallLike('install', payload));

ipcMain.handle('installer:repair', async (_, payload) => performInstallLike('repair', payload));

ipcMain.handle('installer:update', async (_, payload) => performUpdate(payload));

ipcMain.handle('installer:uninstall', async (_, payload) => performUninstall(payload));

ipcMain.handle('installer:open-source-dir', async () => {
  const sourceDir = state.sourceDir || getDefaultSourceDir();
  await shell.openPath(sourceDir);
  return true;
});

ipcMain.handle('installer:open-install-dir', async () => {
  const installDir = state.installDir || getDefaultInstallDir();
  await shell.openPath(installDir);
  return true;
});

app.whenReady().then(async () => {
  await loadState();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
