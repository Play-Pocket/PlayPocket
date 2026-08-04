const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const execFileAsync = promisify(execFile);

const APP_ID = 'io.github.takkunlego0916.playpocket.installer';
const PRODUCT_NAME = 'PlayPocket';
const INSTALL_FOLDER_NAME = 'PlayPocket';

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Play-Pocket';
const GITHUB_REPO = process.env.GITHUB_REPO || 'PlayPocketRelease';
const GITHUB_ASSET_NAME = process.env.GITHUB_ASSET_NAME || '';
const GITHUB_ASSET_REGEX = process.env.GITHUB_ASSET_REGEX || '^PlayPocket\\.[0-9]+\\.[0-9]+\\.[0-9]+\\.exe$';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(APP_ID);
  } catch {}
}

let mainWindow = null;
let state = {
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

async function getInstallerIconDataUrl() {
  const iconPath = getInstallerIconPath();
  try {
    const buf = await fsp.readFile(iconPath);
    return `data:image/x-icon;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function normalizeVersionText(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function extractVersionFromText(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)+)/);
  return match ? match[1] : null;
}

function compareVersions(a, b) {
  const pa = normalizeVersionText(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = normalizeVersionText(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:progress', payload);
  }
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:status', payload);
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

async function findLatestExe(dir) {
  if (!dir) return null;
  if (!(await existsDir(dir))) return null;

  const files = await walkFiles(dir);
  const exes = files.filter((f) => f.toLowerCase().endsWith('.exe'));
  const filtered = exes.filter((f) => isExecutableNameAllowed(path.basename(f)));

  if (!filtered.length) return null;

  const stats = await Promise.all(filtered.map(async (file) => {
    const st = await fsp.stat(file);
    return {
      file,
      name: path.basename(file),
      mtimeMs: st.mtimeMs,
      size: st.size,
      version: extractVersionFromText(file)
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

async function createShortcut(shortcutPath, targetPath, workingDir, iconPath, argumentsText = '') {
  await ensureDir(path.dirname(shortcutPath));
  const script = [
    `$w = New-Object -ComObject WScript.Shell`,
    `$s = $w.CreateShortcut(${psQuote(shortcutPath)})`,
    `$s.TargetPath = ${psQuote(targetPath)}`,
    `$s.WorkingDirectory = ${psQuote(workingDir)}`,
    `$s.IconLocation = ${psQuote(`${iconPath},0`)}`,
    argumentsText ? `$s.Arguments = ${psQuote(argumentsText)}` : null,
    `$s.Save()`
  ].filter(Boolean).join('; ');
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

function getGitHubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'PlayPocket-Installer'
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

function isGitHubConfigured() {
  return Boolean(GITHUB_OWNER && GITHUB_REPO && GITHUB_OWNER !== 'YOUR_OWNER' && GITHUB_REPO !== 'YOUR_REPO');
}

function selectReleaseAsset(assets) {
  if (!Array.isArray(assets) || !assets.length) return null;

  if (GITHUB_ASSET_NAME) {
    const exact = assets.find((asset) => asset.name === GITHUB_ASSET_NAME);
    if (exact) return exact;
  }

  if (GITHUB_ASSET_REGEX) {
    try {
      const regex = new RegExp(GITHUB_ASSET_REGEX, 'i');
      const matched = assets.find((asset) => regex.test(asset.name));
      if (matched) return matched;
    } catch {}
  }

  const exeAsset = assets.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
  if (exeAsset) return exeAsset;

  const zipAsset = assets.find((asset) => asset.name.toLowerCase().endsWith('.zip'));
  if (zipAsset) return zipAsset;

  return assets[0];
}

function getReleaseVersion(release, asset) {
  return (
    extractVersionFromText(release?.tag_name) ||
    extractVersionFromText(release?.name) ||
    extractVersionFromText(asset?.name) ||
    null
  );
}

async function fetchLatestRelease() {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub Releases の設定がありません');
  }

  const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
    headers: getGitHubHeaders()
  });

  if (!response.ok) {
    throw new Error(`GitHub API エラー: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadToFile(url, destPath, onProgress) {
  const response = await fetch(url, {
    headers: {
      ...getGitHubHeaders(),
      Accept: 'application/octet-stream'
    }
  });

  if (!response.ok) {
    throw new Error(`ダウンロード失敗: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('ダウンロードデータを取得できませんでした');
  }

  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;

  const reader = response.body.getReader();
  await ensureDir(path.dirname(destPath));
  const file = fs.createWriteStream(destPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      file.write(Buffer.from(value));
      if (typeof onProgress === 'function') {
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
        onProgress({
          phase: 'download',
          percent,
          loaded: received,
          total
        });
      }
    }
  } finally {
    file.end();
  }

  await new Promise((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

async function expandZip(zipPath, destDir) {
  await ensureDir(destDir);
  const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
}

function getCacheRoot() {
  return path.join(getUserDataDir(), 'github-cache');
}

function safeSegment(text) {
  return String(text || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function prepareGithubSource() {
  const release = await fetchLatestRelease();
  const asset = selectReleaseAsset(release.assets || []);
  if (!asset) {
    throw new Error('GitHub Releases に使えるアセットが見つかりません');
  }

  const version = getReleaseVersion(release, asset);
  const workDir = path.join(getCacheRoot(), safeSegment(release.tag_name || release.id || 'latest'));
  await removeDirSafe(workDir);
  await ensureDir(workDir);

  const downloadedPath = path.join(workDir, asset.name);
  sendProgress({
    phase: 'download',
    percent: 0,
    title: 'ダウンロード中...',
    detail: asset.name
  });

  await downloadToFile(asset.browser_download_url, downloadedPath, (info) => {
    sendProgress({
      phase: 'download',
      percent: info.percent,
      title: 'ダウンロード中...',
      detail: asset.name
    });
  });

  let sourceDir = workDir;
  if (asset.name.toLowerCase().endsWith('.zip')) {
    sendProgress({
      phase: 'extract',
      percent: 100,
      title: '展開中...',
      detail: asset.name
    });
    const extractedDir = path.join(workDir, 'extracted');
    await removeDirSafe(extractedDir);
    await expandZip(downloadedPath, extractedDir);
    sourceDir = extractedDir;
  }

  return {
    release,
    asset,
    version,
    sourceDir
  };
}

async function copyReleaseToInstall(sourceDir, installDir) {
  const sourceStat = await fsp.stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error('sourceDir is not a directory');
  }

  const resolvedSource = path.resolve(sourceDir);
  const resolvedInstall = path.resolve(installDir);

  if (isSameOrNested(resolvedSource, resolvedInstall)) {
    throw new Error('installDir must not be inside sourceDir');
  }

  sendProgress({
    phase: 'copy',
    percent: 100,
    title: 'インストール中...',
    detail: 'ファイルを配置しています'
  });

  await removeDirSafe(installDir);
  await ensureDir(path.dirname(installDir));

  await fsp.cp(sourceDir, installDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true
  });
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

  sendProgress({
    phase: 'shortcut',
    percent: 100,
    title: 'ショートカット作成中...',
    detail: 'デスクトップとスタートメニューを更新しています'
  });

  await createShortcut(getDesktopShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(getStartMenuShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(
    getUninstallShortcutPath(),
    process.execPath,
    path.dirname(process.execPath),
    getInstallerIconPath(),
    '--uninstall'
  );
}

async function removeShortcuts() {
  await removeFileSafe(getDesktopShortcutPath());
  await removeFileSafe(getStartMenuShortcutPath());
  await removeFileSafe(getUninstallShortcutPath());
  await removeDirSafe(getStartMenuShortcutDir());
}

async function buildStatus() {
  const installDir = state.installDir || getDefaultInstallDir();
  const installedLatest = await getInstalledExe(installDir);

  return {
    installDir,
    installExists: await existsDir(installDir),
    installedExe: installedLatest ? installedLatest.file : null,
    installedName: installedLatest ? installedLatest.name : null,
    installedVersion: installedLatest ? installedLatest.version : null,
    installedTime: installedLatest ? installedLatest.mtimeMs : null,
    installedSize: installedLatest ? installedLatest.size : null
  };
}

async function performInstallLike(action, payload = {}) {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub_OWNER と GITHUB_REPO を設定してください');
  }

  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();
  await saveState({ installDir });

  const source = await prepareGithubSource();
  const latest = await findLatestExe(source.sourceDir);
  if (!latest) {
    throw new Error('ダウンロードしたアセット内に exe が見つかりません');
  }

  sendProgress({
    phase: 'install',
    percent: 100,
    title: 'インストール中...',
    detail: latest.name
  });

  await copyReleaseToInstall(source.sourceDir, installDir);
  await syncShortcuts(installDir);

  return {
    action,
    message:
      action === 'repair' ? '修復が完了しました' :
      action === 'update' ? 'アップデートが完了しました' :
      'インストールが完了しました'
  };
}

async function performUpdate(payload = {}) {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub_OWNER と GITHUB_REPO を設定してください');
  }

  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();
  await saveState({ installDir });

  const release = await fetchLatestRelease();
  const asset = selectReleaseAsset(release.assets || []);
  if (!asset) {
    throw new Error('GitHub Releases に使えるアセットが見つかりません');
  }

  const sourceVersion = getReleaseVersion(release, asset);
  const installedLatest = await getInstalledExe(installDir);

  if (installedLatest && sourceVersion && installedLatest.version) {
    if (compareVersions(installedLatest.version, sourceVersion) <= 0) {
      return { action: 'update', message: 'すでに最新です' };
    }
  }

  const source = await prepareGithubSource();
  const latest = await findLatestExe(source.sourceDir);
  if (!latest) {
    throw new Error('ダウンロードしたアセット内に exe が見つかりません');
  }

  await copyReleaseToInstall(source.sourceDir, installDir);
  await syncShortcuts(installDir);

  return { action: 'update', message: 'アップデートが完了しました' };
}

async function performUninstall(payload = {}) {
  const installDir = typeof payload.installDir === 'string' && payload.installDir ? payload.installDir : state.installDir || getDefaultInstallDir();

  sendProgress({
    phase: 'uninstall',
    percent: 100,
    title: 'アンインストール中...',
    detail: 'ショートカットとフォルダを削除しています'
  });

  await removeShortcuts();
  await removeDirSafe(installDir);
  await saveState({ installDir });

  return { action: 'uninstall', message: 'アンインストールが完了しました' };
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
    width: 840,
    height: 560,
    minWidth: 760,
    minHeight: 520,
    autoHideMenuBar: true,
    title: 'PlayPocket Installer',
    backgroundColor: '#0b1020',
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
  return getInstallerIconDataUrl();
});

ipcMain.handle('installer:choose-install-dir', async () => chooseInstallDir());

ipcMain.handle('installer:set-install-dir', async (_, installDir) => {
  if (typeof installDir !== 'string' || !installDir.trim()) return false;
  await saveState({ installDir: installDir.trim() });
  return true;
});

ipcMain.handle('installer:install', async (_, payload) => performInstallLike('install', payload));
ipcMain.handle('installer:repair', async (_, payload) => performInstallLike('repair', payload));
ipcMain.handle('installer:update', async (_, payload) => performUpdate(payload));
ipcMain.handle('installer:uninstall', async (_, payload) => performUninstall(payload));

app.whenReady().then(async () => {
  await loadState();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
